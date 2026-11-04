"use client";

// Presentation pieces of the handover workspace. They hold no business rule: every figure comes
// from the server payload or the journey model, and every action is the server's own endpoint.
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TONE_SIDE, TONE_SURFACE, TONE_TOP, type Tone } from "@/components/ui/tone";
import type { Journey, Panel, Stage, StageState } from "./handover-journey";
import type { ActivityEvent } from "@/lib/handover-activity";

export const PANEL_LABEL: Record<Panel, string> = {
  summary: "الملخص", cash: "المال والمدفوعات", inventory: "الجرد", place: "المكان والأجهزة", orders: "الطلبات المنقولة", activity: "النشاط والتوقيعات",
};
export const PANELS: Panel[] = ["summary", "cash", "inventory", "place", "orders", "activity"];

export function fmtDateTime(value: string | null | undefined, tz: string) {
  if (!value) return "لم يتم";
  try { return new Intl.DateTimeFormat("ar-EG", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return new Date(value).toLocaleString("ar-EG"); }
}

const STATE_LABEL: Record<StageState, string> = { done: "تم", current: "المطلوب الآن", pending: "لاحقًا", blocked: "متوقف", skipped: "غير لازم" };
const STATE_TONE: Record<StageState, Tone | null> = { done: "sage", current: "tide", pending: null, blocked: "clay", skipped: null };

export function TabBar({ active, onChange, counts }: { active: Panel; onChange: (p: Panel) => void; counts: Partial<Record<Panel, number | null>> }) {
  return (
    <div role="tablist" aria-label="أقسام التسليم" className="flex gap-1 overflow-x-auto border-b" data-testid="handover-tabs">
      {PANELS.map((p) => (
        <button key={p} type="button" role="tab" id={`handover-tab-${p}`} aria-selected={active === p} aria-controls={`handover-panel-${p}`} tabIndex={active === p ? 0 : -1}
          onClick={() => onChange(p)}
          onKeyDown={(e) => {
            const i = PANELS.indexOf(p);
            const next = e.key === "ArrowLeft" ? PANELS[(i + 1) % PANELS.length] : e.key === "ArrowRight" ? PANELS[(i + PANELS.length - 1) % PANELS.length] : null;
            if (next) { e.preventDefault(); onChange(next); requestAnimationFrame(() => document.getElementById(`handover-tab-${next}`)?.focus()); }
          }}
          className={cn("min-h-11 shrink-0 whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium", active === p ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {PANEL_LABEL[p]}{counts[p] ? <span className="ms-1.5 rounded-full bg-primary/10 px-1.5 text-xs tabular-nums text-primary">{counts[p]}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SummaryCard({ title, value, lines, tone, panel, onOpen }: { title: string; value: string; lines: string[]; tone: Tone; panel: Panel; onOpen: (p: Panel) => void }) {
  return (
    <button type="button" onClick={() => onOpen(panel)} className={cn("min-w-0 rounded-xl border p-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2", TONE_SURFACE[tone], TONE_TOP[tone])} data-testid={`handover-card-${panel}`}>
      <p className="text-xs font-medium opacity-80">{title}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums [overflow-wrap:anywhere]">{value}</p>
      {lines.map((l) => <p key={l} className="text-xs opacity-80 [overflow-wrap:anywhere]">{l}</p>)}
      <p className="mt-1 text-xs font-medium underline">افتح: {PANEL_LABEL[panel]}</p>
    </button>
  );
}

const STATUS_BADGE: Record<"done" | "pending" | "rejected" | "operational" | "none", string> = {
  done: `${TONE_SURFACE.sage} ${TONE_SIDE.sage}`, operational: `${TONE_SURFACE.sage} ${TONE_SIDE.sage}`,
  pending: `${TONE_SURFACE.caramel} ${TONE_SIDE.caramel}`, rejected: `${TONE_SURFACE.clay} ${TONE_SIDE.clay}`, none: "bg-muted/40",
};

/** The three facts that are easy to confuse, side by side. */
export function JourneyStatus({ journey }: { journey: Journey }) {
  const items: { key: string; heading: string; label: string; state: keyof typeof STATUS_BADGE }[] = [
    { key: "closure", heading: "الإقفال المالي للشيفت المُسلّم", label: journey.closure.label, state: journey.closure.state },
    { key: "completion", heading: "تسليم العهدة", label: journey.completion.label, state: journey.completion.state },
    { key: "readiness", heading: "جاهزية الشيفت المستلم", label: journey.readiness.label, state: journey.readiness.state },
  ];
  return (
    <ul className="grid gap-2 sm:grid-cols-3" aria-label="حالة التسليم" data-testid="handover-journey-status">
      {items.map((i) => (
        <li key={i.key} className={cn("rounded-xl border p-2.5", STATUS_BADGE[i.state])}>
          <p className="text-xs opacity-80">{i.heading}</p>
          <p className="font-semibold">{i.label}</p>
          {i.key === "readiness" && journey.readiness.remaining.length > 0 && <p className="mt-0.5 text-xs">لسه: {journey.readiness.remaining.join(" · ")}</p>}
        </li>
      ))}
    </ul>
  );
}

export function StageList({ stages, onOpen }: { stages: Stage[]; onOpen: (p: Panel) => void }) {
  const groups: { id: Stage["group"]; title: string }[] = [
    { id: "closure", title: "إقفال الشيفت المُسلّم" }, { id: "handover", title: "تسليم العهدة" }, { id: "readiness", title: "جاهزية الشيفت المستلم" },
  ];
  return (
    <div className="space-y-3" data-testid="handover-stage-list">
      {groups.map((g) => {
        const rows = stages.filter((s) => s.group === g.id);
        if (rows.length === 0) return null;
        return (
          <section key={g.id} aria-label={g.title}>
            <h3 className="mb-1 text-sm font-semibold">{g.title}</h3>
            <ol className="space-y-1">
              {rows.map((s) => {
                const tone = STATE_TONE[s.state];
                return (
                  <li key={s.id} aria-current={s.state === "current" ? "step" : undefined} className={cn("flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border p-2", tone ? `${TONE_SURFACE[tone]} ${TONE_SIDE[tone]}` : "bg-muted/20")}>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <span className="font-medium">{s.state === "done" ? "✓ " : ""}{s.label}</span>
                      <span className="block text-xs opacity-80">المسؤول: {s.actor}{s.note ? ` — ${s.note}` : ""}</span>
                    </span>
                    <Badge className="shrink-0 bg-background/60 text-foreground hover:bg-background/60">{STATE_LABEL[s.state]}</Badge>
                    {s.state !== "done" && s.state !== "skipped" && <Button size="sm" variant="outline" className="min-h-9" onClick={() => onOpen(s.panel)}>افتح</Button>}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

export function ActivityPanel({ events, tz }: { events: ActivityEvent[]; tz: string }) {
  if (events.length === 0) return <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="handover-activity-empty">لا يوجد سجل نشاط لهذا التسليم. التسليمات القديمة قد لا يكون لها سجل لبعض الخطوات؛ ما بنخمّنش أحداث ما اتسجلتش.</p>;
  return (
    <ol className="space-y-2" data-testid="handover-activity">
      {events.map((e, i) => (
        <li key={`${e.at}:${e.action}:${i}`} className="rounded-lg border bg-muted/20 p-2">
          <p className="font-medium [overflow-wrap:anywhere]">{e.label}</p>
          <p className="text-xs text-muted-foreground">{fmtDateTime(e.at, tz)} · {e.actor ?? "غير معروف"}{e.detail ? ` — ${e.detail}` : ""}</p>
        </li>
      ))}
    </ol>
  );
}
