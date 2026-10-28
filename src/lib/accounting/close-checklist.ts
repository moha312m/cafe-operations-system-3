// ── Period-close checklist (F8) ──────────────────────────────────────
// What must be true before a period closes, checked from the books and the
// operational subledgers. A blocking item refuses the close; a warning is
// shown to the accountant, who decides. closeCheckedPeriod() runs the list
// and closes only when nothing blocks.
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { addDays, zonedDayStart } from "@/lib/date-range";
import { money } from "@/lib/money";
import { closePeriod, trialBalance } from "@/lib/accounting/ledger";
import { shadowCoverage } from "@/lib/accounting/shadow-projection";
import { supplierPosition, inventoryReconciliation } from "@/lib/accounting/subledgers";

export type ChecklistItem = { key: string; label: string; status: "ok" | "warning" | "blocking"; detail: string };

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function closeChecklist(args: { cafeId: string; periodId: string }) {
  const period = await db.accountingPeriod.findFirst({ where: { id: args.periodId, cafeId: args.cafeId } });
  if (!period) throw new ApiError(404, "الفترة مش موجودة");
  const startsOn = day(period.startsOn), endsOn = day(period.endsOn);
  const items: ChecklistItem[] = [];
  const add = (key: string, label: string, ok: boolean, failStatus: "warning" | "blocking", detail: string) => items.push({ key, label, status: ok ? "ok" : failStatus, detail });

  const earlierOpen = await db.accountingPeriod.count({ where: { cafeId: args.cafeId, endsOn: { lt: period.startsOn }, status: "OPEN" } });
  add("earlier-periods", "الفترات اللي قبلها مقفولة", earlierOpen === 0, "blocking", earlierOpen ? `${earlierOpen} فترة قبلها لسه مفتوحة` : "");

  const coverage = await shadowCoverage({ cafeId: args.cafeId, from: zonedDayStart(startsOn), to: zonedDayStart(addDays(endsOn, 1)) });
  add("all-posted", "كل أحداث الفترة اترحّلت", coverage.missing.length === 0, "blocking", coverage.missing.length ? `${coverage.missing.length} حدث لسه ماترحّلش` : `${coverage.events} حدث`);
  add("no-exceptions", "مفيش أحداث مايقدرش يترحّل", coverage.exceptions.length === 0, "blocking", coverage.exceptions.map((e) => `${e.sourceKey}: ${e.reason}`).join(" · "));

  const tb = await trialBalance({ cafeId: args.cafeId, to: endsOn });
  add("balanced", "ميزان المراجعة متوازن", tb.balanced, "blocking", `مدين ${tb.totalDebit} / دائن ${tb.totalCredit}`);
  const balance = (key: string) => tb.accounts.find((a) => a.systemKey === key)?.balance ?? 0;

  const suppliers = await supplierPosition({ cafeId: args.cafeId, asOf: endsOn });
  add("payables", "حساب الموردين = كشف المستحقات", money(balance("ACCOUNTS_PAYABLE")).equals(money(suppliers.payable)), "blocking", `الدفتر ${balance("ACCOUNTS_PAYABLE")} / الكشف ${suppliers.payable}`);
  add("advances", "الدفعات المقدمة = كشف الدفعات", money(balance("SUPPLIER_ADVANCES")).equals(money(suppliers.advanceTotal)), "blocking", `الدفتر ${balance("SUPPLIER_ADVANCES")} / الكشف ${suppliers.advanceTotal}`);

  const stock = await inventoryReconciliation({ cafeId: args.cafeId, asOf: endsOn });
  add("inventory", "المخزون في الدفتر = سجل الحركات", stock.unposted === 0 && stock.uncostedRows === 0, "blocking", `فرق ${stock.unposted}، وحركات من غير تكلفة ${stock.uncostedRows}`);

  add("goods-not-invoiced", "مفيش بضاعة مستلمة من غير فاتورة", balance("GOODS_RECEIVED_NOT_INVOICED") === 0, "warning", `${balance("GOODS_RECEIVED_NOT_INVOICED")}`);
  add("clearing", "مقاصة الفيزا والمحافظ اتسوّت مع البنك", balance("CARD_CLEARING") === 0 && balance("WALLET_CLEARING") === 0, "warning", `فيزا ${balance("CARD_CLEARING")}، محافظ ${balance("WALLET_CLEARING")}`);
  add("receivable", "مفيش مبالغ معلّقة مع العملاء", balance("CUSTOMER_RECEIVABLE") === 0, "warning", `${balance("CUSTOMER_RECEIVABLE")}`);
  const negative = ["CASH_DRAWER", "CASH_SAFE", "BANK"].filter((k) => balance(k) < 0);
  add("cash-not-negative", "مفيش رصيد نقدي بالسالب", negative.length === 0, "warning", negative.length ? `${negative.join("، ")} — غالبًا الأرصدة الافتتاحية ناقصة` : "");

  return { periodId: period.id, startsOn, endsOn, items, canClose: !items.some((i) => i.status === "blocking") };
}

/** Closes the period only when its checklist has no blocking item. */
export async function closeCheckedPeriod(args: { cafeId: string; periodId: string; actorId: string }) {
  const checklist = await closeChecklist(args);
  if (!checklist.canClose) {
    const blocking = checklist.items.filter((i) => i.status === "blocking").map((i) => i.label).join("، ");
    throw Object.assign(new ApiError(409, `مينفعش تقفل الفترة: ${blocking}`), { checklist });
  }
  await db.$transaction((tx) => closePeriod(tx, args));
  return checklist;
}
