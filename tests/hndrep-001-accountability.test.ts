// HNDREP-001 — the handover accountability report.
// One synthetic café, one Cairo day (2026-10-04, UTC+3), every rule R1–R10
// pinned by a fixture whose answer is known in advance.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { BASE, as, jarFor, requireServer } from "./helpers/http";

let fx: CountCafe, perf: CountCafe;
const DAY = "2026-10-04";
const Q = `period=custom&from=${DAY}&to=${DAY}`;
const at = (iso: string) => new Date(iso);
// Every closed fixture shift opened the day before, so only the two
// deliberate openings fall inside the window.
const OPENED_BEFORE = at("2026-10-03T06:00:00Z");

type Json = {
  kpis: Record<string, number | null>;
  visibility: { ingredientValues: boolean };
  employees: Array<{ employee: { id: string; active: boolean }; cash: { shortage: number; overage: number; net: number; notCounted: number; expected: number }; stock: { shortageValue: number | null; overageValue: number | null; unpriced: number; items: number }; shared: { count: number; stockValue: number | null; cashAmount: number }; deliveries: { disputed: number; pending: number }; flags: Array<{ code: string }> }>;
  employeeTotals: { cash: { shortage: number; overage: number; net: number }; stock: { shortageValue: number | null } };
  ledger: Array<{ kind: string; shift: { number: number }; outgoing: { id: string } | null; mode: string | null; cash: { expected: number | null; counted: number | null; variance: number | null; receiving: number | null }; statuses: Array<{ code: string }> }>;
  ledgerTotals: { shortage: number; overage: number; expected: number; counted: number; rows: number };
  ingredients: Array<{ item: { name: string }; attribution: string; basis: string; employee: { id: string } | null; participants: Array<{ id: string }>; value: number | null; priced: boolean; unitCost: number | null }>;
  ingredientTotals: { net: number | null; shortageValue: number | null };
  exceptions: Array<{ kind: string; stale: boolean }>;
};
const report = async (email: string, extra = "") => {
  const r = await as<Json>(email, `/api/reports/handover-accountability?${Q}${extra}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const emp = (r: Json, id: string) => r.employees.find((e) => e.employee.id === id);

before(async () => {
  await requireServer();
  fx = await countCafe("HNDREP");
  perf = await countCafe("HNDREPPERF");
  const { cafeId, branchId, otherBranchId, cashier, storekeeper, manager, owner, waiter } = fx;
  const close = (n: number, who: string, closedAt: string, expected: number, actual: number | null, branch = branchId, openedAt = OPENED_BEFORE) =>
    db.shift.create({ data: { cafeId, branchId: branch, cashierId: who, closedById: manager.id, shiftNumber: n, status: "CLOSED", openedAt, closedAt: at(closedAt), financiallyClosedAt: at(closedAt),
      openingCashAmount: 0, expectedCashAmount: expected, actualCashAmount: actual, cashDifference: actual === null ? null : actual - expected } });

  // R1 + R4: cashier short 50; a disputed and a pending delivery never add to it.
  const s1 = await close(101, cashier.id, "2026-10-04T10:00:00Z", 1000, 950);
  const h1 = await db.handoverSession.create({ data: { cafeId, branchId, outgoingShiftId: s1.id, outgoingUserId: cashier.id, incomingUserId: storekeeper.id, status: "COMPLETED", target: "SHIFT_TO_SHIFT", directHandover: true, acceptedAt: at("2026-10-04T10:05:00Z"), completedAt: at("2026-10-04T10:05:00Z") } });
  const disposition = await db.shiftCashDisposition.create({ data: { cafeId, branchId, shiftId: s1.id, handoverId: h1.id, countedCash: 950, expectedCash: 1000, cashDifference: -50, deliveredAmount: 450, retainedAmount: 500, fingerprint: "HNDREP", idempotencyKey: "HNDREP-1", declaredById: cashier.id } });
  await db.cashDeliveryDeclaration.create({ data: { cafeId, branchId, dispositionId: disposition.id, shiftId: s1.id, handoverId: h1.id, destination: "OWNER", recipientId: owner.id, amount: 300, declaredById: cashier.id, declaredAt: at("2026-10-04T10:01:00Z"), status: "DISPUTED", disputedById: owner.id, disputedAt: at("2026-10-04T12:00:00Z"), disputeNote: "HNDREP short envelope", claimedReceivedAmount: 250 } });
  await db.cashDeliveryDeclaration.create({ data: { cafeId, branchId, dispositionId: disposition.id, shiftId: s1.id, handoverId: h1.id, destination: "MANAGER", recipientId: manager.id, amount: 150, declaredById: cashier.id, declaredAt: at("2026-10-04T10:02:00Z") } });
  await db.handoverIssue.create({ data: { cafeId, branchId, handoverId: h1.id, kind: "OTHER", description: "HNDREP broken grinder", afterAcceptance: true, reportedById: storekeeper.id, idempotencyKey: "HNDREP-issue" } });

  // R2/R3/R9: storekeeper over 20 in cash; a single-custody stock shortage is theirs;
  // a period gap is shared; the next count found 5 less (shared); one item never counted.
  const s2 = await close(102, storekeeper.id, "2026-10-04T14:00:00Z", 500, 520);
  const h2 = await db.handoverSession.create({ data: { cafeId, branchId, outgoingShiftId: s2.id, outgoingUserId: storekeeper.id, incomingUserId: cashier.id, status: "COMPLETED", target: "SHIFT_TO_SHIFT", acceptedAt: at("2026-10-04T14:10:00Z"), completedAt: at("2026-10-04T14:10:00Z"), cashVerifiedAt: at("2026-10-04T14:05:00Z"), cashVerifiedById: cashier.id, proposedOpeningCash: 520, countedOpeningCash: 515, cashVarianceAmount: -5 } });
  const custodyStore = await db.custodyPeriod.create({ data: { cafeId, branchId, scope: "STOCK", status: "CLOSED", responsibleShiftId: s2.id, endedAt: at("2026-10-04T14:10:00Z"), participants: { create: { userId: storekeeper.id } } } });
  const custodyCash = await db.custodyPeriod.create({ data: { cafeId, branchId, scope: "STOCK", status: "CLOSED", responsibleShiftId: s1.id, endedAt: at("2026-10-04T10:05:00Z"), participants: { create: { userId: cashier.id } } } });
  const item = (name: string) => db.inventoryItem.create({ data: { cafeId, branchId, name: `HNDREP ${name}`, unit: "KG", currentStock: 10, costPerUnit: 94.5 } });
  const [beans, milk, sugar, cups] = await Promise.all([item("beans"), item("milk"), item("sugar"), item("cups")]);
  const count = await db.stockCountSession.create({ data: { cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE", status: "CONFIRMED", initiatedById: manager.id,
    lines: { create: [
      { inventoryItemId: beans.id, unit: "KG", expectedQuantity: 10, countedQuantity: 9.5, effectiveCountedQuantity: 9.5, varianceQuantity: -0.5, confidence: "VERIFIED", unitCostSnapshot: 94.5, unitCostSource: "AVERAGE", costImpact: -47.25, costImpactAvailable: true },
      { inventoryItemId: milk.id, unit: "KG", expectedQuantity: 4, countedQuantity: 4.2, effectiveCountedQuantity: 4.2, varianceQuantity: 0.2, confidence: "VERIFIED", unitCostSnapshot: 92, unitCostSource: "AVERAGE", costImpact: 18.4, costImpactAvailable: true },
      { inventoryItemId: sugar.id, unit: "KG", expectedQuantity: 3, countedQuantity: 2.9, effectiveCountedQuantity: 2.9, varianceQuantity: -0.1, confidence: "VERIFIED" },
    ] } }, select: { lines: { select: { id: true, inventoryItemId: true } } } });
  const line = (id: string) => count.lines.find((l) => l.inventoryItemId === id)!.id;
  const openedAt = at("2026-10-04T14:10:00Z");
  await db.varianceCase.create({ data: { cafeId, branchId, type: "STOCK", stockCountLineId: line(beans.id), openedById: cashier.id, openedAt, quantityVariance: -0.5, financialImpact: 47.25, financialImpactAvailable: true, confidence: "VERIFIED", attribution: "VERIFIED_SHIFT", custodyPeriodId: custodyStore.id, shiftId: s2.id, acceptedHandoverId: h2.id } });
  const gap = await db.varianceCase.create({ data: { cafeId, branchId, type: "STOCK", stockCountLineId: line(milk.id), openedById: cashier.id, openedAt, quantityVariance: 0.2, financialImpact: 18.4, financialImpactAvailable: true, confidence: "VERIFIED", attribution: "PERIOD_UNRESOLVED", acceptedHandoverId: h2.id } });
  await db.stockVarianceSpan.create({ data: { varianceCaseId: gap.id, inventoryItemId: milk.id, toStockCountLineId: line(milk.id), toVerifiedAt: openedAt, unverifiedBoundaryCount: 1, custodyLinks: { create: [{ custodyPeriodId: custodyStore.id }, { custodyPeriodId: custodyCash.id }] } } });
  await db.varianceCase.create({ data: { cafeId, branchId, type: "STOCK", stockCountLineId: line(sugar.id), openedById: cashier.id, openedAt, quantityVariance: -0.1, financialImpactAvailable: false, financialImpactUnavailableReason: "NO_COST", confidence: "VERIFIED", attribution: "VERIFIED_SHIFT", custodyPeriodId: custodyStore.id, shiftId: s2.id, acceptedHandoverId: h2.id } });
  await db.handoverStockBoundary.create({ data: { handoverId: h2.id, inventoryItemId: cups.id, source: "SYSTEM_CARRIED", verified: false, quantity: 5, itemVersion: BigInt(1) } });

  // Not recorded is not zero: a close with no count.
  await close(103, manager.id, "2026-10-04T18:00:00Z", 777, null);
  // A shift that crosses midnight belongs to the Cairo day it closed (Oct 5).
  await close(104, cashier.id, "2026-10-04T21:30:00Z", 100, 90, branchId, at("2026-10-04T20:00:00Z"));
  // Another branch, an employee who has since left.
  await close(201, waiter.id, "2026-10-04T16:00:00Z", 300, 270, otherBranchId);
  await db.user.update({ where: { id: waiter.id }, data: { isActive: false } });
  // The owner opened a shift with no receipt: a control exception, not a "0".
  await db.shift.create({ data: { cafeId, branchId, cashierId: owner.id, shiftNumber: 105, status: "OPEN", openedAt: at("2026-10-04T08:00:00Z") } });
});
after(async () => { await teardownTaggedCafe([fx?.cafeId, perf?.cafeId], [], { disconnect: true }); });

test("shortage and overage stay separate, with the net beside them", async () => {
  const r = await report(fx.owner.email);
  assert.equal(r.kpis.cashShortage, 80);
  assert.equal(r.kpis.cashOverage, 20);
  assert.equal(r.kpis.cashNet, -60);
  assert.equal(r.employeeTotals.cash.shortage, 80);
  assert.equal(r.ledgerTotals.shortage, 80);
  assert.equal(r.ledgerTotals.overage, 20);
});

test("R1: the close variance belongs to the shift's cashier, not whoever signed the close", async () => {
  const r = await report(fx.owner.email);
  assert.equal(emp(r, fx.cashier.id)?.cash.shortage, 50);
  assert.equal(emp(r, fx.storekeeper.id)?.cash.overage, 20);
  assert.equal(emp(r, fx.manager.id)?.cash.shortage ?? 0, 0, "the manager signed every close but held no drawer");
});

test("R4: a disputed delivery is shown apart and never added to the cashier's shortage", async () => {
  const r = await report(fx.owner.email);
  const c = emp(r, fx.cashier.id)!;
  assert.equal(c.cash.shortage, 50);
  assert.equal(c.deliveries.disputed, 300);
  assert.equal(c.deliveries.pending, 150);
  assert.equal(r.kpis.openDisputes, 1);
  assert.equal(r.kpis.pendingDeliveries, 1);
  assert.equal(r.kpis.staleDeliveries, 1, "a delivery pending since October is older than 24 hours");
  assert.ok(r.exceptions.some((e) => e.kind === "DELIVERY_PENDING" && e.stale));
  assert.equal(r.ledger.find((x) => x.shift.number === 101)?.mode, "DIRECT");
});

test("R2/R3: one custodian owns their shortage; a period gap is shared and never split", async () => {
  const r = await report(fx.owner.email);
  const beans = r.ingredients.find((l) => l.item.name === "HNDREP beans")!;
  assert.equal(beans.attribution, "PERSON");
  assert.equal(beans.employee?.id, fx.storekeeper.id);
  assert.equal(beans.value, -47.25);
  assert.equal(beans.unitCost, 94.5, "valued at the cost stored with the count");
  const milk = r.ingredients.find((l) => l.item.name === "HNDREP milk")!;
  assert.equal(milk.attribution, "SHARED");
  assert.equal(milk.employee, null);
  assert.deepEqual(new Set(milk.participants.map((p) => p.id)), new Set([fx.storekeeper.id, fx.cashier.id]));
  const store = emp(r, fx.storekeeper.id)!, cash = emp(r, fx.cashier.id)!;
  assert.equal(store.stock.shortageValue, 47.25);
  assert.equal(store.stock.overageValue, 0, "the shared overage is not credited to anyone");
  assert.equal(cash.stock.overageValue, 0);
  assert.equal(store.shared.stockValue, 18.4, "listed in full against each person, not halved");
  assert.equal(cash.shared.stockValue, 18.4);
  assert.equal(r.kpis.ingredientShortage, 47.25);
  assert.equal(r.kpis.sharedStockOverage, 18.4);
});

test("R9: the next person's count difference is shared between the two of them", async () => {
  const r = await report(fx.owner.email);
  assert.equal(r.ledger.find((x) => x.shift.number === 102)?.cash.receiving, -5);
  assert.equal(emp(r, fx.storekeeper.id)?.shared.cashAmount, -5);
  assert.equal(emp(r, fx.cashier.id)?.shared.cashAmount, -5);
  assert.equal(emp(r, fx.storekeeper.id)?.cash.overage, 20, "the receiving gap does not rewrite the close");
  assert.equal(r.kpis.sharedCashShortage, 5);
  assert.equal(r.kpis.sharedCount, 2);
});

test("not recorded and not counted are excluded from totals and counted as exceptions", async () => {
  const r = await report(fx.owner.email);
  const s3 = r.ledger.find((x) => x.shift.number === 103)!;
  assert.equal(s3.cash.counted, null);
  assert.equal(s3.cash.variance, null);
  assert.ok(s3.statuses.some((s) => s.code === "NOT_COUNTED"));
  assert.equal(r.kpis.closesWithoutCount, 1);
  assert.equal(emp(r, fx.manager.id)?.cash.notCounted, 1);
  assert.equal(emp(r, fx.manager.id)?.cash.expected, 0, "777 expected with no count never enters a total");
  assert.equal(r.ledgerTotals.expected, 1800);
  assert.equal(r.ledgerTotals.counted, 1740);
  const sugar = r.ingredients.find((l) => l.item.name === "HNDREP sugar")!;
  assert.equal(sugar.priced, false);
  assert.equal(sugar.value, null);
  assert.equal(r.kpis.ingredientUnpriced, 1);
  assert.equal(emp(r, fx.storekeeper.id)?.stock.unpriced, 1);
  assert.equal(r.kpis.stockNotCounted, 1, "an item nobody counted is an unknown, not a zero difference");
  assert.ok(r.exceptions.some((e) => e.kind === "STOCK_NOT_COUNTED"));
});

test("an opening without a recorded receipt is counted and listed, never hidden in a 0", async () => {
  const r = await report(fx.owner.email);
  const openings = r.ledger.filter((x) => x.kind === "OPENING");
  assert.deepEqual(openings.map((o) => o.shift.number).sort(), [104, 105]);
  assert.equal(r.kpis.openingsWithoutReceipt, 2);
  assert.equal(r.exceptions.filter((e) => e.kind === "OPENING_WITHOUT_RECEIPT").length, 2);
  for (const o of openings) assert.equal(o.cash.expected, null);
  assert.ok(emp(r, fx.owner.id)?.flags.some((f) => f.code === "NO_RECEIPT"));
});

test("R6: a shift crossing midnight falls on the Cairo day it closed", async () => {
  const oct4 = await report(fx.owner.email);
  assert.ok(!oct4.ledger.some((x) => x.kind === "CLOSE" && x.shift.number === 104));
  const r = await as<Json>(fx.owner.email, "/api/reports/handover-accountability?period=custom&from=2026-10-05&to=2026-10-05");
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.ledger.some((x) => x.kind === "CLOSE" && x.shift.number === 104));
  assert.equal(r.body.kpis.cashShortage, 10);
});

test("branch filtering, branch pinning and foreign filters", async () => {
  const main = await report(fx.owner.email, `&branchId=${fx.branchId}`);
  assert.equal(main.kpis.cashShortage, 50);
  assert.ok(!main.ledger.some((x) => x.shift.number === 201));
  const manager = await report(fx.manager.email);
  assert.ok(!manager.ledger.some((x) => x.shift.number === 201), "a branch-pinned manager never sees the annex");
  assert.equal((await as(fx.manager.email, `/api/reports/handover-accountability?${Q}&branchId=${fx.otherBranchId}`)).status, 403);
  assert.equal((await as(fx.owner.email, `/api/reports/handover-accountability?${Q}&employeeId=${perf.cashier.id}`)).status, 400);
  const foreign = await as<Json>(perf.owner.email, `/api/reports/handover-accountability?${Q}`);
  assert.equal(foreign.status, 200, foreign.text);
  assert.equal(foreign.body.ledger.length, 0);
  assert.equal((await as(fx.owner.email, "/api/reports/handover-accountability?period=custom&from=2026-01-01&to=2026-06-30")).status, 400, "longer than 93 days");
});

test("an inactive employee still appears, by name, flagged", async () => {
  const r = await report(fx.owner.email, `&employeeId=${fx.waiter.id}`);
  const w = emp(r, fx.waiter.id)!;
  assert.equal(w.employee.active, false);
  assert.equal(w.cash.shortage, 30);
  assert.ok(w.flags.some((f) => f.code === "INACTIVE"));
  assert.equal(r.employees.length, 1);
});

test("masking: cashiers see nothing, and hidden costs stay hidden in every output", async () => {
  for (const path of [`/api/reports/handover-accountability?${Q}`, `/api/reports/handover-accountability/export?${Q}&format=xlsx`, `/api/reports/handover-accountability/export?${Q}&format=csv`, `/api/reports/handover-accountability/export?${Q}&format=html`]) {
    const r = await as(fx.cashier.email, path);
    assert.equal(r.status, 403, `${path}: ${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /HNDREP/);
  }
  const page = await as(fx.cashier.email, `/reports/accountability/print?${Q}`);
  assert.doesNotMatch(page.text, /HNDREP beans|47\.25/);
  assert.match(page.text, /ليس لديك صلاحية/);

  // A viewer with the report keys but without purchase costs.
  const { loadHandoverAccountability, resolvePeriod } = await import("@/lib/reports/handover-accountability");
  const { reportXlsx, reportHtml, reportTables, tableCsv } = await import("@/lib/reports/handover-accountability-output");
  const period = resolvePeriod("custom", { from: DAY, to: DAY });
  assert.ok(!("error" in period));
  const masked = await loadHandoverAccountability({ cafeId: fx.cafeId, period, viewer: { id: fx.manager.id, name: "m", role: "BRANCH_MANAGER", keys: new Set(["reports.view", "shifts.view_reports"]) } });
  assert.equal(masked.visibility.ingredientValues, false);
  assert.equal(masked.kpis.ingredientShortage, null);
  assert.ok(masked.ingredients.every((l) => l.value === null && l.unitCost === null));
  assert.equal(masked.kpis.cashShortage, 80, "cash is not a cost figure and stays visible");
  const ingredientsCsv = tableCsv(reportTables(masked).find((t) => t.key === "ingredients")!);
  assert.match(ingredientsCsv, /مخفي/);
  assert.doesNotMatch(ingredientsCsv, /47\.25|18\.4|94\.5/);
  const html = reportHtml(masked);
  assert.doesNotMatch(html, /47\.25|18\.40|94\.50/);
  const sheets = unzip(reportXlsx(masked));
  assert.doesNotMatch(Object.values(sheets).join(""), /<v>-?47\.25<\/v>|<v>18\.4<\/v>|<v>94\.5<\/v>/);
});

