import { z } from "zod";
import type { AttendanceStatus, Prisma } from "@prisma/client";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import {
  addDays, addMonths, dateOnly, eachDate, endOfMonth, fromDateOnly, hhmmToMinutes, isISODate, istDate, istMinutes,
  startOfDayIST, todayIST, type ISODate,
} from "@/lib/dates";
import { route, type Ctx } from "../http/router";
import { registerCrud } from "../http/crud";
import { badRequest, conflict, notFound } from "../http/errors";
import { nextSeq, withPlatform, type Tx } from "../db";
import { token } from "../core/ids";
import { fileUrl, saveImage, storage } from "../core/storage";
import { renderIdCards, type CardData } from "../staff/idcard-pdf";
import { brandHexFromLogo } from "../staff/logo-colour";
import { shifts } from "@/shared/resources";

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const EMP_READ = {
  product: ":product",
  feature: ["staff_management", "attendance", "shifts", "id_cards"],
  permission: ["employees.manage", "attendance.manage", "shifts.manage"],
} as const;
const EMP_WRITE = { product: ":product", feature: "staff_management", permission: "employees.manage" } as const;
const ATT_MANAGE = { product: ":product", feature: "attendance", permission: "attendance.manage" } as const;
const ATT_SELF = { product: ":product", feature: "staff_checkin", permission: "attendance.self" } as const;
const ROSTER = { product: ":product", feature: "shifts", permission: "shifts.manage" } as const;
const CARDS = { product: ":product", feature: "id_cards", permission: "employees.manage" } as const;
const VERIFY = { product: ":product", feature: "qr_verification", permission: ["staff.verify", "attendance.manage"] } as const;

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export const verifyUrl = (qrToken: string) => `${appUrl()}/verify/${qrToken}`;

function employeeOut(e: any) {
  return { ...e, photoUrl: fileUrl(e.photoKey), dateOfJoining: e.dateOfJoining ? fromDateOnly(e.dateOfJoining) : null };
}

const inProduct = (ctx: Ctx): Prisma.EmployeeProfileWhereInput => ({ tenantId: ctx.tenantId, productCodes: { has: ctx.product } });

async function loadEmployee(ctx: Ctx, id: string) {
  const e = await ctx.db.employeeProfile.findFirst({ where: { id, ...inProduct(ctx) } });
  if (!e) throw notFound("Employee");
  return e;
}

// ---------------------------------------------------------------------------
// Employee database
// ---------------------------------------------------------------------------

const employeeBody = z.object({
  fullName: z.string().trim().min(2).max(100),
  designation: z.string().trim().min(2).max(60),
  department: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  bloodGroup: z.string().trim().max(5).nullable().optional(),
  emergencyContact: z.string().trim().max(100).nullable().optional(),
  dateOfJoining: isoDate.nullable().optional(),
  userId: z.uuid().nullable().optional(),
  employeeCode: z.string().trim().max(20).optional(),
});

async function checkLinkableUser(ctx: Ctx, userId: string | null | undefined, selfId?: string) {
  if (!userId) return;
  const u = await ctx.db.user.findFirst({ where: { id: userId, tenantId: ctx.tenantId }, include: { employeeProfile: true } });
  if (!u) throw badRequest("Selected login does not exist.");
  if (u.employeeProfile && u.employeeProfile.id !== selfId) throw conflict("That login is already linked to another employee.");
}

