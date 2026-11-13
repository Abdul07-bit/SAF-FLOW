import { z } from "zod";
import { assertPublicLinkFresh } from "../core/public-links";
import type { Prisma } from "@prisma/client";
import {
  addDays, dateOnly, daysBetween, eachDate, endOfDayIST, financialYear, fmtDate, fromDateOnly, isISODate, istDate,
  startOfDayIST, startOfMonth, todayIST,
} from "@/lib/dates";
import { taxOn } from "@/lib/money";
import { ID_TYPES } from "@/shared/resources";
import { stayExpenses, stayGuests, stayRoomTypes, stayRooms } from "@/shared/resources";
import { route, type Ctx } from "../http/router";
import { registerCrud } from "../http/crud";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http/errors";
import { nextSeq, withPlatform, withTenant, type Tx } from "../db";
import { token } from "../core/ids";
import { getProductSettings } from "../core/settings";
import { fileUrl } from "../core/storage";
import { rangeQuery } from "./dine";

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const TENDER = z.enum(["CASH", "UPI", "CARD", "WALLET", "CREDIT", "OTHER"]);
const LIVE: ("CONFIRMED" | "CHECKED_IN")[] = ["CONFIRMED", "CHECKED_IN"];

registerCrud(stayRoomTypes, { model: "stayRoomType", orderBy: { baseRate: "asc" } });
registerCrud(stayRooms, {
  model: "stayRoom", include: { roomType: { select: { name: true, baseRate: true } } }, orderBy: [{ floor: "asc" }, { number: "asc" }],
});
registerCrud(stayGuests, { model: "stayGuest", orderBy: { createdAt: "desc" } });
registerCrud(stayExpenses, { model: "stayExpense", orderBy: { expenseDate: "desc" } });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resInclude = {
  guest: true,
  room: { select: { id: true, number: true, floor: true, status: true, hkStatus: true } },
  roomType: { select: { id: true, name: true, baseRate: true, maxAdults: true, maxChildren: true } },
  charges: { orderBy: { chargeDate: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.StayReservationInclude;

type ResFull = Prisma.StayReservationGetPayload<{ include: typeof resInclude }>;

async function loadRes(ctx: Ctx, id: string) {
  const r = await ctx.db.stayReservation.findFirst({ where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId }, include: resInclude });
  if (!r) throw notFound("Reservation");
  return r;
}

function nightsOf(r: { checkInDate: Date; checkOutDate: Date }) {
  return Math.max(1, daysBetween(fromDateOnly(r.checkInDate), fromDateOnly(r.checkOutDate)));
}

/** Folio with room charges projected until they are posted at check-out. */
export function folio(r: ResFull) {
  const posted = r.charges.map((c) => ({ ...c, tax: taxOn(c.amount, c.taxRate), projected: false }));
  const roomPosted = r.charges.some((c) => c.type === "ROOM");
  const projected =
    !roomPosted && (r.status === "CONFIRMED" || r.status === "CHECKED_IN")
      ? [{
          id: "projected-room", type: "ROOM" as const, description: `Room charges (${nightsOf(r)} night${nightsOf(r) > 1 ? "s" : ""} x rate)`,
          amount: r.ratePerNight * nightsOf(r), taxRate: r.taxRate, tax: taxOn(r.ratePerNight * nightsOf(r), r.taxRate),
          chargeDate: r.checkInDate, projected: true,
        }]
      : [];
  const lines = [...projected, ...posted];
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const tax = lines.reduce((a, l) => a + l.tax, 0);
  const paid = r.payments.reduce((a, p) => a + p.amount, 0);
  return { lines, subtotal, tax, total: subtotal + tax, paid, balance: subtotal + tax - paid, nights: nightsOf(r) };
}

async function overlapping(db: Tx, tenantId: string, branchId: string, from: string, to: string, excludeId?: string) {
  return db.stayReservation.findMany({
    where: {
      tenantId, branchId, status: { in: LIVE },
      checkInDate: { lt: dateOnly(to) }, checkOutDate: { gt: dateOnly(from) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, roomId: true, roomTypeId: true, checkInDate: true, checkOutDate: true },
  });
}

/** Rooms of a category free for [checkIn, checkOut), not out of order. */
async function freeRooms(db: Tx, ctx: Ctx, roomTypeId: string | undefined, checkIn: string, checkOut: string, excludeResId?: string) {
  const [rooms, busy] = await Promise.all([
    db.stayRoom.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true, status: { not: "OUT_OF_ORDER" }, ...(roomTypeId ? { roomTypeId } : {}) },
      include: { roomType: { select: { name: true, baseRate: true } } }, orderBy: { number: "asc" },
    }),
    overlapping(db, ctx.tenantId, ctx.branchId, checkIn, checkOut, excludeResId),
  ]);
  const taken = new Set(busy.map((b) => b.roomId).filter(Boolean));
  // Unassigned reservations still consume one room of their category.
  const unassigned: Record<string, number> = {};
  for (const b of busy) if (!b.roomId) unassigned[b.roomTypeId] = (unassigned[b.roomTypeId] ?? 0) + 1;
  const free = rooms.filter((r) => !taken.has(r.id));
  return { free, unassigned };
}

async function categoryHasSpace(db: Tx, ctx: Ctx, roomTypeId: string, checkIn: string, checkOut: string, excludeResId?: string) {
  const { free, unassigned } = await freeRooms(db, ctx, roomTypeId, checkIn, checkOut, excludeResId);
  return free.length - (unassigned[roomTypeId] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/stay/dashboard", tag: "stay", summary: "Hotel manager dashboard", auth: { product: "stay", feature: "dashboard", permission: "dashboard.view" },
  handler: async (ctx) => {
    const today = todayIST();
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const monthStart = startOfMonth(today);
    const [rooms, inHouse, arrivals, departures, payToday, payMtd, roomRevMtd, expensesMtd, upcoming] = await Promise.all([
      ctx.db.stayRoom.findMany({ where: { ...scope, isActive: true }, select: { status: true, hkStatus: true } }),
      ctx.db.stayReservation.count({ where: { ...scope, status: "CHECKED_IN" } }),
      ctx.db.stayReservation.count({ where: { ...scope, status: "CONFIRMED", checkInDate: dateOnly(today) } }),
      ctx.db.stayReservation.count({ where: { ...scope, status: "CHECKED_IN", checkOutDate: { lte: dateOnly(today) } } }),
      ctx.db.stayFolioPayment.aggregate({ _sum: { amount: true }, where: { tenantId: ctx.tenantId, reservation: { branchId: ctx.branchId }, createdAt: { gte: startOfDayIST(today), lte: endOfDayIST(today) } } }),
      ctx.db.stayFolioPayment.aggregate({ _sum: { amount: true }, where: { tenantId: ctx.tenantId, reservation: { branchId: ctx.branchId }, createdAt: { gte: startOfDayIST(monthStart) } } }),
      ctx.db.stayFolioCharge.aggregate({ _sum: { amount: true }, _count: true, where: { tenantId: ctx.tenantId, type: "ROOM", reservation: { branchId: ctx.branchId }, chargeDate: { gte: startOfDayIST(monthStart) } } }),
      ctx.db.stayExpense.aggregate({ _sum: { amount: true }, where: { ...scope, expenseDate: { gte: dateOnly(monthStart) } } }),
      ctx.db.stayReservation.count({ where: { ...scope, status: "CONFIRMED", checkInDate: { gt: dateOnly(today), lte: dateOnly(addDays(today, 7)) } } }),
    ]);
    const count = <K extends "status" | "hkStatus">(k: K, v: string) => rooms.filter((r) => r[k] === v).length;
    const sellable = rooms.length - count("status", "OUT_OF_ORDER");
    return {
      rooms: rooms.length, sellable,
      occupied: count("status", "OCCUPIED"),
      occupancyPct: sellable ? Math.round((count("status", "OCCUPIED") / sellable) * 1000) / 10 : 0,
      outOfOrder: count("status", "OUT_OF_ORDER"),
      housekeeping: { CLEAN: count("hkStatus", "CLEAN"), DIRTY: count("hkStatus", "DIRTY"), IN_PROGRESS: count("hkStatus", "IN_PROGRESS"), INSPECTED: count("hkStatus", "INSPECTED") },
      inHouse, arrivals, departures, upcomingArrivals7d: upcoming,
      collectedToday: payToday._sum.amount ?? 0, collectedMtd: payMtd._sum.amount ?? 0,
      roomRevenueMtd: roomRevMtd._sum.amount ?? 0,
      adrMtd: roomRevMtd._count ? Math.round((roomRevMtd._sum.amount ?? 0) / roomRevMtd._count) : 0,
      expensesMtd: expensesMtd._sum.amount ?? 0,
    };
  },
});

