"use client";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import { TouchSelect } from "@/components/pos/touch-select";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, ApiRequestError, blockersOf, money } from "@/lib/client";
import { CloseGuidancePanel, PendingCloseBanner } from "@/components/pos/close-guidance-panel";
import {
  clearCloseDraft, countAction, createReadinessLoader, explainBlockers, loadCloseDraft, readinessView, READINESS_UNCHECKED, saveCloseDraft, saveCloseOutcome,
  shiftPhase, SHIFT_PHASE_LABEL, structuredBlockers,
  type DraftScope, type GuidanceAccess, type GuidanceBlocker, type GuidanceContext, type ReadinessState,
} from "@/lib/close-guidance";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { OpeningCashPanel } from "@/components/handovers/opening-cash-panel";
import { CarriedOrdersStrip } from "@/components/pos/carried-orders-strip";
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
  branchId: string;
  shiftNumber: number;
  custodyGateReason?: string | null;
  pendingHandover?: { id: string; status: string; stockCountSessionId: string | null; outgoingUser: { name: string }; outgoingShift: { shiftNumber: number } } | null;
  openingCashReceipt?: { status: string } | null;
  openedAt: string;
  openingCashAmount: string;
  // Financial totals are available only to staff with report permission.
  expectedCashAmount?: string;
  totalSales?: string;
  totalCashSales?: string;
  totalCardSales?: string;
  totalWalletSales?: string;
  totalDiscounts?: string;
  totalRefunds?: string;
  orderCount?: number;
  cardSettlementRequired?: boolean;
  walletSettlementRequired?: boolean;
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
  const { canKey, can, features, cafe, user } = useApp();
  const router = useRouter();
  const [handoverEnabled, setHandoverEnabled] = useState(false);
  const [handoverTarget, setHandoverTarget] = useState<"" | "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY">("");
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingShift, setPendingShift] = useState<Shift | null>(null);
  const [overnightEnabled, setOvernightEnabled] = useState(false);
  const [leftInDrawer, setLeftInDrawer] = useState('');
  const [toTreasury, setToTreasury] = useState('');
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
  // Open orders at the branch, read when the dialog opens — so the closer
  // learns what will stop (or travel with) the handover before counting.
  const [openOrders, setOpenOrders] = useState<{ total: number; refs: string[]; carry: boolean } | null>(null);
  // Guidance (read-only readiness from the server + the structured findings of a refused close) and the user's own preserved close-form values.
  // One state value for the readiness read (unchecked / loading / failed / checked): "no blockers" can only come from a fresh successful check.
  const [readinessState, setReadinessState] = useState<ReadinessState>(READINESS_UNCHECKED);
  const [refusal, setRefusal] = useState<GuidanceBlocker[]>([]);
  const [configError, setConfigError] = useState<{ code: string } | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [noticeItems, setNoticeItems] = useState<{ name: string; unit: string }[]>([]);
  const [bannerRefresh, setBannerRefresh] = useState(0);
  // What this account can OPEN (not what it may do there) — every guidance action is gated on the destination it points at.
  const access: GuidanceAccess = {
    settingsConfig: canKey("stock_count.configure") && can("branches:manage"),
    orders: can("orders:read"),
    approvals: canKey("qr_orders.view") && features?.qrMenuEnabled === true,
    purchases: canKey("purchases.view") && features?.purchasesEnabled === true,
    counts: canKey("stock_count.view") && features?.inventoryEnabled === true,
    approveCorrections: canKey("stock_count.approve_correction"),
    handovers: canKey("handover.view") && features?.inventoryEnabled === true,
  };
  const guidanceCtx: GuidanceContext = { branchId, access };
  // Browser-tab storage is shared by everyone who uses this tab: drafts and notes are scoped to café + user + branch (+ shift).
  const cafeId = cafe?.id ?? "";
  const shiftId = shift?.id ?? "";
  const draftScope = useMemo<DraftScope>(() => ({ cafeId, userId: user.id, branchId, shiftId }), [cafeId, user.id, branchId, shiftId]);
  const tabStorage = () => (typeof window === "undefined" ? null : window.sessionStorage);

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
      const { shift, pendingShift } = await api<{ shift: Shift | null; pendingShift: Shift | null }>(
        `/api/shifts/active?branchId=${branchId}`
      );
      setActive(shift);
      setPendingShift(pendingShift);
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
          // Staff use their live server assignment rather than a chosen branch.
          body: {
            ...(user.role === "CAFE_OWNER" || user.role === "SUPER_ADMIN" ? { branchId } : {}),
            openingCashAmount: Number(openingCash) || 0,
          },
        }
      );
      if (s.branchId !== branchId) {
        // The owner transferred this employee while their page was still open.
        // Do not enable the old branch UI using a shift opened at the new one.
        setActive(null);
        setOpenDialog(false);
        setOpeningCash("");
        router.refresh();
        toast.success("تم فتح الشيفت في فرعك الحالي وتحديث الصفحة");
        return;
      }
      if (s.custodyGateReason || (s.openingCashReceipt && !["ACCEPTED", "OVERRIDDEN"].includes(s.openingCashReceipt.status))) {
        setPendingShift(s);
        setActive(null);
        setOpenDialog(false);
        toast.error("الشيفت في انتظار التسليم أو التحقق الافتتاحي — أكمل إجراءات العهدة أولًا");
        router.refresh();
        return;
      }
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

  // Read-only: the server's own findings about what would stop a close. It never submits or simulates a close.
  // The loader is per branch; its sequence guard means only the newest request may publish, and a superseded/cancelled one publishes nothing.
  const readinessLoader = useMemo(
    () => (branchId ? createReadinessLoader(() => api<unknown>(`/api/branches/${branchId}/close-readiness`), setReadinessState) : null),
    [branchId],
  );
  useEffect(() => () => { readinessLoader?.cancel(); }, [readinessLoader]);
  const loadReadiness = useCallback(async () => { await readinessLoader?.load(); }, [readinessLoader]);

  // The user's own close-form values survive leaving the screen (e.g. to fix a setting) and are re-applied when the dialog is reopened.
  // Never anything derived from expected figures, and the server state is re-read at the same moment.
  useEffect(() => {
    if (!closeDialog || !shift) return;
    saveCloseDraft(tabStorage(), draftScope,
      { actualCash, notes, varianceReason, actualCard, cardReason, actualWallet, walletReason, handoverTarget, leftInDrawer, toTreasury }, Date.now());
  }, [closeDialog, shift, draftScope, actualCash, notes, varianceReason, actualCard, cardReason, actualWallet, walletReason, handoverTarget, leftInDrawer, toTreasury]);

  async function openCloseDialog() {
    try {
      const opening = await api<{ settings: { overnightCashEnabled: boolean } }>('/api/branches/'+branchId+'/opening-settings');
      setOvernightEnabled(opening.settings.overnightCashEnabled);
      setLeftInDrawer(''); setToTreasury('');
      const { config } = await api<{ config: { enabled: boolean; configError: { code: string } | null } }>(
        `/api/branches/${branchId}/handover-config`
      );
      setHandoverEnabled(config.enabled && config.configError?.code !== "CYCLE_POLICY_UNSUPPORTED");
      setConfigError(config.enabled ? config.configError : null); // kept so the guidance still has a cause if the readiness read is unavailable
      setHandoverTarget("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.shifts.handoverConfigFailure);
      return;
    }
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
    setOpenOrders(null);
    api<{ carryOpenOrdersOnHandover: boolean; open: { total: number; refs: string[] } }>(
      `/api/orders/open-summary?branchId=${branchId}`
    )
      .then((r) => setOpenOrders({ total: r.open.total, refs: r.open.refs, carry: r.carryOpenOrdersOnHandover }))
      .catch(() => setOpenOrders(null));
    // Fresh server findings every time the dialog opens (a returning user must not see yesterday's answer), and the user's own preserved entries.
    setRefusal([]);
    void loadReadiness();
    const restored = shift ? loadCloseDraft(tabStorage(), draftScope, Date.now()) : null;
    setDraftRestored(restored !== null);
    if (restored) {
      setActualCash(restored.actualCash); setNotes(restored.notes); setVarianceReason(restored.varianceReason);
      setActualCard(restored.actualCard); setCardReason(restored.cardReason); setActualWallet(restored.actualWallet); setWalletReason(restored.walletReason);
      setLeftInDrawer(restored.leftInDrawer); setToTreasury(restored.toTreasury);
      // The handover target is restored only if the dialog still offers it (BRANCH_CUSTODY needs the exception grant).
      setHandoverTarget(restored.handoverTarget === "BRANCH_CUSTODY" && !canKey("handover.exception") ? "" : restored.handoverTarget);
    }
    setCloseDialog(true);
  }

  async function closeShift() {
    if (!shift) return;
    if (overnightEnabled && handoverTarget === "BRANCH_CUSTODY" && (leftInDrawer === "" || toTreasury === "")) { toast.error("سجّل المبلغ المتروك في الدرج والمحوّل للخزنة، حتى لو صفر"); return; }
    setBusy(true);
    try {
      // The server acknowledges the count. Only oversight receives the
      // calculated reconciliation in the response.
      const res = await api<{
        shift: Shift & { cashDifference?: string | null };
        // SH-24 — read rather than dropped. The route answers with both
        // stages of the close; the client used to type only the first.
        handover?: HandoverOutcome;
        carriedOrders?: { orderNumber: number; remaining: number }[];
      }>(
        `/api/shifts/${shift.id}/close`,
        {
          method: "POST",
          body: {
            actualCashAmount: Number(actualCash) || 0,
            handoverTarget: handoverEnabled ? handoverTarget || undefined : undefined,
            cashDisposition: overnightEnabled && handoverTarget === 'BRANCH_CUSTODY' ? { leftInDrawer: Number(leftInDrawer), toTreasury: Number(toTreasury) } : undefined,
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
      const canViewReports = canKey("shifts.view_reports");
      const diff = res.shift.cashDifference == null ? null : Number(res.shift.cashDifference);
      const msg = !canViewReports || diff === null
        ? "تم تسجيل العدّ الفعلي للمراجعة"
        : Math.abs(diff) < 0.01
          ? t.shifts.matched
          : diff > 0
            ? `${t.shifts.surplus} ${money(diff, currency)}`
            : `${t.shifts.shortage} ${money(-diff, currency)}`;
      setCloseDialog(false);
      // The close really happened: the preserved entries have served their purpose.
      clearCloseDraft(tabStorage(), draftScope);
      setDraftRestored(false); setRefusal([]);

      // Settled is not discharged. When the server says a handover is still
      // required, the cash reconciliation is reported as what it is — one
      // stage of two — and the notice below carries the rest. Announcing
      // "locked" here would be the lie this stage exists to remove.
      if (res.handover?.required) {
        setNoticeItems((readinessState.status === "checked" ? readinessState.data.requiredItems : []).map((i) => ({ name: i.name, unit: i.unit })));
        if (res.handover.handoverId) saveCloseOutcome(tabStorage(), { cafeId, userId: user.id, branchId }, { handoverId: res.handover.handoverId, shiftNumber: shift.shiftNumber, savedAt: Date.now() });
        setBannerRefresh((n) => n + 1);
        setHandoverNotice(res.handover);
        toast.warning(`${t.shifts.settledNotDischarged} · ${msg}`);
      } else {
        toast.success(`${t.shifts.lockedSuccess} · ${msg}`);
      }
      const carried = res.carriedOrders ?? [];
      if (carried.length > 0) {
        const unpaid = carried.reduce((s, o) => s + o.remaining, 0);
        toast.info(
          `اتنقل للشيفت اللي جاي ${carried.length} أوردر مفتوح: ${carried.map((o) => `#${o.orderNumber}`).join("، ")}` +
            (unpaid > 0 ? ` · مطلوب تحصيل ${money(unpaid, currency)}` : ""),
          { duration: 10_000 }
        );
      }
      if (canViewReports) {
        const closedShiftId = shift.id;
        toast("📄 تقرير قفل الشيفت جاهز", {
          duration: 10_000,
          action: { label: "افتحه", onClick: () => window.open(`/reports/shift/${closedShiftId}`, "_blank", "noopener") },
        });
      }

      // The shift's own status is the server's to report: a close that became
      // AWAITING_HANDOVER is not the same as one that finished, and assuming
      // either here would put a made-up state on screen.
      await load();
    } catch (e) {
      // A refusal that named its obstacles keeps them. The dialog stays open
      // so the list appears beside the button that was refused.
      setBlockers(blockersOf(e));
      setRefusal(e instanceof ApiRequestError ? structuredBlockers(e.payload) : []);
      void loadReadiness(); // recheck the server's current state beside the refusal
      toast.error(e instanceof Error ? e.message : "فشل قفل الشيفت");
    } finally {
      setBusy(false);
    }
  }

  // Fixed-height placeholder while the first fetch resolves — keeps the
  // layout from collapsing/jumping when data arrives.
  // Server findings only. A refused close wins over the earlier readiness read; the config error from the ordinary config read is the fallback
  // cause when the readiness read itself is unavailable. Readiness findings render at the top of the dialog; a REFUSAL renders beside the
  // confirm button that was refused, where the person who pressed it is looking.
  const guidance = (() => {
    const view = readinessView(readinessState, guidanceCtx, configError);
    const source: "refusal" | "readiness" = refusal.length > 0 ? "refusal" : "readiness";
    // A refusal's own list wins over the readiness read; its destinations are resolved from the latest successful readiness records (server-verified),
    // and fall back to a labelled list link when none are available.
    const records = readinessState.status === "checked" ? readinessState.data.records : null;
    return {
      show: handoverEnabled || refusal.length > 0 || readinessState.status === "failed" || !!configError,
      source,
      props: {
        view: refusal.length > 0 ? { ...view, status: "blockers" as const, items: explainBlockers(refusal, { ...guidanceCtx, records }) } : view,
        source,
        rechecking: readinessState.status === "loading",
        restored: draftRestored,
        onRecheck: () => { setRefusal([]); void loadReadiness(); },
      },
    };
  })();

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
          {!pendingShift && <Button size="sm" className="ms-auto" onClick={() => setOpenDialog(true)}>
            {t.shifts.open}
          </Button>}
        </div>
      )}

      {pendingShift && <section className="space-y-2 rounded-lg border p-3 text-sm" aria-label="إجراءات استلام الشيفت">
        <p className="font-medium">شيفت #{pendingShift.shiftNumber} مفتوح لكنه غير جاهز للبيع.</p>
        {pendingShift.pendingHandover ? <p>شيفت #{pendingShift.pendingHandover.outgoingShift.shiftNumber} مقفول ماليًا، وتسليم المخزون لم يكتمل. {["DRAFT", "REJECTED"].includes(pendingShift.pendingHandover.status) ? `المطلوب من المُسلّم ${pendingShift.pendingHandover.outgoingUser.name}: ${pendingShift.pendingHandover.stockCountSessionId ? "استكمال الجرد ومراجعته ثم تسليم العهدة" : "فتح جرد التسليم وتسجيل الكميات الفعلية"}.` : "المطلوب من مستلم العهدة: مراجعة الأصناف وتأكيد الاستلام بصلاحية الاستلام."}</p> : <p>{pendingShift.custodyGateReason === "AWAITING_OPENING_VERIFICATION" ? "المطلوب التحقق الافتتاحي من المخزون المستلم بعهدة الفرع." : "استكمل إجراءات العهدة والنقدية أو فحص المكان حسب المهمة المعروضة. إذا لم يظهر تسليم محدد، راجع المسؤول؛ لن نختار سجلًا بشكل تخميني."}</p>}
        <Link className="inline-flex rounded-lg border px-3 py-2 text-primary underline" href={`/handovers?branchId=${encodeURIComponent(branchId)}${pendingShift.pendingHandover ? `&handoverId=${encodeURIComponent(pendingShift.pendingHandover.id)}` : ""}`}>متابعة التسليم</Link>
      </section>}
      <PendingCloseBanner branchId={branchId} refreshKey={bannerRefresh} />
      {!shift && <OpeningCashPanel branchId={branchId} onAccepted={load}/>}
      {shift && <CarriedOrdersStrip branchId={branchId} currency={currency} />}

      {/* Open shift dialog */}
      <Dialog open={openDialog} onOpenChange={(o) => !busy && setOpenDialog(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t.shifts.open}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{t.shifts.openingCash}</Label>
            <p className="text-xs text-muted-foreground">لو فيه كاش متروك من شيفت الليل، رصيد الافتتاح هيتثبت بعد عدّه وتأكيد استلامه.</p>
            <TouchNumberInput
              type="number"
              min="0"
              step="0.01"
              dir="ltr"
              placeholder="0.00"
              value={openingCash}
              onValueChange={touchValue => setOpeningCash(touchValue)}
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
          {shift && handoverEnabled && openOrders && openOrders.total > 0 && (
            <div
              data-testid="close-open-orders-notice"
              className={
                "rounded-lg border p-3 text-sm " +
                (openOrders.carry
                  ? "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200")
              }
            >
              <p className="font-medium">
                عندك {openOrders.total} أوردر مفتوح في الفرع: {openOrders.refs.join("، ")}
                {openOrders.total > openOrders.refs.length ? " …" : ""}
              </p>
              <p className="mt-1 text-xs">
                {openOrders.carry
                  ? "هيتنقلوا للشيفت اللي جاي يقدّمهم ويحصّلهم. اللي بيتحضر أو جاهز هيتخصم مخزونه عليك قبل الجرد."
                  : "لازم تقدّمهم أو تلغيهم قبل ما تقفل، وإلا القفل هيترفض. "}
                {!openOrders.carry && (
                  <Link href="/kitchen" className="font-medium underline">
                    افتح شاشة البار
                  </Link>
                )}
              </p>
            </div>
          )}
          {guidance.show && guidance.source === "readiness" && <CloseGuidancePanel {...guidance.props} />}
          {shift && (
            <div className="space-y-3">
              {canKey("shifts.view_reports") && <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
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
                    <dd className="tabular-nums">{money(value ?? 0, currency)}</dd>
                  </div>
                ))}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t.shifts.orderCount}</dt>
                  <dd className="tabular-nums">{shift.orderCount}</dd>
                </div>
              </dl>}

              <div className="space-y-2">
                <Label>{t.shifts.actualCashInDrawer}</Label>
                <TouchNumberInput
                  type="number"
                  min="0"
                  step="0.01"
                  dir="ltr"
                  placeholder="0.00"
                  value={actualCash}
                  onValueChange={touchValue => setActualCash(touchValue)}
                />
              </div>

              {overnightEnabled && handoverTarget === 'BRANCH_CUSTODY' && <div className="space-y-3 rounded-lg border p-3"><p className="text-sm font-medium">توزيع الكاش المعدود عند نهاية الليل</p><Label>المبلغ المتروك في الدرج للشيفت القادم</Label><TouchNumberInput aria-label="كاش متروك في الدرج" type="number" min="0" step="0.01" value={leftInDrawer} onValueChange={touchValue => setLeftInDrawer(touchValue)} placeholder="اكتب المبلغ، الصفر مسموح"/><Label>المبلغ المحوّل للخزنة</Label><TouchNumberInput aria-label="كاش محول للخزنة" type="number" min="0" step="0.01" value={toTreasury} onValueChange={touchValue => setToTreasury(touchValue)} placeholder="اكتب المبلغ، الصفر مسموح"/><p className="text-xs text-muted-foreground">المبلغين لازم يساووا إجمالي الكاش اللي عديته. التحويل للخزنة لا يُسجل كمصروف أو بيع جديد.</p></div>}
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
              {(shift.cardSettlementRequired || shift.walletSettlementRequired ||
                Number(shift.totalCardSales ?? 0) !== 0 ||
                Number(shift.totalWalletSales ?? 0) !== 0) && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t.shifts.settlementHeading}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.shifts.settlementHint}
                    </p>
                  </div>

                  {(shift.cardSettlementRequired || Number(shift.totalCardSales ?? 0) !== 0) && (
                    <div className="space-y-2">
                      <Label>{t.shifts.actualCardSettled}</Label>
                      <TouchNumberInput
                        type="number"
                        step="0.01"
                        dir="ltr"
                        placeholder="0.00"
                        value={actualCard}
                        signed
                        aria-label={t.shifts.actualCardSettled}
                        onValueChange={touchValue => setActualCard(touchValue)}
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

                  {(shift.walletSettlementRequired || Number(shift.totalWalletSales ?? 0) !== 0) && (
                    <div className="space-y-2">
                      <Label>{t.shifts.actualWalletSettled}</Label>
                      <TouchNumberInput
                        type="number"
                        step="0.01"
                        dir="ltr"
                        placeholder="0.00"
                        value={actualWallet}
                        signed
                        aria-label={t.shifts.actualWalletSettled}
                        onValueChange={touchValue => setActualWallet(touchValue)}
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

              {handoverEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="shift-handover-target">{t.shifts.closeHandoverTarget}</Label>
                  <TouchSelect
                    id="shift-handover-target"
                    aria-label={t.shifts.closeHandoverTarget}
                    value={handoverTarget}
                    onValueChange={(value) => setHandoverTarget(value as typeof handoverTarget)}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t.shifts.chooseHandoverTarget}</option>
                    <option value="SHIFT_TO_SHIFT">{t.shifts.handoverToNextShift}</option>
                    {canKey("handover.exception") && <option value="BRANCH_CUSTODY">{t.shifts.handoverToBranch}</option>}
                  </TouchSelect>
                  <p className="text-xs text-muted-foreground">{t.shifts.handoverTargetHint}</p>
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
          {blockers.length > 0 && refusal.length === 0 && (
            // The server's list, rendered as the server sent it (plain-string refusals only; structured ones are explained above). A close that
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
          {guidance.show && guidance.source === "refusal" && <CloseGuidancePanel {...guidance.props} />}
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
                (handoverEnabled && !handoverTarget) ||
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
            <p data-testid="handover-phase" className="font-medium">{SHIFT_PHASE_LABEL[shiftPhase("AWAITING_HANDOVER")!].label}</p>
            <p className="text-muted-foreground">{t.shifts.handoverStillOwed}</p>
            <p className="text-xs text-muted-foreground">{SHIFT_PHASE_LABEL.AWAITING_HANDOVER.detail}</p>
            {noticeItems.length > 0 && (
              <div data-testid="handover-required-items" className="rounded-lg border bg-muted/20 p-3">
                <p className="mb-1 font-medium">أصناف مطلوب جردها</p>
                <ul className="list-inside list-disc">{noticeItems.map((i) => <li key={`${i.name}|${i.unit}`}>{i.name} ({i.unit})</li>)}</ul>
              </div>
            )}
            <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {handoverNotice?.target && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.shifts.handoverTarget}</dt>
                  <dd className="font-medium">{handoverNotice.target === "SHIFT_TO_SHIFT" ? t.shifts.handoverToNextShift : handoverNotice.target === "BRANCH_CUSTODY" ? t.shifts.handoverToBranch : handoverNotice.target}</dd>
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
            {(() => {
              // The exact handover the server just created — never a generic list. A fresh handover has no count yet, so the honest label is
              // "ابدأ الجرد" for the custodian who may count; anyone else just follows the handover.
              const action = handoverNotice?.handoverId
                ? countAction(branchId, handoverNotice.handoverId, { status: "DRAFT", count: null }, canKey("handover.submit"))
                : null;
              if (!canKey("handover.view")) return <p data-testid="handover-notice-no-access" className="text-xs">حسابك لا يملك صلاحية عرض التسليم؛ اطلب من المدير أو المالك متابعته.</p>;
              return (
                <Link href={action?.href ?? `/handovers?branchId=${encodeURIComponent(branchId)}`} className={buttonVariants()} data-testid="handover-notice-action">
                  {action?.label ?? t.shifts.goToHandovers}
                </Link>
              );
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