route({
  method: "GET", path: "/:product/staff/employees", tag: "staff", summary: "Employee database for this product", auth: EMP_READ,
  query: z.object({ q: z.string().max(80).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ALL"]).default("ACTIVE"), scope: z.enum(["product", "all"]).default("product") }),
  handler: async (ctx) => {
    const where: Prisma.EmployeeProfileWhereInput = {
      ...(ctx.query.scope === "all" ? { tenantId: ctx.tenantId } : inProduct(ctx)),
      ...(ctx.query.status !== "ALL" ? { status: ctx.query.status } : {}),
      ...(ctx.query.q ? { OR: [{ fullName: { contains: ctx.query.q, mode: "insensitive" } }, { employeeCode: { contains: ctx.query.q, mode: "insensitive" } }, { phone: { contains: ctx.query.q } }] } : {}),
    };
    const items = await ctx.db.employeeProfile.findMany({
      where, orderBy: { fullName: "asc" },
      include: { user: { select: { username: true } }, idCards: { where: { status: "ACTIVE" }, orderBy: { issuedAt: "desc" }, take: 1 } },
    });
    return { items: items.map(employeeOut) };
  },
});

route({
  method: "GET", path: "/:product/staff/linkable-users", tag: "staff", summary: "Logins that can be linked to an employee record", auth: EMP_WRITE,
  handler: async (ctx) => {
    const users = await ctx.db.user.findMany({
      where: { tenantId: ctx.tenantId, employeeProfile: null, productAccess: { some: { productCode: ctx.product } } },
      select: { id: true, username: true, fullName: true, phone: true, email: true }, orderBy: { fullName: "asc" },
    });
    return { items: users };
  },
});

route({
  method: "POST", path: "/:product/staff/employees", tag: "staff", summary: "Add an employee", auth: EMP_WRITE, body: employeeBody,
  handler: async (ctx) => {
    await checkLinkableUser(ctx, ctx.body.userId);
    const seq = await nextSeq(ctx.db, ctx.tenantId, "employee");
    const code = ctx.body.employeeCode || `${ctx.user.tenantCode}-E${String(seq).padStart(4, "0")}`;
    const e = await ctx.db.employeeProfile.create({
      data: {
        ...ctx.body,
        dateOfJoining: ctx.body.dateOfJoining ? dateOnly(ctx.body.dateOfJoining) : null,
        employeeCode: code, tenantId: ctx.tenantId, branchId: ctx.branchId || null,
        productCodes: [ctx.product], qrToken: token(18),
      },
    });
    await ctx.audit("staff.employee.create", { type: "employee", id: e.id }, { code });
    ctx.status = 201;
    return employeeOut(e);
  },
});

route({
  method: "PATCH", path: "/:product/staff/employees/:id", tag: "staff", summary: "Edit an employee", auth: EMP_WRITE, body: employeeBody.partial(),
  handler: async (ctx) => {
    const e = await loadEmployee(ctx, ctx.params.id);
    await checkLinkableUser(ctx, ctx.body.userId, e.id);
    const { dateOfJoining, ...rest } = ctx.body;
    const row = await ctx.db.employeeProfile.update({
      where: { id: e.id },
      data: { ...rest, ...(dateOfJoining !== undefined ? { dateOfJoining: dateOfJoining ? dateOnly(dateOfJoining) : null } : {}) },
    });
    return employeeOut(row);
  },
});

route({
  method: "POST", path: "/:product/staff/employees/:id/status", tag: "staff", summary: "Activate / deactivate an employee", auth: EMP_WRITE,
  body: z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }),
  handler: async (ctx) => {
    const e = await loadEmployee(ctx, ctx.params.id);
    await ctx.db.employeeProfile.update({ where: { id: e.id }, data: { status: ctx.body.status } });
    if (ctx.body.status === "INACTIVE") await ctx.db.employeeIdCard.updateMany({ where: { employeeId: e.id, status: "ACTIVE" }, data: { status: "REVOKED" } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/staff/employees/:id/attach", tag: "staff", summary: "Add an existing employee (from another SAF product) to this product", auth: EMP_WRITE,
  handler: async (ctx) => {
    const e = await ctx.db.employeeProfile.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!e) throw notFound("Employee");
    if (!e.productCodes.includes(ctx.product))
      await ctx.db.employeeProfile.update({ where: { id: e.id }, data: { productCodes: [...e.productCodes, ctx.product] } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/staff/employees/:id/photo", tag: "staff", summary: "Upload employee photograph (PNG/JPEG, max 2 MB)", auth: EMP_WRITE, multipart: true,
  rateLimit: { limit: 20, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const e = await loadEmployee(ctx, ctx.params.id);
    const key = await saveImage(ctx.tenantId, "employees", ctx.form!.get("file") as File | null);
    await ctx.db.employeeProfile.update({ where: { id: e.id }, data: { photoKey: key } });
    return { photoUrl: fileUrl(key) };
  },
});

// ---------------------------------------------------------------------------
// Shifts and roster
// ---------------------------------------------------------------------------

registerCrud(shifts, {
  model: "staffShift",
  orderBy: { startTime: "asc" },
  where: (ctx) => ({ productCode: ctx.product }),
  beforeCreate: (ctx, data) => ({ ...data, productCode: ctx.product }),
});

route({
  method: "GET", path: "/:product/staff/roster", tag: "staff", summary: "Weekly shift roster", auth: ROSTER,
  query: z.object({ from: isoDate.optional(), days: z.coerce.number().int().min(1).max(31).default(7) }),
  handler: async (ctx) => {
    const from = ctx.query.from ?? todayIST();
    const to = addDays(from, ctx.query.days - 1);
    const [employees, shiftRows, assignments] = await Promise.all([
      ctx.db.employeeProfile.findMany({ where: { ...inProduct(ctx), status: "ACTIVE" }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, designation: true, employeeCode: true } }),
      ctx.db.staffShift.findMany({ where: { tenantId: ctx.tenantId, productCode: ctx.product, isActive: true }, orderBy: { startTime: "asc" } }),
      ctx.db.shiftAssignment.findMany({ where: { tenantId: ctx.tenantId, productCode: ctx.product, date: { gte: dateOnly(from), lte: dateOnly(to) } } }),
    ]);
    return {
      dates: eachDate(from, to), employees, shifts: shiftRows,
      assignments: assignments.map((a) => ({ employeeId: a.employeeId, date: fromDateOnly(a.date), shiftId: a.shiftId })),
    };
  },
});

route({
  method: "PUT", path: "/:product/staff/roster", tag: "staff", summary: "Assign shifts (null shiftId clears the day)", auth: ROSTER,
  body: z.object({ assignments: z.array(z.object({ employeeId: z.uuid(), date: isoDate, shiftId: z.uuid().nullable() })).min(1).max(500) }),
  handler: async (ctx) => {
    const empIds = [...new Set(ctx.body.assignments.map((a) => a.employeeId))];
    const shiftIds = [...new Set(ctx.body.assignments.map((a) => a.shiftId).filter(Boolean) as string[])];
    const [emps, sh] = await Promise.all([
      ctx.db.employeeProfile.count({ where: { id: { in: empIds }, ...inProduct(ctx) } }),
      ctx.db.staffShift.count({ where: { id: { in: shiftIds }, tenantId: ctx.tenantId, productCode: ctx.product } }),
    ]);
    if (emps !== empIds.length || sh !== shiftIds.length) throw badRequest("Unknown employee or shift.");
    for (const a of ctx.body.assignments) {
      const key = { employeeId_date: { employeeId: a.employeeId, date: dateOnly(a.date) } };
      if (!a.shiftId) await ctx.db.shiftAssignment.deleteMany({ where: { employeeId: a.employeeId, date: dateOnly(a.date) } });
      else
        await ctx.db.shiftAssignment.upsert({
          where: key,
          create: { tenantId: ctx.tenantId, employeeId: a.employeeId, shiftId: a.shiftId, date: dateOnly(a.date), productCode: ctx.product },
          update: { shiftId: a.shiftId, productCode: ctx.product },
        });
    }
    return { ok: true, count: ctx.body.assignments.length };
  },
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

async function shiftFor(db: Tx, employeeId: string, date: ISODate) {
  const a = await db.shiftAssignment.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, include: { shift: true } });
  return a?.shift ?? null;
}

/** Check-in/out shared by self-service, QR scan and manager actions. */
async function checkInOut(ctx: Ctx, employeeId: string, action: "in" | "out" | "auto", source: "SELF" | "QR" | "MANAGER") {
  const now = new Date();
  const date = istDate(now);
  const existing = await ctx.db.staffAttendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(date) } } });
  const mode = action === "auto" ? (existing?.checkInAt && !existing.checkOutAt ? "out" : "in") : action;

  if (mode === "in") {
    if (existing?.checkInAt) throw conflict("Already checked in today.");
    const shift = await shiftFor(ctx.db, employeeId, date);
    let lateMinutes = 0;
    let status: AttendanceStatus = "PRESENT";
    if (shift) {
      lateMinutes = Math.max(0, istMinutes(now) - hhmmToMinutes(shift.startTime));
      if (lateMinutes > shift.graceMinutes) status = "LATE";
      else lateMinutes = 0;
    }
    const data = { checkInAt: now, status, lateMinutes, shiftId: shift?.id ?? null, source, productCode: ctx.product, branchId: ctx.branchId || null };
    const row = existing
      ? await ctx.db.staffAttendance.update({ where: { id: existing.id }, data })
      : await ctx.db.staffAttendance.create({ data: { ...data, tenantId: ctx.tenantId, employeeId, date: dateOnly(date) } });
    return { action: "in" as const, record: row };
  }

  if (!existing?.checkInAt) throw conflict("Not checked in today.");
  if (existing.checkOutAt) throw conflict("Already checked out today.");
  const worked = Math.max(0, Math.round((now.getTime() - existing.checkInAt.getTime()) / 60_000));
  const status: AttendanceStatus = worked < 240 && existing.status !== "LATE" ? "HALF_DAY" : existing.status;
  const row = await ctx.db.staffAttendance.update({ where: { id: existing.id }, data: { checkOutAt: now, workedMinutes: worked, status } });
  return { action: "out" as const, record: row };
}

