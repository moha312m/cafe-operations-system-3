"use client";

import { useCallback, useEffect, useState } from "react";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { ShiftControls, type Shift } from "@/components/pos/shift-controls";
import { PageHeader, StatCard } from "@/components/cafe/ui";

// Single source of truth: ShiftControls fetches the active shift once and
// hands the full object up via onActiveChange. The page derives its stat
// cards from that — no separate fetch, so there's no refetch/re-render loop
// and the layout stays stable.
export default function CurrentShiftPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const [branchId, setBranchId] = useState<string>(user.branchId ?? "");
  const [shift, setShift] = useState<Shift | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Resolve a branch for non-pinned staff (owners/managers) — runs once.
  useEffect(() => {
    if (user.branchId) return;
    api<{ branches: { id: string }[] }>("/api/branches")
      .then((r) => r.branches[0] && setBranchId(r.branches[0].id))
      .catch(() => {});
  }, [user.branchId]);

  // Stable callback — never changes identity, so ShiftControls' internal
  // effect runs only when branchId changes (not on every render).
  const handleActive = useCallback((_active: boolean, s?: Shift | null) => {
    setShift(s ?? null);
    setLoaded(true);
  }, []);

  const stats = shift
    ? [
        { label: t.shifts.openingCash, value: money(shift.openingCashAmount, currency), icon: "🔓", accent: "slate" as const },
        { label: t.shifts.totalSales, value: money(shift.totalSales, currency), icon: "💵", accent: "emerald" as const },
        { label: t.shifts.cashSales, value: money(shift.totalCashSales, currency), icon: "💰", accent: "emerald" as const },
        { label: t.shifts.cardSales, value: money(shift.totalCardSales, currency), icon: "💳", accent: "blue" as const },
        { label: t.shifts.walletSales, value: money(shift.totalWalletSales, currency), icon: "📱", accent: "violet" as const },
        { label: t.shifts.discounts, value: money(shift.totalDiscounts, currency), icon: "🏷️", accent: "amber" as const },
        { label: t.shifts.refunds, value: money(shift.totalRefunds, currency), icon: "↩️", accent: "red" as const },
        { label: t.shifts.orderCount, value: String(shift.orderCount), icon: "🧾", accent: "blue" as const },
        { label: t.shifts.expectedCash, value: money(shift.expectedCashAmount, currency), icon: "🧮", accent: "emerald" as const },
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t.shifts.current} subtitle={t.shifts.details} />

      {branchId ? (
        <ShiftControls
          branchId={branchId}
          currency={currency}
          onActiveChange={handleActive}
        />
      ) : (
        <div className="h-[52px] animate-pulse rounded-xl border border-dashed bg-muted/30" />
      )}

      {/* Fixed-height grid area — shows skeletons, stats, or the gate hint
          without the container height jumping between states. */}
      <div className="mt-4">
        {!loaded ? (
          <StatGrid>
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-[92px] animate-pulse rounded-2xl border border-border bg-card" />
            ))}
          </StatGrid>
        ) : shift ? (
          <StatGrid>
            {stats.map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} accent={s.accent} />
            ))}
          </StatGrid>
        ) : (
          <div className="rounded-2xl border border-dashed bg-muted/20 py-12 text-center text-sm text-muted-foreground">
            {t.shifts.mustOpen}
          </div>
        )}
      </div>
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">{children}</div>;
}
