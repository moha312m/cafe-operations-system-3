// ── Period-close checklist and close protocol (F8, G1) ───────────────
// What must be true before a period closes, checked from the books and the
// operational subledgers. A blocking item refuses the close; a warning is
// shown to the accountant, who decides.
//
// Close protocol (closeCheckedPeriod), all in ONE transaction:
//   1. lock the period row FOR UPDATE — posting into it takes it FOR SHARE,
//      so no entry can land in it while the close decides;
//   2. take the café's close gate EXCLUSIVELY — every write to a source table
//      holds it SHARED (migration 20261029100000), so the close waits for
//      in-flight source writes to commit and new ones wait for the close;
//   3. re-run the complete checklist through this transaction;
//   4. close only if nothing blocks.
// An event that still lands in the period afterwards (a backdated record) is
// reported by the next projection as a LATE_EVENT, never silently absorbed.
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { money } from "@/lib/money";
import { trialBalance } from "@/lib/accounting/ledger";
import { shadowCoverage } from "@/lib/accounting/shadow-projection";
import { supplierPosition, inventoryReconciliation } from "@/lib/accounting/subledgers";

type Client = Prisma.TransactionClient | typeof db;
export type ChecklistItem = { key: string; label: string; status: "ok" | "warning" | "blocking"; detail: string };

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function closeChecklist(args: { cafeId: string; periodId: string }, client: Client = db) {
  const period = await client.accountingPeriod.findFirst({ where: { id: args.periodId, cafeId: args.cafeId } });
  if (!period) throw new ApiError(404, "الفترة مش موجودة");
  const startsOn = day(period.startsOn), endsOn = day(period.endsOn);
  const items: ChecklistItem[] = [];
  const add = (key: string, label: string, ok: boolean, failStatus: "warning" | "blocking", detail: string) => items.push({ key, label, status: ok ? "ok" : failStatus, detail });

  const today = dateStrInTz(new Date());
  add("period-ended", "الفترة خلصت", endsOn < today, "blocking", endsOn < today ? "" : `الفترة لسه شغالة لحد ${endsOn}`);

  const earlierOpen = await client.accountingPeriod.count({ where: { cafeId: args.cafeId, endsOn: { lt: period.startsOn }, status: "OPEN" } });
  add("earlier-periods", "الفترات اللي قبلها مقفولة", earlierOpen === 0, "blocking", earlierOpen ? `${earlierOpen} فترة قبلها لسه مفتوحة` : "");

  const coverage = await shadowCoverage({ cafeId: args.cafeId, from: zonedDayStart(startsOn), to: zonedDayStart(addDays(endsOn, 1)) }, client);
  add("all-posted", "كل أحداث الفترة اترحّلت", coverage.missing.length === 0, "blocking", coverage.missing.length ? `${coverage.missing.length} حدث لسه ماترحّلش` : `${coverage.events} حدث`);
  add("unchanged", "مفيش مصدر اتغير بعد ترحيله", coverage.changed.length === 0, "blocking", coverage.changed.map((e) => e.sourceKey).join(" · "));
  add("not-disappeared", "مفيش قيد مصدره اختفى", coverage.disappeared.length === 0, "blocking", coverage.disappeared.map((e) => e.sourceKey).join(" · "));
  const unpostable = [...coverage.unpostable, ...coverage.failed];
  add("no-exceptions", "مفيش أحداث مايقدرش يترحّل", unpostable.length === 0, "blocking", unpostable.map((e) => `${e.sourceKey}: ${e.reason}`).join(" · "));
  const blockingIssues = coverage.recordedIssues.filter((i) => i.severity === "BLOCKING");
  add("recorded-issues", "مفيش مشاكل ترحيل متسجلة لسه مفتوحة", blockingIssues.length === 0, "blocking", blockingIssues.map((i) => `${i.kind} ${i.sourceKey}`).join(" · "));
  // Direct-handover cash declared to an owner/manager: unconfirmed or disputed deliveries keep the
  // period open (they never block a shift). An owner's on-behalf confirmation closes the recipient's
  // dispute window with the period, so it is surfaced as a warning to check before closing.
  const declaredIn = { cafeId: args.cafeId, declaredAt: { gte: zonedDayStart(startsOn), lt: zonedDayStart(addDays(endsOn, 1)) } };
  const [pendingDeliveries, disputedDeliveries, onBehalfDeliveries] = await Promise.all([
    client.cashDeliveryDeclaration.count({ where: { ...declaredIn, status: "DECLARED" } }),
    client.cashDeliveryDeclaration.count({ where: { ...declaredIn, status: "DISPUTED" } }),
    client.cashDeliveryDeclaration.count({ where: { ...declaredIn, status: "CONFIRMED", confirmedByException: true } }),
  ]);
  add("cash-deliveries", "كل تسليمات النقدية المُعلنة اتأكدت أو اتسوّت", pendingDeliveries + disputedDeliveries === 0, "blocking",
    pendingDeliveries + disputedDeliveries ? `${pendingDeliveries} بانتظار تأكيد المستلم، ${disputedDeliveries} عليها اختلاف مفتوح` : "");
  add("cash-deliveries-on-behalf", "مفيش تأكيد نيابةً عن المستلم لسه المستلم ماشافهوش", onBehalfDeliveries === 0, "warning",
    onBehalfDeliveries ? `${onBehalfDeliveries} تأكيد نيابةً عن المستلم — قفل الفترة يقفل حق الاعتراض عليها` : "");
  const warnings = coverage.recordedIssues.filter((i) => i.severity === "WARNING");
  add("assumed-dates", "كل التواريخ من دليل فعلي", warnings.length === 0, "warning", warnings.length ? `${warnings.length} حدث اتاخد تاريخه بافتراض` : "");

  const tb = await trialBalance({ cafeId: args.cafeId, to: endsOn }, client);
  add("balanced", "ميزان المراجعة متوازن", tb.balanced, "blocking", `مدين ${tb.totalDebit} / دائن ${tb.totalCredit}`);
  const balance = (key: string) => tb.accounts.find((a) => a.systemKey === key)?.balance ?? 0;

  const suppliers = await supplierPosition({ cafeId: args.cafeId, asOf: endsOn }, client);
  add("payables", "حساب الموردين = كشف المستحقات", money(balance("ACCOUNTS_PAYABLE")).equals(money(suppliers.payable)), "blocking", `الدفتر ${balance("ACCOUNTS_PAYABLE")} / الكشف ${suppliers.payable}`);
  add("advances", "الدفعات المقدمة = كشف الدفعات", money(balance("SUPPLIER_ADVANCES")).equals(money(suppliers.advanceTotal)), "blocking", `الدفتر ${balance("SUPPLIER_ADVANCES")} / الكشف ${suppliers.advanceTotal}`);

  const stock = await inventoryReconciliation({ cafeId: args.cafeId, asOf: endsOn }, client);
  add("inventory", "المخزون في الدفتر = سجل الحركات", stock.unposted === 0 && stock.uncostedRows === 0, "blocking", `فرق ${stock.unposted}، وحركات من غير تكلفة ${stock.uncostedRows}`);

  add("goods-not-invoiced", "مفيش بضاعة مستلمة من غير فاتورة", balance("GOODS_RECEIVED_NOT_INVOICED") === 0, "warning", `${balance("GOODS_RECEIVED_NOT_INVOICED")}`);
  add("clearing", "مقاصة الفيزا والمحافظ اتسوّت مع البنك", balance("CARD_CLEARING") === 0 && balance("WALLET_CLEARING") === 0, "warning", `فيزا ${balance("CARD_CLEARING")}، محافظ ${balance("WALLET_CLEARING")}`);
  add("receivable", "مفيش مبالغ معلّقة مع العملاء", balance("CUSTOMER_RECEIVABLE") === 0 && balance("CUSTOMER_CREDIT") === 0, "warning", `مستحق ${balance("CUSTOMER_RECEIVABLE")}، مقدمات ${balance("CUSTOMER_CREDIT")}`);
  const negative = ["CASH_DRAWER", "CASH_SAFE", "BANK"].filter((k) => balance(k) < 0);
  add("cash-not-negative", "مفيش رصيد نقدي بالسالب", negative.length === 0, "warning", negative.length ? `${negative.join("، ")} — غالبًا الأرصدة الافتتاحية ناقصة` : "");

  return { periodId: period.id, startsOn, endsOn, status: period.status, checkedAt: new Date().toISOString(), items, canClose: period.status === "OPEN" && !items.some((i) => i.status === "blocking") };
}