route({
  method: "GET", path: "/stay/front-desk", tag: "stay", summary: "Front desk: arrivals, departures, in-house, room grid",
  auth: { product: "stay", feature: "front_desk", permission: "frontdesk.view" },
  handler: async (ctx) => {
    const today = todayIST();
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const inc = { guest: { select: { fullName: true, phone: true, isVip: true } }, room: { select: { number: true } }, roomType: { select: { name: true } } };
    const [arrivals, departures, inHouse, rooms] = await Promise.all([
      ctx.db.stayReservation.findMany({ where: { ...scope, status: "CONFIRMED", checkInDate: { lte: dateOnly(today) } }, include: inc, orderBy: { checkInDate: "asc" } }),
      ctx.db.stayReservation.findMany({ where: { ...scope, status: "CHECKED_IN", checkOutDate: { lte: dateOnly(today) } }, include: inc, orderBy: { checkOutDate: "asc" } }),
      ctx.db.stayReservation.findMany({ where: { ...scope, status: "CHECKED_IN" }, include: inc, orderBy: { checkOutDate: "asc" } }),
      ctx.db.stayRoom.findMany({
        where: { ...scope, isActive: true }, orderBy: [{ floor: "asc" }, { number: "asc" }],
        include: { roomType: { select: { name: true } }, reservations: { where: { status: "CHECKED_IN" }, include: { guest: { select: { fullName: true } } }, take: 1 } },
      }),
    ]);
    const mapRes = (r: (typeof arrivals)[number]) => ({
      id: r.id, reservationNo: r.reservationNo, guest: r.guest, room: r.room?.number ?? null, roomType: r.roomType.name,
      checkInDate: fromDateOnly(r.checkInDate), checkOutDate: fromDateOnly(r.checkOutDate), adults: r.adults, children: r.children,
      overdue: r.status === "CONFIRMED" ? fromDateOnly(r.checkInDate) < today : fromDateOnly(r.checkOutDate) < today,
    });
    return {
      today,
      arrivals: arrivals.map(mapRes), departures: departures.map(mapRes), inHouse: inHouse.map(mapRes),
      rooms: rooms.map((r) => ({
        id: r.id, number: r.number, floor: r.floor, type: r.roomType.name, status: r.status, hkStatus: r.hkStatus,
        guest: r.reservations[0]?.guest.fullName ?? null, reservationId: r.reservations[0]?.id ?? null,
      })),
    };
  },
});

route({
  method: "GET", path: "/stay/availability", tag: "stay", summary: "Room availability calendar",
  auth: { product: "stay", feature: "availability", permission: ["rooms.view", "reservations.view"] },
  query: z.object({ from: isoDate.optional(), days: z.coerce.number().int().min(1).max(62).default(14) }),
  handler: async (ctx) => {
    const from = ctx.query.from ?? todayIST();
    const to = addDays(from, ctx.query.days);
    const [rooms, res, types] = await Promise.all([
      ctx.db.stayRoom.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true }, include: { roomType: { select: { name: true } } }, orderBy: [{ floor: "asc" }, { number: "asc" }] }),
      ctx.db.stayReservation.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: { in: LIVE }, checkInDate: { lt: dateOnly(to) }, checkOutDate: { gt: dateOnly(from) } },
        include: { guest: { select: { fullName: true } } },
      }),
      ctx.db.stayRoomType.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, orderBy: { baseRate: "asc" } }),
    ]);
    const dates = eachDate(from, addDays(to, -1));
    return {
      dates,
      rooms: rooms.map((r) => ({ id: r.id, number: r.number, type: r.roomType.name, roomTypeId: r.roomTypeId, status: r.status })),
      bookings: res.filter((r) => r.roomId).map((r) => ({
        id: r.id, roomId: r.roomId, guest: r.guest.fullName, status: r.status, reservationNo: r.reservationNo,
        checkInDate: fromDateOnly(r.checkInDate), checkOutDate: fromDateOnly(r.checkOutDate),
      })),
      byType: types.map((t) => ({
        id: t.id, name: t.name, baseRate: t.baseRate,
        available: dates.map((d) => {
          const total = rooms.filter((r) => r.roomTypeId === t.id && r.status !== "OUT_OF_ORDER").length;
          const used = res.filter((r) => r.roomTypeId === t.id && fromDateOnly(r.checkInDate) <= d && fromDateOnly(r.checkOutDate) > d).length;
          return Math.max(0, total - used);
        }),
      })),
    };
  },
});

route({
  method: "GET", path: "/stay/availability/rooms", tag: "stay", summary: "Rooms free for a stay (for assignment)",
  auth: { product: "stay", feature: ["availability", "reservations"], permission: ["rooms.view", "reservations.view"] },
  query: z.object({ checkIn: isoDate, checkOut: isoDate, roomTypeId: z.uuid().optional(), excludeReservationId: z.uuid().optional() }),
  handler: async (ctx) => {
    if (ctx.query.checkOut <= ctx.query.checkIn) throw badRequest("Check-out must be after check-in.");
    const { free } = await freeRooms(ctx.db, ctx, ctx.query.roomTypeId, ctx.query.checkIn, ctx.query.checkOut, ctx.query.excludeReservationId);
    return { items: free.map((r) => ({ id: r.id, number: r.number, floor: r.floor, roomTypeId: r.roomTypeId, type: r.roomType.name, hkStatus: r.hkStatus })) };
  },
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

const RES_READ = { product: "stay", feature: ["reservations", "front_desk", "room_billing"], permission: ["reservations.view", "billing.view"] } as const;
const RES_WRITE = { product: "stay", feature: "reservations", permission: "reservations.manage" } as const;
const CHECKIN = { product: "stay", feature: "checkin_checkout", permission: "checkin.perform" } as const;

route({
  method: "GET", path: "/stay/reservations", tag: "stay", summary: "Search reservations", auth: RES_READ,
  query: z.object({ status: z.enum(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]).optional(), from: isoDate.optional(), to: isoDate.optional(), q: z.string().max(60).optional() }),
  handler: async (ctx) => {
    const where: Prisma.StayReservationWhereInput = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    if (ctx.query.status) where.status = ctx.query.status;
    if (ctx.query.from) where.checkOutDate = { gt: dateOnly(ctx.query.from) };
    if (ctx.query.to) where.checkInDate = { lte: dateOnly(ctx.query.to) };
    if (ctx.query.q) {
      const n = Number(ctx.query.q);
      where.OR = [{ guest: { fullName: { contains: ctx.query.q, mode: "insensitive" } } }, { guest: { phone: { contains: ctx.query.q } } }, ...(Number.isInteger(n) ? [{ reservationNo: n }] : [])];
    }
    const items = await ctx.db.stayReservation.findMany({
      where, include: { guest: { select: { fullName: true, phone: true, isVip: true } }, room: { select: { number: true } }, roomType: { select: { name: true } } },
      orderBy: { checkInDate: "desc" }, take: 300,
    });
    return { items: items.map((r) => ({ ...r, checkInDate: fromDateOnly(r.checkInDate), checkOutDate: fromDateOnly(r.checkOutDate), nights: nightsOf(r) })) };
  },
});

route({
  method: "GET", path: "/stay/reservations/:id", tag: "stay", summary: "Reservation with guest folio", auth: RES_READ,
  handler: async (ctx) => {
    const r = await loadRes(ctx, ctx.params.id);
    return { ...r, checkInDate: fromDateOnly(r.checkInDate), checkOutDate: fromDateOnly(r.checkOutDate), folio: folio(r) };
  },
});

const guestInline = z.object({
  fullName: z.string().trim().min(2).max(100), phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, "Enter a valid phone"),
  email: z.string().trim().max(120).optional(), idType: z.enum(ID_TYPES).optional(), idNumber: z.string().trim().max(40).optional(),
  city: z.string().trim().max(60).optional(), address: z.string().trim().max(300).optional(),
});

