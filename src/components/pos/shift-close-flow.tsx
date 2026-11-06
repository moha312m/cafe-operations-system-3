"use client";

// HND-UX-004 — the outgoing employee's close, as two focused screens.
//
//   1. «تسليم الفلوس»   money, every shift. Commits the financial close.
//   2. «تسليم الخامات»  only when the owner's schedule says materials are due.
//
// The two screens are NOT one transaction, and the screen never pretends
// otherwise: money commits on the server at step 1, and every load asks the
// server which step remains (`/api/shifts/close-flow`). A refresh, a lost
// response or a closed tab therefore resumes at materials instead of settling
// money a second time. Nothing here computes a variance or shows an expected
// figure the account may not see; drafts hold only what this person typed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiRequestError, blockersOf, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { clearCloseDraft, loadCloseDraft, saveCloseDraft, type DraftScope } from "@/lib/close-guidance";
import { CashDenominationCalculator } from "@/components/pos/cash-denomination-calculator";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import { CountLineRow, type CountLine } from "@/components/stock-counts/count-line-row";
import { CountEntryQueue } from "@/components/stock-counts/count-entry-queue";
import { convertedMessage, convertToBranchCustody, signPendingLines } from "@/components/handovers/branch-custody-save";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { materialsDecisionLabel } from "@/lib/materials-labels";
import { parseAmount } from "@/lib/close-amount";
import { UNIT_LABEL } from "@/lib/inventory";
import { CashDispositionEditor, type DispositionEditorController, type DispositionView, type EligibleRecipient } from "@/components/pos/cash-disposition-editor";

type MoneyShift = {
  id: string; shiftNumber: number; openedAt: string; openingCashAmount: string;
  cardSettlementRequired: boolean; walletSettlementRequired: boolean;
};
type Tender = { method: string; actualAmount: string | null; expectedAmount?: string | null; varianceAmount?: string | null };
type ClosedShift = {
  id: string; shiftNumber: number; status: string; openedAt: string; financiallyClosedAt: string | null;
  openingCashAmount: string; actualCashAmount: string | null; notes: string | null;
  expectedCashAmount?: string | null; cashDifference?: string | null;
  tenderReconciliations: Tender[];
  materialsDecision: { due: boolean; reason: string; cadence: string; periodFrom: string | null; periodTo: string | null; nextDueAt: string | null } | null;
};
type FlowHandover = { id: string; status: string; target?: string | null; directHandover?: boolean; stockCountSessionId: string | null; requiredItemCount: number | null; outgoingNote: string | null; submittedAt: string | null };
type Flow =
  | { stage: "NONE"; branch: { id: string; name: string } }
  | { stage: "MONEY"; branch: { id: string; name: string }; shift: MoneyShift; handover: { enabled: boolean }; materials: { cadence: string; duePreview: boolean; nextDueAt: string | null; branchCustodyFullCountDue?: boolean }; recipients?: EligibleRecipient[] }
  | ClosedFlow;
type ClosedFlow = { stage: "MATERIALS" | "DONE"; branch: { id: string; name: string }; shift: ClosedShift; handover: FlowHandover | null; cashDisposition?: DispositionView | null; recipients?: EligibleRecipient[] };

const dateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("ar-EG", { weekday: "long", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "";

export function ShiftCloseFlow({ branchId, currency }: { branchId: string; currency: string }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ notDue?: { nextDueAt: string | null }; recordedDifferences?: number } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api<Flow>(`/api/shifts/close-flow?branchId=${encodeURIComponent(branchId)}`);
      if (mine === generation.current) { setFlow(next); setError(null); }
      return next;
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : "تعذّر قراءة حالة الشيفت");
      return null;
    }
  }, [branchId]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  if (error && !flow) return <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm text-destructive">{error} <Button size="sm" variant="outline" className="ms-2" onClick={() => void load()}>إعادة المحاولة</Button></div>;
  if (!flow) return <div className="h-64 animate-pulse rounded-2xl border bg-muted/30" />;

  const showMaterialsStep = flow.stage === "MATERIALS" || (flow.stage === "MONEY" && flow.handover.enabled && flow.materials.duePreview) || (flow.stage === "DONE" && !!flow.handover);
  return <div className="mx-auto w-full max-w-2xl space-y-4" dir="rtl">
    <Steps stage={flow.stage} withMaterials={showMaterialsStep} />
    {flow.stage === "NONE" && <section className="space-y-3 rounded-2xl border bg-card p-5 text-sm">
      <p>مفيش شيفت مفتوح ليك في الفرع ده.</p>
      <Link href="/pos" className={buttonVariants({ variant: "outline" })}>رجوع للكاشير</Link>
    </section>}
    {flow.stage === "MONEY" && <MoneyStep flow={flow} currency={currency} onCommitted={async (result) => {
      const next = await load();
      if (result?.notDue) setOutcome({ notDue: result.notDue });
      return next;
    }} />}
    {flow.stage === "MATERIALS" && flow.handover && <MaterialsStep flow={flow} handover={flow.handover} currency={currency} onFinished={async (recordedDifferences) => { setOutcome({ recordedDifferences }); await load(); }} onStale={load} />}
    {flow.stage === "DONE" && <DoneStep flow={flow} currency={currency} outcome={outcome} />}
  </div>;
}

