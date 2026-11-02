"use client";
import { TouchNumberInput } from "@/components/pos/touch-number-input";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { PendingCloseBanner } from "@/components/pos/close-guidance-panel";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { OpeningCashPanel } from "@/components/handovers/opening-cash-panel";
import { handoverBlockMessage } from "@/components/handovers/workflow-state";
import { CarriedOrdersStrip } from "@/components/pos/carried-orders-strip";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  pendingHandover?: { id: string; status: string; stockCountSessionId: string | null; stockCountSession?: { status: string } | null; outgoingUser: { name: string }; outgoingShift: { shiftNumber: number } } | null;
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
  totalCashPayouts?: string;
  totalExpensePayouts?: string;
  totalExpenseReturns?: string;
  orderCount?: number;
  cardSettlementRequired?: boolean;
  walletSettlementRequired?: boolean;
  cashier: { name: string };
};

/**
 * The second half of a two-stage close, as the server reports it.
 *
 * `POST /api/shifts/:id/close` answers with this beside the shift. The close
 * itself now lives on its own screen (`/close-shift`, HND-UX-004); the type
 * stays exported because it describes the route's response.
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
// "open shift" gate or the open-shift top bar, and opens shifts. Closing is
// one authoritative flow on its own screen — «إنهاء الشيفت» goes to
// `/close-shift`, which settles money first and materials when due, and which
// resumes there after a refresh. There is no second close path here.
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
  const { user } = useApp();
  const router = useRouter();
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError,setReadError]=useState("");
  const controllerRef=useRef<AbortController|null>(null);
  const [pendingShift, setPendingShift] = useState<Shift | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState("");
  const [busy, setBusy] = useState(false);
  // HND-UX-004: money already committed, materials still owed. Read from the
  // server, never from this tab, so it survives a refresh or another device.
  const [closeStage, setCloseStage] = useState<"MATERIALS" | null>(null);

  const setActive = useCallback(
    (s: Shift | null) => {
      setShift(s);
      onActiveChange(s !== null, s);
    },
    [onActiveChange]
  );

  const load = useCallback(async () => {
    if (!branchId) return;
    controllerRef.current?.abort();
    const controller=new AbortController();controllerRef.current=controller;
    setLoading(true);setReadError("");
    try {
      const { shift, pendingShift } = await api<{ shift: Shift | null; pendingShift: Shift | null }>(
        `/api/shifts/active?branchId=${branchId}`,{signal:controller.signal,readTimeoutMs:20_000}
      );
      if(controller.signal.aborted)return;
      setActive(shift);
      setPendingShift(pendingShift);
      if (!shift) {
        api<{ stage: string }>(`/api/shifts/close-flow?branchId=${encodeURIComponent(branchId)}`,{signal:controller.signal,readTimeoutMs:20_000})
          .then((r) => {if(!controller.signal.aborted)setCloseStage(r.stage === "MATERIALS" ? "MATERIALS" : null)})
          .catch(() => {if(!controller.signal.aborted)setCloseStage(null)});
      } else {
        setCloseStage(null);
      }
    } catch(error) {
      if(!controller.signal.aborted){setActive(null);setReadError(error instanceof Error?error.message:"تعذر تحميل حالة الوردية");}
    } finally {
      if(!controller.signal.aborted)setLoading(false);
    }
  }, [branchId, setActive]);

  useEffect(() => {
    load();
    return ()=>controllerRef.current?.abort();
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

  // Fixed-height placeholder while the first fetch resolves — keeps the
  // layout from collapsing/jumping when data arrives.
  if(readError)return <div role="alert" className="rounded-xl bg-caramel-soft p-3 text-sm text-caramel-ink">{readError} <Button variant="outline" onClick={()=>void load()}>إعادة المحاولة</Button></div>;
  if (loading) {
    return (
      <div className="h-[52px] animate-pulse rounded-xl border border-dashed bg-muted/30" />
    );
  }

  const closeHref = `/close-shift?branchId=${encodeURIComponent(branchId)}`;
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
          <Link href={closeHref} className={buttonVariants({ size: "sm", variant: "outline", className: "ms-auto" })} data-testid="shift-close-entry">
            إنهاء الشيفت
          </Link>
        </div>
      ) : (
        // ── Gate ──
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3">
          <span className="text-sm font-medium text-muted-foreground">
            🔒 {pendingShift ? "الشيفت مفتوح لكن البيع مقفول لحين اكتمال استلام العهدة" : t.shifts.mustOpen}
          </span>
          {!pendingShift && <Button size="sm" className="ms-auto" onClick={() => setOpenDialog(true)}>
            {t.shifts.open}
          </Button>}
        </div>
      )}

      {!shift && closeStage === "MATERIALS" && <section className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="close-resume-materials">
        <p className="font-medium">الفلوس اتسجلت — فاضل تسليم الخامات.</p>
        <Link href={closeHref} className={buttonVariants({ size: "sm", className: "ms-auto" })}>كمّل تسليم الخامات</Link>
      </section>}

      {pendingShift && <section className="space-y-2 rounded-lg border p-3 text-sm" aria-label="إجراءات استلام الشيفت">
        <p className="font-medium">شيفت #{pendingShift.shiftNumber} مفتوح لكنه غير جاهز للبيع.</p>
        {pendingShift.pendingHandover ? <p data-testid="handover-gate-message">{handoverBlockMessage({ status: pendingShift.pendingHandover.status, countStatus: pendingShift.pendingHandover.stockCountSession?.status ?? null, outgoingName: pendingShift.pendingHandover.outgoingUser.name, outgoingShiftNumber: pendingShift.pendingHandover.outgoingShift.shiftNumber })}</p> : <p>{pendingShift.custodyGateReason === "AWAITING_OPENING_VERIFICATION" ? "المطلوب التحقق الافتتاحي من المخزون المستلم بعهدة الفرع." : "استكمل إجراءات العهدة والنقدية أو فحص المكان حسب المهمة المعروضة. إذا لم يظهر تسليم محدد، راجع المسؤول؛ لن نختار سجلًا بشكل تخميني."}</p>}
        <Link className="inline-flex rounded-lg border px-3 py-2 text-primary underline" href={`/handovers?branchId=${encodeURIComponent(branchId)}${pendingShift.pendingHandover ? `&handoverId=${encodeURIComponent(pendingShift.pendingHandover.id)}` : ""}`}>متابعة التسليم</Link>
      </section>}
      <PendingCloseBanner branchId={branchId} refreshKey={0} />
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
    </>
  );
}