route({
  method: "GET", path: "/:product/staff/attendance/me", tag: "attendance", summary: "My attendance, today's shift and recent history", auth: ATT_SELF,
  handler: async (ctx) => {
    const emp = await ctx.db.employeeProfile.findFirst({ where: { userId: ctx.user.id, tenantId: ctx.tenantId } });
    if (!emp) return { employee: null };
    const today = todayIST();
    const [records, shift, upcoming] = await Promise.all([
      ctx.db.staffAttendance.findMany({ where: { employeeId: emp.id, date: { gte: dateOnly(addDays(today, -30)) } }, orderBy: { date: "desc" } }),
      shiftFor(ctx.db, emp.id, today),
      ctx.db.shiftAssignment.findMany({ where: { employeeId: emp.id, date: { gte: dateOnly(today), lte: dateOnly(addDays(today, 6)) } }, include: { shift: true }, orderBy: { date: "asc" } }),
    ]);
    return {
      employee: employeeOut(emp),
      today: records.find((r) => fromDateOnly(r.date) === today) ?? null,
      todayShift: shift,
      upcoming: upcoming.map((u) => ({ date: fromDateOnly(u.date), shift: u.shift })),
      history: records.map((r) => ({ ...r, date: fromDateOnly(r.date) })),
    };
  },
});

