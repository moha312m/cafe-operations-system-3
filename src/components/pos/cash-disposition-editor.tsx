"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money as formatMoney } from "@/lib/client";
import { decimal, money as roundMoney, sumMoney, validCurrencyInput } from "@/lib/money";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type EligibleRecipient = {
  id: string;
  name: string;
  role: "CAFE_OWNER" | "BRANCH_MANAGER";
  destination: "OWNER" | "MANAGER";
};

export type DispositionDeliveryView = {
  id: string;
  destination: "OWNER" | "MANAGER";
  destinationLabel: string;
  recipientId: string;
  recipientName: string;
  amount: number;
  reference: string | null;
  status: "DECLARED" | "CONFIRMED" | "DISPUTED" | "RESOLVED";
  statusLabel: string;
  declaredAt: string;
  confirmedAt: string | null;
};

export type DispositionView = {
  id: string;
  shiftId: string;
  handoverId: string | null;
  countedCash: number;
  expectedCash: number;
  cashDifference: number;
  deliveredAmount: number;
  retainedAmount: number;
  note: string | null;
  declaredByName: string;
  declaredAt: string;
  deliveries: DispositionDeliveryView[];
  retainedCustody: {
    destinationLabel: string;
    amount: number;
    status: string;
    statusLabel: string;
    holderName: string | null;
  };
};

export type DraftDeliveryRow = {
  key: string;
  enabled: boolean;
  destination: "OWNER" | "MANAGER";
  recipientId: string;
  amount: string;
  reference: string;
};

export type DispositionEditorController = {
  valid: boolean;
  error: string | null;
  alreadyRecorded: boolean;
  counted: number;
  deliveredTotal: number;
  retainedAmount: number;
  deliveries: Array<{
    destination: "OWNER" | "MANAGER";
    recipientId: string;
    recipientName: string;
    destinationLabel: string;
    amount: number;
    reference: string | null;
  }>;
  note: string;
  submit: () => Promise<DispositionView>;
};

