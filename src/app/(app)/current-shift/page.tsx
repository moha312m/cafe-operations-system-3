"use client";

import { useCallback, useEffect, useState } from "react";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { ShiftControls } from "@/components/pos/shift-controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Shift = {
  id: string;
  shiftNumber: number;
  openedAt: string;
  openingCashAmount: string;
  expectedCashAmount: string;
  totalSales: string;
  totalCashSales: string;
  totalCardSales: string;
  totalWalletSales: string;
  totalDiscounts: string;
  totalRefunds: string;
  orderCount: number;
};

export default function CurrentShiftPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "USD";
  const [branchId, setBranchId] = useState<string>(user.branchId ?? "");
  const [shift, setShift] = useState<Shift | null>(null);

  // Resolve a branch for non-pinned staff (owners/managers).
  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: { id: string }[] }>("/api/branches")
        .then((r) => r.branches[0] && setBranchId(r.branches[0].id))
        .catch(() => {});
    }
  }, [user.branchId]);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const { shift } = await api<{ shift: Shift | null }>(
        `/api/shifts/active?branchId=${branchId}`
      );
      setShift(shift);
    } catch {
      setShift(null);
    }
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = shift
    ? [
        { label: t.shifts.openingCash, value: money(shift.openingCashAmount, currency) },
        { label: t.shifts.totalSales, value: money(shift.totalSales, currency) },
        { label: t.shifts.cashSales, value: money(shift.totalCashSales, currency) },
        { label: t.shifts.cardSales, value: money(shift.totalCardSales, currency) },
        { label: t.shifts.walletSales, value: money(shift.totalWalletSales, currency) },
        { label: t.shifts.discounts, value: money(shift.totalDiscounts, currency) },
        { label: t.shifts.refunds, value: money(shift.totalRefunds, currency) },
        { label: t.shifts.orderCount, value: String(shift.orderCount) },
        {
          label: t.shifts.expectedCash,
          value: money(shift.expectedCashAmount, currency),
        },
      ]
    : [];

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">{t.shifts.current}</h1>

      {branchId && (
        <ShiftControls
          branchId={branchId}
          currency={currency}
          onActiveChange={() => load()}
        />
      )}

      {shift ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((s) => (
            <Card key={s.label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-normal text-muted-foreground">
                  {s.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t.shifts.mustOpen}</p>
      )}
    </div>
  );
}