for (const action of ["in", "out"] as const) {
  route({
    method: "POST", path: `/:product/staff/attendance/check-${action}`, tag: "attendance",
    summary: action === "in" ? "Check in (self)" : "Check out (self)", auth: ATT_SELF,
    handler: async (ctx) => {
      const emp = await ctx.db.employeeProfile.findFirst({ where: { userId: ctx.user.id, tenantId: ctx.tenantId, status: "ACTIVE" } });
      if (!emp) throw badRequest("Your login is not linked to an employee record. Ask your manager.");
      return checkInOut(ctx, emp.id, action, "SELF");
    },
  });
}

route({
  method: "GET", path: "/:product/staff/attendance", tag: "attendance", summary: "Daily attendance sheet", auth: ATT_MANAGE,
  query: z.object({ date: isoDate.optional() }),
  handler: async (ctx) => {
    const date = ctx.query.date ?? todayIST();
    const [emps, records, assigns] = await Promise.all([
      ctx.db.employeeProfile.findMany({ where: { ...inProduct(ctx), status: "ACTIVE" }, orderBy: { fullName: "asc" } }),
      ctx.db.staffAttendance.findMany({ where: { tenantId: ctx.tenantId, date: dateOnly(date) } }),
      ctx.db.shiftAssignment.findMany({ where: { tenantId: ctx.tenantId, date: dateOnly(date) }, include: { shift: true } }),
    ]);
    const rows = emps.map((e) => ({
      employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, designation: e.designation, photoUrl: fileUrl(e.photoKey) },
      shift: assigns.find((a) => a.employeeId === e.id)?.shift ?? null,
      record: records.find((r) => r.employeeId === e.id) ?? null,
    }));
    const count = (s: string) => rows.filter((r) => r.record?.status === s).length;
    return {
      date, rows,
      summary: {
        total: rows.length, present: count("PRESENT"), late: count("LATE"), halfDay: count("HALF_DAY"),
        absent: count("ABSENT"), onLeave: count("ON_LEAVE"), notMarked: rows.filter((r) => !r.record).length,
      },
    };
  },
});

