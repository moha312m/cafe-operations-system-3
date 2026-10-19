// OPS-003 — the shift close report, and sending it to the owner on WhatsApp.
//
//   • /api/shifts/[id]/report (and /reports/shift/[id]) build the report from
//     committed rows only, once the money is settled; same reach as the
//     shift detail.
//   • The WhatsApp Business token is write-only: sealed on the way in, never
//     in a response, an audit row or an error message.
//   • A close sends the report AFTER responding, at most once per shift; a
//     WhatsApp failure is logged and audited and never fails the close.
//
// The Graph API is a local mock on :3199 — the test server is started with
// WHATSAPP_GRAPH_BASE_URL pointing at it, so no real message is ever sent.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
let mock: Server;
const MOCK_PORT = 3199;
const TOKEN = `EAATEST${"x".repeat(12)}${Date.now()}`;
const PHONE_NUMBER_ID = "109876543210987";

type Captured = { url: string; auth: string | undefined; body: {
  to: string; type: string;
  template: { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text: string }[] }[] };
} };
const captured: Captured[] = [];
let respond: { status: number; body: unknown } = { status: 200, body: { messages: [{ id: "wamid.TEST1" }] } };

let seq = 0;
async function settledShift(opening = 100) {
  seq += 1;
  return db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id,
      shiftNumber: 47000 + seq, openingCashAmount: opening, expectedCashAmount: opening,
    },
  });
}

const closeShift = (shiftId: string, actualCashAmount = 100) =>
  as(fx.cashier.email, `/api/shifts/${shiftId}/close`, {
    method: "POST",
    body: JSON.stringify({ actualCashAmount, reason: "test" }),
  });

const patch = (email: string, body: unknown) =>
  as<Record<string, unknown>>(email, "/api/cafe/whatsapp", { method: "PATCH", body: JSON.stringify(body) });

async function waitForLog(shiftId: string, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const log = await db.whatsAppMessageLog.findFirst({ where: { shiftId }, orderBy: { createdAt: "desc" } });
    if (log) return log;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

before(async () => {
  await requireServer();
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(respond.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));
  fx = await countCafe("OPS003");
  // No stock handover, so a close settles straight to CLOSED.
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "NO_SHIFT_COUNT" } });
});

after(async () => {
  await new Promise<void>((resolve) => mock?.close(() => resolve()));
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  captured.length = 0;
  respond = { status: 200, body: { messages: [{ id: "wamid.TEST1" }] } };
  await db.shift.deleteMany({ where: { cafeId: fx.cafeId, status: "OPEN" } });
});

describe("OPS-003 WhatsApp settings", () => {
  test("owner only; enabling needs every field; the token never comes back", async () => {
    assert.equal((await as(fx.cashier.email, "/api/cafe/whatsapp")).status, 403);
    assert.equal((await as(fx.manager.email, "/api/cafe/whatsapp")).status, 403);

    const incomplete = await patch(fx.owner.email, { enabled: true, phoneNumberId: PHONE_NUMBER_ID });
    assert.equal(incomplete.status, 400, incomplete.text);
    assert.equal(await db.whatsAppIntegration.count({ where: { cafeId: fx.cafeId } }), 0, "a refusal stores nothing");

    const r = await patch(fx.owner.email, {
      enabled: true, phoneNumberId: PHONE_NUMBER_ID, accessToken: TOKEN,
      templateName: "shift_close_report", templateLanguage: "ar", recipientPhone: "01012345678",
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.tokenSet, true);
    assert.equal(r.body.recipientPhone, "201012345678", "Egyptian local numbers become international");
    assert.ok(!r.text.includes(TOKEN), "the token is not in the response");
    assert.ok(!(await as(fx.owner.email, "/api/cafe/whatsapp")).text.includes(TOKEN));

    const row = await db.whatsAppIntegration.findUniqueOrThrow({ where: { cafeId: fx.cafeId } });
    assert.ok(row.accessTokenCipher!.startsWith("v1:"));
    assert.ok(!row.accessTokenCipher!.includes(TOKEN), "stored sealed, not in clear");

    const audits = await db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: "WHATSAPP_SETTINGS_CHANGED" } });
    assert.ok(audits.length >= 1);
    assert.ok(audits.every((a) => !JSON.stringify(a.details).includes(TOKEN)), "the audit names the change, not the token");
    assert.ok(audits.some((a) => (a.details as { changed: string[] }).changed.includes("accessToken")));
  });

  test("refuses unknown keys, bad template names, bad phone numbers", async () => {
    assert.equal((await patch(fx.owner.email, { apiBaseUrl: "http://evil" })).status, 400);
    assert.equal((await patch(fx.owner.email, { templateName: "Bad Name!" })).status, 400);
    assert.equal((await patch(fx.owner.email, { recipientPhone: "12" })).status, 400);
    assert.equal((await patch(fx.owner.email, { phoneNumberId: "../../x" })).status, 400);
  });

  test("the database refuses an enabled connection with missing fields", async () => {
    await assert.rejects(
      db.whatsAppIntegration.update({ where: { cafeId: fx.cafeId }, data: { enabled: true, recipientPhone: null } }),
      /WhatsAppIntegration_enabled_complete/
    );
  });
});

