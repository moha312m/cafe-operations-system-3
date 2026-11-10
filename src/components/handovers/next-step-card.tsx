"use client";

// «المطلوب منك دلوقتي» — the one card at the top of /handovers. It shows the
// step due now and lists what comes after it; every panel with nothing waiting
// stays off the page. Navigation only: the button brings the panel that does
// the work into view.
import { Button } from "@/components/ui/button";
import { nextSteps, stepAnchor, STEP_LABEL, type PendingReports, type PendingSource } from "./next-step-model";

export function NextStepCard({ reports, sources, onOpen }: {
  reports: PendingReports;
  sources: PendingSource[];
  /** Overrides scrolling for a source (the handover step selects the handover instead). */
  onOpen?: (source: PendingSource) => boolean;
}) {
  const { steps, failed, checking } = nextSteps(reports, sources);
  const open = (source: PendingSource) => {
    if (onOpen?.(source)) return;
    const target = document.getElementById(stepAnchor(source));
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const [now, ...later] = steps;
  return (
    <section className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-4" aria-label="المطلوب منك دلوقتي" data-testid="handover-next-step">
      <p className="text-xs font-medium text-muted-foreground">المطلوب منك دلوقتي</p>
      {now ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere]" data-testid="handover-next-step-title">{now.title}</p>
          <Button className="min-h-11" onClick={() => open(now.source)} data-testid="handover-next-step-open">{now.action}</Button>
        </div>
      ) : checking ? (
        <p className="text-sm text-muted-foreground" role="status">جاري فحص المطلوب…</p>
      ) : (
        <div role="status" data-testid="handover-next-step-idle">
          <p className="text-base font-semibold">مفيش حاجة مستنياك دلوقتي ✓</p>
          <p className="text-sm text-muted-foreground">مفيش مهام تسليم واستلام مطلوبة منك شخصيًا هنا. ممكن يفضل إجراء على عهدة الفرع محتاج متابعة من مسؤول تاني.</p>
        </div>
      )}
      {later.length > 0 && (
        <ul className="space-y-1 border-t pt-2 text-sm" aria-label="بعدها">
          {later.map((s) => (
            <li key={s.source} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">بعدها:</span>
              <span className="font-medium">{s.title}</span>
              <button type="button" className="text-primary underline" onClick={() => open(s.source)}>{s.action}</button>
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && <p className="text-xs text-destructive" role="alert">تعذّر فحص: {failed.map((s) => STEP_LABEL[s]).join("، ")} — التفاصيل تحت.</p>}
    </section>
  );
}