route({
  method: "POST", path: "/:product/staff/attendance/mark", tag: "attendance", summary: "Mark or correct attendance (manager)", auth: ATT_MANAGE,
  body: z.object({
    employeeId: z.uuid(), date: isoDate,
    status: z.enum(["PRESENT", "LATE", "HALF_DAY", "ABSENT", "ON_LEAVE"]),
    checkIn: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    checkOut: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    notes: z.string().max(200).optional(),
  }),
  handler: async (ctx) => {
    const emp = await loadEmployee(ctx, ctx.body.employeeId);
    const at = (hhmm?: string | null) => (hhmm ? new Date(startOfDayIST(ctx.body.date).getTime() + hhmmToMinutes(hhmm) * 60_000) : null);
    const checkInAt = at(ctx.body.checkIn);
    const checkOutAt = at(ctx.body.checkOut);
    if (checkInAt && checkOutAt && checkOutAt < checkInAt) throw badRequest("Check-out must be after check-in.");
    const shift = await shiftFor(ctx.db, emp.id, ctx.body.date);
    const lateMinutes = shift && checkInAt ? Math.max(0, istMinutes(checkInAt) - hhmmToMinutes(shift.startTime)) : 0;
    const data = {
      status: ctx.body.status, checkInAt, checkOutAt, notes: ctx.body.notes ?? null, source: "MANAGER",
      lateMinutes: ctx.body.status === "LATE" ? lateMinutes : 0,
      workedMinutes: checkInAt && checkOutAt ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000) : 0,
      shiftId: shift?.id ?? null, productCode: ctx.product,
    };
    const row = await ctx.db.staffAttendance.upsert({
      where: { employeeId_date: { employeeId: emp.id, date: dateOnly(ctx.body.date) } },
      create: { ...data, tenantId: ctx.tenantId, employeeId: emp.id, date: dateOnly(ctx.body.date), branchId: ctx.branchId || null },
      update: data,
    });
    await ctx.audit("attendance.mark", { type: "employee", id: emp.id }, { date: ctx.body.date, status: ctx.body.status });
    return row;
  },
});

route({
  method: "GET", path: "/:product/staff/attendance/report", tag: "attendance", summary: "Monthly attendance report (late arrivals, working hours)", auth: ATT_MANAGE,
  query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
  handler: async (ctx) => {
    const month = ctx.query.month ?? todayIST().slice(0, 7);
    const from = `${month}-01`;
    const to = endOfMonth(from);
    const [emps, records] = await Promise.all([
      ctx.db.employeeProfile.findMany({ where: { ...inProduct(ctx) }, orderBy: { fullName: "asc" } }),
      ctx.db.staffAttendance.findMany({ where: { tenantId: ctx.tenantId, date: { gte: dateOnly(from), lte: dateOnly(to) } } }),
    ]);
    const dates = eachDate(from, to);
    const rows = emps.map((e) => {
      const mine = records.filter((r) => r.employeeId === e.id);
      const c = (s: string) => mine.filter((r) => r.status === s).length;
      return {
        employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, designation: e.designation, status: e.status },
        present: c("PRESENT"), late: c("LATE"), halfDay: c("HALF_DAY"), absent: c("ABSENT"), onLeave: c("ON_LEAVE"),
        lateMinutes: mine.reduce((a, r) => a + r.lateMinutes, 0),
        workedMinutes: mine.reduce((a, r) => a + r.workedMinutes, 0),
        days: Object.fromEntries(mine.map((r) => [fromDateOnly(r.date), r.status])),
      };
    });
    return { month, dates, rows, prevMonth: addMonths(from, -1).slice(0, 7), nextMonth: addMonths(from, 1).slice(0, 7) };
  },
});

// ---------------------------------------------------------------------------
// ID cards & QR verification
// ---------------------------------------------------------------------------

