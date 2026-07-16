"use client";

// Shared UI kit for the cafe operations app (owner/manager/staff).
// Theme-token based so it adapts to light/dark; semantic accent colors
// for status. Arabic-RTL friendly (logical properties, no truncated money).

import type { OrderStatus, OrderSource } from "@prisma/client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ── Page header ──────────────────────────────────────────────
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// ── Stat card ────────────────────────────────────────────────
const ACCENTS: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  slate: "bg-foreground/5 text-foreground/70",
};

export function StatCard({
  label,
  value,
  icon,
  hint,
  accent = "slate",
  href,
}: {
  label: string;
  value: string | number;
  icon?: string;
  hint?: React.ReactNode;
  accent?: keyof typeof ACCENTS;
  href?: string;
}) {
  const inner = (
    <div className="flex h-full items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="min-w-0">
        <p className="text-xs font-medium leading-snug text-muted-foreground">{label}</p>
        <p className="mt-1.5 text-2xl font-bold tabular-nums text-foreground">{value}</p>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </div>
      {icon && (
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl text-lg", ACCENTS[accent])}>
          {icon}
        </span>
      )}
    </div>
  );
  if (href) return <a href={href} className="block">{inner}</a>;
  return inner;
}

// ── Panel / ChartCard ────────────────────────────────────────
export function Panel({
  title,
  action,
  className,
  bodyClassName,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card shadow-sm", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b border-border/70 px-5 py-3.5">
          {title && <h2 className="font-heading text-sm font-semibold text-foreground">{title}</h2>}
          {action}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

// ── Status + source badges ───────────────────────────────────
const STATUS_TONE: Record<OrderStatus, string> = {
  PENDING_WAITER_APPROVAL: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  CONFIRMED: "bg-blue-500/12 text-blue-700 dark:text-blue-400",
  PREPARING: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  READY: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  SERVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  CANCELLED: "bg-foreground/8 text-muted-foreground",
  REJECTED: "bg-red-500/12 text-red-700 dark:text-red-400",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_TONE[status])}>
      {t.orderStatus[status]}
    </span>
  );
}

const SOURCE_TONE: Record<OrderSource, string> = {
  QR_MENU: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  WAITER: "bg-blue-500/12 text-blue-700 dark:text-blue-400",
  CASHIER_POS: "bg-foreground/8 text-foreground/70",
};

export function SourceBadge({ source }: { source: OrderSource }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", SOURCE_TONE[source])}>
      {t.orderSource[source]}
    </span>
  );
}

// Generic on/off pill.
export function StatusPill({ active, labels }: { active: boolean; labels: { on: string; off: string } }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        active ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-red-500/12 text-red-700 dark:text-red-400"
      )}
    >
      <span className={cn("size-1.5 rounded-full", active ? "bg-emerald-500" : "bg-red-500")} />
      {active ? labels.on : labels.off}
    </span>
  );
}

// ── Empty / loading states ───────────────────────────────────
export function EmptyState({ message, icon = "🗂️" }: { message: string; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <span className="text-3xl opacity-50">{icon}</span>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function LoadingState({ label = t.common.loading }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
      {label}
    </div>
  );
}

// ── Charts (inline SVG, dependency-free) ─────────────────────
export function BarChart({
  data,
  color = "var(--chart-bar, #0f766e)",
  format,
}: {
  data: { label: string; value: number; hint?: string }[];
  color?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end justify-between gap-2" dir="ltr">
      {data.map((d, i) => {
        const h = Math.round((d.value / max) * 100);
        return (
          <div key={i} className="group/bar flex flex-1 flex-col items-center gap-1.5">
            <div className="relative flex h-32 w-full items-end justify-center">
              <span className="pointer-events-none absolute -top-1 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs opacity-0 shadow-sm transition-opacity group-hover/bar:opacity-100">
                {format ? format(d.value) : d.value}
              </span>
              <div
                className="w-full max-w-9 rounded-t-md transition-all"
                style={{ height: `${Math.max(h, d.value > 0 ? 3 : 0)}%`, backgroundColor: color, opacity: 0.5 + (h / 100) * 0.5 }}
              />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function RankBars({
  data,
  format,
  emptyLabel = "—",
}: {
  data: { label: string; value: number }[];
  format?: (v: number) => string;
  emptyLabel?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <EmptyState message={emptyLabel} icon="📊" />;
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium text-foreground">{d.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{format ? format(d.value) : d.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500/80" style={{ width: `${Math.max((d.value / max) * 100, 3)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const DONUT_COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#d97706", "#dc2626"];

export function Donut({ data }: { data: { label: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <EmptyState message="—" icon="🥧" />;
  const r = 42;
  const c = 2 * Math.PI * r;
  const dashes = data.map((d) => (d.value / total) * c);
  const segments = dashes.map((dash, i) => ({ dash, offset: dashes.slice(0, i).reduce((a, b) => a + b, 0) }));
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 100 100" className="size-28 shrink-0 -rotate-90">
        {segments.map((s, i) => (
          <circle
            key={i}
            cx="50" cy="50" r={r} fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth="12"
            strokeDasharray={`${s.dash} ${c - s.dash}`} strokeDashoffset={-s.offset}
          />
        ))}
      </svg>
      <ul className="space-y-1.5 text-xs">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            <span className="text-foreground/80">{d.label}</span>
            <span className="tabular-nums text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