function Steps({ stage, withMaterials }: { stage: Flow["stage"]; withMaterials: boolean }) {
  if (stage === "NONE") return null;
  const items = [{ id: "MONEY", label: "تسليم الفلوس" }, ...(withMaterials ? [{ id: "MATERIALS", label: "تسليم الخامات" }] : [])];
  const at = stage === "DONE" ? items.length : items.findIndex((i) => i.id === stage);
  return <ol className="flex items-center gap-2 text-sm" aria-label="خطوات إنهاء الشيفت">
    {items.map((item, index) => <li key={item.id} aria-current={index === at ? "step" : undefined}
      className={`flex items-center gap-2 rounded-full border px-3 py-1 ${index < at ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-300" : index === at ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
      <span className="tabular-nums">{index < at ? "✓" : index + 1}</span>{item.label}
    </li>)}
  </ol>;
}

function Identity({ branch, shiftNumber, name }: { branch: string; shiftNumber: number; name: string }) {
  return <p className="text-sm text-muted-foreground">{branch} · شيفت #{shiftNumber} · {name}</p>;
}

// ── Screen 1 ──────────────────────────────────────────────────────────────
function MoneyStep({ flow, currency, onCommitted }: {
  flow: Extract<Flow, { stage: "MONEY" }>; currency: string;
  onCommitted: (result: { notDue?: { nextDueAt: string | null } } | null) => Promise<Flow | null>;
}) {
  const { user, cafe, canKey } = useApp();
  const router = useRouter();
  const shift = flow.shift;
  const scope = useMemo<DraftScope>(() => ({ cafeId: cafe?.id ?? "", userId: user.id, branchId: flow.branch.id, shiftId: shift.id }), [cafe?.id, user.id, flow.branch.id, shift.id]);
  const storage = () => (typeof window === "undefined" ? null : window.sessionStorage);
  // Read once: the draft is this person's own typing for this shift, scoped by café, user, branch and shift.
  const [restored] = useState(() => loadCloseDraft(storage(), scope, Date.now()));
  const [cash, setCash] = useState(restored?.actualCash ?? "");
  const [card, setCard] = useState(restored?.actualCard ?? "");
  const [wallet, setWallet] = useState(restored?.actualWallet ?? "");
  const [note, setNote] = useState(restored?.notes ?? "");
  const exceptionAllowed = canKey("handover.exception");
  const [branchCustody, setBranchCustody] = useState(exceptionAllowed && restored?.handoverTarget === "BRANCH_CUSTODY");
  const [leftInDrawer, setLeftInDrawer] = useState(restored?.leftInDrawer ?? "");
  const [toTreasury, setToTreasury] = useState(restored?.toTreasury ?? "");
  const [overnight, setOvernight] = useState(false);
  const [openOrders, setOpenOrders] = useState<{ total: number; refs: string[]; carry: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; blockers: string[] } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    saveCloseDraft(storage(), scope, { actualCash: cash, notes: note, varianceReason: "", actualCard: card, cardReason: "", actualWallet: wallet, walletReason: "",
      handoverTarget: branchCustody ? "BRANCH_CUSTODY" : "", leftInDrawer, toTreasury }, Date.now());
  }, [scope, cash, note, card, wallet, branchCustody, leftInDrawer, toTreasury]);
  useEffect(() => {
    api<{ carryOpenOrdersOnHandover: boolean; open: { total: number; refs: string[] } }>(`/api/orders/open-summary?branchId=${flow.branch.id}`)
      .then((r) => setOpenOrders({ total: r.open.total, refs: r.open.refs, carry: r.carryOpenOrdersOnHandover })).catch(() => setOpenOrders(null));
  }, [flow.branch.id]);
  useEffect(() => {
    if (!branchCustody) return;
    api<{ settings: { overnightCashEnabled: boolean } }>(`/api/branches/${flow.branch.id}/opening-settings`).then((r) => setOvernight(r.settings.overnightCashEnabled)).catch(() => setOvernight(false));
  }, [branchCustody, flow.branch.id]);

  const cashValue = parseAmount(cash, false);
  const cardValue = parseAmount(card, true);
  const walletValue = parseAmount(wallet, true);
  const cardInvalid = card.trim() !== "" && cardValue === null;
  const walletInvalid = wallet.trim() !== "" && walletValue === null;
  const needsDisposition = branchCustody && overnight;
  const ready = cashValue !== null && !cardInvalid && !walletInvalid
    && (!shift.cardSettlementRequired || cardValue !== null)
    && (!shift.walletSettlementRequired || walletValue !== null)
    && (!needsDisposition || (parseAmount(leftInDrawer, false) !== null && parseAmount(toTreasury, false) !== null));
  // Branch custody adds a count only when night cash is stored or the separate
  // periodic full count is due (the server decides again under its lock).
  const materialsNext = flow.handover.enabled && (flow.materials.duePreview || (branchCustody && (overnight || flow.materials.branchCustodyFullCountDue === true)));

  async function commit() {
    if (inFlight.current || !ready || cashValue === null) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    try {
      const res = await api<{ handover?: { required: boolean }; materials?: { due: boolean; nextDueAt: string | null } | null }>(`/api/shifts/${shift.id}/close`, {
        method: "POST",
        body: {
          actualCashAmount: cashValue,
          ...(cardValue !== null ? { actualCardAmount: cardValue } : {}),
          ...(walletValue !== null ? { actualWalletAmount: walletValue } : {}),
          ...(note.trim() ? { notes: note.trim() } : {}),
          ...(flow.handover.enabled ? { handoverTarget: branchCustody ? "BRANCH_CUSTODY" : "SHIFT_TO_SHIFT", directHandover: !branchCustody } : {}),
          ...(needsDisposition ? { cashDisposition: { leftInDrawer: Number(leftInDrawer), toTreasury: Number(toTreasury) } } : {}),
        },
      });
      clearCloseDraft(storage(), scope);
      // "Not due" only when the server decided so; a café that does not count
      // at handover has no materials schedule to be "not due" under.
      await onCommitted(res.materials && !res.materials.due ? { notDue: { nextDueAt: res.materials.nextDueAt } } : null);
      router.refresh();
    } catch (e) {
      // A lost response may still have committed. Ask the server which step
      // remains rather than showing success — or a second close — on a guess.
      const next = await onCommitted(null);
      if (next && next.stage !== "MONEY") { clearCloseDraft(storage(), scope); return; }
      setFailure({ message: e instanceof Error ? e.message : "تعذّر تسجيل الفلوس", blockers: e instanceof ApiRequestError ? blockersOf(e) : [] });
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  return <section className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="money-heading" data-testid="close-money-step">
    <div className="space-y-1">
      <h1 id="money-heading" className="text-xl font-bold">تسليم الفلوس</h1>
      <Identity branch={flow.branch.name} shiftNumber={shift.shiftNumber} name={user.name} />
    </div>
    {openOrders && openOrders.total > 0 && <p data-testid="close-open-orders-notice" className={`rounded-lg border p-3 text-sm ${openOrders.carry ? "border-sky-500/40 bg-sky-500/10" : "border-amber-500/40 bg-amber-500/10"}`}>
      {openOrders.carry ? `${openOrders.total} أوردر مفتوح هيتنقل للشيفت الجاي.` : `عندك ${openOrders.total} أوردر مفتوح (${openOrders.refs.join("، ")}) — قدّمهم أو ألغيهم الأول.`}
    </p>}
    <div className="space-y-2">
      <Label htmlFor="close-cash">النقدية الموجودة في الدرج</Label>
      <p className="text-xs text-muted-foreground">كل الكاش اللي في الدرج، ومعاه رصيد الافتتاح ({money(shift.openingCashAmount, currency)}).</p>
      {currency === "EGP" && <CashDenominationCalculator onApply={(value) => setCash(value)} />}
      <TouchNumberInput id="close-cash" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00" value={cash} aria-label="النقدية الموجودة في الدرج" aria-invalid={cash.trim() !== "" && cashValue === null} onValueChange={setCash} />
      {cash.trim() !== "" && cashValue === null && <p role="alert" className="text-xs text-destructive">اكتب مبلغ صحيح (صفر أو أكتر، لحد قرشين).</p>}
    </div>
    {shift.cardSettlementRequired && <div className="space-y-2">
      <Label htmlFor="close-card">إجمالي الفيزا من الماكينة</Label>
      <TouchNumberInput id="close-card" type="number" step="0.01" dir="ltr" signed placeholder="0.00" value={card} aria-label="إجمالي الفيزا من الماكينة" aria-invalid={cardInvalid} onValueChange={setCard} />
      <p className="text-xs text-muted-foreground">صافي تقرير الماكينة بعد المرتجعات.</p>
      {cardInvalid && <p role="alert" className="text-xs text-destructive">اكتب مبلغ صحيح.</p>}
    </div>}
    {shift.walletSettlementRequired && <div className="space-y-2">
      <Label htmlFor="close-wallet">إجمالي المحافظ</Label>
      <TouchNumberInput id="close-wallet" type="number" step="0.01" dir="ltr" signed placeholder="0.00" value={wallet} aria-label="إجمالي المحافظ" aria-invalid={walletInvalid} onValueChange={setWallet} />
      <p className="text-xs text-muted-foreground">صافي اللي وصل المحافظ بعد المرتجعات.</p>
      {walletInvalid && <p role="alert" className="text-xs text-destructive">اكتب مبلغ صحيح.</p>}
    </div>}
    <div className="space-y-2">
      <Label htmlFor="close-note">ملاحظة (اختياري)</Label>
      <Textarea id="close-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
    </div>
    {flow.handover.enabled && exceptionAllowed && (
      <div className="rounded-xl border bg-muted/20 p-3 text-sm space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            id="branch-custody-toggle"
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-gray-300"
            checked={branchCustody}
            onChange={(e) => setBranchCustody(e.target.checked)}
          />
          <div className="space-y-1">
            <span className="font-semibold text-foreground block">
              آخر شيفت في اليوم؟ (تسليم المخزون لعهدة الفرع)
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {branchCustody ? (
                <span className="text-amber-800 dark:text-amber-300 font-medium block">
                  ⚠️ مفعل: إغلاق نهائي للمبيت وعزل العهدة للفرع. {canKey("handover.accept") ? "بعد «إغلاق» سطور الجرد المعدودة هتتوقّع باسم الفرع باسمك والعهدة هتتحفظ في عهدة الفرع تلقائيًا." : "بعد «إغلاق» المدير يحفظها في عهدة الفرع من صفحة التسليم."} (إذا كان هناك شيفت قادم، اترك الخيار غير محدد).
                </span>
              ) : (
                <span className="block">
                  الوضع الطبيعي الموصى به: تسليم مباشر للشيفت التالي — يستلم الكاشير بضغطة زر واحدة دون الحاجة لتوقيع أو اعتماد سطور.
                </span>
              )}
            </p>
          </div>
        </label>
        {branchCustody && needsDisposition && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 pt-2 border-t">
            <label className="space-y-1"><span className="text-xs">المتروك في الدرج</span><TouchNumberInput aria-label="كاش متروك في الدرج" type="number" min="0" step="0.01" value={leftInDrawer} onValueChange={setLeftInDrawer} /></label>
            <label className="space-y-1"><span className="text-xs">المحوّل للخزنة</span><TouchNumberInput aria-label="كاش محول للخزنة" type="number" min="0" step="0.01" value={toTreasury} onValueChange={setToTreasury} /></label>
          </div>
        )}
      </div>
    )}
    {!materialsNext && flow.handover.enabled && <p className="rounded-lg bg-muted/50 p-2 text-sm" data-testid="materials-not-due-hint">جرد الخامات غير مستحق حسب الجدول{flow.materials.nextDueAt ? ` · الجرد الجاي: ${dateTime(flow.materials.nextDueAt)}` : ""}.</p>}
    {failure && <div role="alert" className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="close-money-error">
      <p>{failure.message}</p>
      {failure.blockers.length > 0 && <ul className="list-inside list-disc">{failure.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      <p className="text-xs text-muted-foreground">المبالغ اللي كتبتها لسه موجودة.</p>
    </div>}
    <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 pt-3 pb-1 backdrop-blur sm:-mx-5 sm:px-5">
      <Button className="h-12 w-full text-base" disabled={busy || !ready} onClick={() => void commit()} data-testid="close-money-submit">
        {busy ? "جارٍ التسجيل…" : materialsNext ? "التالي: تسليم الخامات" : "إنهاء الشيفت"}
      </Button>
    </div>
  </section>;
}

// ── Screen 2 ──────────────────────────────────────────────────────────────
type CountSession = { id: string; status: string; branchId: string; lines: CountLine[] };

function MaterialsStep({ flow, handover, currency, onFinished, onStale }: {
  flow: ClosedFlow; handover: FlowHandover; currency: string;
  onFinished: (recordedDifferences: number) => Promise<void>; onStale: () => Promise<Flow | null>;
}) {
  const { user, canKey } = useApp();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(handover.status === "DRAFT" ? handover.stockCountSessionId : null);
  const [session, setSession] = useState<CountSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState(handover.outgoingNote ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [dispController, setDispController] = useState<DispositionEditorController | null>(null);
  const [, redraw] = useState(0);
  const inFlight = useRef(false);
  const noteKey = `hnd-ux-004-note:${user.id}:${handover.id}`;
  const needsDirectDisposition = handover.target !== "BRANCH_CUSTODY";

  useEffect(() => { try { const saved = window.sessionStorage.getItem(noteKey); if (saved !== null) setNote(saved); } catch { /* storage unavailable */ } }, [noteKey]);
  useEffect(() => { try { if (note) window.sessionStorage.setItem(noteKey, note); else window.sessionStorage.removeItem(noteKey); } catch { /* storage unavailable */ } }, [note, noteKey]);

  // The count this handover is answerable for. Starting it is idempotent on
  // the server; a REJECTED handover gets its replacement round here.
  useEffect(() => {
    if (sessionId) return;
    let stopped = false;
    api<{ countSession: { id: string } }>("/api/handovers", { method: "POST", body: { action: "start_count", handoverId: handover.id } })
      .then((r) => { if (!stopped) setSessionId(r.countSession.id); })
      .catch((e) => { if (!stopped) setLoadError(e instanceof Error ? e.message : "تعذّر فتح جرد الخامات"); });
    return () => { stopped = true; };
  }, [sessionId, handover.id]);

  const queue = useMemo(() => new CountEntryQueue(async (lineId, value, expectedCountedAt) => {
    const { line } = await api<{ line: CountLine }>(`/api/stock-counts/${sessionId}/lines/${lineId}`, { method: "PATCH", body: { countedQuantity: value, expectedCountedAt } })
      .catch((e: unknown) => {
        // A server refusal keeps its own message and status (a 409 is a
        // conflict to review); a lost connection says so in Arabic.
        if (e instanceof ApiRequestError) throw e;
        throw new Error("تعذّر الحفظ — تأكد من الاتصال واضغط «إعادة الحفظ»");
      });
    if (!line || line.id !== lineId) throw new Error("تعذّر التحقق من حفظ الكمية — أعد المحاولة");
    setSession((current) => current ? { ...current, status: current.status === "DRAFT" ? "IN_PROGRESS" : current.status, lines: current.lines.map((row) => row.id === lineId ? line : row) } : current);
    return line;
  }, () => redraw((n) => n + 1), async (lineId) => {
    const { session: fresh } = await api<{ session: CountSession }>(`/api/stock-counts/${sessionId}`);
    const line = fresh.lines.find((row) => row.id === lineId);
    if (!line) throw new Error("تعذّر تحديث سطر الجرد");
    return line;
  }), [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    api<{ session: CountSession }>(`/api/stock-counts/${sessionId}`)
      .then(({ session: s }) => {
        if (stopped) return;
        if (s.branchId !== flow.branch.id) throw new Error("الجرد لا يخص هذا الفرع");
        queue.reconcile(s.lines); setSession(s);
      })
      .catch((e) => { if (!stopped) setLoadError(e instanceof Error ? e.message : "تعذّر فتح جرد الخامات"); });
    return () => { stopped = true; };
  }, [sessionId, queue, flow.branch.id]);

  const lines = session?.lines ?? [];
  const capture = session ? ["DRAFT", "IN_PROGRESS"].includes(session.status) : false;
  const savedCount = lines.filter((l) => (queue.get(l.id)?.status ?? (l.countedQuantity === null ? "empty" : "saved")) === "saved").length;
  const dispositionReady = !needsDirectDisposition || !!flow.cashDisposition || (dispController?.valid ?? false);
  const complete = !!session && lines.length > 0 && (capture ? queue.canSubmit(true) : true) && dispositionReady;

  async function finish() {
    if (inFlight.current || !session) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    try {
      // Every typed figure is saved and acknowledged before the submission.
      if (capture) {
        for (const line of lines) {
          const entry = queue.get(line.id);
          if (entry && (entry.status === "dirty" || entry.status === "saving")) await queue.save(line.id);
        }
        if (!queue.canSubmit(true)) { setFailure("في كميات ما اتحفظتش — راجع الخانات المعلّمة"); return; }
      }
      if (needsDirectDisposition && dispController && !dispController.alreadyRecorded) {
        await dispController.submit();
      }
      const result = await api<{ recordedDifferences: number }>("/api/handovers", { method: "POST", body: { action: "finish_outgoing", handoverId: handover.id, ...(note.trim() ? { note: note.trim() } : {}) } });
      try { window.sessionStorage.removeItem(noteKey); } catch { /* storage unavailable */ }
      await onFinished(result.recordedDifferences ?? 0);
      router.refresh();
    } catch (e) {
      const next = await onStale();
      if (next && next.stage === "DONE") return;
      setFailure(e instanceof Error ? e.message : "تعذّر إنهاء التسليم");
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  const money1 = flow.shift;
  return <section className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="materials-heading" data-testid="close-materials-step">
    <div className="space-y-1">
      <h1 id="materials-heading" className="text-xl font-bold">تسليم الخامات</h1>
      <Identity branch={flow.branch.name} shiftNumber={money1.shiftNumber} name={user.name} />
      {money1.materialsDecision && <p className="text-xs text-muted-foreground">{materialsDecisionLabel(money1.materialsDecision)}{money1.materialsDecision.periodFrom ? ` · ${money1.materialsDecision.periodFrom === money1.materialsDecision.periodTo ? money1.materialsDecision.periodTo : `${money1.materialsDecision.periodFrom} ← ${money1.materialsDecision.periodTo}`}` : ""}</p>}
    </div>
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    {!session && !loadError && <div className="h-40 animate-pulse rounded-xl bg-muted/30" />}
    {session && <>
      <p className="text-sm" aria-live="polite">اكتب الكمية الفعلية لكل صنف · المحفوظ {savedCount}/{lines.length}</p>
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader className="max-sm:hidden"><TableRow><TableHead>الصنف</TableHead><TableHead>الوحدة</TableHead><TableHead>الكمية الفعلية</TableHead><TableHead>الحفظ</TableHead></TableRow></TableHeader>
          <TableBody>
            {lines.map((line) => <CountLineRow key={line.id} line={line} sessionStatus={session.status as never} blind handover can={canKey} busy={busy || !capture}
              entry={queue.get(line.id) ?? { value: line.countedQuantity ?? "", status: line.countedQuantity === null ? "empty" : "saved" }}
              onDraft={(id, value) => { if (!inFlight.current) queue.edit(id, value); }}
              onSave={(id) => { if (!inFlight.current) void queue.save(id); }}
              onAct={() => {}} />)}
          </TableBody>
        </Table>
      </div>
      {!capture && <p className="text-xs text-muted-foreground">الكميات اتسجلت — اضغط «إنهاء التسليم» لتسليمها.</p>}
    </>}
    <div className="space-y-2">
      <Label htmlFor="materials-note">ملاحظة (اختياري)</Label>
      <Textarea id="materials-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
    </div>
    {needsDirectDisposition && money1.actualCashAmount !== null && (
      <CashDispositionEditor
        shiftId={money1.id}
        countedCash={Number(money1.actualCashAmount)}
        expectedCash={money1.expectedCashAmount != null ? Number(money1.expectedCashAmount) : null}
        cashDifference={money1.cashDifference != null ? Number(money1.cashDifference) : null}
        electronicCard={money1.tenderReconciliations.find((t) => t.method === "CARD")?.actualAmount != null ? Number(money1.tenderReconciliations.find((t) => t.method === "CARD")!.actualAmount) : null}
        electronicWallet={money1.tenderReconciliations.find((t) => t.method === "WALLET")?.actualAmount != null ? Number(money1.tenderReconciliations.find((t) => t.method === "WALLET")!.actualAmount) : null}
        currency={currency}
        recipients={flow.recipients ?? []}
        initialDisposition={flow.cashDisposition ?? null}
        draftKey={`hnd-disp:${user.id}:${money1.id}`}
        onControllerChange={setDispController}
      />
    )}
    <section className="space-y-3 rounded-xl border bg-muted/15 p-4 text-sm" data-testid="outgoing-unified-review">
      <h2 className="font-bold">مراجعة ملخص الإغلاق والتسليم قبل الإرسال</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border bg-background p-2.5">
          <div className="text-xs text-muted-foreground">النقدية الفعلية المعدودة</div>
          <div className="mt-0.5 font-bold tabular-nums">{money1.actualCashAmount === null ? "—" : money(money1.actualCashAmount, currency)}</div>
        </div>
        <div className="rounded-lg border bg-background p-2.5">
          <div className="text-xs text-muted-foreground">الخامات المعدودة</div>
          <div className="mt-0.5 font-bold tabular-nums">{savedCount} / {lines.length} صنف</div>
        </div>
        <div className="rounded-lg border bg-background p-2.5">
          <div className="text-xs text-muted-foreground">تُترك في الدرج كعهدة</div>
          <div className="mt-0.5 font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {dispController ? money(dispController.retainedAmount, currency) : flow.cashDisposition ? money(flow.cashDisposition.retainedAmount, currency) : "—"}
          </div>
        </div>
      </div>
      {lines.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {lines.map((l) => {
            const val = queue.get(l.id)?.value ?? l.countedQuantity;
            return (
              <span key={l.id} className="rounded-md border bg-background px-2 py-1 tabular-nums">
                {l.inventoryItem.name}: <strong>{val ?? "—"}</strong> {UNIT_LABEL[l.unit as keyof typeof UNIT_LABEL] ?? l.unit}
              </span>
            );
          })}
        </div>
      )}
      {dispController && dispController.deliveries.length > 0 && (
        <div className="space-y-1 text-xs">
          {dispController.deliveries.map((d, idx) => (
            <div key={`${d.destination}-${d.recipientId}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5">
              <span>{d.destinationLabel} ({d.recipientName}): <strong className="tabular-nums">{money(d.amount, currency)}</strong></span>
              <span className="text-amber-800 dark:text-amber-300">تسليم مُعلن — بانتظار تأكيد المستلم</span>
            </div>
          ))}
        </div>
      )}
    </section>
    <details className="rounded-lg border p-3 text-sm" data-testid="close-money-summary">
      <summary className="cursor-pointer text-muted-foreground">تسليم الفلوس — اتسجل</summary>
      <MoneySummary shift={money1} currency={currency} />
    </details>
    {failure && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="close-materials-error">{failure}</p>}
    <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 pt-3 pb-1 backdrop-blur sm:-mx-5 sm:px-5">
      <Button className="h-12 w-full text-base" disabled={busy || !complete} onClick={() => void finish()} data-testid="close-materials-submit">{busy ? "جارٍ التسليم…" : "إغلاق الوردية وتسليم العهدة"}</Button>
    </div>
  </section>;
}