route({
  method: "POST", path: "/stay/reservations", tag: "stay", summary: "Create a reservation or walk-in (optionally check in immediately)", auth: RES_WRITE,
  body: z.object({
    guestId: z.uuid().optional(), guest: guestInline.optional(),
    roomTypeId: z.uuid(), roomId: z.uuid().nullable().optional(),
    checkInDate: isoDate, checkOutDate: isoDate,
    adults: z.number().int().min(1).max(20).default(1), children: z.number().int().min(0).max(20).default(0),
    ratePerNight: z.number().int().min(0).optional(),
    source: z.enum(["WALK_IN", "PHONE", "OTA", "WEBSITE", "CORPORATE", "AGENT"]).default("WALK_IN"),
    specialRequests: z.string().max(500).optional(),
    advance: z.object({ amount: z.number().int().min(1), method: TENDER, reference: z.string().max(60).optional() }).optional(),
    checkInNow: z.boolean().default(false),
  }),
  handler: async (ctx) => {
    const b = ctx.body;
    if (b.checkOutDate <= b.checkInDate) throw badRequest("Check-out must be after check-in.");
    if (b.checkInDate < todayIST() && !b.checkInNow) throw badRequest("Check-in date cannot be in the past.");
    const type = await ctx.db.stayRoomType.findFirst({ where: { id: b.roomTypeId, tenantId: ctx.tenantId, isActive: true } });
    if (!type) throw badRequest("Unknown room category.");
    if (b.adults > type.maxAdults || b.children > type.maxChildren)
      throw badRequest(`${type.name} allows up to ${type.maxAdults} adults and ${type.maxChildren} children.`);

    let guestId = b.guestId;
    if (!guestId) {
      if (!b.guest) throw badRequest("Select a guest or enter guest details.");
      ctx.require({ feature: "guest_registration", permission: "guests.manage" });
      const g = await ctx.db.stayGuest.create({ data: { ...b.guest, email: b.guest.email || null, tenantId: ctx.tenantId } });
      guestId = g.id;
    } else if (!(await ctx.db.stayGuest.findFirst({ where: { id: guestId, tenantId: ctx.tenantId } }))) throw badRequest("Unknown guest.");

    if (b.roomId) {
      const room = await ctx.db.stayRoom.findFirst({ where: { id: b.roomId, tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true } });
      if (!room || room.roomTypeId !== type.id) throw badRequest("The room does not belong to the selected category.");
      if (room.status === "OUT_OF_ORDER") throw conflict(`Room ${room.number} is out of order.`);
    }
    if (!(await categoryHasSpace(ctx.db, ctx, type.id, b.checkInDate, b.checkOutDate)))
      throw new HttpError(409, "NO_AVAILABILITY", `No ${type.name} rooms are available for these dates.`);

    const settings = await getProductSettings(ctx.db, ctx.tenantId, "stay");
    const reservationNo = await nextSeq(ctx.db, ctx.tenantId, "stay-reservation");
    const r = await ctx.db.stayReservation.create({
      data: {
        tenantId: ctx.tenantId, branchId: ctx.branchId, reservationNo, guestId, roomTypeId: type.id, roomId: b.roomId ?? null,
        checkInDate: dateOnly(b.checkInDate), checkOutDate: dateOnly(b.checkOutDate), adults: b.adults, children: b.children,
        ratePerNight: b.ratePerNight ?? type.baseRate, taxRate: settings.roomTaxBp, source: b.source,
        specialRequests: b.specialRequests || null, publicToken: token(18), createdById: ctx.user.id,
      },
    });
    if (b.advance) {
      ctx.require({ feature: "room_billing", permission: "billing.manage" });
      await ctx.db.stayFolioPayment.create({ data: { tenantId: ctx.tenantId, reservationId: r.id, amount: b.advance.amount, method: b.advance.method, reference: b.advance.reference, receivedById: ctx.user.id } });
    }
    if (b.checkInNow) {
      ctx.require({ feature: "checkin_checkout", permission: "checkin.perform" });
      await doCheckIn(ctx, r.id, b.roomId ?? undefined);
    }
    await ctx.audit("stay.reservation.create", { type: "stay_reservation", id: r.id }, { reservationNo, checkInNow: b.checkInNow });
    ctx.status = 201;
    return loadRes(ctx, r.id);
  },
});

route({
  method: "PATCH", path: "/stay/reservations/:id", tag: "stay", summary: "Modify dates, room, occupancy or rate", auth: RES_WRITE,
  body: z.object({
    checkInDate: isoDate.optional(), checkOutDate: isoDate.optional(), roomId: z.uuid().nullable().optional(),
    adults: z.number().int().min(1).max(20).optional(), children: z.number().int().min(0).max(20).optional(),
    ratePerNight: z.number().int().min(0).optional(), specialRequests: z.string().max(500).nullable().optional(),
  }),
  handler: async (ctx) => {
    const r = await loadRes(ctx, ctx.params.id);
    if (r.status !== "CONFIRMED" && r.status !== "CHECKED_IN") throw conflict("Only upcoming or in-house reservations can be changed.");
    const b = ctx.body;
    if (r.status === "CHECKED_IN" && b.checkInDate) throw badRequest("Check-in date cannot change after check-in.");
    const checkIn = b.checkInDate ?? fromDateOnly(r.checkInDate);
    const checkOut = b.checkOutDate ?? fromDateOnly(r.checkOutDate);
    if (checkOut <= checkIn) throw badRequest("Check-out must be after check-in.");
    if (b.roomId) {
      const room = await ctx.db.stayRoom.findFirst({ where: { id: b.roomId, tenantId: ctx.tenantId, branchId: ctx.branchId } });
      if (!room || room.roomTypeId !== r.roomTypeId) throw badRequest("Room must belong to the reserved category.");
      if (r.status === "CHECKED_IN" && room.status !== "AVAILABLE") throw conflict(`Room ${room.number} is not available.`);
    }
    if ((b.checkInDate || b.checkOutDate) && !(await categoryHasSpace(ctx.db, ctx, r.roomTypeId, checkIn, checkOut, r.id)))
      throw new HttpError(409, "NO_AVAILABILITY", "No room of this category is free for the new dates.");
    await ctx.db.stayReservation.update({
      where: { id: r.id },
      data: {
        checkInDate: dateOnly(checkIn), checkOutDate: dateOnly(checkOut),
        ...(b.roomId !== undefined ? { roomId: b.roomId } : {}),
        ...(b.adults !== undefined ? { adults: b.adults } : {}), ...(b.children !== undefined ? { children: b.children } : {}),
        ...(b.ratePerNight !== undefined ? { ratePerNight: b.ratePerNight } : {}),
        ...(b.specialRequests !== undefined ? { specialRequests: b.specialRequests } : {}),
      },
    });
    // Room move while in-house
    if (r.status === "CHECKED_IN" && b.roomId && b.roomId !== r.roomId) {
      if (r.roomId) await ctx.db.stayRoom.update({ where: { id: r.roomId }, data: { status: "AVAILABLE", hkStatus: "DIRTY" } });
      await ctx.db.stayRoom.update({ where: { id: b.roomId }, data: { status: "OCCUPIED" } });
    }
    return loadRes(ctx, r.id);
  },
});

