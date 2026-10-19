import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { resolvePermissions } from "@/lib/perms/effective";
import { buildShiftReport, type ShiftReport } from "@/lib/shift-report";
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

// تقرير قفل الشيفت — printable, READ-ONLY. Same reach as the shift detail:
// this café, this branch for branch-pinned staff, and only your own shift
// without `shifts.view_reports`.
export default async function ShiftReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return <Message text="سجّل دخولك الأول" />;

  const shift = await db.shift.findFirst({
    where: { id, cafeId: session.cafeId ?? "" },
    select: { branchId: true, cashierId: true },
  });
  if (!shift) return <Message text="الشيفت مش موجود" />;
  if (session.branchId && shift.branchId !== session.branchId) return <Message text="الشيفت تبع فرع تاني" />;
  const { keys } = await resolvePermissions(session);
  const oversight = keys.has("shifts.view_reports");
  if (!oversight && shift.cashierId !== session.id) return <Message text="ليس لديك صلاحية لعرض التقرير" />;

  const report: ShiftReport | null = await buildShiftReport(id, session.cafeId ?? "");
  if (!report) return <Message text="التقرير بيجهز بعد قفل الشيفت" />;
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
          <Row label="المتوقع في الدرج" value={fmt(report.cash.expected, c)} />
          <Row label="الفعلي (اتعد)" value={fmt(report.cash.actual, c)} />
          <Row
            label={`الفرق${report.cash.withinTolerance === null ? "" : report.cash.withinTolerance ? " (داخل السماح)" : " (خارج السماح)"}`}
            value={diff === null ? "—" : `${diff > 0 ? "+" : ""}${fmt(diff, c)}`}
            strong
            color={diffColor}
          />
          {report.cash.reasonNote && <p style={{ margin: "4px 0 0", color: "#52525b" }}>السبب: {report.cash.reasonNote}</p>}
        </Section>

        {report.tenders.length > 0 && (
          <Section title="💳 الفيزا والمحافظ">
            {report.tenders.map((t) => (
              <div key={t.method}>
                <Row label={`${METHOD_LABEL[t.method] ?? t.method}: متوقع ${fmt(t.expected, c)}`}
                  value={`فعلي ${fmt(t.actual, c)} (فرق ${fmt(t.variance, c)})`} />
                {t.reasonNote && <p style={{ margin: "4px 0 0", color: "#52525b" }}>السبب: {t.reasonNote}</p>}
              </div>
            ))}
          </Section>
        )}

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
            <Row label="الحالة" value={HANDOVER_LABEL[report.handover.status] ?? report.handover.status} />
            <Row label="المستلم" value={report.handover.incomingName ?? "—"} />
            <Row label="وقت الاستلام" value={fmtDate(report.handover.acceptedAt)} />
          </Section>
        )}
      </article>
    </main>
  );
}