/**
 * Closes the period only when its checklist, re-run inside the close
 * transaction under the period lock and the café's close gate, has nothing
 * blocking. Returns the checklist the decision was made on.
 * `beforeCommit` exists for tests that inject a concurrent writer.
 */
export async function closeCheckedPeriod(args: { cafeId: string; periodId: string; actorId: string; beforeCommit?: () => Promise<void> }) {
  return db.$transaction(async (tx) => {
    const [period] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status"::text AS "status" FROM "AccountingPeriod" WHERE "id" = ${args.periodId} AND "cafeId" = ${args.cafeId} FOR UPDATE`;
    if (!period) throw new ApiError(404, "الفترة مش موجودة");
    if (period.status !== "OPEN") throw new ApiError(409, "الفترة مقفولة بالفعل");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock("accounting_close_key"(${args.cafeId}))`;
    const checklist = await closeChecklist(args, tx);
    if (!checklist.canClose) {
      const blocking = checklist.items.filter((i) => i.status === "blocking").map((i) => i.label).join("، ");
      throw Object.assign(new ApiError(409, `مينفعش تقفل الفترة: ${blocking}`), { checklist });
    }
    await args.beforeCommit?.();
    await tx.accountingPeriod.update({ where: { id: period.id }, data: { status: "CLOSED", closedAt: new Date(), closedById: args.actorId } });
    return checklist;
  }, { timeout: 120000, maxWait: 30000 });
}