for (const action of ["cancel", "no-show"] as const) {
  route({
    method: "POST", path: `/stay/reservations/:id/${action}`, tag: "stay", summary: action === "cancel" ? "Cancel a reservation" : "Mark a no-show", auth: RES_WRITE,
    body: z.object({ reason: z.string().max(200).optional() }),
    handler: async (ctx) => {
      const r = await loadRes(ctx, ctx.params.id);
      if (r.status !== "CONFIRMED") throw conflict("Only confirmed (not yet arrived) reservations can be changed this way.");
      await ctx.db.stayReservation.update({ where: { id: r.id }, data: { status: action === "cancel" ? "CANCELLED" : "NO_SHOW", cancelledReason: ctx.body.reason ?? null } });
      return { ok: true };
    },
  });
}

async function doCheckIn(ctx: Ctx, id: string, roomId?: string, force = false) {
  const r = await loadRes(ctx, id);
  if (r.status !== "CONFIRMED") throw conflict("Only confirmed reservations can be checked in.");
  const today = todayIST();
  const roomIdToUse = roomId ?? r.roomId;
  if (!roomIdToUse) throw new HttpError(400, "ROOM_REQUIRED", "Assign a room before check-in.");
  const room = await ctx.db.stayRoom.findFirst({ where: { id: roomIdToUse, tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true } });
  if (!room || room.roomTypeId !== r.roomTypeId) throw badRequest("Room must belong to the reserved category.");
  if (room.status !== "AVAILABLE") throw conflict(`Room ${room.number} is ${room.status.toLowerCase().replace("_", " ")}.`);
  if (room.hkStatus === "DIRTY" && !force) throw new HttpError(409, "ROOM_NOT_CLEAN", `Room ${room.number} has not been cleaned yet.`);
  // Early arrival moves the stay start to today (the exclusion constraint guards overlaps).
  const checkIn = fromDateOnly(r.checkInDate);
  await ctx.db.stayReservation.update({
    where: { id: r.id },
    data: { status: "CHECKED_IN", checkedInAt: new Date(), roomId: room.id, ...(checkIn > today ? { checkInDate: dateOnly(today) } : {}) },
  });
  await ctx.db.stayRoom.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });
}

route({
  method: "POST", path: "/stay/reservations/:id/check-in", tag: "stay", summary: "Check a guest in (assigns room, marks it occupied)", auth: CHECKIN,
  body: z.object({ roomId: z.uuid().optional(), idType: z.enum(ID_TYPES).optional(), idNumber: z.string().max(40).optional(), force: z.boolean().default(false) }),
  handler: async (ctx) => {
    const r = await loadRes(ctx, ctx.params.id);
    if (ctx.body.idType || ctx.body.idNumber)
      await ctx.db.stayGuest.update({ where: { id: r.guestId }, data: { idType: ctx.body.idType ?? r.guest.idType, idNumber: ctx.body.idNumber ?? r.guest.idNumber } });
    await doCheckIn(ctx, r.id, ctx.body.roomId, ctx.body.force);
    await ctx.audit("stay.check_in", { type: "stay_reservation", id: r.id });
    return loadRes(ctx, r.id);
  },
});

route({
  method: "POST", path: "/stay/reservations/:id/check-out", tag: "stay",
  summary: "Check out: posts room charges, settles the folio, issues the invoice, marks the room dirty", auth: CHECKIN,
  body: z.object({ payment: z.object({ amount: z.number().int().min(1), method: TENDER, reference: z.string().max(60).optional() }).optional(), allowBalance: z.boolean().default(false) }),
  handler: async (ctx) => {
    let r = await loadRes(ctx, ctx.params.id);
    if (r.status !== "CHECKED_IN") throw conflict("Guest is not checked in.");
    const today = todayIST();
    const checkIn = fromDateOnly(r.checkInDate);
    const plannedOut = fromDateOnly(r.checkOutDate);
    // Early departure bills nights actually stayed (min. 1); a late departure bills the extra nights.
    const actualOut = today < plannedOut ? (today > checkIn ? today : addDays(checkIn, 1)) : today;
    if (actualOut !== plannedOut) await ctx.db.stayReservation.update({ where: { id: r.id }, data: { checkOutDate: dateOnly(actualOut) } });

    if (!r.charges.some((c) => c.type === "ROOM")) {
      const nights = Math.max(1, daysBetween(checkIn, actualOut));
      await ctx.db.stayFolioCharge.createMany({
        data: Array.from({ length: nights }, (_, i) => ({
          tenantId: ctx.tenantId, reservationId: r.id, type: "ROOM" as const,
          description: `Room ${r.room?.number ?? ""} - ${fmtDate(addDays(checkIn, i))}`,
          amount: r.ratePerNight, taxRate: r.taxRate, chargeDate: startOfDayIST(addDays(checkIn, i)), createdById: ctx.user.id,
        })),
      });
    }
    if (ctx.body.payment) {
      ctx.require({ feature: "room_billing", permission: "billing.manage" });
      await ctx.db.stayFolioPayment.create({ data: { tenantId: ctx.tenantId, reservationId: r.id, ...ctx.body.payment, receivedById: ctx.user.id } });
    }
    r = await loadRes(ctx, r.id);
    const f = folio(r);
    if (f.balance > 0 && !ctx.body.allowBalance)
      throw new HttpError(402, "BALANCE_DUE", `Balance due before check-out.`, { balance: f.balance });
    if (f.balance > 0 && !ctx.can("dashboard.view")) throw forbidden("PERMISSION_DENIED", "Only a manager can check out with an unpaid balance.");

    const settings = await getProductSettings(ctx.db, ctx.tenantId, "stay");
    const fy = financialYear(today).label;
    const seq = await nextSeq(ctx.db, ctx.tenantId, `stay-invoice-${fy}`);
    const invoiceNo = `${settings.invoicePrefix}/${fy}/${String(seq).padStart(5, "0")}`;
    await ctx.db.stayReservation.update({ where: { id: r.id }, data: { status: "CHECKED_OUT", checkedOutAt: new Date(), invoiceNo } });
    if (r.roomId) {
      await ctx.db.stayRoom.update({ where: { id: r.roomId }, data: { status: "AVAILABLE", hkStatus: "DIRTY" } });
      if (ctx.has("housekeeping_tasks"))
        await ctx.db.stayHousekeepingTask.create({
          data: { tenantId: ctx.tenantId, roomId: r.roomId, type: "CHECKOUT_CLEAN", priority: "HIGH", notes: `Departure of ${r.guest.fullName}`, createdById: ctx.user.id },
        });
    }
    await ctx.audit("stay.check_out", { type: "stay_reservation", id: r.id }, { invoiceNo, total: f.total, balance: f.balance });
    return { ...(await loadRes(ctx, r.id)), folio: f, invoiceUrl: `/invoice/stay/${r.publicToken}` };
  },
});

