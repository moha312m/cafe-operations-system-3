import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, invoice, pay, http, journal } from "./helpers/acc01b-purchase-runtime";
import { dateStrInTz } from "@/lib/date-range";
import { DAILY_REPORT_METRICS } from "@/lib/metric-definitions";

// ACC-01B supplemental: the daily report recognizes confirmed purchases only
// and lists drafts as commitments (report-006), on a retained ACC01B-VERIFY
// café. The cancelled draft goes through the real cancel route, never a direct
// status write, and the payment names its SAFE source.

after(async () => { await db.$disconnect(); });

type Purchases = { total: number; invoiceCount: number; supplierPayments: number; unpaidTotal: number; unpaidAsOf: string; draftCount: number; draftTotal: number };

test("C1: daily report counts the confirmed 100 only, keeps the 50 draft a commitment and ignores the cancelled draft", { timeout: 120000 }, async () => {
  const fx = await fixture("VERIFY-RPT", null);
  const confirmed = await invoice(fx, 100);
  const payment = await pay(fx.owner, confirmed, { amount: 40, method: "CASH", fundingSource: "SAFE" });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  const draft = await invoice(fx, 50, false);
  const cancelled = await invoice(fx, 30, false);
  const cancel = await http(fx.owner, "/api/purchases/" + cancelled + "/cancel", "POST", {});
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

  const date = dateStrInTz(new Date());
  const requestedAt = Date.now();
  const report = await http<{ purchases: Purchases; outputSnapshot?: string }>(fx.owner, "/api/reports/daily?date=" + date + "&branchId=" + fx.branchId);
  const answeredAt = Date.now();
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 500));
  const p = report.body.purchases;

  // Persisted sources the report must agree with.
  const invoices = await db.purchaseInvoice.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, status: true, confirmedAt: true, cancelledAt: true, totalAmount: true, paidAmount: true, remainingAmount: true, paymentStatus: true, branchId: true } });
  const payments = await db.purchasePayment.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, purchaseInvoiceId: true, amount: true, method: true, fundingSource: true, shiftId: true } });
  const stockRows = await db.inventoryTransaction.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, type: true, quantity: true, totalCost: true, note: true } });
  const audits = await db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: { startsWith: "PURCHASE_" } }, select: { id: true, action: true, entityId: true, details: true } });
  let labels: Record<string, string> | null = null;
  if (report.body.outputSnapshot) {
    const decoded = JSON.parse(Buffer.from(report.body.outputSnapshot.split(".")[0], "base64url").toString("utf8")) as { report: { labels?: Record<string, string>; metrics?: { purchases?: Purchases } } };
    labels = decoded.report.labels ?? null;
    assert.deepEqual(decoded.report.metrics?.purchases, p, "the signed output carries the same purchase figures");
  }
  journal("verify-c1-report", { cafeId: fx.cafeId, branchId: fx.branchId, date, invoices: { confirmed, draft, cancelled }, purchases: p, labels: labels && { unpaidTotal: labels["purchases.unpaidTotal"], draftTotal: labels["purchases.draftTotal"], total: labels["purchases.total"] }, sources: { invoices, payments, stockRows, audits } });

  const byId = new Map(invoices.map((i) => [i.id, i]));
  assert.deepEqual([byId.get(confirmed)!.status, byId.get(draft)!.status, byId.get(cancelled)!.status], ["CONFIRMED", "DRAFT", "CANCELLED"]);
  assert.equal(p.total, 100, "only the confirmed invoice is a recognized purchase");
  assert.equal(p.invoiceCount, 1);
  assert.equal(p.unpaidTotal, 60, "a draft is not owed to the supplier");
  assert.equal(p.supplierPayments, 40);
  assert.equal(p.draftCount, 1);
  assert.equal(p.draftTotal, 50);
  const asOf = Date.parse(p.unpaidAsOf);
  assert.ok(!Number.isNaN(asOf), "unpaidAsOf parses");
  assert.ok(asOf >= requestedAt - 1000 && asOf <= answeredAt + 1000, "unpaidAsOf is the instant the report was made, a current balance");
  assert.equal(DAILY_REPORT_METRICS.supplierUnpaid.basis, "now");
  if (labels) assert.equal(labels["purchases.unpaidTotal"], DAILY_REPORT_METRICS.supplierUnpaid.label, "the unpaid figure is labelled a current balance");

  // Report fields against persisted values.
  const confirmedRows = invoices.filter((i) => i.status === "CONFIRMED");
  assert.equal(p.total, confirmedRows.reduce((s, i) => s + Number(i.totalAmount), 0));
  assert.equal(p.unpaidTotal, confirmedRows.reduce((s, i) => s + Number(i.remainingAmount), 0));
  assert.equal(p.supplierPayments, payments.reduce((s, x) => s + Number(x.amount), 0));
  assert.deepEqual(payments.map((x) => [x.purchaseInvoiceId, String(x.amount), x.fundingSource, x.shiftId]), [[confirmed, "40", "SAFE", null]]);
  assert.equal(p.draftTotal, Number(byId.get(draft)!.totalAmount));
  // The draft is a commitment: no stock received, nothing paid, not in the debt.
  assert.deepEqual(stockRows.map((s) => [s.type, String(s.quantity)]), [["PURCHASE", "1"]], "only the confirmed invoice received stock");
  assert.deepEqual([String(byId.get(draft)!.paidAmount), byId.get(draft)!.confirmedAt], ["0", null]);
  // The cancelled draft was never confirmed or paid, so it contributes nowhere.
  const c = byId.get(cancelled)!;
  assert.deepEqual([c.confirmedAt, String(c.paidAmount), c.cancelledAt !== null], [null, "0", true]);
  const cancelAudit = audits.find((a) => a.action === "PURCHASE_INVOICE_CANCELLED" && a.entityId === cancelled);
  assert.ok(cancelAudit, "the cancel route recorded its audit");
  assert.equal((cancelAudit.details as { wasConfirmed: boolean }).wasConfirmed, false);
});