async function cardData(ctx: Ctx, cards: { cardNumber: string; validUntil: Date; employee: any }[]): Promise<CardData[]> {
  const business = await ctx.db.business.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
  // Cards wear the shop's own colour (taken from its logo); SAF colour only when there is no usable logo.
  const logo = business.logoKey ? await storage().get(business.logoKey) : null;
  const brandHex = (logo && brandHexFromLogo(logo.body, logo.contentType)) || PRODUCTS[ctx.product].theme.brand;
  return cards.map((c) => ({
    businessName: business.name, businessPhone: business.phone, businessAddress: [business.address, business.city].filter(Boolean).join(", ") || null,
    logoKey: business.logoKey, brandHex,
    employeeName: c.employee.fullName, employeeCode: c.employee.employeeCode, designation: c.employee.designation,
    department: c.employee.department, bloodGroup: c.employee.bloodGroup, photoKey: c.employee.photoKey,
    cardNumber: c.cardNumber, validUntil: c.validUntil, verifyUrl: verifyUrl(c.employee.qrToken),
  }));
}

route({
  method: "GET", path: "/:product/staff/id-cards", tag: "id-cards", summary: "Issued ID cards", auth: CARDS,
  handler: async (ctx) => {
    const cards = await ctx.db.employeeIdCard.findMany({
      where: { tenantId: ctx.tenantId, employee: { productCodes: { has: ctx.product } } },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true, designation: true, photoKey: true, status: true } } },
      orderBy: { issuedAt: "desc" },
    });
    return { items: cards.map((c) => ({ ...c, employee: { ...c.employee, photoUrl: fileUrl(c.employee.photoKey) } })) };
  },
});

route({
  method: "POST", path: "/:product/staff/id-cards", tag: "id-cards",
  summary: "Issue (or re-issue) ID cards. Re-issuing rotates the QR so lost cards stop verifying.", auth: CARDS,
  body: z.object({ employeeIds: z.array(z.uuid()).min(1).max(200), validMonths: z.number().int().min(1).max(60).default(12) }),
  handler: async (ctx) => {
    const emps = await ctx.db.employeeProfile.findMany({ where: { id: { in: ctx.body.employeeIds }, ...inProduct(ctx), status: "ACTIVE" } });
    if (emps.length !== ctx.body.employeeIds.length) throw badRequest("Some employees were not found or are inactive.");
    const validUntil = startOfDayIST(addMonths(todayIST(), ctx.body.validMonths));
    const issued = [];
    for (const e of emps) {
      const hadCard = await ctx.db.employeeIdCard.count({ where: { employeeId: e.id } });
      await ctx.db.employeeIdCard.updateMany({ where: { employeeId: e.id, status: "ACTIVE" }, data: { status: "REVOKED" } });
      if (hadCard) await ctx.db.employeeProfile.update({ where: { id: e.id }, data: { qrToken: token(18) } });
      const seq = await nextSeq(ctx.db, ctx.tenantId, "id-card");
      issued.push(await ctx.db.employeeIdCard.create({
        data: {
          tenantId: ctx.tenantId, employeeId: e.id, cardNumber: `${ctx.user.tenantCode}-ID-${String(seq).padStart(5, "0")}`,
          validUntil, issuedById: ctx.user.id, productCode: ctx.product,
        },
      }));
    }
    await ctx.audit("staff.id_cards.issue", { type: "employee" }, { count: issued.length });
    ctx.status = 201;
    return { items: issued };
  },
});

route({
  method: "POST", path: "/:product/staff/id-cards/:id/revoke", tag: "id-cards", summary: "Revoke an ID card", auth: CARDS,
  handler: async (ctx) => {
    const c = await ctx.db.employeeIdCard.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!c) throw notFound("ID card");
    await ctx.db.employeeIdCard.update({ where: { id: c.id }, data: { status: "REVOKED" } });
    await ctx.db.employeeProfile.update({ where: { id: c.employeeId }, data: { qrToken: token(18) } });
    return { ok: true };
  },
});