function MoneySummary({ shift, currency }: { shift: ClosedShift; currency: string }) {
  const label: Record<string, string> = { CARD: "الفيزا", WALLET: "المحافظ" };
  return <dl className="mt-2 space-y-1">
    <div className="flex justify-between gap-3"><dt className="text-muted-foreground">النقدية في الدرج</dt><dd className="tabular-nums">{shift.actualCashAmount === null ? "—" : money(shift.actualCashAmount, currency)}</dd></div>
    {shift.tenderReconciliations.map((t) => <div key={t.method} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label[t.method] ?? t.method}</dt><dd className="tabular-nums">{t.actualAmount === null ? "—" : money(t.actualAmount, currency)}</dd></div>)}
    {shift.financiallyClosedAt && <div className="flex justify-between gap-3 text-xs text-muted-foreground"><dt>اتسجل</dt><dd>{dateTime(shift.financiallyClosedAt)}</dd></div>}
  </dl>;
}

// ── Done ──────────────────────────────────────────────────────────────────
// A manager's own branch-custody close is saved to branch custody right here: the same per-line
// signatures and conversion as «حفظ في عهدة الفرع» on the handover screen, run once on arrival. When
// it cannot finish (a required item needs a manager's reason, or a line failed), what was signed stays
// signed and the handover screen finishes it.
function AutoBranchSave({ handoverId, href }: { handoverId: string; href: string }) {
  const [state, setState] = useState<{ phase: "running" } | { phase: "saved"; signed: number; message: string } | { phase: "stopped"; message: string }>({ phase: "running" });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const signed = await signPendingLines(handoverId);
      if (signed.failed.length) {
        setState({ phase: "stopped", message: `اتوقّع ${signed.done} من ${signed.total} سطر، وفاضل ${signed.failed.length}: ${signed.failed.map((f) => f.name).join("، ")}.` });
        return;
      }
      const res = await convertToBranchCustody(handoverId);
      setState(res.ok ? { phase: "saved", signed: signed.done, message: convertedMessage(res) }
        : { phase: "stopped", message: res.omissionRequired ? "فيه صنف مطلوب ماتعدّش — الحفظ محتاج سبب مدير ومبرر مكتوب." : res.message });
    })();
  }, [handoverId]);
  if (state.phase === "running") return <p role="status" className="text-sm text-muted-foreground" data-testid="close-branch-saving">جارٍ الحفظ في عهدة الفرع باسمك…</p>;
  if (state.phase === "saved") return <p role="status" className="text-sm" data-testid="close-branch-saved">✓ {state.message}{state.signed > 0 ? ` · اتوقّع ${state.signed} سطر جرد باسم الفرع باسمك` : ""}. شيفت الصبح بيجرد ويتحقق قبل البيع.</p>;
  return <div role="alert" className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="close-branch-stopped">
    <p>الحفظ في عهدة الفرع ما خلصش: {state.message} اللي اتوقّع محفوظ.</p>
    <Link href={`${href}#inventory`} className={buttonVariants({ className: "h-11" })} data-testid="close-save-to-branch">كمّل «حفظ في عهدة الفرع»</Link>
  </div>;
}