describe("OPS-003 shift report", () => {
  test("409 while open; after the close it reports the committed figures", async () => {
    const shift = await settledShift(100);
    assert.equal((await as(fx.owner.email, `/api/shifts/${shift.id}/report`)).status, 409);

    await db.whatsAppIntegration.update({ where: { cafeId: fx.cafeId }, data: { enabled: false } });
    const closed = await closeShift(shift.id, 90);
    assert.equal(closed.status, 200, closed.text);

    const r = await as<{ report: { shiftNumber: number; cash: { expected: number; actual: number; difference: number }; carried: { count: number } } }>(
      fx.owner.email, `/api/shifts/${shift.id}/report`
    );
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.report.shiftNumber, shift.shiftNumber);
    assert.equal(r.body.report.cash.expected, 100);
    assert.equal(r.body.report.cash.actual, 90);
    assert.equal(r.body.report.cash.difference, -10);
    assert.equal(r.body.report.carried.count, 0);

    const page = await as(fx.owner.email, `/reports/shift/${shift.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`تقرير قفل شيفت #(<!-- -->)?${shift.shiftNumber}`), "the printable page renders");
    assert.match(page.text, /طباعة التقرير/);

    assert.equal((await as(fx.cashier.email, `/api/shifts/${shift.id}/report`)).status, 403, "the counter cannot read the financial report");
    assert.equal((await as(fx.waiter.email, `/api/shifts/${shift.id}/report`)).status, 403);
  });
});