// Folio
const BILLING_WRITE = { product: "stay", feature: "room_billing", permission: "billing.manage" } as const;

route({
  method: "POST", path: "/stay/reservations/:id/charges", tag: "stay", summary: "Post a charge to the guest folio", auth: BILLING_WRITE,
  body: z.object({ type: z.enum(["FOOD", "LAUNDRY", "MINIBAR", "SERVICE", "OTHER"]), description: z.string().trim().min(2).max(120), amount: z.number().int().min(1), taxRate: z.number().int().min(0).max(2800).default(0) }),
  handler: async (ctx) => {
    const r = await loadRes(ctx, ctx.params.id);
    if (r.status !== "CHECKED_IN" && r.status !== "CONFIRMED") throw conflict("Charges can only be posted to active stays.");
    const c = await ctx.db.stayFolioCharge.create({ data: { ...ctx.body, tenantId: ctx.tenantId, reservationId: r.id, createdById: ctx.user.id } });
    ctx.status = 201;
    return c;
  },
});

route({
  method: "DELETE", path: "/stay/charges/:id", tag: "stay", summary: "Remove a folio charge (before check-out)", auth: BILLING_WRITE,
  handler: async (ctx) => {
    const c = await ctx.db.stayFolioCharge.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, include: { reservation: true } });
    if (!c) throw notFound("Charge");
    if (c.reservation.status === "CHECKED_OUT") throw conflict("The folio is closed.");
    await ctx.db.stayFolioCharge.delete({ where: { id: c.id } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/stay/reservations/:id/payments", tag: "stay", summary: "Record a guest payment / advance", auth: BILLING_WRITE,
  body: z.object({ amount: z.number().int().min(1), method: TENDER, reference: z.string().max(60).optional() }),
  handler: async (ctx) => {
    const r = await loadRes(ctx, ctx.params.id);
    if (r.status === "CANCELLED" || r.status === "NO_SHOW") throw conflict("Reservation is not active.");
    const p = await ctx.db.stayFolioPayment.create({ data: { ...ctx.body, tenantId: ctx.tenantId, reservationId: r.id, receivedById: ctx.user.id } });
    ctx.status = 201;
    return p;
  },
});

route({
  method: "GET", path: "/stay/cashier", tag: "stay", summary: "Cashier dashboard: open folios and today's collections",
  auth: { product: "stay", feature: "room_billing", permission: "billing.view" },
  handler: async (ctx) => {
    const today = todayIST();
    const [inHouse, payments] = await Promise.all([
      ctx.db.stayReservation.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "CHECKED_IN" }, include: resInclude, orderBy: { checkOutDate: "asc" } }),
      ctx.db.stayFolioPayment.findMany({
        where: { tenantId: ctx.tenantId, reservation: { branchId: ctx.branchId }, createdAt: { gte: startOfDayIST(today), lte: endOfDayIST(today) } },
        include: { reservation: { select: { reservationNo: true, guest: { select: { fullName: true } } } } }, orderBy: { createdAt: "desc" },
      }),
    ]);
    const byMethod: Record<string, number> = {};
    for (const p of payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    const folios = inHouse.map((r) => ({
      id: r.id, reservationNo: r.reservationNo, guest: r.guest.fullName, phone: r.guest.phone, room: r.room?.number,
      checkOutDate: fromDateOnly(r.checkOutDate), dueToday: fromDateOnly(r.checkOutDate) <= today, ...folio(r), lines: undefined,
    }));
    return { folios, payments, collections: { total: payments.reduce((a, p) => a + p.amount, 0), byMethod }, outstanding: folios.reduce((a, f) => a + Math.max(0, f.balance), 0) };
  },
});

route({
  method: "GET", path: "/stay/invoices", tag: "stay", summary: "Guest invoices (checked-out stays)",
  auth: { product: "stay", feature: "invoices", permission: "invoices.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const rows = await ctx.db.stayReservation.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "CHECKED_OUT", checkedOutAt: { gte: ctx.query.gte, lte: ctx.query.lte } },
      include: resInclude, orderBy: { checkedOutAt: "desc" },
    });
    return {
      from: ctx.query.from, to: ctx.query.to,
      items: rows.map((r) => {
        const f = folio(r);
        return { id: r.id, invoiceNo: r.invoiceNo, guest: r.guest.fullName, phone: r.guest.phone, room: r.room?.number, checkedOutAt: r.checkedOutAt, nights: f.nights, total: f.total, paid: f.paid, balance: f.balance, url: `/invoice/stay/${r.publicToken}` };
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// Housekeeping, tasks, maintenance
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/stay/housekeeping", tag: "stay", summary: "Housekeeping board",
  auth: { product: "stay", feature: "housekeeping_status", permission: "housekeeping.view" },
  handler: async (ctx) => {
    const rooms = await ctx.db.stayRoom.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true },
      include: {
        roomType: { select: { name: true } },
        hkTasks: { where: { status: { in: ["PENDING", "IN_PROGRESS"] } }, include: { assignedTo: { select: { fullName: true } } } },
        reservations: { where: { status: "CHECKED_IN" }, select: { checkOutDate: true }, take: 1 },
      },
      orderBy: [{ floor: "asc" }, { number: "asc" }],
    });
    const today = todayIST();
    return {
      rooms: rooms.map((r) => ({
        id: r.id, number: r.number, floor: r.floor, type: r.roomType.name, status: r.status, hkStatus: r.hkStatus,
        departureToday: r.reservations[0] ? fromDateOnly(r.reservations[0].checkOutDate) <= today : false,
        tasks: ctx.has("housekeeping_tasks") ? r.hkTasks.map((t) => ({ id: t.id, type: t.type, status: t.status, assignee: t.assignedTo?.fullName ?? null })) : [],
      })),
    };
  },
});

