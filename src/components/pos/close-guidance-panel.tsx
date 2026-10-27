"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  clearCloseOutcome, countAction, handoverPhaseLabel, loadCloseOutcome, shiftPhase, SHIFT_PHASE_LABEL,
  type ReadinessView, type StorageScope,
} from "@/lib/close-guidance";

/**
 * What stands in the way of closing, in the server's own findings, with a cause, who can fix it, and real destinations.
 * `view.status` keeps five situations apart — not yet checked, checking, check failed, found blockers, found none — because "no findings" must only
 * ever mean a real, fresh, successful check came back empty. `source` says whether the findings came from the read-only readiness read
 * ("readiness") or from a close the server actually refused ("refusal"). Nothing here submits or simulates a close, and nothing claims that
 * anybody was notified.
 */
export function CloseGuidancePanel({ view, source, rechecking, onRecheck, restored }: {
  view: ReadinessView;
  source: "readiness" | "refusal";
  rechecking: boolean;
  onRecheck: () => void;
  restored: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const { status, items } = view;
  // A refusal appears where the confirm button is; make sure it is actually on screen when it arrives.
  useEffect(() => {
    if (source === "refusal" && items.length > 0) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [source, items.length]);
  const time = view.checkedAt ? new Date(view.checkedAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }) : null;
  const tone = status === "clear" ? "border-emerald-500/30 bg-emerald-500/5"
    : status === "failed" ? "border-destructive/40 bg-destructive/5"
    : status === "blockers" ? "border-amber-500/40 bg-amber-500/10"
    : "border-border bg-muted/30";
  const headline = source === "refusal" && items.length > 0 ? "الخادم رفض القفل للأسباب دي"
    : status === "loading" ? "جاري فحص جاهزية التسليم…"
    : status === "unchecked" ? "لم يتم فحص جاهزية التسليم بعد"
    : status === "failed" ? "تعذّر فحص جاهزية التسليم — لم يتم التأكد من أي شيء"
    : status === "not_applicable" ? "التسليم غير مفعّل في هذا الفرع — لا توجد فحوص تسليم"
    : status === "clear" ? "الخادم لم يجد عوائق تسليم تشغيلية الآن"
    : "قبل ما تقفل — الخادم لقى:";
  return (
    <section
      ref={ref}
      data-testid="close-guidance"
      data-source={source}
      data-status={source === "refusal" ? "refusal" : status}
      aria-label="جاهزية قفل الشيفت"
      aria-busy={status === "loading" || rechecking}
      className={"space-y-2 rounded-lg border p-3 text-sm " + (source === "refusal" ? "border-amber-500/40 bg-amber-500/10" : tone)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium" role={status === "loading" ? "status" : undefined}>{headline}</p>
        <Button type="button" size="sm" variant="outline" className="ms-auto" disabled={rechecking || status === "loading"} onClick={onRecheck} data-testid="close-guidance-recheck">
          {rechecking || status === "loading" ? "جاري التحقق…" : status === "failed" ? "أعد المحاولة" : "تحقق من الحالة الآن"}
        </Button>
      </div>
      {restored && (
        <p data-testid="close-draft-restored" className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs text-sky-900 dark:text-sky-200">
          استُرجعت القيم اللي كنت كتبتها في القفل قبل ما تغادر الشاشة. راجعها قبل التأكيد — مفيش قيمة اتملت من أرقام النظام.
        </p>
      )}
      {status === "failed" && source === "readiness" && (
        <p role="alert" data-testid="close-guidance-error" className="text-xs text-destructive">
          {view.message ? `${view.message}. ` : ""}ده مش معناه إن مفيش عوائق — الفحص نفسه ما اكتملش. تقدر تعيد المحاولة.
        </p>
      )}
      {status === "failed" && items.length > 0 && source === "readiness" && (
        <p className="text-xs text-muted-foreground">اللي ظاهر تحت من قراءة إعدادات التسليم فقط (غير مؤكد بالفحص الكامل):</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.key} data-testid="close-guidance-item" data-code={i.code} className="space-y-1 rounded-md border bg-background/60 p-2">
              <p className="font-medium">{i.title}{i.count > 1 ? ` (${i.count})` : ""}</p>
              <p>{i.cause}{i.refs.length > 0 ? ` ${i.refs.join("، ")}${i.count > i.refs.length ? ` و${i.count - i.refs.length} غيرهم` : ""}` : ""}</p>
              <p className="text-xs text-muted-foreground">المسؤول عن الحل: {i.role}</p>
              {i.actions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {i.actions.map((a) => (
                    <Link key={a.href} href={a.href} className={buttonVariants({ size: "sm", variant: "outline" })} data-testid="close-guidance-action">{a.label}</Link>
                  ))}
                </div>
              )}
              {i.note && <p data-testid="close-guidance-note" className="text-xs">{i.note}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {source === "refusal" ? "من رد الخادم على محاولة القفل."
          : status === "clear" ? "ده فحص لعوائق التسليم التشغيلية بس (أوردرات، مشتريات، جرد وتصحيحات، تسليم مفتوح، إعداد التسليم). مش معناه إن الإقفال المالي جاهز: النقدية والبطاقة والمحفظة والصلاحيات يقرّرها الخادم عند التأكيد."
          : "قراءة فقط من الخادم — لا تقفل ولا تغيّر أي شيء."}
        {time ? ` آخر فحص ${time}.` : ""} القرار النهائي دايمًا للخادم عند الضغط على «تأكيد القفل».
      </p>
    </section>
  );
}

type HandoverView = {
  handoverId: string; status: string; branchId: string; outgoingUserId: string;
  requiredItems: { inventoryItemId: string; itemNameSnapshot: string; unitSnapshot: string }[];
  count: { sessionId: string; status: string } | null;
};

/**
 * Keeps "settled, not discharged" visible after the close dialog is gone: it remembers (this tab only) which handover the last close created, and
 * re-reads that handover from the server whenever it is shown. If the server says the handover is complete the note is dropped; if this account
 * cannot read handovers it says so instead of guessing.
 */
export function PendingCloseBanner({ branchId, refreshKey }: { branchId: string; refreshKey: number }) {
  const { canKey, user, cafe } = useApp();
  const cafeId = cafe?.id ?? "";
  const userId = user.id;
  const scopeId = `${cafeId}|${userId}|${branchId}`;
  // Everything the banner shows is stamped with the scope it was read for, and ignored once the café, user or branch has changed — so an account
  // switch can never render the previous account's note, not even for the one tick before the next check runs.
  const [state, setState] = useState<{ scope: string; note: ReturnType<typeof loadCloseOutcome>; view: HandoverView | null; error: string | null; loading: boolean } | null>(null);
  const sequence = useRef(0);
  const current = state && state.scope === scopeId ? state : null;
  const note = current?.note ?? null;
  const view = current?.view ?? null;
  const error = current?.error ?? null;
  const loading = current?.loading ?? false;

  const check = useCallback(async () => {
    const mine = ++sequence.current;
    const storage = typeof window === "undefined" ? null : window.sessionStorage;
    const scope: StorageScope = { cafeId, userId, branchId };
    const found = loadCloseOutcome(storage, scope, Date.now());
    const publish = (patch: { note?: ReturnType<typeof loadCloseOutcome>; view?: HandoverView | null; error?: string | null; loading?: boolean }) => {
      if (mine !== sequence.current) return; // superseded by a newer check (or by a scope change)
      setState((prev) => ({ scope: scopeId, note: found, view: null, error: null, loading: false, ...(prev && prev.scope === scopeId ? prev : {}), ...patch }));
    };
    setState({ scope: scopeId, note: found, view: null, error: null, loading: false });
    if (!found || !canKey("handover.view")) return;
    publish({ loading: true });
    try {
      const { handover } = await api<{ handover: HandoverView }>(`/api/handovers/${found.handoverId}`);
      if (handover.branchId !== branchId) throw new Error("التسليم لا يخص هذا الفرع");
      if (handoverPhaseLabel(handover.status).complete) { clearCloseOutcome(storage, scope); publish({ note: null, loading: false }); return; }
      publish({ view: handover, loading: false });
    } catch (e) {
      publish({ error: e instanceof Error ? e.message : "تعذر قراءة حالة التسليم", loading: false });
    }
  }, [branchId, canKey, cafeId, userId, scopeId]);

  // Deferred one tick: the check reads this tab's storage and then the server, and sets state with the answers.
  useEffect(() => {
    const id = setTimeout(() => void check(), 0);
    return () => { clearTimeout(id); sequence.current += 1; };
  }, [check, refreshKey]);

  if (!note) return null;
  const phase = SHIFT_PHASE_LABEL[shiftPhase("AWAITING_HANDOVER")!];
  const canWork = canKey("handover.submit") && !!view && view.outgoingUserId === user.id;
  const action = canKey("handover.view") ? countAction(branchId, note.handoverId, view, canWork) : null;
  return (
    <section data-testid="pending-close-banner" aria-label="حالة الشيفت المقفول ماليًا" className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">{note.shiftNumber ? `شيفت #${note.shiftNumber}: ` : ""}{phase.label}</p>
      <p className="text-xs">{phase.detail}</p>
      {view && <p data-testid="pending-close-phase">{handoverPhaseLabel(view.status).label}</p>}
      {view && view.requiredItems.length > 0 && (
        <p data-testid="pending-close-items" className="text-xs">أصناف مطلوب جردها: {view.requiredItems.map((i) => `${i.itemNameSnapshot} (${i.unitSnapshot})`).join(" · ")}</p>
      )}
      {!canKey("handover.view") && <p className="text-xs">حسابك لا يملك صلاحية عرض التسليم؛ اسأل المدير أو المالك عن حالته.</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {action && <Link href={action.href} className={buttonVariants({ size: "sm" })} data-testid="pending-close-action">{action.label}</Link>}
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void check()}>{loading ? "جاري التحقق…" : "تحديث الحالة"}</Button>
      </div>
    </section>
  );
}