describe("OPS-003 sending on close", () => {
  test("a close sends the report once, after responding, with eight one-line parameters", async () => {
    await db.whatsAppIntegration.update({ where: { cafeId: fx.cafeId }, data: { enabled: true } });
    const shift = await settledShift(100);
    const closed = await closeShift(shift.id, 100);
    assert.equal(closed.status, 200, closed.text);

    const log = await waitForLog(shift.id);
    assert.ok(log, "the attempt is logged");
    assert.equal(log!.status, "SENT");
    assert.equal(log!.trigger, "AUTO");
    assert.equal(log!.providerMessageId, "wamid.TEST1");
    assert.equal(log!.recipientMasked, "2010*****678");

    assert.equal(captured.length, 1);
    const call = captured[0];
    assert.equal(call.url, `/v21.0/${PHONE_NUMBER_ID}/messages`);
    assert.equal(call.auth, `Bearer ${TOKEN}`);
    assert.equal(call.body.to, "201012345678");
    assert.equal(call.body.template.name, "shift_close_report");
    assert.equal(call.body.template.language.code, "ar");
    const params = call.body.template.components[0].parameters.map((p) => p.text);
    assert.equal(params.length, 8);
    assert.ok(params.every((p) => p.length > 0 && !/[\n\t]| {5,}/.test(p)), "WhatsApp refuses newlines, tabs and long space runs");
    assert.ok(params[1].includes(`#${shift.shiftNumber}`));
    assert.equal(params[7], `http://localhost:3100/reports/shift/${shift.id}`);

    const audit = await db.auditLog.findFirst({ where: { cafeId: fx.cafeId, action: "WHATSAPP_SHIFT_REPORT_SENT", entityId: shift.id } });
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit!.details).includes(TOKEN));
  });

  test("a WhatsApp refusal is logged with the token scrubbed and does not fail the close", async () => {
    respond = { status: 400, body: { error: { code: 132001, message: `Template does not exist (token ${TOKEN})` } } };
    const shift = await settledShift(100);
    const closed = await closeShift(shift.id, 100);
    assert.equal(closed.status, 200, "the close stands");
    const log = await waitForLog(shift.id);
    assert.equal(log?.status, "FAILED");
    assert.match(log!.error!, /132001/);
    assert.ok(!log!.error!.includes(TOKEN), "the token is scrubbed from the provider's error");
    assert.ok(await db.auditLog.findFirst({ where: { cafeId: fx.cafeId, action: "WHATSAPP_SHIFT_REPORT_FAILED", entityId: shift.id } }));

    respond = { status: 200, body: { messages: [{ id: "wamid.RESEND" }] } };
    assert.equal((await as(fx.cashier.email, `/api/shifts/${shift.id}/report/whatsapp`, { method: "POST" })).status, 403);
    const resend = await as(fx.owner.email, `/api/shifts/${shift.id}/report/whatsapp`, { method: "POST" });
    assert.equal(resend.status, 200, resend.text);
    const logs = await db.whatsAppMessageLog.findMany({ where: { shiftId: shift.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(logs.map((l) => `${l.trigger}:${l.status}`), ["AUTO:FAILED", "MANUAL:SENT"]);
  });

  test("disabled: a close sends nothing; manual send says why", async () => {
    await db.whatsAppIntegration.update({ where: { cafeId: fx.cafeId }, data: { enabled: false } });
    const shift = await settledShift(100);
    assert.equal((await closeShift(shift.id, 100)).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(captured.length, 0);
    assert.equal(await db.whatsAppMessageLog.count({ where: { shiftId: shift.id } }), 0);
    const manual = await as(fx.owner.email, `/api/shifts/${shift.id}/report/whatsapp`, { method: "POST" });
    assert.equal(manual.status, 409);
    await db.whatsAppIntegration.update({ where: { cafeId: fx.cafeId }, data: { enabled: true } });
  });

  test("the owner's test send uses the latest closed shift", async () => {
    const r = await as<{ status: string; shiftNumber: number }>(fx.owner.email, "/api/cafe/whatsapp/test", { method: "POST" });
    assert.equal(r.status, 200, r.text);
    assert.equal(captured.length, 1);
    const log = await db.whatsAppMessageLog.findFirst({ where: { cafeId: fx.cafeId, trigger: "TEST" } });
    assert.equal(log?.status, "SENT");
    assert.equal((await as(fx.manager.email, "/api/cafe/whatsapp/test", { method: "POST" })).status, 403);
  });
});

describe("OPS-003 wiring", () => {
  test("close route sends after responding; settings and shifts link the feature", () => {
    const route = readFileSync("src/app/api/shifts/[id]/close/route.ts", "utf8");
    assert.match(route, /after\(\(\) =>\s*sendShiftReport\(/);
    const settings = readFileSync("src/app/(app)/settings/page.tsx", "utf8");
    assert.match(settings, /canKey\("settings\.edit"\) && <WhatsAppCard \/>/);
    const card = readFileSync("src/components/settings/whatsapp-card.tsx", "utf8");
    assert.match(card, /type="password"/);
    assert.match(readFileSync("src/app/(app)/shifts/page.tsx", "utf8"), /\/reports\/shift\/\$\{detail\.shift\.id\}/);
  });

  test("the migration only adds", () => {
    const sql = readFileSync("prisma/migrations/20261003000000_whatsapp_shift_report/migration.sql", "utf8");
    assert.doesNotMatch(sql, /\bDROP\b/i);
    assert.doesNotMatch(sql, /ALTER TABLE "(?!WhatsApp)/);
  });
});
