import { describe, expect, it } from "vitest";
import { addDays, todayIST } from "@/lib/dates";
import { api, createBusiness, createStaff, expectError } from "../helpers";

const guest = (n: string) => ({ fullName: `Guest ${n}`, phone: "9812345678", idType: "AADHAAR", idNumber: "1234 5678 9012" });

async function setupRooms(cookie: string, numbers: string[]) {
  const type = await api("POST", "/stay/room-types", { cookie, body: { name: "Deluxe", baseRate: 300000, maxAdults: 2, maxChildren: 1, amenities: ["AC", "WiFi"] } });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  const rooms = [];
  for (const number of numbers) {
    const r = await api("POST", "/stay/rooms", { cookie, body: { number, roomTypeId: type.body.id, floor: "1" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rooms.push(r.body);
  }
  return { type: type.body, rooms };
}

describe("SAF Stay Flow (Basic)", () => {
  it("walk-in -> check-in -> folio -> check-out -> invoice; rooms cannot be double-booked", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "BASIC" }]);
    const { type, rooms } = await setupRooms(biz.manager, ["101", "102"]);
    const today = todayIST();

    const res = await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: {
        guest: guest("One"), roomTypeId: type.id, roomId: rooms[0].id, checkInDate: today, checkOutDate: addDays(today, 2),
        adults: 2, advance: { amount: 100000, method: "UPI" }, checkInNow: true,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("CHECKED_IN");
    expect(res.body.room.number).toBe("101");

    // Same room, overlapping dates -> database exclusion constraint refuses it
    const clash = await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: { guest: guest("Two"), roomTypeId: type.id, roomId: rooms[0].id, checkInDate: addDays(today, 1), checkOutDate: addDays(today, 3) },
    });
    expectError(clash, 409, "ROOM_ALREADY_BOOKED");
    // Second room is fine; a third booking for the category is not
    const second = await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: { guest: guest("Two"), roomTypeId: type.id, checkInDate: addDays(today, 1), checkOutDate: addDays(today, 3) },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const third = await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: { guest: guest("Three"), roomTypeId: type.id, checkInDate: addDays(today, 1), checkOutDate: addDays(today, 2) },
    });
    expectError(third, 409, "NO_AVAILABILITY");
    // Occupancy limits of the category are enforced
    expectError(await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: { guest: guest("Big"), roomTypeId: type.id, checkInDate: addDays(today, 10), checkOutDate: addDays(today, 11), adults: 5 },
    }), 400);

    // Front desk and room grid
    const fd = await api("GET", "/stay/front-desk", { cookie: biz.manager });
    expect(fd.body.inHouse).toHaveLength(1);
    expect(fd.body.rooms.find((r: any) => r.number === "101").status).toBe("OCCUPIED");

    // Folio: projected room charge for 2 nights + posted food charge
    await api("POST", `/stay/reservations/${res.body.id}/charges`, { cookie: biz.manager, body: { type: "FOOD", description: "Dinner", amount: 50000, taxRate: 500 } });
    const before = await api("GET", `/stay/reservations/${res.body.id}`, { cookie: biz.manager });
    expect(before.body.folio.total).toBe(600000 + 72000 + 50000 + 2500);
    expect(before.body.folio.paid).toBe(100000);

    // Early departure today bills one night: 3000 + 12% + 500 + 5% - 1000 advance = 2885.00 due
    expectError(await api("POST", `/stay/reservations/${res.body.id}/check-out`, { cookie: biz.manager, body: {} }), 402, "BALANCE_DUE");
    // The failed attempt rolled back completely
    expect((await api("GET", `/stay/reservations/${res.body.id}`, { cookie: biz.manager })).body.status).toBe("CHECKED_IN");
    const out = await api("POST", `/stay/reservations/${res.body.id}/check-out`, { cookie: biz.manager, body: { payment: { amount: 288500, method: "CARD" } } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.status).toBe("CHECKED_OUT");
    expect(out.body.folio).toMatchObject({ total: 388500, paid: 388500, balance: 0, nights: 1 });
    expect(out.body.invoiceNo).toMatch(/^SF\/\d{4}-\d{2}\/\d{5}$/);

    // Room is free again but dirty; a receptionist cannot check a guest into a dirty room
    const room = await api("GET", `/stay/rooms/${rooms[0].id}`, { cookie: biz.manager });
    expect(room.body).toMatchObject({ status: "AVAILABLE", hkStatus: "DIRTY" });

    const inv = await api("GET", `/public/invoice/stay/${out.body.publicToken}`);
    expect(inv.status).toBe(200);
    expect(inv.body.total).toBe(388500);
    expect((await api("GET", "/stay/invoices", { cookie: biz.manager })).body.items).toHaveLength(1);
    expect((await api("GET", "/stay/reports/occupancy", { cookie: biz.manager })).status).toBe(200);
  });

  it("role dashboards: housekeeping updates room status only; Growth modules are locked", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "BASIC" }]);
    const { rooms } = await setupRooms(biz.manager, ["11"]);
    const hk = await createStaff(biz.manager, "stay", "hk1", [{ product: "stay", roleCode: "housekeeping" }]);
    const rec = await createStaff(biz.manager, "stay", "rec1", [{ product: "stay", roleCode: "receptionist" }]);
    expect((await api("GET", "/stay/housekeeping", { cookie: hk.cookie })).status).toBe(200);
    expect((await api("POST", `/stay/rooms/${rooms[0].id}/hk-status`, { cookie: hk.cookie, body: { hkStatus: "DIRTY" } })).status).toBe(200);
    expectError(await api("GET", "/stay/front-desk", { cookie: hk.cookie }), 403, "PERMISSION_DENIED");
    expectError(await api("GET", "/stay/cashier", { cookie: hk.cookie }), 403, "PERMISSION_DENIED");
    expect((await api("GET", "/stay/front-desk", { cookie: rec.cookie })).status).toBe(200);
    expectError(await api("POST", "/stay/room-types", { cookie: rec.cookie, body: { name: "X", baseRate: 1 } }), 403, "PERMISSION_DENIED");
    for (const p of ["/stay/hk-tasks", "/stay/maintenance", "/stay/analytics", "/stay/reports/revenue", "/stay/reports/operations", "/stay/branches"])
      expectError(await api("GET", p, { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
  });
});

