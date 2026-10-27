"use client";

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
const amount = (v: MoneyValue) => v === null ? "غير مسجل" : Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (v: string | null) => v ? new Date(v).toLocaleString("ar-EG") : "لم يتم";
const methodName: Record<string, string> = { CASH: "نقدي", CARD: "بطاقة", WALLET: "محفظة", MIXED: "دفع مقسّم" };

export function HandoverOverview({ overview: o }: { overview: Overview }) {
  return <div className="min-w-0 space-y-4" data-testid="handover-overview">
    <section className="space-y-3 rounded-xl border p-3" aria-label="ملخص المال والمدفوعات">
      <h2 className="font-semibold">المال والمدفوعات — شيفت #{o.shiftNumber}</h2>
      <p className="text-muted-foreground">الإقفال المالي: {date(o.financiallyClosedAt)}. المعلومات المكتملة للقراءة فقط؛ هذه الصفحة لا تعيد فتح الإقفال ولا تسجل تحصيلًا جديدًا.</p>
      {!o.money ? <p>{o.financialAccess ? "لا يوجد إقفال مالي مكتمل لعرضه." : "تفاصيل المال متاحة فقط لصاحب صلاحية تقارير الشيفت؛ لم تُوسّع صلاحياتك."}</p> : <>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="handover-money-totals">
          {[['صافي المبيعات المسجل',o.money.sales],['المرتجعات',o.money.refunds],['الخصومات',o.money.discounts],['نقد بداية الشيفت',o.money.openingCash],['نقد الدرج المتوقع عند الإقفال',o.money.expectedDrawer],['النقد المعدود عند الإقفال',o.money.closingCount],['فرق الإقفال النقدي',o.money.closingDifference],['النقد المنقول المسجل عند الاستلام',o.money.receivedCash]].map(([label,v])=><div key={label!} className="min-w-0 rounded-lg bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words font-medium tabular-nums">{amount(v ?? null)}</dd></div>)}
        </dl>
        <p>عدد الطلبات المسجل: {o.money.orderCount}. سبب فرق الإقفال: {o.money.closingReason ?? "غير مسجل"}. فرق الاستلام: {amount(o.money.receiptDifference)}.</p>
        <p className="text-muted-foreground">المبيعات ليست نقد الدرج وليست النقد المنقول. حقل الاستلام أدناه عدّ مستقل فعلي، ولا يُملأ من هذه الأرقام.</p>
        <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm" data-testid="handover-payment-table"><caption className="p-2 text-start">كل طرق الدفع المتاحة في النظام، بما فيها الطرق بلا حركة</caption><thead><tr>{['الطريقة','صافي الحركة','المتوقع بالتسوية','المبلغ المسجل','الفرق','حالة ERP'].map(x=><th key={x} className="whitespace-nowrap p-2 text-start">{x}</th>)}</tr></thead><tbody>{o.money.payments.map(row=><tr key={row.method} className="border-t"><td className="p-2">{methodName[row.method] ?? row.method}</td><td className="p-2">{amount(row.netSales)}</td><td className="p-2">{amount(row.expected)}</td><td className="p-2">{amount(row.actual)}</td><td className="p-2">{amount(row.variance)}{row.reason && <p>{row.reason}</p>}</td><td className="p-2">{row.method === 'MIXED' ? 'ليست قناة تسوية مستقلة؛ أجزاؤها ضمن النقد/البطاقة/المحفظة' : row.method === 'CASH' ? 'عد الدرج منفصل أعلاه' : row.status ?? 'لا توجد تسوية مسجلة'}</td></tr>)}</tbody></table></div>
        <p className="rounded-lg bg-muted/30 p-2">البطاقة والمحفظة مراجعة إيصالات إلكترونية، وليستا نقدًا ينتقل مع العهدة. لا يوجد هنا دليل مستقل من جهاز الدفع أو المزوّد؛ حالة ERP لا تثبت تسوية خارجية أو تأكيدًا جديدًا من المستلم.</p>
        <h3 className="font-medium">النقد المحتفظ به وحركات المالك</h3>
        {!o.money.storage ? <p>لا يوجد سجل تخزين نقد ليلي لهذا التسليم. لا نفترض وجود إيداع أو سحب أو عهدة محتفظ بها.</p> : <><p>عند الإعلان: الدرج {amount(o.money.storage.leftInDrawer)}؛ للخزنة {amount(o.money.storage.toTreasury)}؛ إجمالي العد {amount(o.money.storage.closingAmount)}.</p>{o.money.storage.movements.length ? o.money.storage.movements.map(m=><p key={m.id}>{Number(m.amount) > 0 ? 'إيداع' : 'سحب'}: {amount(m.amount)} — {m.reason} — {m.actor.name} — {date(m.createdAt)}</p>) : <p>لا حركات إيداع أو سحب مسجلة على عهدة التخزين.</p>}</>}
      </>}
    </section>
    <section className="space-y-2 rounded-xl border p-3" aria-label="الطلبات والالتزامات المعلقة">
      <h2 className="font-semibold">الطلبات المحمولة والالتزامات التشغيلية</h2>
      {o.operations === null ? <p>تفاصيل الطلبات تحتاج صلاحية عرض الطلبات.</p> : o.operations.length === 0 ? <p>لا طلبات محمولة مسجلة على هذا التسليم.</p> : o.operations.map(row=><div className="rounded-lg bg-muted/30 p-2" key={row.orderNumber}>طلب #{row.orderNumber}: عند التسليم {row.statusAtHandover} / {row.paymentStatusAtHandover}؛ المتبقي وقت القطع {amount(row.remainingAtHandover)}. الآن {row.order.status} / {row.order.paymentStatus}؛ الإجمالي {amount(row.order.total)} والمدفوع {amount(row.order.paidAmount)}.</div>)}
      <p className="text-muted-foreground">هذه حالة السجلات وليست تأكيدًا بإتمام خدمة أو تحصيل. متطلبات النقد الافتتاحي والمكان، إن وجدت، تظهر في نفس الصفحة دون إسقاط حراسها.</p>
    </section>
    <section className="space-y-1 rounded-xl border p-3" aria-label="التوقيعات المسجلة">
      <h2 className="font-semibold">التوقيعات المسجلة</h2>
      <p>المُسلّم: {o.signatures.outgoingName} — تقديم العهدة: {date(o.signatures.submittedAt)}</p>
      <p>المستلم المسجل: {o.signatures.incomingName ?? 'لم يُسجل'} — القبول: {date(o.signatures.acceptedAt)} — اكتمال العهدة: {date(o.signatures.completedAt)}</p>
      <p>تحقق النقدية: {o.signatures.cashVerifiedBy ?? 'لم يُسجل'} — {date(o.signatures.cashVerifiedAt)}</p>
      <p className="text-muted-foreground">التقديم يثبت الجرد المربوط؛ توقيع كل سطر والعد النقدي والقبول تسجلها إجراءات العهدة القائمة. لا ندّعي توقيعًا مستقلًا لمراجعة إيصالات إلكترونية غير محفوظ في السجلات.</p>
    </section>
  </div>;
}
