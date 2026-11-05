"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, money as formatMoney } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type AwaitingDelivery = {
  id: string;
  amount: number;
  destination: "OWNER" | "MANAGER";
  destinationLabel: string;
  status: "DECLARED" | "CONFIRMED" | "DISPUTED" | "RESOLVED";
  statusLabel: string;
  declaredAt: string;
  reference: string | null;
  recipientId: string;
  recipientName: string;
  declaredByName: string;
  shiftNumber: number;
  branchName: string;
  disputeNote: string | null;
  claimedReceivedAmount: number | null;
  mine: boolean;
};

export function CashDeliveriesPanel({
  onChanged,
  currency: propCurrency,
}: {
  onChanged?: () => void;
  currency?: string;
}) {
  const { user, cafe } = useApp();
  const currency = propCurrency ?? cafe?.currency ?? "EGP";
  const [deliveries, setDeliveries] = useState<AwaitingDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [disputeOpenId, setDisputeOpenId] = useState<string | null>(null);
  const [claimedAmount, setClaimedAmount] = useState("");
  const [disputeNote, setDisputeNote] = useState("");

  const [resolveOpenId, setResolveOpenId] = useState<string | null>(null);
  const [resolvedAmount, setResolvedAmount] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const confirmKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ deliveries: AwaitingDelivery[] }>("/api/cash-deliveries");
      setDeliveries(res.deliveries ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تحميل تسليمات النقدية المعلقة");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmReceipt(d: AwaitingDelivery) {
    if (busyId) return;
    if (!confirmKeys.current[d.id]) {
      confirmKeys.current[d.id] = `conf-${d.id}-${crypto.randomUUID()}`;
    }
    setBusyId(d.id);
    try {
      await api(`/api/cash-deliveries/${d.id}/confirm`, {
        method: "POST",
        body: { idempotencyKey: confirmKeys.current[d.id] },
      });
      toast.success("تم تأكيد استلام النقدية بنجاح");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تأكيد الاستلام");
    } finally {
      setBusyId(null);
    }
  }

  async function submitDispute(d: AwaitingDelivery) {
    if (busyId) return;
    setBusyId(d.id);
    try {
      const claimed = claimedAmount.trim() === "" ? undefined : Number(claimedAmount);
      await api(`/api/cash-deliveries/${d.id}/dispute`, {
        method: "POST",
        body: {
          note: disputeNote.trim(),
          ...(claimed !== undefined ? { claimedReceivedAmount: claimed } : {}),
        },
      });
      toast.success("تم تسجيل بلاغ الاختلاف على التسليم");
      setDisputeOpenId(null);
      setClaimedAmount("");
      setDisputeNote("");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسجيل الاختلاف");
    } finally {
      setBusyId(null);
    }
  }

  async function submitResolve(d: AwaitingDelivery) {
    if (busyId) return;
    setBusyId(d.id);
    try {
      await api(`/api/cash-deliveries/${d.id}/resolve`, {
        method: "POST",
        body: {
          resolvedAmount: Number(resolvedAmount),
          resolutionNote: resolutionNote.trim(),
        },
      });
      toast.success("تمت تسوية وحسم اختلاف التسليم");
      setResolveOpenId(null);
      setResolvedAmount("");
      setResolutionNote("");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسوية الاختلاف");
    } finally {
      setBusyId(null);
    }
  }

  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <details
      className="rounded-xl border p-4 text-sm"
      data-testid="cash-deliveries-panel"
      open={deliveries.length > 0 || !!error}
    >
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 font-semibold">
        <span>تأكيد استلام النقدية المُسلّمة للمالك / المدير ({deliveries.length})</span>
        {deliveries.some((d) => d.mine && d.status === "DECLARED") && (
          <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:text-amber-200">
            بانتظار تأكيدك
          </span>
        )}
      </summary>

      <div className="mt-3 space-y-3">
        {loading && <p className="text-xs text-muted-foreground">جارٍ فحص التسليمات المعلقة…</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {!loading && !error && deliveries.length === 0 && (
          <p className="text-xs text-muted-foreground">
            لا توجد تسليمات نقدية معلقة بانتظار تأكيدك أو مراجعتك حاليًا.
          </p>
        )}

        {deliveries.map((d) => (
          <div
            key={d.id}
            className="space-y-2 rounded-xl border bg-card p-3"
            data-testid={`cash-delivery-card-${d.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-bold">{d.destinationLabel}</span>
                <span className="ms-1 text-muted-foreground">({d.recipientName})</span>
                <span className="ms-2 text-base font-extrabold tabular-nums">{formatMoney(d.amount, currency)}</span>
              </div>
              <span
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  d.status === "DISPUTED"
                    ? "bg-rose-500/15 text-rose-800 dark:text-rose-200"
                    : "bg-amber-500/15 text-amber-900 dark:text-amber-200",
                )}
              >
                {d.statusLabel}
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              {d.branchName} · شيفت #{d.shiftNumber} · أعلن التسليم: {d.declaredByName} · {fmtDate(d.declaredAt)}
              {d.reference ? ` · مرجع: ${d.reference}` : ""}
            </p>

            {d.status === "DECLARED" && d.mine && (
              <div className="space-y-2 pt-1">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busyId === d.id}
                    onClick={() => void confirmReceipt(d)}
                    data-testid={`confirm-delivery-${d.id}`}
                  >
                    {busyId === d.id ? "جارٍ التأكيد…" : "تأكيد استلام النقدية"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === d.id}
                    onClick={() => {
                      if (disputeOpenId === d.id) {
                        setDisputeOpenId(null);
                      } else {
                        setDisputeOpenId(d.id);
                        setClaimedAmount("");
                        setDisputeNote("");
                      }
                    }}
                    data-testid={`dispute-delivery-toggle-${d.id}`}
                  >
                    الإبلاغ عن فرق في التسليم
                  </Button>
                </div>

                {disputeOpenId === d.id && (
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    <div className="space-y-1">
                      <Label htmlFor={`claim-${d.id}`} className="text-xs">المبلغ المستلم فعليًا (اختياري، من 0 إلى {d.amount})</Label>
                      <TouchNumberInput
                        id={`claim-${d.id}`}
                        type="number"
                        min="0"
                        step="0.01"
                        dir="ltr"
                        placeholder="0.00"
                        value={claimedAmount}
                        aria-label="المبلغ المستلم فعليًا"
                        onValueChange={setClaimedAmount}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`dispute-note-${d.id}`} className="text-xs">تفاصيل الاختلاف</Label>
                      <Textarea
                        id={`dispute-note-${d.id}`}
                        rows={2}
                        maxLength={1000}
                        placeholder="اشرح الفرق بين المبلغ المُعلن والمبلغ المستلم فعليًا"
                        value={disputeNote}
                        onChange={(e) => setDisputeNote(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyId === d.id || !disputeNote.trim()}
                        onClick={() => void submitDispute(d)}
                        data-testid={`dispute-delivery-submit-${d.id}`}
                      >
                        تسجيل اختلاف التسليم
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDisputeOpenId(null)}>
                        إلغاء
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {d.status === "DECLARED" && !d.mine && (
              <p className="text-xs text-muted-foreground">
                يؤكد الاستلام المستلم المسمّى ({d.recipientName}) من حسابه الخاص فقط.
              </p>
            )}

            {d.status === "DISPUTED" && (
              <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs">
                <p>
                  <strong>بلاغ المستلم ({d.recipientName}):</strong> {d.disputeNote ?? "—"}
                  {d.claimedReceivedAmount !== null ? ` · المبلغ المستلم فعليًا حسب البلاغ: ${formatMoney(d.claimedReceivedAmount, currency)}` : ""}
                </p>
                {user.role === "CAFE_OWNER" && (
                  <div className="space-y-2 pt-1">
                    {resolveOpenId !== d.id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setResolveOpenId(d.id);
                          setResolvedAmount(d.claimedReceivedAmount !== null ? String(d.claimedReceivedAmount) : String(d.amount));
                          setResolutionNote("");
                        }}
                        data-testid={`resolve-delivery-toggle-${d.id}`}
                      >
                        مراجعة وحسم الاختلاف (المالك)
                      </Button>
                    ) : (
                      <div className="space-y-2 rounded-lg border bg-background p-2.5">
                        <div className="space-y-1">
                          <Label htmlFor={`res-amt-${d.id}`} className="text-xs">المبلغ المعتمد بعد المراجعة</Label>
                          <TouchNumberInput
                            id={`res-amt-${d.id}`}
                            type="number"
                            min="0"
                            step="0.01"
                            dir="ltr"
                            value={resolvedAmount}
                            aria-label="المبلغ المعتمد بعد المراجعة"
                            onValueChange={setResolvedAmount}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`res-note-${d.id}`} className="text-xs">قرار المراجعة والتسوية</Label>
                          <Textarea
                            id={`res-note-${d.id}`}
                            rows={2}
                            maxLength={1000}
                            placeholder="اكتب قرار المالك بعد مراجعة التسليم"
                            value={resolutionNote}
                            onChange={(e) => setResolutionNote(e.target.value)}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={busyId === d.id || !resolutionNote.trim() || resolvedAmount.trim() === ""}
                            onClick={() => void submitResolve(d)}
                            data-testid={`resolve-delivery-submit-${d.id}`}
                          >
                            تسوية وحسم الاختلاف
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setResolveOpenId(null)}>
                            إلغاء
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
