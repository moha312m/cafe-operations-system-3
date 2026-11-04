"use client";

import { TONE_SURFACE, TONE_TOP, type Tone } from "@/components/ui/tone";
import { cn } from "@/lib/utils";
import { money as formatMoney } from "@/lib/client";

type MoneyValue = string | number | null;
export type Overview = {
  shiftNumber: number; financiallyClosedAt: string | null; financialAccess: boolean;
  money: null | { sales: string; refunds: string; discounts: string; orderCount: number;
    openingCash: string; expectedDrawer: string; closingCount: string | null; closingDifference: string | null; closingReason: string | null;
    proposedTransfer: string | null; receivedCash: string | null; receiptDifference: string | null;
    payments: { method: string; netSales: string | null; expected: string | null; actual: string | null; variance: string | null; status: string | null; reason: string | null }[];
    storage: null | { closingAmount: MoneyValue; leftInDrawer: MoneyValue; toTreasury: MoneyValue; movements: { id: string; amount: MoneyValue; reason: string; createdAt: string; actor: { name: string } }[] };
  };
  operations: null | { orderNumber: number; statusAtHandover: string; paymentStatusAtHandover: string; remainingAtHandover: MoneyValue; order: { status: string; paymentStatus: string; total: MoneyValue; paidAmount: MoneyValue } }[];
  signatures: { outgoingName: string; submittedAt: string | null; incomingName: string | null; acceptedAt: string | null; completedAt: string | null; cashVerifiedBy: string | null; cashVerifiedAt: string | null };
};
const methodName: Record<string, string> = { CASH: "نقدي", CARD: "بطاقة", WALLET: "محفظة", MIXED: "دفع مقسّم" };
// Display names only; unknown values are shown as stored rather than guessed.
const TENDER_STATUS: Record<string, string> = { DRAFT: "مسودة", SUBMITTED: "مسجّلة — بانتظار الاعتماد", APPROVED: "معتمدة" };
const ORDER_STATUS: Record<string, string> = { PENDING_WAITER_APPROVAL: "مستني موافقة", CONFIRMED: "مؤكد", PREPARING: "بيتحضر", READY: "جاهز", SERVED: "اتقدم", CANCELLED: "ملغي", COMPLETED: "مكتمل" };
const PAYMENT_STATUS: Record<string, string> = { UNPAID: "غير مدفوع", PARTIALLY_PAID: "مدفوع جزئيًا", PAID: "مدفوع", REFUNDED: "مسترد", PARTIALLY_REFUNDED: "مسترد جزئيًا" };
const nonZero = (v: MoneyValue) => v !== null && Math.abs(Number(v)) > 0.005;

function Figures({ rows, testId, fmt }: { rows: [string, MoneyValue, Tone?][]; testId?: string; fmt: (v: MoneyValue) => string }) {
  // Two columns: the overview sits in the narrow side column of the wide layout, where four cards squeeze every figure into a wrapped sliver.
  return <dl className="grid grid-cols-2 gap-2" data-testid={testId}>
    {rows.map(([label, v, tone]) => <div key={label} className={cn("min-w-0 rounded-lg border p-2.5", tone ? `${TONE_SURFACE[tone]} ${TONE_TOP[tone]}` : "bg-muted/30")}><dt className="text-xs font-medium opacity-80">{label}</dt><dd className="mt-0.5 break-words text-base font-bold tabular-nums">{fmt(v ?? null)}</dd></div>)}
  </dl>;
}

