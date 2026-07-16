"use client";

// Shared building blocks for the Super Admin (platform owner) panel.
// Deliberately a different visual identity from the cafe dashboard:
// deep-indigo accents, generous spacing, dependency-free inline-SVG charts.

import { cn } from "@/lib/utils";
import { money } from "@/lib/client";

// ── Page header ──────────────────────────────────────────────
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight text-slate-900">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

// ── Stat card ────────────────────────────────────────────────
export function StatCard({
  label,
  value,
  icon,
  hint,
  accent = "indigo",
}: {
  label: string;
  value: string | number;
  icon?: string;
  hint?: string;
  accent?: "indigo" | "emerald" | "amber" | "rose" | "slate" | "violet";
}) {
  const ring: Record<string, string> = {
    indigo: "text-indigo-600 bg-indigo-50",
    emerald: "text-emerald-600 bg-emerald-50",
    amber: "text-amber-600 bg-amber-50",
    rose: "text-rose-600 bg-rose-50",
    slate: "text-slate-600 bg-slate-100",
    violet: "text-violet-600 bg-violet-50",
  };
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="min-w-0">
        <p className="text-xs font-medium leading-snug text-slate-500">{label}</p>
        <p className="mt-1 truncate text-2xl font-bold tabular-nums text-slate-900">
          {value}
        </p>
        {hint && <p className="mt-1 line-clamp-2 text-xs text-slate-400">{hint}</p>}
      </div>
      {icon && (
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl text-lg",
            ring[accent]
          )}
        >
          {icon}
        </span>
      )}
    </div>
  );
}

// ── Panel (card container) ───────────────────────────────────
export function Panel({
  title,
  action,
  className,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-slate-200 bg-white shadow-sm",
        className
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          {title && (
            <h2 className="font-heading text-sm font-semibold text-slate-800">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// ── Status badges ────────────────────────────────────────────
export function StatusPill({
  active,
  labels,
}: {
  active: boolean;
  labels: { on: string; off: string };
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        active
          ? "bg-emerald-50 text-emerald-700"
          : "bg-rose-50 text-rose-700"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          active ? "bg-emerald-500" : "bg-rose-500"
        )}
      />
      {active ? labels.on : labels.off}
    </span>
  );
}

const SUB_TONES: Record<string, string> = {
  TRIAL: "bg-sky-50 text-sky-700",
  ACTIVE: "bg-emerald-50 text-emerald-700",
  EXPIRED: "bg-amber-50 text-amber-700",
  SUSPENDED: "bg-rose-50 text-rose-700",
};

export function SubscriptionBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        SUB_TONES[status] ?? "bg-slate-100 text-slate-700"
      )}
    >
      {label}
    </span>
  );
}

// ── Empty state ──────────────────────────────────────────────
export function EmptyState({ message, icon = "🗂️" }: { message: string; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <span className="text-3xl opacity-60">{icon}</span>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}

// ── Loading skeleton row ─────────────────────────────────────
export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-400">
      <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
      {label}
    </div>
  );
}

// ── Bar chart (inline SVG, RTL-friendly) ─────────────────────
export function BarChart({
  data,
  color = "#4f46e5",
  format = "number",
}: {
  data: { label: string; value: number }[];
  color?: string;
  format?: "number" | "money";
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end justify-between gap-2" dir="ltr">
      {data.map((d, i) => {
        const h = Math.round((d.value / max) * 100);
        return (
          <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex h-32 w-full items-end justify-center">
              <div
                className="w-full max-w-9 rounded-t-md transition-all"
                style={{
                  height: `${Math.max(h, 2)}%`,
                  backgroundColor: color,
                  opacity: 0.45 + (h / 100) * 0.55,
                }}
                title={format === "money" ? money(d.value) : String(d.value)}
              />
            </div>
            <span className="text-[10px] font-medium text-slate-500">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Horizontal ranking bars (top cafes) ──────────────────────
export function RankBars({
  data,
  format = "money",
}: {
  data: { label: string; value: number }[];
  format?: "number" | "money";
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <EmptyState message="—" icon="📊" />;
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate font-medium text-slate-700">{d.label}</span>
            <span className="shrink-0 tabular-nums text-slate-500">
              {format === "money" ? money(d.value) : d.value}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{ width: `${Math.max((d.value / max) * 100, 3)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Donut (payment split) ────────────────────────────────────
const DONUT_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#f43f5e"];

export function Donut({
  data,
}: {
  data: { label: string; value: number }[];
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <EmptyState message="—" icon="🥧" />;
  const r = 42;
  const c = 2 * Math.PI * r;
  // Precompute each segment's dash length and cumulative start offset with
  // pure prefix sums so nothing is mutated during render (compiler-safe).
  const dashes = data.map((d) => (d.value / total) * c);
  const segments = dashes.map((dash, i) => ({
    dash,
    offset: dashes.slice(0, i).reduce((a, b) => a + b, 0),
  }));
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 100 100" className="size-28 shrink-0 -rotate-90">
        {segments.map((s, i) => (
          <circle
            key={i}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="12"
            strokeDasharray={`${s.dash} ${c - s.dash}`}
            strokeDashoffset={-s.offset}
          />
        ))}
      </svg>
      <ul className="space-y-1.5 text-xs">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
            />
            <span className="text-slate-600">{d.label}</span>
            <span className="tabular-nums text-slate-400">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
