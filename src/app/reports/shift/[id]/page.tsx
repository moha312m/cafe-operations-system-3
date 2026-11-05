import { db } from "@/lib/db";
import { requireActiveSession, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { buildShiftMaterialsReport, buildShiftReport, type ShiftMaterialsReport, type ShiftReport } from "@/lib/shift-report";
import { UNIT_LABEL } from "@/lib/inventory";
import { CADENCE_LABEL, materialsDecisionLabel } from "@/lib/materials-labels";
import { ShiftReportActions } from "@/components/reports/shift-report-actions";

export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = { CASH: "كاش", CARD: "فيزا", WALLET: "محفظة" };
const STATUS_LABEL: Record<string, string> = {
  PENDING_WAITER_APPROVAL: "مستني موافقة", CONFIRMED: "مؤكد", PREPARING: "بيتحضر", READY: "جاهز", SERVED: "اتقدم",
};
const PAY_LABEL: Record<string, string> = {
  UNPAID: "مش مدفوع", PENDING_COLLECTION: "مستني تحصيل", PARTIAL: "مدفوع جزئي", PAID: "مدفوع",
};
const HANDOVER_LABEL: Record<string, string> = {
  DRAFT: "مسودة", OUTGOING_SUBMITTED: "مستني الاستلام", INCOMING_REVIEW: "المستلم بيراجع", ACCEPTED: "اتسلّم",
  REJECTED: "اترفض", MANAGER_EXCEPTION: "استثناء من المدير", COMPLETED: "خلص",
};

function fmt(n: number | null, currency: string) {
  if (n === null) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
function qty(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
function signedQty(n: number | null) {
  if (n === null) return "—";
  return `${n > 0 ? "+" : ""}${qty(n)}`;
}
const EVIDENCE_LABEL: Record<string, string> = {
  SYSTEM_MATCH: "مطابق — تحقّق منه النظام",
  OUTGOING_DECLARED: "مسجّل كما عدّه المُسلِّم (بفروق)",
  MANAGER_CONFIRMED: "معتمد من مسؤول",
  PENDING: "لسه ما اتسلّمش",
};
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ar-EG", {
    timeZone: "Africa/Cairo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function Message({ text }: { text: string }) {
  return (
    <main dir="rtl" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", fontFamily: "var(--font-cairo), sans-serif" }}>
      <p style={{ fontSize: 16, fontWeight: 600 }}>{text}</p>
    </main>
  );
}

function Row({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", fontWeight: strong ? 700 : 400, color }}>
      <span>{label}</span>
      <span dir="ltr">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: "1px dashed #d4d4d8", paddingTop: 10, marginTop: 10 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 6px" }}>{title}</h2>
      {children}
    </section>
  );
}

// Printable, READ-ONLY shift close report. Restricted to this cafe,
// this branch for branch-pinned staff, and `shifts.view_reports` permission.
export default async function ShiftReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The full guard, not the bare cookie: a deactivated, revoked or moved
  // account must lose its shift cash reports with the rest of its access.
  let session;
  try {
    session = await requireActiveSession();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return <Message text={error.message} />;
    throw error;
  }

  const shift = await db.shift.findFirst({
    where: { id, cafeId: session.cafeId ?? "" },
    select: { branchId: true, cashierId: true },
  });
  if (!shift) return <Message text="الشيفت مش موجود" />;
  if (session.branchId && shift.branchId !== session.branchId) return <Message text="الشيفت تبع فرع تاني" />;
  const { keys } = await resolvePermissions(session);
  const oversight = keys.has("shifts.view_reports");
  if (!oversight) return <Message text="ليس لديك صلاحية لعرض التقرير المالي" />;

  const report: ShiftReport | null = await buildShiftReport(id, session.cafeId ?? "");
  if (!report) return <Message text="التقرير بيجهز بعد قفل الشيفت" />;
  // Expected quantities, differences and cost are oversight's, as the count's
  // own blindness rules have it.
  const materials: ShiftMaterialsReport = await buildShiftMaterialsReport(id, session.cafeId ?? "", { withFigures: oversight });
  const whatsapp = oversight
    ? await db.whatsAppIntegration.findUnique({ where: { cafeId: session.cafeId ?? "" }, select: { enabled: true } })
    : null;

  const c = report.cafe.currency;
  const diff = report.cash.difference;
  const diffColor = diff === null || diff === 0 ? undefined : report.cash.withinTolerance === false ? "#b91c1c" : "#a16207";

  return (
    <main dir="rtl" style={{ background: "#f4f4f5", minHeight: "100dvh", padding: "16px 8px", fontFamily: "var(--font-cairo), sans-serif" }}>
      <style>{`
        @media print {
          body { margin: 0; background: #fff !important; }
          main { background: #fff !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .report { box-shadow: none !important; border: 0 !important; max-width: 100% !important; }
        }
      `}</style>
      <ShiftReportActions shiftId={report.shiftId} canSend={!!whatsapp?.enabled} />
      <article
        className="report"
        style={{ maxWidth: 520, margin: "0 auto", background: "#fff", borderRadius: 12, border: "1px solid #e4e4e7", padding: 20, fontSize: 13 }}
      >
        <header style={{ textAlign: "center", marginBottom: 8 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>تقرير قفل شيفت #{report.shiftNumber}</h1>
          <p style={{ margin: "4px 0 0", color: "#52525b" }}>{report.cafe.name} — {report.branch.name}</p>
        </header>

        <Row label="الكاشير" value={report.cashierName} />
        {report.closedByName && report.closedByName !== report.cashierName && <Row label="قفله" value={report.closedByName} />}
        <Row label="الفتح" value={fmtDate(report.openedAt)} />
        <Row label="القفل" value={fmtDate(report.closedAt)} />

        <Section title="💵 النقدية">
          <Row label="رصيد الافتتاح" value={fmt(report.cash.opening, c)} />
          <Row label="دفعات الموردين من الدرج" value={fmt(report.cash.supplierPayouts ?? 0, c)} />
          <Row label="مصروفات تشغيلية من الدرج" value={fmt(report.cash.expensePayouts ?? 0, c)} />
          <Row label="نقد مصروفات مردود" value={fmt(report.cash.expenseReturns ?? 0, c)} />
          <Row label="المتوقع في الدرج" value={fmt(report.cash.expected, c)} />
          <Row label="الفعلي (اتعد)" value={fmt(report.cash.actual, c)} />
          <Row
            label={`الفرق${report.cash.withinTolerance === null ? "" : report.cash.withinTolerance ? " (داخل السماح)" : " (خارج السماح)"}`}
            value={diff === null ? "—" : `${diff > 0 ? "+" : ""}${fmt(diff, c)}`}
            strong
            color={diffColor}
          />
          {report.cash.reasonNote ? <p style={{ margin: "4px 0 0", color: "#52525b" }}>ملاحظة: {report.cash.reasonNote}</p>
            : diff !== null && diff !== 0 && <p style={{ margin: "4px 0 0", color: "#a16207" }}>بدون ملاحظة — للمراجعة</p>}
        </Section>

        {report.cashDisposition && (
          <Section title="💼 توزيع نقدية الإغلاق والعهدة">
            <div data-testid="report-cash-disposition">
              <Row label="النقد الفعلي الموزّع" value={fmt(report.cashDisposition.countedCash, c)} strong />
              <Row label="إجمالي التسليمات المُعلنة (للمالك / للمدير)" value={fmt(report.cashDisposition.deliveredAmount, c)} />
              {report.cashDisposition.deliveries.map((d) => (
                <div key={d.id} style={{ padding: "4px 8px", margin: "4px 0", background: "#f4f4f5", borderRadius: 6 }}>
                  <Row label={`${d.destinationLabel} (${d.recipientName})`} value={fmt(d.amount, c)} strong />
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: d.status === "DISPUTED" ? "#b91c1c" : d.status === "CONFIRMED" || d.status === "RESOLVED" ? "#15803d" : "#a16207" }}>
                    الحالة: {d.statusLabel}
                    {d.confirmedAt ? ` · أكد الاستلام: ${fmtDate(d.confirmedAt)}` : ""}
                    {d.disputedAt ? ` · أبلغ عن فرق (${fmt(d.claimedReceivedAmount, c)}): ${d.disputeNote ?? ""}` : ""}
                    {d.resolvedAt ? ` · حسم المالك (${fmt(d.resolvedAmount, c)}): ${d.resolutionNote ?? ""}` : ""}
                  </p>
                </div>
              ))}
              <Row label={report.cashDisposition.retainedCustody.destinationLabel} value={fmt(report.cashDisposition.retainedAmount, c)} strong />
              <Row label="حالة عهدة الدرج المتبقية" value={`${report.cashDisposition.retainedCustody.statusLabel}${report.cashDisposition.retainedCustody.holderName ? ` (${report.cashDisposition.retainedCustody.holderName})` : ""}`} />
              {report.cashDisposition.note && <p style={{ margin: "4px 0 0", color: "#52525b" }}>ملاحظة التوزيع: {report.cashDisposition.note}</p>}
            </div>
          </Section>
        )}

        {report.tenders.length > 0 && (
          <Section title="💳 الفيزا والمحافظ">
            {report.tenders.map((t) => (
              <div key={t.method}>
                <Row label={`${METHOD_LABEL[t.method] ?? t.method}: متوقع ${fmt(t.expected, c)}`}
                  value={`فعلي ${fmt(t.actual, c)} (فرق ${t.variance === null ? "—" : `${t.variance > 0 ? "+" : ""}${fmt(t.variance, c)}`})`} />
                {t.reasonNote ? <p style={{ margin: "4px 0 0", color: "#52525b" }}>ملاحظة: {t.reasonNote}</p>
                  : t.variance !== null && t.variance !== 0 && <p style={{ margin: "4px 0 0", color: "#a16207" }}>بدون ملاحظة — للمراجعة</p>}
              </div>
            ))}
          </Section>
        )}

        <MaterialsSection materials={materials} />

        <Section title="🧾 المبيعات">
          <Row label="إجمالي المبيعات" value={fmt(report.sales.total, c)} strong />
          <Row label="كاش" value={fmt(report.sales.cash, c)} />
          <Row label="فيزا" value={fmt(report.sales.card, c)} />
          <Row label="محافظ" value={fmt(report.sales.wallet, c)} />
          <Row label="مرتجعات" value={fmt(report.sales.refunds, c)} />
          <Row label="خصومات" value={fmt(report.sales.discounts, c)} />
          <Row label="عدد الأوردرات" value={String(report.sales.orderCount)} />
        </Section>

        <Section title="📥 أوردرات اترحّلت للشيفت اللي بعده">
          {report.carried.count === 0 ? (
            <p style={{ margin: 0, color: "#52525b" }}>لا يوجد</p>
          ) : (
            <>
              {report.carried.orders.map((o) => (
                <Row
                  key={o.orderNumber}
                  label={`#${o.orderNumber} — ${STATUS_LABEL[o.status] ?? o.status} / ${PAY_LABEL[o.paymentStatus] ?? o.paymentStatus}`}
                  value={fmt(o.remaining, c)}
                />
              ))}
              <Row label={`المتبقي تحصيله (${report.carried.count})`} value={fmt(report.carried.unpaidTotal, c)} strong />
            </>
          )}
        </Section>

        {report.handover && (
          <Section title="🤝 الاستلام والتسليم">
            <Row label="نمط التسليم" value={report.handover.directHandover ? "تسليم مباشر ومبسّط بين الورديتين" : "تسليم قياسي"} />
            <Row label="الحالة" value={HANDOVER_LABEL[report.handover.status] ?? report.handover.status} />
            <Row label="المستلم" value={report.handover.incomingName ?? "—"} />
            <Row label="وقت الاستلام" value={fmtDate(report.handover.acceptedAt)} />
            {report.handover.directAcknowledgedAt && (
              <Row label="إقرار الاستلام المباشر" value={`${report.handover.directAcknowledgedByName ?? report.handover.incomingName ?? "—"} · ${fmtDate(report.handover.directAcknowledgedAt)}`} />
            )}
            {report.handover.issues.length > 0 && (
              <div style={{ marginTop: 6 }} data-testid="report-handover-issues">
                <p style={{ margin: "4px 0", fontWeight: 700 }}>بلاغات الاختلاف والملاحظات ({report.handover.issues.length}):</p>
                {report.handover.issues.map((i) => (
                  <div key={i.id} style={{ padding: "4px 8px", margin: "4px 0", background: "#fef2f2", borderRadius: 6, fontSize: 12 }}>
                    <div><strong>{i.kind === "CASH" ? "نقدية" : i.kind === "STOCK_ITEM" ? `خامات${i.itemNameSnapshot ? ` (${i.itemNameSnapshot})` : ""}` : "أخرى"}</strong> — {i.status === "RESOLVED" ? "تمت المعالجة" : "مفتوح للمراجعة"}</div>
                    <div>{i.description}{i.amount !== null ? ` (${fmt(i.amount, c)})` : ""} (أبلغ: {i.reportedByName} · {fmtDate(i.reportedAt)})</div>
                    {i.resolutionNote && <div>قرار المعالجة: {i.resolutionNote} ({i.resolvedByName ?? "—"})</div>}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
      </article>
    </main>
  );
}

// HND-UX-004. Materials on the same report: the schedule's answer, the
// outgoing count as recorded, receiving, and the period it covers.
function MaterialsSection({ materials }: { materials: ShiftMaterialsReport }) {
  const { decision, handover, lines, coveredShifts, withFigures } = materials;
  if (!decision && !handover) return null;
  const period = decision?.periodFrom ? (decision.periodFrom === decision.periodTo ? decision.periodTo : `${decision.periodFrom} ← ${decision.periodTo}`) : null;
  const cell = { padding: "4px 6px", borderBottom: "1px solid #f4f4f5", textAlign: "start" as const, verticalAlign: "top" as const };
  return (
    <Section title="📦 جرد الخامات">
      <div data-testid="report-materials">
        {decision && <Row label="الجدول" value={decision.cadence === "EVERY_SHIFT" ? materialsDecisionLabel(decision) : `${materialsDecisionLabel(decision)} · ${CADENCE_LABEL[decision.cadence] ?? decision.cadence}`} />}
        {period && <Row label="الفترة" value={period} />}
        {decision && !decision.due && decision.nextDueAt && <Row label="الجرد الجاي" value={fmtDate(decision.nextDueAt)} />}
        {handover && <>
          <Row label="حالة التسليم" value={HANDOVER_LABEL[handover.status] ?? handover.status} />
          <Row label="المُسلِّم" value={`${handover.outgoingName}${handover.submittedAt ? ` · ${fmtDate(handover.submittedAt)}` : ""}`} />
          <Row label="المستلم" value={handover.incomingName ? `${handover.incomingName}${handover.acceptedAt ? ` · ${fmtDate(handover.acceptedAt)}` : ""}` : "لسه ما استلمش"} />
          {handover.evidence && <Row label="دليل الجرد" value={EVIDENCE_LABEL[handover.evidence] ?? handover.evidence} />}
          {handover.outgoingNote && <p style={{ margin: "4px 0", color: "#52525b" }}>ملاحظة المُسلِّم: {handover.outgoingNote}</p>}
        </>}
        {lines.length > 0 && <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ color: "#52525b" }}>
              <th style={cell}>الصنف</th><th style={cell}>الوحدة</th>
              {withFigures && <th style={cell}>المتوقع</th>}<th style={cell}>عدّ المُسلِّم</th>{withFigures && <th style={cell}>الفرق</th>}
              <th style={cell}>عدّ المستلم</th>{withFigures && <th style={cell}>فرق الاستلام</th>}{withFigures && <th style={cell}>التكلفة</th>}
            </tr></thead>
            <tbody>{lines.map((l) => <tr key={l.lineId} data-testid="report-materials-line">
              <td style={cell}>{l.name}{l.note && <div style={{ color: "#52525b" }}>{l.note}</div>}</td>
              <td style={cell}>{UNIT_LABEL[l.unit as keyof typeof UNIT_LABEL] ?? l.unit}</td>
              {withFigures && <td style={cell} dir="ltr">{qty(l.expected)}</td>}
              <td style={cell} dir="ltr">{l.counted === null ? "لم يُعدّ" : qty(l.counted)}</td>
              {withFigures && <td style={{ ...cell, color: l.difference ? "#a16207" : undefined }} dir="ltr">{signedQty(l.difference)}</td>}
              <td style={cell}>{!l.receiving ? "—" : l.receiving.decision === "DISPUTED" ? "مرفوض" : l.receiving.incomingCounted === null ? "بدون عدّ مستقل" : <span dir="ltr">{qty(l.receiving.incomingCounted)}</span>}</td>
              {withFigures && <td style={cell} dir="ltr">{l.receiving && l.receiving.incomingCounted !== null ? signedQty(l.receiving.difference) : "—"}</td>}
              {withFigures && <td style={cell}>{l.costAvailable && l.costImpact !== null ? <span dir="ltr">{qty(l.costImpact)}</span> : l.difference ? "غير متاحة" : "—"}</td>}
            </tr>)}</tbody>
          </table>
        </div>}
        {coveredShifts.length > 1 && <div style={{ marginTop: 6 }}>
          <p style={{ margin: "4px 0", fontWeight: 600 }}>الفترة دي بتغطي {coveredShifts.length} شيفتات:</p>
          <p style={{ margin: 0, color: "#52525b" }}>{coveredShifts.map((s) => `#${s.shiftNumber} ${s.cashierName}`).join("، ")}</p>
        </div>}
        {(lines.some((l) => l.difference) || lines.some((l) => l.receiving?.difference)) && <p style={{ margin: "6px 0 0", color: "#52525b" }}>
          {coveredShifts.length > 1 ? "الفرق للفترة كلها، والمسؤولية غير محددة." : "المسؤولية غير محددة — تسجيل الفرق مش خصم."}
        </p>}
      </div>
    </Section>
  );
}