export type OverviewPart = "all" | "money" | "orders" | "signatures";
export function HandoverOverview({ overview: o, part = "all", currency: currencyCode = "EGP", timezone: tz = "Africa/Cairo" }: { overview: Overview; part?: OverviewPart; currency?: string; timezone?: string }) {
  // Money always carries its currency, and times use the branch's reporting timezone (project fallback Africa/Cairo).
  const amount = (v: MoneyValue) => v === null ? "غير مسجل" : formatMoney(Number(v), currencyCode);
  const date = (v: string | null) => { if (!v) return "لم يتم"; try { return new Intl.DateTimeFormat("ar-EG", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(v)); } catch { return new Date(v).toLocaleString("ar-EG"); } };
  const show = (p: Exclude<OverviewPart, "all">) => part === "all" || part === p;
  const m = o.money;
  // A card/wallet difference is the one thing in the details that needs a
  // look, so the details open by themselves when there is one.
  const tenderDifference = m?.payments.some((row) => nonZero(row.variance)) ?? false;
  return <div className="min-w-0 space-y-3" data-testid="handover-overview">
    {show("money") && <section className="space-y-3 rounded-xl border p-3" aria-label="ملخص المال والمدفوعات">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">المال — شيفت #{o.shiftNumber}</h2>
        <span className="text-xs text-muted-foreground">الإقفال المالي: {date(o.financiallyClosedAt)} · للقراءة فقط</span>
      </div>
      {!m ? <p className="text-muted-foreground">{o.financialAccess ? "لا يوجد إقفال مالي مكتمل لعرضه." : "تفاصيل المال متاحة لصاحب صلاحية تقارير الشيفت فقط."}</p> : <>
        <Figures fmt={amount} testId="handover-money-totals" rows={[["صافي المبيعات", m.sales, "caramel"], ["الدرج المتوقع", m.expectedDrawer, "tide"], ["المعدود عند الإقفال", m.closingCount, "sage"], ["فرق الكاش", m.closingDifference, nonZero(m.closingDifference) ? "clay" : "sage"]]} />
        {nonZero(m.closingDifference) && <p className="text-xs">سبب فرق الكاش: {m.closingReason ?? "غير مسجل"}</p>}
        <details className="rounded-lg border" open={tenderDifference}>
          <summary className="cursor-pointer p-2 font-medium">
            تفاصيل المال والمدفوعات
            {tenderDifference && <span className="ms-2 text-xs font-normal text-clay-ink">فيه فرق في البطاقة أو المحفظة</span>}
          </summary>
          <div className="space-y-3 p-2 pt-0">
            <Figures fmt={amount} rows={[["المرتجعات", m.refunds], ["الخصومات", m.discounts], ["نقد بداية الشيفت", m.openingCash], ["الكاش المستلم عند الاستلام", m.receivedCash], ["فرق الاستلام", m.receiptDifference]]} />
            <p className="text-xs text-muted-foreground">عدد الطلبات: {m.orderCount}. عدّ المستلم للكاش مستقل ولا يُملأ من هذه الأرقام، والإقفال لا يُعاد فتحه من هنا.</p>
            <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm" data-testid="handover-payment-table"><thead><tr>{["الطريقة", "صافي الحركة", "المتوقع", "المسجل", "الفرق", "حالة التسوية"].map((x) => <th key={x} className="whitespace-nowrap p-2 text-start">{x}</th>)}</tr></thead><tbody>{m.payments.map((row) => <tr key={row.method} className="border-t"><td className="p-2">{methodName[row.method] ?? row.method}</td><td className="p-2">{amount(row.netSales)}</td><td className="p-2">{amount(row.expected)}</td><td className="p-2">{amount(row.actual)}</td><td className="p-2">{amount(row.variance)}{row.reason && <p className="text-xs text-muted-foreground">{row.reason}</p>}</td><td className="p-2">{row.method === "MIXED" ? "موزّع على الطرق الأخرى" : row.method === "CASH" ? "يُعدّ مع الدرج" : row.status ? TENDER_STATUS[row.status] ?? row.status : "لا توجد تسوية"}</td></tr>)}</tbody></table></div>
            <p className="text-xs text-muted-foreground">البطاقة والمحفظة تُراجعان بالإيصالات ولا تنتقلان مع عهدة الكاش.</p>
            {m.storage && <div className="space-y-1">
              <h3 className="font-medium">النقد المحتفظ به وحركات المالك</h3>
              <p>عند الإعلان: الدرج {amount(m.storage.leftInDrawer)}؛ للخزنة {amount(m.storage.toTreasury)}؛ إجمالي العد {amount(m.storage.closingAmount)}.</p>
              {m.storage.movements.length ? m.storage.movements.map((mv) => <p key={mv.id}>{Number(mv.amount) > 0 ? "إيداع" : "سحب"}: {amount(mv.amount)} — {mv.reason} — {mv.actor.name} — {date(mv.createdAt)}</p>) : <p className="text-muted-foreground">لا حركات إيداع أو سحب مسجلة.</p>}
            </div>}
          </div>
        </details>
      </>}
    </section>}
    {show("orders") && (o.operations === null
      ? <p className="text-xs text-muted-foreground">تفاصيل الطلبات المحمولة تحتاج صلاحية عرض الطلبات.</p>
      : o.operations.length > 0 && <section className="space-y-2 rounded-xl border p-3" aria-label="الطلبات والالتزامات المعلقة">
        <h2 className="font-semibold">طلبات منقولة مع التسليم ({o.operations.length})</h2>
        {o.operations.map((row) => <div className="rounded-lg bg-muted/30 p-2" key={row.orderNumber}>طلب #{row.orderNumber}: وقت التسليم {ORDER_STATUS[row.statusAtHandover] ?? row.statusAtHandover} / {PAYMENT_STATUS[row.paymentStatusAtHandover] ?? row.paymentStatusAtHandover}، المتبقي {amount(row.remainingAtHandover)}. الآن {ORDER_STATUS[row.order.status] ?? row.order.status} / {PAYMENT_STATUS[row.order.paymentStatus] ?? row.order.paymentStatus}، الإجمالي {amount(row.order.total)} والمدفوع {amount(row.order.paidAmount)}.</div>)}
      </section>)}
    {show("signatures") && <details className="rounded-xl border" aria-label="التوقيعات المسجلة" open={part === "signatures"}>
      <summary className="cursor-pointer p-3 font-semibold">سجل التوقيعات</summary>
      <div className="space-y-1 px-3 pb-3">
        <p>المُسلّم: {o.signatures.outgoingName} — تقديم العهدة: {date(o.signatures.submittedAt)}</p>
        <p>المستلم: {o.signatures.incomingName ?? "لم يُسجل"} — القبول: {date(o.signatures.acceptedAt)} — اكتمال العهدة: {date(o.signatures.completedAt)}</p>
        <p>تحقق النقدية: {o.signatures.cashVerifiedBy ?? "لم يُسجل"} — {date(o.signatures.cashVerifiedAt)}</p>
      </div>
    </details>}
  </div>;
}