describe("SAF Stay Flow (Growth)", () => {
  it("check-out raises a housekeeping task; maintenance takes a room out of order; reports work", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "GROWTH" }]);
    const { type, rooms } = await setupRooms(biz.manager, ["201", "202"]);
    const hk = await createStaff(biz.manager, "stay", "hk1", [{ product: "stay", roleCode: "housekeeping" }]);
    const today = todayIST();

    const res = await api("POST", "/stay/reservations", {
      cookie: biz.manager,
      body: { guest: guest("G"), roomTypeId: type.id, roomId: rooms[0].id, checkInDate: today, checkOutDate: addDays(today, 1), checkInNow: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const due = (await api("GET", `/stay/reservations/${res.body.id}`, { cookie: biz.manager })).body.folio.balance;
    expect(due).toBe(336000);
    expect((await api("POST", `/stay/reservations/${res.body.id}/check-out`, { cookie: biz.manager, body: { payment: { amount: due, method: "CASH" } } })).status).toBe(200);

    // Housekeeping picks up the auto-created task and finishes it
    const tasks = await api("GET", "/stay/hk-tasks", { cookie: hk.cookie });
    expect(tasks.body.items).toHaveLength(1);
    const task = tasks.body.items[0];
    expect(task).toMatchObject({ type: "CHECKOUT_CLEAN", priority: "HIGH" });
    expect((await api("POST", `/stay/hk-tasks/${task.id}/status`, { cookie: hk.cookie, body: { status: "IN_PROGRESS" } })).status).toBe(200);
    expect((await api("GET", `/stay/rooms/${rooms[0].id}`, { cookie: biz.manager })).body.hkStatus).toBe("IN_PROGRESS");
    expectError(await api("POST", `/stay/hk-tasks/${task.id}/status`, { cookie: hk.cookie, body: { status: "CANCELLED" } }), 403);
    expect((await api("POST", `/stay/hk-tasks/${task.id}/status`, { cookie: hk.cookie, body: { status: "DONE" } })).status).toBe(200);
    expect((await api("GET", `/stay/rooms/${rooms[0].id}`, { cookie: biz.manager })).body.hkStatus).toBe("CLEAN");

    // Maintenance
    const job = await api("POST", "/stay/maintenance", { cookie: hk.cookie, body: { roomId: rooms[1].id, title: "AC not cooling", priority: "HIGH", roomOutOfOrder: true } });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect((await api("GET", `/stay/rooms/${rooms[1].id}`, { cookie: biz.manager })).body.status).toBe("OUT_OF_ORDER");
    const free = await api("GET", `/stay/availability/rooms?checkIn=${addDays(today, 5)}&checkOut=${addDays(today, 6)}`, { cookie: biz.manager });
    expect(free.body.items.map((r: any) => r.number)).toEqual(["201"]);
    expect((await api("PATCH", `/stay/maintenance/${job.body.id}`, { cookie: biz.manager, body: { status: "RESOLVED", cost: 150000, resolution: "Gas refilled" } })).status).toBe(200);
    expect((await api("GET", `/stay/rooms/${rooms[1].id}`, { cookie: biz.manager })).body.status).toBe("AVAILABLE");

    const analytics = await api("GET", "/stay/analytics", { cookie: biz.manager });
    expect(analytics.status).toBe(200);
    expect(analytics.body.kpis.roomRevenue).toBe(300000);
    expect(analytics.body.kpis.adr).toBe(300000);
    const revenue = await api("GET", "/stay/reports/revenue", { cookie: biz.manager });
    expect(revenue.body.totals).toMatchObject({ revenue: 300000, collected: 336000 });
    const ops = await api("GET", "/stay/reports/operations", { cookie: biz.manager });
    expect(ops.body.housekeeping.completed).toBe(1);
    expect(ops.body.maintenance.totalCost).toBe(150000);

    // Multiple branches (Growth): data is scoped per branch
    const branch = await api("POST", "/stay/branches", { cookie: biz.manager, body: { name: "Beach Wing", code: "bw" } });
    expect(branch.status, JSON.stringify(branch.body)).toBe(201);
    const other = await api("GET", "/stay/rooms", { cookie: biz.manager, headers: { "x-saf-branch": branch.body.id } });
    expect(other.body.items).toHaveLength(0);
  });
});