route({
  method: "POST", path: "/stay/rooms/:id/hk-status", tag: "stay", summary: "Update room cleaning status",
  auth: { product: "stay", feature: "housekeeping_status", permission: "housekeeping.update" },
  body: z.object({ hkStatus: z.enum(["CLEAN", "DIRTY", "IN_PROGRESS", "INSPECTED"]) }),
  handler: async (ctx) => {
    const room = await ctx.db.stayRoom.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!room) throw notFound("Room");
    await ctx.db.stayRoom.update({ where: { id: room.id }, data: { hkStatus: ctx.body.hkStatus } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/stay/rooms/:id/status", tag: "stay", summary: "Put a room out of order / back in service",
  auth: { product: "stay", feature: ["rooms", "maintenance"], permission: ["rooms.manage", "maintenance.manage"] },
  body: z.object({ status: z.enum(["AVAILABLE", "OUT_OF_ORDER"]) }),
  handler: async (ctx) => {
    const room = await ctx.db.stayRoom.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!room) throw notFound("Room");
    if (room.status === "OCCUPIED") throw conflict("Room is occupied.");
    await ctx.db.stayRoom.update({ where: { id: room.id }, data: { status: ctx.body.status } });
    return { ok: true };
  },
});

async function staffWith(db: Tx, tenantId: string, permission: string) {
  return db.user.findMany({
    where: { tenantId, isActive: true, productAccess: { some: { productCode: "stay", isActive: true, role: { permissions: { some: { permissionKey: permission } } } } } },
    select: { id: true, fullName: true, username: true }, orderBy: { fullName: "asc" },
  });
}

const HK_TASKS = { product: "stay", feature: "housekeeping_tasks" } as const;

route({
  method: "GET", path: "/stay/hk-tasks", tag: "stay", summary: "Housekeeping tasks", auth: { ...HK_TASKS, permission: "housekeeping.view" },
  query: z.object({ status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "CANCELLED", "OPEN"]).default("OPEN"), mine: z.enum(["0", "1"]).optional() }),
  handler: async (ctx) => {
    const mineOnly = ctx.query.mine === "1" || !ctx.can("housekeeping.assign");
    const items = await ctx.db.stayHousekeepingTask.findMany({
      where: {
        tenantId: ctx.tenantId, room: { branchId: ctx.branchId },
        status: ctx.query.status === "OPEN" ? { in: ["PENDING", "IN_PROGRESS"] } : ctx.query.status,
        // Staff see their own tasks plus unassigned ones they can pick up.
        ...(mineOnly ? { OR: [{ assignedToId: ctx.user.id }, { assignedToId: null }] } : {}),
      },
      include: { room: { select: { number: true, floor: true, hkStatus: true } }, assignedTo: { select: { id: true, fullName: true } } },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 300,
    });
    return { items, staff: ctx.can("housekeeping.assign") ? await staffWith(ctx.db, ctx.tenantId, "stay.housekeeping.update") : [] };
  },
});

route({
  method: "POST", path: "/stay/hk-tasks", tag: "stay", summary: "Assign a housekeeping task", auth: { ...HK_TASKS, permission: "housekeeping.assign" },
  body: z.object({
    roomId: z.uuid(), type: z.enum(["CLEANING", "CHECKOUT_CLEAN", "INSPECTION", "TURNDOWN", "DEEP_CLEAN", "LINEN_CHANGE"]).default("CLEANING"),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"), assignedToId: z.uuid().nullable().optional(),
    notes: z.string().max(300).optional(), dueAt: z.iso.datetime().optional(),
  }),
  handler: async (ctx) => {
    const room = await ctx.db.stayRoom.findFirst({ where: { id: ctx.body.roomId, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!room) throw badRequest("Unknown room.");
    if (ctx.body.assignedToId && !(await ctx.db.user.findFirst({ where: { id: ctx.body.assignedToId, tenantId: ctx.tenantId } }))) throw badRequest("Unknown staff member.");
    const t = await ctx.db.stayHousekeepingTask.create({
      data: { ...ctx.body, dueAt: ctx.body.dueAt ? new Date(ctx.body.dueAt) : null, tenantId: ctx.tenantId, createdById: ctx.user.id },
    });
    ctx.status = 201;
    return t;
  },
});

route({
  method: "POST", path: "/stay/hk-tasks/:id/status", tag: "stay", summary: "Start / complete / cancel a housekeeping task", auth: { ...HK_TASKS, permission: "housekeeping.update" },
  body: z.object({ status: z.enum(["IN_PROGRESS", "DONE", "CANCELLED"]).optional(), assignedToId: z.uuid().nullable().optional() }),
  handler: async (ctx) => {
    const t = await ctx.db.stayHousekeepingTask.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!t) throw notFound("Task");
    const canAssign = ctx.can("housekeeping.assign");
    if (!canAssign && t.assignedToId && t.assignedToId !== ctx.user.id) throw forbidden("PERMISSION_DENIED", "This task is assigned to someone else.");
    if (ctx.body.status === "CANCELLED" && !canAssign) throw forbidden("PERMISSION_DENIED", "Only a supervisor can cancel tasks.");
    if (ctx.body.assignedToId !== undefined && !canAssign) throw forbidden("PERMISSION_DENIED", "Only a supervisor can assign tasks.");
    if (ctx.body.assignedToId && !(await ctx.db.user.findFirst({ where: { id: ctx.body.assignedToId, tenantId: ctx.tenantId }, select: { id: true } })))
      throw badRequest("Unknown staff member.");
    if (!ctx.body.status) {
      // Assignment only: the task keeps its status.
      if (ctx.body.assignedToId === undefined) throw badRequest("Nothing to change.");
      await ctx.db.stayHousekeepingTask.update({ where: { id: t.id }, data: { assignedToId: ctx.body.assignedToId } });
      return { ok: true };
    }
    const now = new Date();
    await ctx.db.stayHousekeepingTask.update({
      where: { id: t.id },
      data: {
        status: ctx.body.status,
        ...(ctx.body.status === "IN_PROGRESS" ? { startedAt: now, assignedToId: t.assignedToId ?? ctx.user.id } : {}),
        ...(ctx.body.status === "DONE" ? { completedAt: now, startedAt: t.startedAt ?? now } : {}),
        ...(canAssign && ctx.body.assignedToId !== undefined ? { assignedToId: ctx.body.assignedToId } : {}),
      },
    });
    if (ctx.body.status === "IN_PROGRESS") await ctx.db.stayRoom.update({ where: { id: t.roomId }, data: { hkStatus: "IN_PROGRESS" } });
    if (ctx.body.status === "DONE")
      await ctx.db.stayRoom.update({ where: { id: t.roomId }, data: { hkStatus: t.type === "INSPECTION" ? "INSPECTED" : "CLEAN" } });
    return { ok: true };
  },
});

const MAINT = { product: "stay", feature: "maintenance" } as const;

route({
  method: "GET", path: "/stay/maintenance", tag: "stay", summary: "Maintenance jobs", auth: { ...MAINT, permission: ["maintenance.view", "maintenance.report"] },
  query: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "ACTIVE", "ALL"]).default("ACTIVE") }),
  handler: async (ctx) => {
    const items = await ctx.db.stayMaintenanceRecord.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(ctx.query.status === "ACTIVE" ? { status: { in: ["OPEN", "IN_PROGRESS"] } } : ctx.query.status === "ALL" ? {} : { status: ctx.query.status }),
      },
      include: { room: { select: { number: true } }, assignedTo: { select: { id: true, fullName: true } } },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }], take: 300,
    });
    return { items, staff: ctx.can("maintenance.manage") ? await staffWith(ctx.db, ctx.tenantId, "stay.maintenance.update") : [] };
  },
});

route({
  method: "POST", path: "/stay/maintenance", tag: "stay", summary: "Report a maintenance issue", auth: { ...MAINT, permission: "maintenance.report" },
  body: z.object({
    roomId: z.uuid().nullable().optional(), title: z.string().trim().min(3).max(120), description: z.string().max(1000).optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"), roomOutOfOrder: z.boolean().default(false),
  }),
  handler: async (ctx) => {
    if (ctx.body.roomId) {
      const room = await ctx.db.stayRoom.findFirst({ where: { id: ctx.body.roomId, tenantId: ctx.tenantId } });
      if (!room) throw badRequest("Unknown room.");
      if (ctx.body.roomOutOfOrder && room.status !== "OCCUPIED") await ctx.db.stayRoom.update({ where: { id: room.id }, data: { status: "OUT_OF_ORDER" } });
    }
    const m = await ctx.db.stayMaintenanceRecord.create({ data: { ...ctx.body, tenantId: ctx.tenantId, reportedById: ctx.user.id } });
    ctx.status = 201;
    return m;
  },
});

