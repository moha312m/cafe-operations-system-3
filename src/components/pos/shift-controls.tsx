"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Shift = {
  id: string;
  shiftNumber: number;
  openedAt: string;
  openingCashAmount: string;
  expectedCashAmount: string;
  totalCashSales: string;
  totalCardSales: string;
  totalWalletSales: string;
  totalDiscounts: string;
  totalRefunds: string;
  orderCount: number;
  cashier: { name: string };
};

// Owns the POS shift lifecycle: fetches the cashier's open shift, renders the
// "open shift" gate or the open-shift top bar, and drives open/close modals.
export function ShiftControls({
  branchId,
  currency,
  onActiveChange,
}: {
  branchId: string;
  currency: string;
  onActiveChange: (hasActiveShift: boolean) => void;
}) {
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [closeDialog, setCloseDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const setActive = useCallback(
    (s: Shift | null) => {
      setShift(s);
      onActiveChange(s !== null);
    },
    [onActiveChange]
  );

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const { shift } = await api<{ shift: Shift | null }>(
        `/api/shifts/active?branchId=${branchId}`
      );
      setActive(shift);
    } catch {
      setActive(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, setActive]);

  useEffect(() => {
    load();
  }, [load]);

  async function openShift() {
    setBusy(true);
    try {
      const { shift: s, alreadyOpen } = await api<{ shift: Shift; alreadyOpen?: boolean }>(
        "/api/shifts",
        {
          method: "POST",
          body: { branchId, openingCashAmount: Number(openingCash) || 0 },
        }
      );
      setActive(s);
      setOpenDialog(false);
      setOpeningCash("");
      toast.success(alreadyOpen ? t.shifts.alreadyOpen : t.shifts.openedSuccess);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل فتح الشيفت");
    } finally {
      setBusy(false);
    }
  }

  async function openCloseDialog() {
    // Refresh figures so the reconciliation summary is current.
    try {
      const { shift: s } = await api<{ shift: Shift | null }>(
        `/api/shifts/active?branchId=${branchId}`
      );
      if (s) setShift(s);
    } catch {
      /* keep cached */
    }
    setActualCash("");
    setNotes("");
    setCloseDialog(true);
  }

  async function closeShift() {
    if (!shift) return;
    setBusy(true);
    try {
      await api(`/api/shifts/${shift.id}/close`, {
        method: "POST",
        body: { actualCashAmount: Number(actualCash) || 0, notes: notes.trim() || undefined },
      });
      const diff = (Number(actualCash) || 0) - Number(shift.expectedCashAmount);
      const msg =
        Math.abs(diff) < 0.01
          ? t.shifts.matched
          : diff > 0
            ? `${t.shifts.surplus} ${money(diff, currency)}`
            : `${t.shifts.shortage} ${money(-diff, currency)}`;
      toast.success(`${t.shifts.closedSuccess} · ${msg}`);
      setCloseDialog(false);
      setActive(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل قفل الشيفت");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  const expected = shift ? Number(shift.expectedCashAmount) : 0;
  const diffPreview = (Number(actualCash) || 0) - expected;

  return (
    <>
      {shift ? (
        // ── Open-shift top bar ──
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-2.5 shadow-sm">
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
            ● {t.shifts.shiftOpen}
          </Badge>
          <span className="text-sm font-medium">
            #{shift.shiftNumber} · {shift.cashier.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.shifts.openedAt}: {new Date(shift.openedAt).toLocaleTimeString("ar-EG", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.shifts.expectedCash}: {money(shift.expectedCashAmount, currency)}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={openCloseDialog}
          >
            {t.shifts.close}
          </Button>
        </div>
      ) : (
        // ── Gate ──
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3">
          <span className="text-sm font-medium text-muted-foreground">
            🔒 {t.shifts.mustOpen}
          </span>
          <Button size="sm" className="ms-auto" onClick={() => setOpenDialog(true)}>
            {t.shifts.open}
          </Button>
        </div>
      )}

      {/* Open shift dialog */}
      <Dialog open={openDialog} onOpenChange={(o) => !busy && setOpenDialog(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t.shifts.open}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{t.shifts.openingCash}</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              dir="ltr"
              placeholder="0.00"
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button className="w-full" disabled={busy} onClick={openShift}>
              {t.shifts.openConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close shift dialog */}
      <Dialog open={closeDialog} onOpenChange={(o) => !busy && setCloseDialog(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.shifts.close}</DialogTitle>
          </DialogHeader>
          {shift && (
            <div className="space-y-3">
              <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
                {[
                  [t.shifts.openingCash, shift.openingCashAmount],
                  [t.shifts.cashSales, shift.totalCashSales],
                  [t.shifts.cardSales, shift.totalCardSales],
                  [t.shifts.walletSales, shift.totalWalletSales],
                  [t.shifts.discounts, shift.totalDiscounts],
                  [t.shifts.refunds, shift.totalRefunds],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">{money(value, currency)}</dd>
                  </div>
                ))}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t.shifts.orderCount}</dt>
                  <dd className="tabular-nums">{shift.orderCount}</dd>
                </div>
                <div className="flex justify-between border-t pt-1.5 font-semibold">
                  <dt>{t.shifts.expectedCashInDrawer}</dt>
                  <dd className="tabular-nums">
                    {money(shift.expectedCashAmount, currency)}
                  </dd>
                </div>
              </dl>

              <div className="space-y-2">
                <Label>{t.shifts.actualCashInDrawer}</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  dir="ltr"
                  placeholder="0.00"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                />
              </div>

              {actualCash !== "" && (
                <div
                  className={
                    Math.abs(diffPreview) < 0.01
                      ? "rounded-lg bg-emerald-50 p-2 text-center text-sm font-medium text-emerald-700"
                      : diffPreview > 0
                        ? "rounded-lg bg-sky-50 p-2 text-center text-sm font-medium text-sky-700"
                        : "rounded-lg bg-red-50 p-2 text-center text-sm font-medium text-red-700"
                  }
                >
                  {Math.abs(diffPreview) < 0.01
                    ? t.shifts.matched
                    : diffPreview > 0
                      ? `${t.shifts.surplus} ${money(diffPreview, currency)}`
                      : `${t.shifts.shortage} ${money(-diffPreview, currency)}`}
                </div>
              )}

              <div className="space-y-2">
                <Label>{t.shifts.notes}</Label>
                <Textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              className="w-full"
              disabled={busy || actualCash === ""}
              onClick={closeShift}
            >
              {t.shifts.closeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