test("totals parity: screen = print = CSV = XLSX, with numeric cells, freeze panes and filters", async () => {
  const screen = await report(fx.owner.email);
  const get = async (q: string) => {
    const r = await fetch(`${BASE}/api/reports/handover-accountability/export?${Q}&${q}`, { headers: { cookie: jarFor(fx.owner.email) } });
    assert.equal(r.status, 200, q);
    return r;
  };
  const xlsx = await get("format=xlsx");
  assert.match(decodeURIComponent(xlsx.headers.get("content-disposition") ?? ""), /تقرير-المسؤولية_كل-الفروع_2026-10-04_2026-10-04\.xlsx/);
  const sheets = unzip(Buffer.from(await xlsx.arrayBuffer()));
  const sheetXml = Object.entries(sheets).filter(([n]) => n.startsWith("xl/worksheets/")).map(([, x]) => x);
  assert.equal(sheetXml.length, 5, "الملخص، حسب الموظف، سجل الاستلامات، فروق الخامات، الاستثناءات");
  for (const x of sheetXml) {
    assert.match(x, /rightToLeft="1"/);
    assert.match(x, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    assert.match(x, /<autoFilter ref="A1:/);
  }
  assert.match(sheets["xl/workbook.xml"], /حسب الموظف/);
  assert.match(sheets["xl/styles.xml"], /#,##0\.00/);
  // Employee sheet totals row: G = cash shortage, bold money style 3, a real number.
  const employees = sheetXml[1];
  const rows = employees.match(/<row r="\d+">.*?<\/row>/g)!;
  const total = rows[rows.length - 1];
  assert.match(total, new RegExp(`<c r="G${rows.length}" s="3"><v>${screen.employeeTotals.cash.shortage}</v></c>`));
  assert.match(total, new RegExp(`<c r="H${rows.length}" s="3"><v>${screen.employeeTotals.cash.overage}</v></c>`));
  // Dates are serial numbers in a date style, not text.
  assert.match(sheetXml[2], /<c r="A2" s="10"><v>\d{5}\.\d+<\/v><\/c>/);

  const csvLast = async (table: string) => {
    // Read bytes: Response.text() decodes away the BOM it is checking for.
    const bytes = Buffer.from(await (await get(`format=csv&table=${table}`)).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
    const text = bytes.subarray(3).toString("utf8");
    assert.ok(text.includes("\r\n"), "RFC 4180 line ends");
    return text.trim().split("\r\n").at(-1)!.split(",");
  };
  const employeeTotals = await csvLast("employees");
  assert.equal(Number(employeeTotals[6]), screen.employeeTotals.cash.shortage);
  assert.equal(Number(employeeTotals[7]), screen.employeeTotals.cash.overage);
  assert.equal(Number(employeeTotals[16]), screen.employeeTotals.stock.shortageValue);
  const ledgerTotals = await csvLast("ledger");
  assert.equal(Number(ledgerTotals[12]), screen.ledgerTotals.shortage);
  assert.equal(Number(ledgerTotals[13]), screen.ledgerTotals.overage);
  const ingredientTotals = await csvLast("ingredients");
  assert.equal(Number(ingredientTotals[9]), screen.ingredientTotals.net);

  const html = await (await get("format=html")).text();
  const tfoot = html.match(/<tfoot>.*?<\/tfoot>/g)!;
  assert.equal(tfoot.length, 4);
  assert.match(tfoot[0], />80\.00</);
  assert.match(tfoot[1], />80\.00</);
  assert.match(html, /@page\{size:A4 landscape/);
  assert.match(html, /thead\{display:table-header-group\}/);
  assert.doesNotMatch(html, /[٠-٩]/, "Western digits only");

  const print = await as(fx.owner.email, `/reports/accountability/print?${Q}`);
  assert.equal(print.status, 200);
  assert.match(print.text, /80\.00/);
  assert.doesNotMatch(print.text.replace(/<script[\s\S]*?<\/script>/g, ""), /[٠-٩]/);
});

test("the report page renders under its new name", async () => {
  const page = await as(fx.owner.email, "/reports/opening-receipts");
  assert.equal(page.status, 200);
  assert.match(page.text, /تقرير الاستلام والمسؤولية/);
});

test("periods: Saturday-to-Friday week and last month on Cairo days", async () => {
  const { resolvePeriod } = await import("@/lib/reports/handover-accountability");
  const wed = new Date("2026-11-04T10:00:00Z"); // Wednesday in Cairo
  const week = resolvePeriod("this_week", {}, wed);
  assert.ok(!("error" in week));
  assert.equal(week.from, "2026-10-31"); // Saturday
  assert.equal(week.to, "2026-11-04");
  const last = resolvePeriod("last_month", {}, wed);
  assert.ok(!("error" in last));
  assert.deepEqual([last.from, last.to], ["2026-10-01", "2026-10-31"]);
  const late = resolvePeriod("today", {}, new Date("2026-11-04T22:30:00Z")); // 00:30 on the 5th in Cairo
  assert.ok(!("error" in late));
  assert.equal(late.from, "2026-11-05");
  const { formatMoney, formatQuantity, formatDate, formatTime } = await import("@/lib/reports/handover-accountability-format");
  assert.equal(formatMoney(1234.5), "1,234.50 ج.م");
  assert.equal(formatQuantity(2.35, "KG"), "2.350 كجم");
  assert.equal(formatDate("2026-11-05T03:06:00Z"), "05/11/2026");
  assert.equal(formatTime("2026-11-05T15:06:00Z"), "5:06 م");
});

test("performance: a 31-day month at realistic volume", async () => {
  const { cafeId, branchId, cashier, storekeeper, manager } = perf;
  const items = await db.inventoryItem.createManyAndReturn({ data: Array.from({ length: 12 }, (_, i) => ({ cafeId, branchId, name: `HNDREPPERF item ${i}`, unit: "KG" as const, currentStock: 50, costPerUnit: 80 })), select: { id: true } });
  const shifts: { cafeId: string; branchId: string; cashierId: string; shiftNumber: number; status: "CLOSED"; openedAt: Date; closedAt: Date; financiallyClosedAt: Date; expectedCashAmount: number; actualCashAmount: number; cashDifference: number }[] = [];
  for (let d = 1; d <= 31; d++) for (let s = 0; s < 6; s++) {
    const closedAt = new Date(Date.UTC(2026, 9, d, 6 + s * 2, 30));
    const diff = ((d * 7 + s * 3) % 11) - 5;
    shifts.push({ cafeId, branchId, cashierId: s % 2 ? cashier.id : storekeeper.id, shiftNumber: d * 10 + s, status: "CLOSED", openedAt: new Date(closedAt.getTime() - 7200000), closedAt, financiallyClosedAt: closedAt, expectedCashAmount: 1000 + s, actualCashAmount: 1000 + s + diff, cashDifference: diff });
  }
  const created = await db.shift.createManyAndReturn({ data: shifts, select: { id: true, cashierId: true, closedAt: true } });
  const handovers = await db.handoverSession.createManyAndReturn({ data: created.map((s) => ({ cafeId, branchId, outgoingShiftId: s.id, outgoingUserId: s.cashierId, incomingUserId: s.cashierId === cashier.id ? storekeeper.id : cashier.id, status: "COMPLETED" as const, target: "SHIFT_TO_SHIFT" as const, acceptedAt: s.closedAt, completedAt: s.closedAt })), select: { id: true, completedAt: true } });
  // One count per handover, three lines each — a count line is unique per session and item.
  const sessions = await db.stockCountSession.createManyAndReturn({ data: handovers.map(() => ({ cafeId, branchId, type: "FULL" as const, scopeDerivation: "ALL_ELIGIBLE", status: "CONFIRMED" as const, initiatedById: manager.id })), select: { id: true } });
  const lines = await db.stockCountLine.createManyAndReturn({ data: handovers.flatMap((_, h) => [0, 1, 2].map((k) => ({ sessionId: sessions[h].id, inventoryItemId: items[(h + k) % items.length].id, unit: "KG" as const, expectedQuantity: 5, countedQuantity: 4.9, effectiveCountedQuantity: 4.9, varianceQuantity: -0.1, confidence: "VERIFIED" as const, unitCostSnapshot: 80, costImpact: -8, costImpactAvailable: true }))), select: { id: true } });
  await db.varianceCase.createMany({ data: lines.map((l, i) => ({ cafeId, branchId, type: "STOCK" as const, stockCountLineId: l.id, openedById: manager.id, openedAt: handovers[Math.floor(i / 3)].completedAt!, quantityVariance: -0.1, financialImpact: 8, financialImpactAvailable: true, confidence: "PARTIAL" as const, attribution: "PERIOD_UNRESOLVED" as const, acceptedHandoverId: handovers[Math.floor(i / 3)].id })) });

  const path = "/api/reports/handover-accountability?period=custom&from=2026-10-01&to=2026-10-31";
  await as(perf.owner.email, path); // warm the route
  const started = performance.now();
  const r = await as<Json>(perf.owner.email, path);
  const ms = Math.round(performance.now() - started);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ledger.filter((x) => x.kind === "CLOSE").length, 186);
  assert.equal(r.body.ingredients.length, 558);
  console.log(`[HNDREP perf] 31 days, 186 closes, 558 ingredient lines: ${ms} ms`);
  assert.ok(ms < 5000, `31-day report took ${ms} ms (budget 5000 ms)`);
});

/** Minimal reader for the ZIP our own writer produces (local headers carry sizes). */
function unzip(buf: Buffer): Record<string, string> {
  const files: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18), nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const start = o + 30 + nameLen + extra;
    files[name] = inflateRawSync(buf.subarray(start, start + size)).toString("utf8");
    o = start + size;
  }
  return files;
}