route({
  method: "PATCH", path: "/stay/maintenance/:id", tag: "stay", summary: "Update a maintenance job", auth: { ...MAINT, permission: ["maintenance.update", "maintenance.manage"] },
  body: z.object({
    status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(), assignedToId: z.uuid().nullable().optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(), cost: z.number().int().min(0).optional(), resolution: z.string().max(1000).optional(),
  }),
  handler: async (ctx) => {
    const m = await ctx.db.stayMaintenanceRecord.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!m) throw notFound("Maintenance job");
    if ((ctx.body.assignedToId !== undefined || ctx.body.priority) && !ctx.can("maintenance.manage"))
      throw forbidden("PERMISSION_DENIED", "Only a supervisor can assign or re-prioritise jobs.");
    const closing = ctx.body.status === "RESOLVED" || ctx.body.status === "CLOSED";
    const updated = await ctx.db.stayMaintenanceRecord.update({
      where: { id: m.id },
      data: { ...ctx.body, ...(closing && !m.resolvedAt ? { resolvedAt: new Date() } : {}), ...(ctx.body.status === "IN_PROGRESS" && !m.assignedToId ? { assignedToId: ctx.user.id } : {}) },
    });
    if (closing && m.roomId && m.roomOutOfOrder) {
      const stillOpen = await ctx.db.stayMaintenanceRecord.count({ where: { roomId: m.roomId, roomOutOfOrder: true, status: { in: ["OPEN", "IN_PROGRESS"] }, id: { not: m.id } } });
      if (!stillOpen) await ctx.db.stayRoom.updateMany({ where: { id: m.roomId, status: "OUT_OF_ORDER" }, data: { status: "AVAILABLE", hkStatus: "DIRTY" } });
    }
    return updated;
  },
});

// ---------------------------------------------------------------------------
// Reports & analytics
// ---------------------------------------------------------------------------

async function stayNights(ctx: Ctx, from: string, to: string) {
  const [rooms, res] = await Promise.all([
    ctx.db.stayRoom.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true }, select: { id: true, roomTypeId: true } }),
    ctx.db.stayReservation.findMany({
      where: {
        tenantId: ctx.tenantId, branchId: ctx.branchId, status: { in: ["CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] },
        checkInDate: { lte: dateOnly(to) }, checkOutDate: { gt: dateOnly(from) },
      },
      include: { roomType: { select: { name: true } }, guest: { select: { id: true } } },
    }),
  ]);
  return { rooms, res };
}

route({
  method: "GET", path: "/stay/reports/occupancy", tag: "stay", summary: "Occupancy report (daily rooms sold, %)",
  auth: { product: "stay", feature: "occupancy_reports", permission: "reports.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to } = ctx.query;
    const { rooms, res } = await stayNights(ctx, from, to);
    const days = eachDate(from, to).map((d) => {
      const occupied = res.filter((r) => fromDateOnly(r.checkInDate) <= d && fromDateOnly(r.checkOutDate) > d).length;
      return {
        date: d, rooms: rooms.length, occupied,
        occupancyPct: rooms.length ? Math.round((occupied / rooms.length) * 1000) / 10 : 0,
        arrivals: res.filter((r) => fromDateOnly(r.checkInDate) === d).length,
        departures: res.filter((r) => fromDateOnly(r.checkOutDate) === d).length,
      };
    });
    const sold = days.reduce((a, d) => a + d.occupied, 0);
    const capacity = days.reduce((a, d) => a + d.rooms, 0);
    return { from, to, days, summary: { roomNightsSold: sold, capacity, avgOccupancyPct: capacity ? Math.round((sold / capacity) * 1000) / 10 : 0, guests: new Set(res.map((r) => r.guestId)).size } };
  },
});

route({
  method: "GET", path: "/stay/analytics", tag: "stay", summary: "Advanced occupancy analytics (ADR, RevPAR, mix, LOS)",
  auth: { product: "stay", feature: "analytics_advanced", permission: "analytics.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const { rooms, res } = await stayNights(ctx, from, to);
    const [roomCharges, cancelled, allGuests] = await Promise.all([
      ctx.db.stayFolioCharge.findMany({ where: { tenantId: ctx.tenantId, type: "ROOM", reservation: { branchId: ctx.branchId }, chargeDate: { gte, lte } }, include: { reservation: { select: { roomTypeId: true } } } }),
      ctx.db.stayReservation.groupBy({ by: ["status"], _count: true, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, createdAt: { gte, lte } } }),
      ctx.db.stayReservation.groupBy({ by: ["guestId"], _count: true, where: { tenantId: ctx.tenantId, status: { in: ["CHECKED_IN", "CHECKED_OUT"] } } }),
    ]);
    const dates = eachDate(from, to);
    const sold = dates.reduce((a, d) => a + res.filter((r) => fromDateOnly(r.checkInDate) <= d && fromDateOnly(r.checkOutDate) > d).length, 0);
    const roomRevenue = roomCharges.reduce((a, c) => a + c.amount, 0);
    const capacity = rooms.length * dates.length;
    const dow = Array.from({ length: 7 }, (_, i) => ({ day: i, sold: 0, capacity: 0 }));
    for (const d of dates) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      dow[wd].capacity += rooms.length;
      dow[wd].sold += res.filter((r) => fromDateOnly(r.checkInDate) <= d && fromDateOnly(r.checkOutDate) > d).length;
    }
    const byType: Record<string, { name: string; nights: number; revenue: number }> = {};
    for (const r of res) {
      byType[r.roomTypeId] ??= { name: r.roomType.name, nights: 0, revenue: 0 };
      byType[r.roomTypeId].nights += nightsOf(r);
    }
    for (const c of roomCharges) if (byType[c.reservation.roomTypeId]) byType[c.reservation.roomTypeId].revenue += c.amount;
    const sources: Record<string, number> = {};
    for (const r of res) sources[r.source] = (sources[r.source] ?? 0) + 1;
    const los = res.length ? res.reduce((a, r) => a + nightsOf(r), 0) / res.length : 0;
    const lead = res.length ? res.reduce((a, r) => a + Math.max(0, daysBetween(istDate(r.createdAt), fromDateOnly(r.checkInDate))), 0) / res.length : 0;
    const totalCreated = cancelled.reduce((a, c) => a + c._count, 0);
    const pct = (n: number) => (totalCreated ? Math.round((n / totalCreated) * 1000) / 10 : 0);
    const stayGuestsInRange = new Set(res.map((r) => r.guestId));
    const repeat = [...stayGuestsInRange].filter((g) => (allGuests.find((x) => x.guestId === g)?._count ?? 0) > 1).length;
    return {
      from, to,
      kpis: {
        occupancyPct: capacity ? Math.round((sold / capacity) * 1000) / 10 : 0,
        adr: roomCharges.length ? Math.round(roomRevenue / roomCharges.length) : 0,
        revpar: capacity ? Math.round(roomRevenue / capacity) : 0,
        roomRevenue, roomNightsSold: sold, avgLengthOfStay: Math.round(los * 10) / 10, avgLeadTimeDays: Math.round(lead * 10) / 10,
        cancellationPct: pct(cancelled.find((c) => c.status === "CANCELLED")?._count ?? 0),
        noShowPct: pct(cancelled.find((c) => c.status === "NO_SHOW")?._count ?? 0),
        repeatGuestPct: stayGuestsInRange.size ? Math.round((repeat / stayGuestsInRange.size) * 1000) / 10 : 0,
      },
      byWeekday: dow.map((d) => ({ ...d, occupancyPct: d.capacity ? Math.round((d.sold / d.capacity) * 1000) / 10 : 0 })),
      byRoomType: Object.values(byType).sort((a, b) => b.revenue - a.revenue),
      sources: Object.entries(sources).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    };
  },
});

