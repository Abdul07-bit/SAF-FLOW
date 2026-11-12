import { describe, expect, it } from "vitest";
import { addDays, todayIST } from "@/lib/dates";
import { api, createBusiness, createStaff, expectError } from "../helpers";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function imageForm(bytes: Uint8Array, name = "photo.png") {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name, { type: "image/png" }));
  return fd;
}

describe("Growth staff management", () => {
  it("employee database, shifts, attendance and reports", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "GROWTH" }]);
    const cashier = await createStaff(biz.manager, "bill", "anu", [{ product: "bill", roleCode: "cashier" }]);
    const today = todayIST();

    // Not linked to an employee record yet
    expectError(await api("POST", "/bill/staff/attendance/check-in", { cookie: cashier.cookie }), 400);

    const emp = await api("POST", "/bill/staff/employees", { cookie: biz.manager, body: { fullName: "Anu Thomas", designation: "Cashier", phone: "9800000001", bloodGroup: "O+", userId: cashier.id, dateOfJoining: today } });
    expect(emp.status, JSON.stringify(emp.body)).toBe(201);
    expect(emp.body.employeeCode).toBe(`${biz.code}-E0001`);
    const other = await api("POST", "/bill/staff/employees", { cookie: biz.manager, body: { fullName: "Binu Mathew", designation: "Storekeeper" } });

    // A login can be linked to one employee only
    expectError(await api("PATCH", `/bill/staff/employees/${other.body.id}`, { cookie: biz.manager, body: { userId: cashier.id } }), 409);

    // Self check-in / check-out
    const cin = await api("POST", "/bill/staff/attendance/check-in", { cookie: cashier.cookie });
    expect(cin.status, JSON.stringify(cin.body)).toBe(200);
    expect(cin.body.record.status).toBe("PRESENT");
    expectError(await api("POST", "/bill/staff/attendance/check-in", { cookie: cashier.cookie }), 409);
    const cout = await api("POST", "/bill/staff/attendance/check-out", { cookie: cashier.cookie });
    expect(cout.body.record.checkOutAt).toBeTruthy();
    expectError(await api("POST", "/bill/staff/attendance/check-out", { cookie: cashier.cookie }), 409);
    const mine = await api("GET", "/bill/staff/attendance/me", { cookie: cashier.cookie });
    expect(mine.body.today.checkInAt).toBeTruthy();

    // Shift + roster, then a manager correction that is 30 minutes late
    const shift = await api("POST", "/bill/staff/shifts", { cookie: biz.manager, body: { name: "Morning", startTime: "09:00", endTime: "17:00", graceMinutes: 10 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const yesterday = addDays(today, -1);
    const roster = await api("PUT", "/bill/staff/roster", { cookie: biz.manager, body: { assignments: [{ employeeId: other.body.id, date: yesterday, shiftId: shift.body.id }] } });
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    const mark = await api("POST", "/bill/staff/attendance/mark", { cookie: biz.manager, body: { employeeId: other.body.id, date: yesterday, status: "LATE", checkIn: "09:30", checkOut: "17:30" } });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    expect(mark.body).toMatchObject({ lateMinutes: 30, workedMinutes: 480, status: "LATE" });

    const sheet = await api("GET", `/bill/staff/attendance?date=${yesterday}`, { cookie: biz.manager });
    expect(sheet.body.summary).toMatchObject({ total: 2, late: 1, notMarked: 1 });
    const report = await api("GET", `/bill/staff/attendance/report?month=${yesterday.slice(0, 7)}`, { cookie: biz.manager });
    const row = report.body.rows.find((r: any) => r.employee.id === other.body.id);
    expect(row).toMatchObject({ late: 1, lateMinutes: 30, workedMinutes: 480 });

    // Staff cannot see the attendance sheet of others
    expectError(await api("GET", "/bill/staff/attendance", { cookie: cashier.cookie }), 403, "PERMISSION_DENIED");
  });

  it("ID cards: photo upload, PDF, QR verification, re-issue invalidates the old card", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const emp = await api("POST", "/dine/staff/employees", { cookie: biz.manager, body: { fullName: "Chef Kiran", designation: "Head Chef", department: "Kitchen", bloodGroup: "B+" } });

    // Only real PNG/JPEG files are accepted
    expectError(await api("POST", `/dine/staff/employees/${emp.body.id}/photo`, { cookie: biz.manager, body: imageForm(new TextEncoder().encode("<script>alert(1)</script>"), "x.png") }), 400);
    const photo = await api("POST", `/dine/staff/employees/${emp.body.id}/photo`, { cookie: biz.manager, body: imageForm(PNG_1PX) });
    expect(photo.status, JSON.stringify(photo.body)).toBe(200);
    const served = await api("GET", photo.body.photoUrl.replace(/^\/api/, ""));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expectError(await api("GET", "/files/t/../../.env"), 404);

    const issued = await api("POST", "/dine/staff/id-cards", { cookie: biz.manager, body: { employeeIds: [emp.body.id] } });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const card = issued.body.items[0];
    expect(card.cardNumber).toBe(`${biz.code}-ID-00001`);

    const pdf = await api("GET", `/dine/staff/id-cards/pdf?cardIds=${card.id}`, { cookie: biz.manager });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(pdf.body as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.body as Uint8Array).length).toBeGreaterThan(2000);

    const token1 = (await api("GET", "/dine/staff/employees", { cookie: biz.manager })).body.items[0].qrToken;
    const pub = await api("GET", `/public/verify/${token1}`);
    expect(pub.body).toMatchObject({ valid: true, employee: { fullName: "Chef Kiran", designation: "Head Chef" } });
    // The public page exposes no contact details
    expect(JSON.stringify(pub.body)).not.toContain("bloodGroup");

    // In-app verification and QR attendance
    const inApp = await api("GET", `/dine/staff/verify/${token1}`, { cookie: biz.manager });
    expect(inApp.body.valid).toBe(true);
    const qr = await api("POST", "/dine/staff/attendance/qr", { cookie: biz.manager, body: { token: `http://localhost:3000/verify/${token1}` } });
    expect(qr.body.action).toBe("in");
    expect((await api("POST", "/dine/staff/attendance/qr", { cookie: biz.manager, body: { token: token1 } })).body.action).toBe("out");

    // Re-issue rotates the QR: the old card no longer verifies
    await api("POST", "/dine/staff/id-cards", { cookie: biz.manager, body: { employeeIds: [emp.body.id] } });
    expect((await api("GET", `/public/verify/${token1}`)).body.valid).toBe(false);
    const token2 = (await api("GET", "/dine/staff/employees", { cookie: biz.manager })).body.items[0].qrToken;
    expect(token2).not.toBe(token1);
    expect((await api("GET", `/public/verify/${token2}`)).body.valid).toBe(true);

    // Deactivating the employee revokes the card
    await api("POST", `/dine/staff/employees/${emp.body.id}/status`, { cookie: biz.manager, body: { status: "INACTIVE" } });
    expect((await api("GET", `/public/verify/${token2}`)).body.valid).toBe(false);
  });

  it("attendance and ID cards are entitled independently per product", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "GROWTH" }, { productCode: "dine", tier: "BASIC" }]);
    expect((await api("GET", "/stay/staff/employees", { cookie: biz.manager })).status).toBe(200);
    expectError(await api("GET", "/dine/staff/employees", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
    // Revoke only ID cards on Stay: attendance keeps working
    await api("PUT", `/admin/businesses/${biz.tenantId}/features/stay.id_cards`, { cookie: biz.admin, body: { mode: "revoke" } });
    expectError(await api("GET", "/stay/staff/id-cards", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
    expect((await api("GET", "/stay/staff/attendance", { cookie: biz.manager })).status).toBe(200);
    // Grant only attendance on Dine Basic
    await api("PUT", `/admin/businesses/${biz.tenantId}/features/dine.attendance`, { cookie: biz.admin, body: { mode: "grant" } });
    expect((await api("GET", "/dine/staff/attendance", { cookie: biz.manager })).status).toBe(200);
    expectError(await api("GET", "/dine/staff/id-cards", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
  });

  it("managers manage logins: reset password, change role, disable", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const w = await createStaff(biz.manager, "dine", "ravi", [{ product: "dine", roleCode: "waiter" }]);
    expect(w.username).toBe(`${biz.code}@ravi`);
    expectError(await api("POST", "/dine/team", { cookie: biz.manager, body: { fullName: "Dup", handle: "ravi", access: [{ product: "dine", roleCode: "waiter" }] } }), 409);

    // As a waiter the cashier board is off limits; after the role change it opens
    expectError(await api("GET", "/dine/cashier/board", { cookie: w.cookie }), 403, "PERMISSION_DENIED");
    await api("PATCH", `/dine/team/${w.id}`, { cookie: biz.manager, body: { access: [{ product: "dine", roleCode: "cashier" }] } });
    expect((await api("GET", "/dine/cashier/board", { cookie: w.cookie })).status).toBe(200);
    expectError(await api("GET", "/dine/kitchen/tickets", { cookie: w.cookie }), 403, "PERMISSION_DENIED");

    const reset = await api("POST", `/dine/team/${w.id}/reset-password`, { cookie: biz.manager });
    expect(reset.body.temporaryPassword).toHaveLength(12);
    expectError(await api("GET", "/me", { cookie: w.cookie }), 401); // old sessions revoked

    await api("POST", `/dine/team/${w.id}/status`, { cookie: biz.manager, body: { isActive: false } });
    expectError(await api("POST", "/auth/login", { body: { username: w.username, password: reset.body.temporaryPassword } }), 403, "ACCOUNT_DISABLED");
    // A non-owner cannot touch the owner account; nobody can disable themselves
    const team = await api("GET", "/dine/team", { cookie: biz.manager });
    const owner = team.body.items.find((u: any) => u.isTenantOwner);
    expectError(await api("POST", `/dine/team/${owner.id}/status`, { cookie: biz.manager, body: { isActive: false } }), 400);
  });
});
