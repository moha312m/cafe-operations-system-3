"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, blockersOf, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button, buttonVariants } from "@/components/ui/button";
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

export type Shift = {
  id: string;
  shiftNumber: number;
  openedAt: string;
  openingCashAmount: string;
  // Absent while the shift is open and belongs to the viewer: the drawer
  // target is withheld until they commit an independent count (SHIFT-003).
  expectedCashAmount?: string;
  totalSales: string;
  totalCashSales: string;
  totalCardSales: string;
  totalWalletSales: string;
  totalDiscounts: string;
  totalRefunds: string;
  orderCount: number;
  cashier: { name: string };
};

/**
 * The second half of a two-stage close, as the server reports it.
 *
 * `POST /api/shifts/:id/close` answers with this beside the shift, and a
 * close that ignored it would tell a custodian holding frozen stock that
 * they were finished. `required` is the whole question; everything else is
 * what they need in order to go and finish.
 */
export type HandoverOutcome = {
  required: boolean;
  target?: string | null;
  handoverId?: string | null;
  freezeId?: string | null;
  requiredItemCount?: number | null;
  configIssue?: string | null;
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
  // Receives the active shift (or null). The second arg lets consumers
  // that need the full figures (e.g. /current-shift) avoid a second fetch;
  // consumers that only need a boolean (POS) can ignore it.
  onActiveChange: (hasActiveShift: boolean, shift?: Shift | null) => void;
}) {
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [closeDialog, setCloseDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [notes, setNotes] = useState("");
  const [varianceReason, setVarianceReason] = useState("");
  // T34 — one settlement figure and one reason per processor channel. Kept as
  // four separate pieces of state rather than one "settlement" object because
  // that is what they are: two independent reconciliations that happen to be
  // collected on the same screen, and merging them here is the first step
  // towards netting them in the request.
  const [actualCard, setActualCard] = useState("");
  const [cardReason, setCardReason] = useState("");
  const [actualWallet, setActualWallet] = useState("");
  const [walletReason, setWalletReason] = useState("");
  const [busy, setBusy] = useState(false);
  // SH-24 — the two halves of an honest close.
  //
  // `blockers` is what the server named as still standing in the way; it is
  // shown inside the close dialog, beside the button that was refused,
  // because a list of reasons delivered anywhere else is a list the closer
  // has to go looking for. `handoverNotice` is the opposite case: the close
  // SUCCEEDED and the shift is settled, yet the custodian still holds stock.
  // Both are the server's words. Neither is computed here.
  const [blockers, setBlockers] = useState<string[]>([]);
  const [handoverNotice, setHandoverNotice] = useState<HandoverOutcome | null>(null);

  const setActive = useCallback(
    (s: Shift | null) => {
      setShift(s);
      onActiveChange(s !== null, s);
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
    setActualCard("");
    setCardReason("");
    setActualWallet("");
    setWalletReason("");
    setVarianceReason("");
    // Last attempt's obstacles belong to last attempt.
    setBlockers([]);
    setCloseDialog(true);
  }

  async function closeShift() {
    if (!shift) return;
    setBusy(true);
    try {
      // The reconciliation is revealed by the server's response, and only
      // once it has persisted the count — never computed here from a target
      // the client was never given (SHIFT-003).
      const res = await api<{
        shift: Shift & { cashDifference: string | null };
        // SH-24 — read rather than dropped. The route answers with both
        // stages of the close; the client used to type only the first.
        handover?: HandoverOutcome;
      }>(
        `/api/shifts/${shift.id}/close`,
        {
          method: "POST",
          body: {
            actualCashAmount: Number(actualCash) || 0,
            reason: varianceReason.trim() || undefined,
            // Sent only when the closer actually typed something. An empty
            // box must stay `undefined` rather than becoming 0: the server
            // treats a supplied 0 as an affirmative "the provider settled
            // nothing", which is a different statement from "this channel was
            // not settled here" and, on a channel that took money, a
            // fabricated report.
            actualCardAmount: actualCard === "" ? undefined : Number(actualCard),
            cardReason: cardReason.trim() || undefined,
            actualWalletAmount: actualWallet === "" ? undefined : Number(actualWallet),
            walletReason: walletReason.trim() || undefined,
            notes: notes.trim() || undefined,
          },
        }
      );
      const diff = Number(res.shift.cashDifference ?? 0);
      const msg =
        Math.abs(diff) < 0.01
          ? t.shifts.matched
          : diff > 0
            ? `${t.shifts.surplus} ${money(diff, currency)}`
            : `${t.shifts.shortage} ${money(-diff, currency)}`;
      setCloseDialog(false);

      // Settled is not discharged. When the server says a handover is still
      // required, the cash reconciliation is reported as what it is — one
      // stage of two — and the notice below carries the rest. Announcing
      // "locked" here would be the lie this stage exists to remove.
      if (res.handover?.required) {
        setHandoverNotice(res.handover);
        toast.warning(`${t.shifts.settledNotDischarged} · ${msg}`);
      } else {
        toast.success(`${t.shifts.lockedSuccess} · ${msg}`);
      }

      // The shift's own status is the server's to report: a close that became
      // AWAITING_HANDOVER is not the same as one that finished, and assuming
      // either here would put a made-up state on screen.
      await load();
    } catch (e) {
      // A refusal that named its obstacles keeps them. The dialog stays open
      // so the list appears beside the button that was refused.
      setBlockers(blockersOf(e));
      toast.error(e instanceof Error ? e.message : "فشل قفل الشيفت");
    } finally {
      setBusy(false);
    }
  }

  // Fixed-height placeholder while the first fetch resolves — keeps the
  // layout from collapsing/jumping when data arrives.
  if (loading) {
    return (
      <div className="h-[52px] animate-pulse rounded-xl border border-dashed bg-muted/30" />
    );
  }

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

              {/* No live variance: the count has to be the cashier's own
                  reading of the drawer, not a number nudged until the banner
                  turns green. The result appears once the server has stored
                  it (SHIFT-003). */}
              <p className="rounded-lg bg-muted/50 p-2 text-center text-xs text-muted-foreground">
                {t.shifts.blindCountHint}
              </p>

              {/* Offered unconditionally, and never pre-filled. The count is
                  blind, so the cashier cannot be shown "you are 30 short —
                  explain it" without handing them the target SHIFT-003 exists
                  to withhold. If they leave it empty and the drawer does not
                  balance, the server refuses the close and says so, the count
                  they typed is still here, and they add the reason then. */}
              <div className="space-y-2">
                <Label>{t.shifts.varianceReason}</Label>
                <Textarea
                  rows={2}
                  value={varianceReason}
                  onChange={(e) => setVarianceReason(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t.shifts.varianceReasonHint}
                </p>
              </div>

              {/* T34 — the channels that never reach the drawer.
                  Shown per channel, and ONLY when that channel took money
                  this shift: a café that never accepted a wallet payment is
                  not asked what its wallet provider settled, and a zero typed
                  into a box for a terminal nobody owns would be a provider
                  report that was never read.

                  The two are laid out as two blocks, not one "electronic
                  settlement" total, because they settle with two different
                  counterparties on two different schedules — and a single
                  combined figure would let a card shortfall hide inside a
                  wallet surplus, which is the exact failure the server-side
                  rule refuses to allow. */}
              {(Number(shift.totalCardSales) !== 0 ||
                Number(shift.totalWalletSales) !== 0) && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t.shifts.settlementHeading}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.shifts.settlementHint}
                    </p>
                  </div>

                  {Number(shift.totalCardSales) !== 0 && (
                    <div className="space-y-2">
                      <Label>{t.shifts.actualCardSettled}</Label>
                      <Input
                        type="number"
                        step="0.01"
                        dir="ltr"
                        placeholder="0.00"
                        value={actualCard}
                        onChange={(e) => setActualCard(e.target.value)}
                      />
                      {/* Offered unconditionally and never pre-filled, the
                          same treatment the cash reason gets: if it is left
                          empty and the settlement does not match, the server
                          refuses and says so, and the figure typed above is
                          still here to explain. */}
                      <Label className="text-xs font-normal text-muted-foreground">
                        {t.shifts.cardVarianceReason}
                      </Label>
                      <Textarea
                        rows={2}
                        value={cardReason}
                        onChange={(e) => setCardReason(e.target.value)}
                      />
                    </div>
                  )}

                  {Number(shift.totalWalletSales) !== 0 && (
                    <div className="space-y-2">
                      <Label>{t.shifts.actualWalletSettled}</Label>
                      <Input
                        type="number"
                        step="0.01"
                        dir="ltr"
                        placeholder="0.00"
                        value={actualWallet}
                        onChange={(e) => setActualWallet(e.target.value)}
                      />
                      <Label className="text-xs font-normal text-muted-foreground">
                        {t.shifts.walletVarianceReason}
                      </Label>
                      <Textarea
                        rows={2}
                        value={walletReason}
                        onChange={(e) => setWalletReason(e.target.value)}
                      />
                    </div>
                  )}
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
          {blockers.length > 0 && (
            // The server's list, rendered as the server sent it. A close that
            // is refused for four reasons and names one teaches the closer to
            // fix things one at a time and distrust the answer.
            <div
              data-testid="close-blockers"
              className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {t.shifts.blockersTitle}
              </p>
              <ul className="list-inside list-disc space-y-1 text-amber-800 dark:text-amber-300">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button
              className="w-full"
              // A settlement is required for every channel that took money,
              // so the button waits for it the same way it waits for the
              // drawer count. This is convenience, not enforcement — the
              // server refuses the close on its own figures regardless of
              // what the client allows to be pressed.
              disabled={
                busy ||
                actualCash === "" ||
                (Number(shift?.totalCardSales ?? 0) !== 0 && actualCard === "") ||
                (Number(shift?.totalWalletSales ?? 0) !== 0 && actualWallet === "")
              }
              onClick={closeShift}
            >
              {t.shifts.closeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Settled, not discharged ──
          Raised only when the server said a handover is still required. It
          names what is owed and opens the door to where it is owed, so the
          custodian is not left to discover on their own that the shift they
          just closed did not release them from the stock they hold. */}
      <Dialog
        open={handoverNotice !== null}
        onOpenChange={(o) => !o && setHandoverNotice(null)}
      >
        <DialogContent className="max-w-md" data-testid="handover-required-notice">
          <DialogHeader>
            <DialogTitle>{t.shifts.settledNotDischarged}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t.shifts.handoverStillOwed}</p>
            <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {handoverNotice?.target && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.shifts.handoverTarget}</dt>
                  <dd className="font-medium">{handoverNotice.target}</dd>
                </div>
              )}
              {typeof handoverNotice?.requiredItemCount === "number" && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.shifts.requiredItemCount}</dt>
                  <dd className="tabular-nums">{handoverNotice.requiredItemCount}</dd>
                </div>
              )}
            </dl>
            {handoverNotice?.configIssue && (
              // A configuration problem is the server's finding, not a
              // failure of the close. Naming it here is the only way the
              // person standing at the till learns why the handover they
              // are being sent to may not behave as they expect.
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
                {handoverNotice.configIssue}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => setHandoverNotice(null)}>
              {t.common.close}
            </Button>
            <Link href="/handovers" className={buttonVariants()}>
              {t.shifts.goToHandovers}
            </Link>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