route({
  method: "GET", path: "/stay/reports/revenue", tag: "stay", summary: "Revenue report: by charge type, day, payment method, minus expenses",
  auth: { product: "stay", feature: "revenue_reports", permission: "analytics.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const [charges, payments, expenses] = await Promise.all([
      ctx.db.stayFolioCharge.findMany({ where: { tenantId: ctx.tenantId, reservation: { branchId: ctx.branchId }, chargeDate: { gte, lte } } }),
      ctx.db.stayFolioPayment.findMany({ where: { tenantId: ctx.tenantId, reservation: { branchId: ctx.branchId }, createdAt: { gte, lte } } }),
      ctx.db.stayExpense.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, expenseDate: { gte: dateOnly(from), lte: dateOnly(to) } } }),
    ]);
    const byType: Record<string, number> = {};
    const daily = Object.fromEntries(eachDate(from, to).map((d) => [d, { date: d, revenue: 0, collected: 0, expenses: 0 }]));
    for (const c of charges) {
      byType[c.type] = (byType[c.type] ?? 0) + c.amount;
      const d = istDate(c.chargeDate);
      if (daily[d]) daily[d].revenue += c.amount;
    }
    const byMethod: Record<string, number> = {};
    for (const p of payments) {
      byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
      const d = istDate(p.createdAt);
      if (daily[d]) daily[d].collected += p.amount;
    }
    const expByCat: Record<string, number> = {};
    for (const e of expenses) {
      expByCat[e.category] = (expByCat[e.category] ?? 0) + e.amount;
      const d = fromDateOnly(e.expenseDate);
      if (daily[d]) daily[d].expenses += e.amount;
    }
    const revenue = charges.reduce((a, c) => a + c.amount, 0);
    const tax = charges.reduce((a, c) => a + taxOn(c.amount, c.taxRate), 0);
    const spend = expenses.reduce((a, e) => a + e.amount, 0);
    return {
      from, to,
      totals: { revenue, tax, collected: payments.reduce((a, p) => a + p.amount, 0), expenses: spend, netOperating: revenue - spend },
      byChargeType: Object.entries(byType).map(([type, amount]) => ({ type, amount })),
      byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, amount })),
      expensesByCategory: Object.entries(expByCat).map(([category, amount]) => ({ category, amount })),
      daily: Object.values(daily),
    };
  },
});

route({
  method: "GET", path: "/stay/reports/operations", tag: "stay", summary: "Operational report: housekeeping turnaround, maintenance, no-shows",
  auth: { product: "stay", feature: "ops_reports", permission: "analytics.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const [tasks, maint, resStats] = await Promise.all([
      ctx.db.stayHousekeepingTask.findMany({ where: { tenantId: ctx.tenantId, room: { branchId: ctx.branchId }, createdAt: { gte, lte } }, include: { assignedTo: { select: { fullName: true } } } }),
      ctx.db.stayMaintenanceRecord.findMany({ where: { tenantId: ctx.tenantId, createdAt: { gte, lte } } }),
      ctx.db.stayReservation.groupBy({ by: ["status"], _count: true, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, checkInDate: { gte: dateOnly(from), lte: dateOnly(to) } } }),
    ]);
    const done = tasks.filter((t) => t.status === "DONE" && t.completedAt);
    const turnaround = done.map((t) => (t.completedAt!.getTime() - t.createdAt.getTime()) / 60_000);
    const perStaff: Record<string, { name: string; done: number; avgMinutes: number; _sum: number }> = {};
    for (const t of done) {
      const n = t.assignedTo?.fullName ?? "Unassigned";
      perStaff[n] ??= { name: n, done: 0, avgMinutes: 0, _sum: 0 };
      perStaff[n].done++;
      perStaff[n]._sum += (t.completedAt!.getTime() - (t.startedAt ?? t.createdAt).getTime()) / 60_000;
    }
    const resolved = maint.filter((m) => m.resolvedAt);
    return {
      from, to,
      housekeeping: {
        created: tasks.length, completed: done.length, open: tasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS").length,
        avgTurnaroundMinutes: turnaround.length ? Math.round(turnaround.reduce((a, b) => a + b, 0) / turnaround.length) : null,
        byStaff: Object.values(perStaff).map(({ _sum, ...s }) => ({ ...s, avgMinutes: Math.round(_sum / s.done) })).sort((a, b) => b.done - a.done),
      },
      maintenance: {
        reported: maint.length, resolved: resolved.length, open: maint.filter((m) => m.status === "OPEN" || m.status === "IN_PROGRESS").length,
        urgent: maint.filter((m) => m.priority === "URGENT").length,
        avgResolutionHours: resolved.length ? Math.round((resolved.reduce((a, m) => a + (m.resolvedAt!.getTime() - m.createdAt.getTime()), 0) / resolved.length / 3_600_000) * 10) / 10 : null,
        totalCost: maint.reduce((a, m) => a + m.cost, 0),
      },
      reservations: Object.fromEntries(resStats.map((r) => [r.status, r._count])),
    };
  },
});

// ---------------------------------------------------------------------------
// Public invoice
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/public/invoice/stay/:token", tag: "public", summary: "Printable hotel invoice",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) => {
    const ref = await withPlatform((db) => db.stayReservation.findUnique({ where: { publicToken: ctx.params.token }, select: { id: true, tenantId: true } }));
    if (!ref) throw notFound("Invoice");
    return withTenant(ref.tenantId, async (db) => {
      const r = await db.stayReservation.findUniqueOrThrow({ where: { id: ref.id }, include: resInclude });
      if (r.status !== "CHECKED_OUT") throw notFound("Invoice");
      assertPublicLinkFresh(r.checkedOutAt ?? r.createdAt);
      const business = await db.business.findUniqueOrThrow({ where: { tenantId: ref.tenantId } });
      const settings = await getProductSettings(db, ref.tenantId, "stay");
      const f = folio(r);
      return {
        kind: "stay",
        seller: { name: settings.hotelName || business.name, address: [business.address, business.city, business.state, business.pincode].filter(Boolean).join(", "), phone: business.phone, gstin: settings.gstin || business.gstin, logoUrl: fileUrl(business.logoKey) },
        invoiceNo: r.invoiceNo, date: r.checkedOutAt,
        customer: { name: r.guest.fullName, phone: r.guest.phone, address: r.guest.address, gstin: r.guest.gstin, company: r.guest.company },
        meta: [`Room ${r.room?.number ?? "-"} (${r.roomType.name})`, `${fmtDate(r.checkInDate)} to ${fmtDate(r.checkOutDate)}`, `${f.nights} night(s)`, `Reservation #${r.reservationNo}`],
        lines: f.lines.map((l) => ({ name: l.description, qty: 1, rate: l.amount, taxRate: l.taxRate, amount: l.amount })),
        subtotal: f.subtotal, discount: 0, tax: f.tax, total: f.total,
        payments: r.payments.map((p) => ({ method: p.method, amount: p.amount, date: p.createdAt })), paid: f.paid, balance: f.balance,
        footer: settings.invoiceFooter,
      };
    });
  },
});
