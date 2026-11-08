"use client";

import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app-shell";
import { formatTime } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ISSUE_LABELS, statusLabel } from "@/components/accounting/accounting-shell";

type ChecklistItem = { key: string; label: string; status: "ok" | "warning" | "blocking"; detail: string };
type Overview =
  | { configured: false; notice: string }
  | {
      configured: true; notice: string; mode: "SHADOW";
      entity: { name: string; currency: string; accounts: number };
      branchScope: string | null;
      periods: { id: string; startsOn: string; endsOn: string; status: string }[];
      currentPeriod: { id: string; startsOn: string; endsOn: string; status: string } | null;
      lastProjection: { at: string; windowFrom: string; windowTo: string; posted: number; replayed: number; issues: number } | null;
      journal: { entries: number; lastEntryDate: string | null };
      openingBalances: { posted: boolean; date: string | null };
      issues: { byKind: Record<string, number>; open: { kind: string; severity: string; sourceKey: string; sourceType: string; reason: string; eventAt: string }[] };
      checklist: { canClose: boolean; checkedAt: string; items: ChecklistItem[] } | null;
    };

const STATUS_STYLE = { ok: "text-emerald-700 dark:text-emerald-400", warning: "text-amber-700 dark:text-amber-400", blocking: "text-red-700 dark:text-red-400" };
const STATUS_TEXT = { ok: "تمام", warning: "تنبيه", blocking: "يمنع القفل" };

export default function AccountingOverviewPage() {
  const { cafe } = useApp();
  const { data, error, loading, reload } = useAccountingData<Overview>("/api/accounting/overview");
  const currency = cafe?.currency ?? "EGP";

  if (error) return <div role="alert" className="workspace-state text-destructive"><p>{error}</p><Button variant="outline" disabled={loading} onClick={reload}>{loading ? "جارٍ إعادة التحميل…" : "إعادة المحاولة"}</Button></div>;
  if (!data) return <p role="status">{loading ? "جاري التحميل…" : ""}</p>;

  if (!data.configured) {
    return (
      <Card data-testid="accounting-unconfigured">
        <CardHeader><CardTitle>الدفاتر لسه ماتعملتش</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm leading-7">
          <p>مفيش دفاتر محاسبية للكافيه ده لحد دلوقتي. فتح الصفحة دي مش بيعمل دفاتر ولا بيرحّل أي حاجة.</p>
          <p>علشان تبدأ:</p>
          <ol className="list-decimal space-y-1 pe-6">
            <li>المحاسب يراجع دليل الحسابات المقترح وقواعد الترحيل.</li>
            <li>يتحدد تاريخ البداية ومين هيوقّع الأرصدة الافتتاحية.</li>
            <li>بعدها يتشغّل الترحيل التجريبي على فترة محددة، ويتراجع قبل أي اعتماد.</li>
          </ol>
        </CardContent>
      </Card>
    );
  }

  const blocking = data.checklist?.items.filter((i) => i.status === "blocking").length ?? 0;
  const stats = [
    { label: "الشركة", value: data.entity.name },
    { label: "العملة", value: data.entity.currency },
    { label: "نطاق الفروع", value: data.branchScope ? "فرعك بس" : "كل الفروع" },
    { label: "الفترة الحالية", value: data.currentPeriod ? `${data.currentPeriod.startsOn} ← ${data.currentPeriod.endsOn} (${statusLabel(data.currentPeriod.status)})` : "مفيش فترة" },
    { label: "عدد القيود", value: String(data.journal.entries) },
    { label: "آخر قيد", value: data.journal.lastEntryDate ?? "—" },
    { label: "آخر ترحيل تجريبي", value: data.lastProjection ? `${formatTime(data.lastProjection.at)} — ${data.lastProjection.posted} جديد` : "ماتشغلش لسه" },
    { label: "الأرصدة الافتتاحية", value: data.openingBalances.posted ? `متسجلة (${data.openingBalances.date})` : "مش متسجلة" },
    { label: "مشاكل ترحيل مفتوحة", value: String(data.issues.open.length) },
    { label: "بنود بتمنع القفل", value: data.checklist ? String(blocking) : "—" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-1"><CardTitle className="text-sm font-normal text-muted-foreground">{s.label}</CardTitle></CardHeader>
            <CardContent><p className="text-lg font-semibold" dir="auto">{s.value}</p></CardContent>
          </Card>
        ))}
      </div>

      {data.checklist && (
        <Card>
          <CardHeader><CardTitle className="text-base">حالة الفترة الحالية ومطابقة الحسابات</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">اتحسبت {formatTime(data.checklist.checkedAt)}. قفل الفترة الرسمي مقفول لحد اعتماد المحاسب.</p>
            <ul className="divide-y text-sm">
              {data.checklist.items.map((i) => (
                <li key={i.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span>{i.label}</span>
                  <span className={`font-medium ${STATUS_STYLE[i.status]}`}>{STATUS_TEXT[i.status]}{i.detail ? ` — ${i.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data.issues.open.length > 0 && (
      <Card>
        <CardHeader><CardTitle className="text-base">مشاكل الترحيل المفتوحة</CardTitle></CardHeader>
        <CardContent>
            <ul className="divide-y text-sm">
              {data.issues.open.map((i) => (
                <li key={`${i.kind}:${i.sourceKey}`} className="py-2">
                  <span className={i.severity === "BLOCKING" ? STATUS_STYLE.blocking : STATUS_STYLE.warning}>{ISSUE_LABELS[i.kind] ?? i.kind}</span>
                  {" — "}<span dir="auto">{i.reason}</span>
                  <span className="block text-xs text-muted-foreground" dir="ltr">{i.sourceKey} · {formatTime(i.eventAt)}</span>
                </li>
              ))}
            </ul>
        </CardContent>
      </Card>
      )}

      <p className="text-sm text-muted-foreground">كل المبالغ بعملة {currency}.</p>
    </div>
  );
}