export function CashDispositionEditor({
  shiftId,
  countedCash,
  expectedCash,
  cashDifference,
  electronicCard,
  electronicWallet,
  currency,
  recipients,
  initialDisposition,
  draftKey,
  showSaveButton = false,
  onRecorded,
  onControllerChange,
}: {
  shiftId: string;
  countedCash: number;
  expectedCash?: number | null;
  cashDifference?: number | null;
  electronicCard?: number | null;
  electronicWallet?: number | null;
  currency: string;
  recipients: EligibleRecipient[];
  initialDisposition?: DispositionView | null;
  draftKey?: string;
  showSaveButton?: boolean;
  onRecorded?: (disposition: DispositionView) => void;
  onControllerChange?: (controller: DispositionEditorController) => void;
}) {
  const owners = useMemo(() => recipients.filter((r) => r.destination === "OWNER"), [recipients]);
  const managers = useMemo(() => recipients.filter((r) => r.destination === "MANAGER"), [recipients]);

  const [recorded, setRecorded] = useState<DispositionView | null>(initialDisposition ?? null);
  useEffect(() => {
    if (initialDisposition) setRecorded(initialDisposition);
  }, [initialDisposition]);

  const defaultOwnerId = owners[0]?.id ?? "";
  const defaultManagerId = managers[0]?.id ?? "";

  const [ownerEnabled, setOwnerEnabled] = useState(false);
  const [ownerRecipientId, setOwnerRecipientId] = useState(defaultOwnerId);
  const [ownerAmount, setOwnerAmount] = useState("");
  const [ownerReference, setOwnerReference] = useState("");

  const [managerEnabled, setManagerEnabled] = useState(false);
  const [managerRecipientId, setManagerRecipientId] = useState(defaultManagerId);
  const [managerAmount, setManagerAmount] = useState("");
  const [managerReference, setManagerReference] = useState("");

  const [retainedText, setRetainedText] = useState(() => roundMoney(countedCash).toFixed(2));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string>("");

  useEffect(() => {
    if (!ownerRecipientId && defaultOwnerId) setOwnerRecipientId(defaultOwnerId);
  }, [ownerRecipientId, defaultOwnerId]);
  useEffect(() => {
    if (!managerRecipientId && defaultManagerId) setManagerRecipientId(defaultManagerId);
  }, [managerRecipientId, defaultManagerId]);

  // Restore draft from sessionStorage when available
  useEffect(() => {
    if (!draftKey || initialDisposition) return;
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        ownerEnabled?: boolean;
        ownerRecipientId?: string;
        ownerAmount?: string;
        ownerReference?: string;
        managerEnabled?: boolean;
        managerRecipientId?: string;
        managerAmount?: string;
        managerReference?: string;
        retainedText?: string;
        note?: string;
      };
      if (typeof parsed.ownerEnabled === "boolean") setOwnerEnabled(parsed.ownerEnabled);
      if (parsed.ownerRecipientId) setOwnerRecipientId(parsed.ownerRecipientId);
      if (typeof parsed.ownerAmount === "string") setOwnerAmount(parsed.ownerAmount);
      if (typeof parsed.ownerReference === "string") setOwnerReference(parsed.ownerReference);
      if (typeof parsed.managerEnabled === "boolean") setManagerEnabled(parsed.managerEnabled);
      if (parsed.managerRecipientId) setManagerRecipientId(parsed.managerRecipientId);
      if (typeof parsed.managerAmount === "string") setManagerAmount(parsed.managerAmount);
      if (typeof parsed.managerReference === "string") setManagerReference(parsed.managerReference);
      if (typeof parsed.retainedText === "string") setRetainedText(parsed.retainedText);
      if (typeof parsed.note === "string") setNote(parsed.note);
    } catch {
      /* ignore */
    }
  }, [draftKey, initialDisposition]);

  useEffect(() => {
    if (!draftKey || recorded) return;
    try {
      window.sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          ownerEnabled,
          ownerRecipientId,
          ownerAmount,
          ownerReference,
          managerEnabled,
          managerRecipientId,
          managerAmount,
          managerReference,
          retainedText,
          note,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    draftKey,
    recorded,
    ownerEnabled,
    ownerRecipientId,
    ownerAmount,
    ownerReference,
    managerEnabled,
    managerRecipientId,
    managerAmount,
    managerReference,
    retainedText,
    note,
  ]);

  const validation = useMemo(() => {
    if (recorded) {
      return {
        valid: true,
        error: null as string | null,
        counted: recorded.countedCash,
        deliveredTotal: recorded.deliveredAmount,
        retainedAmount: recorded.retainedAmount,
        remainingUnallocated: 0,
        deliveries: recorded.deliveries.map((d) => ({
          destination: d.destination,
          recipientId: d.recipientId,
          recipientName: d.recipientName,
          destinationLabel: d.destinationLabel,
          amount: d.amount,
          reference: d.reference,
        })),
      };
    }

    const countedDec = roundMoney(countedCash);
    const deliveries: Array<{
      destination: "OWNER" | "MANAGER";
      recipientId: string;
      recipientName: string;
      destinationLabel: string;
      amount: number;
      reference: string | null;
    }> = [];

    if (ownerEnabled) {
      if (!ownerRecipientId) {
        return { valid: false, error: "اختر المالك المستلم من القائمة", counted: countedDec.toNumber(), deliveredTotal: 0, retainedAmount: 0, remainingUnallocated: 0, deliveries: [] };
      }
      if (!validCurrencyInput(ownerAmount) || decimal(ownerAmount).lte(0)) {
        return { valid: false, error: "اكتب مبلغ التسليم للمالك (أكبر من صفر وبحد أقصى قرشين)", counted: countedDec.toNumber(), deliveredTotal: 0, retainedAmount: 0, remainingUnallocated: 0, deliveries: [] };
      }
      const rec = owners.find((o) => o.id === ownerRecipientId);
      deliveries.push({
        destination: "OWNER",
        recipientId: ownerRecipientId,
        recipientName: rec?.name ?? "المالك",
        destinationLabel: "استلمها المالك",
        amount: roundMoney(ownerAmount).toNumber(),
        reference: ownerReference.trim() || null,
      });
    }

    if (managerEnabled) {
      if (!managerRecipientId) {
        return { valid: false, error: "اختر المدير المستلم من القائمة", counted: countedDec.toNumber(), deliveredTotal: 0, retainedAmount: 0, remainingUnallocated: 0, deliveries: [] };
      }
      if (!validCurrencyInput(managerAmount) || decimal(managerAmount).lte(0)) {
        return { valid: false, error: "اكتب مبلغ التسليم للمدير (أكبر من صفر وبحد أقصى قرشين)", counted: countedDec.toNumber(), deliveredTotal: 0, retainedAmount: 0, remainingUnallocated: 0, deliveries: [] };
      }
      const rec = managers.find((m) => m.id === managerRecipientId);
      deliveries.push({
        destination: "MANAGER",
        recipientId: managerRecipientId,
        recipientName: rec?.name ?? "المدير",
        destinationLabel: "استلمها المدير",
        amount: roundMoney(managerAmount).toNumber(),
        reference: managerReference.trim() || null,
      });
    }

    if (!validCurrencyInput(retainedText) || decimal(retainedText).lt(0)) {
      return { valid: false, error: "اكتب المبلغ المتروك في الدرج كعهدة (صفر أو أكثر وبحد أقصى قرشين)", counted: countedDec.toNumber(), deliveredTotal: 0, retainedAmount: 0, remainingUnallocated: 0, deliveries };
    }

    const deliveredDec = roundMoney(sumMoney(deliveries.map((d) => d.amount)));
    const retainedDec = roundMoney(retainedText);
    const allocatedDec = deliveredDec.plus(retainedDec);
    const remainingDec = countedDec.minus(allocatedDec);

    if (!allocatedDec.eq(countedDec)) {
      return {
        valid: false,
        error: `توزيع النقدية لازم يساوي المعدود بالظبط: المعدود ${countedDec.toFixed(2)} والموزّع ${allocatedDec.toFixed(2)} (الفرق ${remainingDec.toFixed(2)})`,
        counted: countedDec.toNumber(),
        deliveredTotal: deliveredDec.toNumber(),
        retainedAmount: retainedDec.toNumber(),
        remainingUnallocated: remainingDec.toNumber(),
        deliveries,
      };
    }

    return {
      valid: true,
      error: null,
      counted: countedDec.toNumber(),
      deliveredTotal: deliveredDec.toNumber(),
      retainedAmount: retainedDec.toNumber(),
      remainingUnallocated: 0,
      deliveries,
    };
  }, [
    recorded,
    countedCash,
    ownerEnabled,
    ownerRecipientId,
    ownerAmount,
    ownerReference,
    managerEnabled,
    managerRecipientId,
    managerAmount,
    managerReference,
    retainedText,
    owners,
    managers,
  ]);

  const fillRemainderToDrawer = useCallback(
    (nextOwnerEnabled = ownerEnabled, nextOwnerAmt = ownerAmount, nextMgrEnabled = managerEnabled, nextMgrAmt = managerAmount) => {
      const countedDec = roundMoney(countedCash);
      const oDec = nextOwnerEnabled && validCurrencyInput(nextOwnerAmt) && decimal(nextOwnerAmt).gt(0) ? roundMoney(nextOwnerAmt) : decimal(0);
      const mDec = nextMgrEnabled && validCurrencyInput(nextMgrAmt) && decimal(nextMgrAmt).gt(0) ? roundMoney(nextMgrAmt) : decimal(0);
      const rem = countedDec.minus(oDec).minus(mDec);
      if (rem.gte(0)) setRetainedText(rem.toFixed(2));
    },
    [countedCash, ownerEnabled, ownerAmount, managerEnabled, managerAmount],
  );

  const submit = useCallback(async (): Promise<DispositionView> => {
    if (recorded) return recorded;
    if (!validation.valid) {
      throw new Error(validation.error ?? "راجع توزيع النقدية قبل الحفظ");
    }
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = `disp-${shiftId}-${crypto.randomUUID()}`;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await api<{ disposition: DispositionView }>(`/api/shifts/${shiftId}/cash-disposition`, {
        method: "POST",
        body: {
          deliveries: validation.deliveries.map((d) => ({
            destination: d.destination,
            recipientId: d.recipientId,
            amount: d.amount,
            ...(d.reference ? { reference: d.reference } : {}),
          })),
          retainedAmount: validation.retainedAmount,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        idempotencyKey: idempotencyKeyRef.current,
      });
      setRecorded(res.disposition);
      if (draftKey) {
        try {
          window.sessionStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
      }
      onRecorded?.(res.disposition);
      return res.disposition;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "تعذّر تسجيل مصير النقدية";
      setSubmitError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [recorded, validation, shiftId, note, draftKey, onRecorded]);

  useEffect(() => {
    onControllerChange?.({
      valid: validation.valid,
      error: validation.error,
      alreadyRecorded: !!recorded,
      counted: validation.counted,
      deliveredTotal: validation.deliveredTotal,
      retainedAmount: validation.retainedAmount,
      deliveries: validation.deliveries,
      note: recorded ? (recorded.note ?? "") : note,
      submit,
    });
  }, [validation, recorded, note, submit, onControllerChange]);

  if (recorded) {
    return (
      <section className="space-y-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm" data-testid="cash-disposition-recorded">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-emerald-900 dark:text-emerald-200">✓ تم تسجيل مصير النقدية المعدودة</h2>
          <span className="text-xs text-muted-foreground">المعدود: {formatMoney(recorded.countedCash, currency)}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border bg-background p-2.5">
            <div className="text-xs text-muted-foreground">إجمالي التسليمات المُعلنة (مالك / مدير)</div>
            <div className="mt-0.5 text-base font-bold tabular-nums">{formatMoney(recorded.deliveredAmount, currency)}</div>
          </div>
          <div className="rounded-lg border bg-background p-2.5">
            <div className="text-xs text-muted-foreground">{recorded.retainedCustody.destinationLabel}</div>
            <div className="mt-0.5 text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{formatMoney(recorded.retainedAmount, currency)}</div>
            <div className="text-xs text-muted-foreground">{recorded.retainedCustody.statusLabel}</div>
          </div>
        </div>
        {recorded.deliveries.length > 0 && (
          <div className="space-y-1.5">
            {recorded.deliveries.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-2 text-xs">
                <span>
                  <strong>{d.destinationLabel}</strong> ({d.recipientName}): <span className="font-bold tabular-nums">{formatMoney(d.amount, currency)}</span>
                </span>
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-900 dark:text-amber-200">{d.statusLabel}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border bg-muted/20 p-4 text-sm" data-testid="cash-disposition-editor">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">تحديد مصير النقدية المعدودة</h2>
          <p className="text-xs text-muted-foreground">
            حدد أين ذهبت النقدية المعدودة في الدرج ({formatMoney(countedCash, currency)}): تسليم للمالك، أو للمدير، أو تُترك في الدرج كعهدة للوردية التالية.
          </p>
        </div>
        <div className="rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold tabular-nums">
          النقدية المعدودة: {formatMoney(countedCash, currency)}
        </div>
      </div>

      {/* Separate expected-vs-counted discrepancy notice & electronic payment note */}
      <div className="rounded-lg border bg-background p-2.5 text-xs text-muted-foreground space-y-1">
        <p>
          • مبالغ البطاقة (الفيزا{electronicCard != null ? `: ${formatMoney(electronicCard, currency)}` : ""}) وإنستاباي / المحافظ ({electronicWallet != null ? formatMoney(electronicWallet, currency) : "الإلكترونية"}) هي بيانات مطابقة وتسوية فقط وليست نقدية فعلية قابلة للتوزيع.
        </p>
        {expectedCash != null && cashDifference != null && (
          <p data-testid="cash-disposition-discrepancy-note">
            • النقد المتوقع بالنظام: <span className="font-semibold tabular-nums">{formatMoney(expectedCash, currency)}</span> · فرق العد عند الإغلاق:{" "}
            <span className={cn("font-semibold tabular-nums", Math.abs(cashDifference) > 0.005 ? "text-amber-700" : "text-emerald-700")}>
              {cashDifference > 0 ? "+" : ""}{formatMoney(cashDifference, currency)}
            </span>{" "}
            (يُعرض ويُسجّل منفصلًا عن توزيع النقد الفعلي).
          </p>
        )}
      </div>

      {/* Quick Presets */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="اختصارات توزيع النقدية">
        <button
          type="button"
          data-testid="disposition-preset-all-retained"
          onClick={() => {
            setOwnerEnabled(false);
            setOwnerAmount("");
            setManagerEnabled(false);
            setManagerAmount("");
            setRetainedText(roundMoney(countedCash).toFixed(2));
          }}
          className="rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-muted"
        >
          تُترك بالكامل في الدرج كعهدة ({formatMoney(countedCash, currency)})
        </button>
        {owners.length > 0 && countedCash > 0 && (
          <button
            type="button"
            data-testid="disposition-preset-all-owner"
            onClick={() => {
              setOwnerEnabled(true);
              if (!ownerRecipientId && owners[0]) setOwnerRecipientId(owners[0].id);
              setOwnerAmount(roundMoney(countedCash).toFixed(2));
              setManagerEnabled(false);
              setManagerAmount("");
              setRetainedText("0.00");
            }}
            className="rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            استلمها المالك بالكامل
          </button>
        )}
        {managers.length > 0 && countedCash > 0 && (
          <button
            type="button"
            data-testid="disposition-preset-all-manager"
            onClick={() => {
              setManagerEnabled(true);
              if (!managerRecipientId && managers[0]) setManagerRecipientId(managers[0].id);
              setManagerAmount(roundMoney(countedCash).toFixed(2));
              setOwnerEnabled(false);
              setOwnerAmount("");
              setRetainedText("0.00");
            }}
            className="rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            استلمها المدير بالكامل
          </button>
        )}
      </div>

      {/* Choice 1: استلمها المالك */}
      <div className={cn("space-y-3 rounded-xl border p-3", ownerEnabled ? "border-primary bg-background" : "bg-background/60")}>
        <label className="flex cursor-pointer items-center justify-between gap-2 font-semibold">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={ownerEnabled}
              disabled={owners.length === 0}
              onChange={(e) => {
                const next = e.target.checked;
                setOwnerEnabled(next);
                if (!next) {
                  setOwnerAmount("");
                  fillRemainderToDrawer(false, "", managerEnabled, managerAmount);
                }
              }}
              data-testid="disposition-toggle-owner"
            />
            <span>استلمها المالك</span>
          </span>
          {owners.length === 0 && <span className="text-xs font-normal text-muted-foreground">لا يوجد حساب مالك آخر متاح</span>}
        </label>
        {ownerEnabled && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="disp-owner-recipient" className="text-xs">حساب المالك المستلم</Label>
              <select
                id="disp-owner-recipient"
                className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                value={ownerRecipientId}
                onChange={(e) => setOwnerRecipientId(e.target.value)}
                data-testid="disposition-owner-select"
              >
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="disp-owner-amount" className="text-xs">المبلغ المُسلّم للمالك</Label>
              <TouchNumberInput
                id="disp-owner-amount"
                type="number"
                min="0"
                step="0.01"
                dir="ltr"
                placeholder="0.00"
                value={ownerAmount}
                aria-label="المبلغ المُسلّم للمالك"
                onValueChange={(val) => {
                  setOwnerAmount(val);
                  fillRemainderToDrawer(true, val, managerEnabled, managerAmount);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="disp-owner-ref" className="text-xs">مرجع / بيان (اختياري)</Label>
              <input
                id="disp-owner-ref"
                className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                maxLength={160}
                placeholder="مثال: تسليم يدًا بيد"
                value={ownerReference}
                onChange={(e) => setOwnerReference(e.target.value)}
              />
            </div>
            <p className="text-xs text-amber-800 dark:text-amber-300 sm:col-span-3">
              يُحفظ كـ «تسليم مُعلن — بانتظار تأكيد المستلم» ليؤكده المالك من حسابه الخاص، ولا يمنع الوردية التالية من استلام المتبقي في الدرج.
            </p>
          </div>
        )}
      </div>

      {/* Choice 2: استلمها المدير */}
      <div className={cn("space-y-3 rounded-xl border p-3", managerEnabled ? "border-primary bg-background" : "bg-background/60")}>
        <label className="flex cursor-pointer items-center justify-between gap-2 font-semibold">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={managerEnabled}
              disabled={managers.length === 0}
              onChange={(e) => {
                const next = e.target.checked;
                setManagerEnabled(next);
                if (!next) {
                  setManagerAmount("");
                  fillRemainderToDrawer(ownerEnabled, ownerAmount, false, "");
                }
              }}
              data-testid="disposition-toggle-manager"
            />
            <span>استلمها المدير</span>
          </span>
          {managers.length === 0 && <span className="text-xs font-normal text-muted-foreground">لا يوجد مدير فرع متاح</span>}
        </label>
        {managerEnabled && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="disp-manager-recipient" className="text-xs">حساب المدير المستلم</Label>
              <select
                id="disp-manager-recipient"
                className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                value={managerRecipientId}
                onChange={(e) => setManagerRecipientId(e.target.value)}
                data-testid="disposition-manager-select"
              >
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="disp-manager-amount" className="text-xs">المبلغ المُسلّم للمدير</Label>
              <TouchNumberInput
                id="disp-manager-amount"
                type="number"
                min="0"
                step="0.01"
                dir="ltr"
                placeholder="0.00"
                value={managerAmount}
                aria-label="المبلغ المُسلّم للمدير"
                onValueChange={(val) => {
                  setManagerAmount(val);
                  fillRemainderToDrawer(ownerEnabled, ownerAmount, true, val);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="disp-manager-ref" className="text-xs">مرجع / بيان (اختياري)</Label>
              <input
                id="disp-manager-ref"
                className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                maxLength={160}
                placeholder="مثال: تسليم نهاية الشيفت"
                value={managerReference}
                onChange={(e) => setManagerReference(e.target.value)}
              />
            </div>
            <p className="text-xs text-amber-800 dark:text-amber-300 sm:col-span-3">
              يُحفظ كـ «تسليم مُعلن — بانتظار تأكيد المستلم» ليؤكده المدير من حسابه الخاص.
            </p>
          </div>
        )}
      </div>

      {/* Choice 3: تُترك في الدرج كعهدة */}
      <div className="space-y-2 rounded-xl border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="disp-retained-amount" className="font-semibold">تُترك في الدرج كعهدة (رصيد افتتاح الوردية التالية)</Label>
          <button
            type="button"
            onClick={() => fillRemainderToDrawer()}
            className="text-xs font-medium text-primary underline"
            data-testid="disposition-fill-remainder"
          >
            وضع الباقي في الدرج تلقائيًا
          </button>
        </div>
        <TouchNumberInput
          id="disp-retained-amount"
          type="number"
          min="0"
          step="0.01"
          dir="ltr"
          placeholder="0.00"
          value={retainedText}
          aria-label="تُترك في الدرج كعهدة"
          onValueChange={setRetainedText}
        />
        <p className="text-xs text-muted-foreground">
          هذا المبلغ سيبقى فعليًا في الدرج وتفتح به الوردية المستلمة مباشرةً عند ضغط «فتح ورديتي واستلام العهدة».
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="disp-note" className="text-xs">ملاحظة على توزيع النقدية (اختياري)</Label>
        <Textarea id="disp-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {/* Live Reconciliation Bar */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-xs font-medium",
          validation.valid ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        )}
        data-testid="cash-disposition-status"
      >
        <span>
          المُسلّم للمالك/المدير: <strong className="tabular-nums">{formatMoney(validation.deliveredTotal, currency)}</strong> + المتروك في الدرج:{" "}
          <strong className="tabular-nums">{formatMoney(validation.retainedAmount, currency)}</strong> ={" "}
          <strong className="tabular-nums">{formatMoney(validation.deliveredTotal + validation.retainedAmount, currency)}</strong>
        </span>
        <span>{validation.valid ? "✓ التوزيع يطابق النقدية المعدودة بالظبط" : validation.error}</span>
      </div>

      {submitError && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          {submitError}
        </p>
      )}

      {showSaveButton && (
        <Button
          type="button"
          className="h-11 w-full"
          disabled={busy || !validation.valid}
          onClick={() => void submit().catch(() => {})}
          data-testid="cash-disposition-save"
        >
          {busy ? "جارٍ حفظ توزيع النقدية…" : "تأكيد وحفظ توزيع النقدية"}
        </Button>
      )}
    </section>
  );
}