function DoneStep({ flow, currency, outcome }: { flow: ClosedFlow; currency: string; outcome: { notDue?: { nextDueAt: string | null }; recordedDifferences?: number } | null }) {
  const { canKey } = useApp();
  const router = useRouter();
  const shift = flow.shift;
  const handover = flow.handover;
  const submitted = shift.status === "AWAITING_HANDOVER" && handover && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(handover.status);
  // Nobody arrives after a branch-custody night: the next act is the manager's «حفظ في عهدة الفرع», not handing the device over.
  const branchNight = !!submitted && handover?.target === "BRANCH_CUSTODY";
  const waiting = submitted && !branchNight;
  const maySaveToBranch = canKey("handover.accept") && canKey("handover.exception");
  const handoverHref = handover ? `/handovers?branchId=${encodeURIComponent(flow.branch.id)}&handoverId=${encodeURIComponent(handover.id)}` : null;
  const decision = shift.materialsDecision;
  const notDue = decision ? !decision.due : !!outcome?.notDue;
  const nextDueAt = decision?.nextDueAt ?? outcome?.notDue?.nextDueAt ?? null;
  const moneyDifference = shift.cashDifference != null && Number(shift.cashDifference) !== 0
    || shift.tenderReconciliations.some((t) => t.varianceAmount != null && Number(t.varianceAmount) !== 0);
  const hasDifferences = (outcome?.recordedDifferences ?? 0) > 0 || moneyDifference;
  async function handOver() {
    await fetch("/api/auth/logout", { method: "POST" });
    const next = handoverHref ?? "/pos";
    router.push(`/login?next=${encodeURIComponent(next)}`);
    router.refresh();
  }
  return <section className="space-y-4 rounded-2xl border bg-card p-5 text-center" data-testid="close-done-step">
    <p className="text-4xl" aria-hidden>✓</p>
    <h1 className="text-xl font-bold">تم تسجيل تسليم شيفتك</h1>
    {waiting && <p className="text-sm text-muted-foreground">بانتظار استلام الموظف الجاي من حسابه.</p>}
    {branchNight && maySaveToBranch && handover && handoverHref && <AutoBranchSave handoverId={handover.id} href={handoverHref} />}
    {branchNight && !maySaveToBranch && <p className="text-sm text-muted-foreground" data-testid="close-branch-night">باقي خطوة واحدة: المدير يضغط «حفظ في عهدة الفرع» من صفحة التسليم. شيفت الصبح بيجرد ويتحقق قبل البيع.</p>}
    {notDue && <p className="text-sm" data-testid="materials-not-due">جرد الخامات غير مستحق حسب الجدول{nextDueAt ? ` · الجرد الجاي: ${dateTime(nextDueAt)}` : ""}.</p>}
    {hasDifferences && canKey("shifts.view_reports") && <p className="text-sm">الفروق المسجلة موجودة في <Link className="underline" href={`/reports/shift/${shift.id}`} target="_blank">تقرير الشيفت</Link>.</p>}
    {hasDifferences && !canKey("shifts.view_reports") && <p className="text-sm text-muted-foreground">الفروق المسجلة متاحة للمالك في تقرير الشيفت.</p>}
    {shift.actualCashAmount !== null && (!handover || handover.target !== "BRANCH_CUSTODY") && (
      <div className="text-start">
        <CashDispositionEditor
          shiftId={shift.id}
          countedCash={Number(shift.actualCashAmount)}
          expectedCash={shift.expectedCashAmount != null ? Number(shift.expectedCashAmount) : null}
          cashDifference={shift.cashDifference != null ? Number(shift.cashDifference) : null}
          currency={currency}
          recipients={flow.recipients ?? []}
          initialDisposition={flow.cashDisposition ?? null}
          showSaveButton
        />
      </div>
    )}
    <details className="rounded-lg border p-3 text-start text-sm">
      <summary className="cursor-pointer text-muted-foreground">تفاصيل تسليم الفلوس</summary>
      <MoneySummary shift={shift} currency={currency} />
    </details>
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
      {waiting && <Button className="h-12" onClick={() => void handOver()} data-testid="close-hand-device">تسليم الجهاز للموظف الجاي</Button>}
      <Link href="/pos" className={buttonVariants({ variant: "outline", className: "h-12" })}>رجوع للكاشير</Link>
    </div>
  </section>;
}