route({
  method: "GET", path: "/:product/staff/id-cards/pdf", tag: "id-cards", summary: "Download printable ID card PDF (one card, or 9 per A4 sheet)", auth: CARDS,
  query: z.object({ cardIds: z.string().min(1).max(8000) }),
  handler: async (ctx) => {
    const ids = ctx.query.cardIds.split(",").filter(Boolean);
    const cards = await ctx.db.employeeIdCard.findMany({
      where: { id: { in: ids }, tenantId: ctx.tenantId, status: "ACTIVE" }, include: { employee: true }, orderBy: { cardNumber: "asc" },
    });
    if (!cards.length) throw notFound("Active ID card");
    const pdf = await renderIdCards(await cardData(ctx, cards));
    return new Response(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${cards.length === 1 ? cards[0].cardNumber : "id-cards"}.pdf"`,
        "cache-control": "no-store",
      },
    });
  },
});

async function verificationView(db: Tx, qrToken: string) {
  const e = await db.employeeProfile.findUnique({
    where: { qrToken },
    include: {
      tenant: { include: { business: true } },
      idCards: { where: { status: "ACTIVE" }, orderBy: { issuedAt: "desc" }, take: 1 },
    },
  });
  if (!e) return null;
  const card = e.idCards[0] ?? null;
  const valid = e.status === "ACTIVE" && e.tenant.status === "ACTIVE" && !!card && card.validUntil > new Date();
  return { e, card, valid };
}

route({
  method: "GET", path: "/:product/staff/verify/:token", tag: "id-cards", summary: "Verify a staff QR code (in-app, full details)", auth: VERIFY,
  handler: async (ctx) => {
    const tokenValue = ctx.params.token.split("/").pop()!;
    const e = await ctx.db.employeeProfile.findFirst({ where: { qrToken: tokenValue, tenantId: ctx.tenantId }, include: { idCards: { where: { status: "ACTIVE" }, take: 1 } } });
    if (!e) return { valid: false, reason: "Unknown or revoked QR code for this business." };
    const today = await ctx.db.staffAttendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOnly(todayIST()) } } });
    const card = e.idCards[0] ?? null;
    return {
      valid: e.status === "ACTIVE" && !!card && card.validUntil > new Date(),
      reason: e.status !== "ACTIVE" ? "Employee is inactive." : !card ? "No active ID card." : card.validUntil <= new Date() ? "ID card has expired." : null,
      employee: employeeOut(e), card, today, worksInThisProduct: e.productCodes.includes(ctx.product),
    };
  },
});

route({
  method: "POST", path: "/:product/staff/attendance/qr", tag: "attendance", summary: "Check a staff member in/out by scanning their ID card QR",
  auth: { product: ":product", feature: ["qr_verification"], permission: "attendance.manage" },
  body: z.object({ token: z.string().min(10).max(300), action: z.enum(["in", "out", "auto"]).default("auto") }),
  handler: async (ctx) => {
    const tokenValue = ctx.body.token.split("/").pop()!;
    const e = await ctx.db.employeeProfile.findFirst({ where: { qrToken: tokenValue, ...inProduct(ctx), status: "ACTIVE" } });
    if (!e) throw notFound("Active employee for this QR code");
    const r = await checkInOut(ctx, e.id, ctx.body.action, "QR");
    return { ...r, employee: employeeOut(e) };
  },
});

route({
  method: "GET", path: "/public/verify/:token", tag: "public", summary: "Public staff ID verification (scanned from the card)",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) =>
    withPlatform(async (db) => {
      const v = await verificationView(db, ctx.params.token);
      if (!v) return { valid: false, reason: "This QR code is not recognised. The card may have been revoked." };
      const { e, card, valid } = v;
      return {
        valid,
        reason: valid ? null : e.status !== "ACTIVE" ? "This employee is no longer active." : !card ? "No active ID card." : "This ID card has expired.",
        business: { name: e.tenant.business?.name ?? e.tenant.code, logoUrl: fileUrl(e.tenant.business?.logoKey), phone: e.tenant.business?.phone },
        employee: { fullName: e.fullName, designation: e.designation, department: e.department, employeeCode: e.employeeCode, photoUrl: fileUrl(e.photoKey) },
        card: card ? { cardNumber: card.cardNumber, validUntil: card.validUntil } : null,
      };
    }),
});

export type { ProductCode };
