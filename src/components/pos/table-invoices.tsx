"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { OrderSource, OrderStatus, PaymentStatus } from "@prisma/client";

type Invoice = {
  id: string; orderNumber: number; source: OrderSource; status: OrderStatus;
  paymentStatus: PaymentStatus; createdAt: string; createdBy: string | null;
  subtotal: number; discountAmount: number; serviceChargeAmount: number; taxAmount: number;
  total: number; paidAmount: number; remainingAmount: number; itemCount: number; editable: boolean;
  items: { id: string; productName: string; variantName: string | null; unitPrice: number; quantity: number; lineTotal: number; notes: string | null; addOns: { name: string; price: number }[] }[];
};
type SessionSummary = {
  id: string; tableNumber: string; displayStatus: string; startedAt: string;
  totalAmount: number; paidAmount: number; remainingAmount: number; invoiceCount: number;
};

const SOURCE_LABEL: Record<OrderSource, string> = { QR_MENU: "منيو QR", WAITER: "ويتر", CASHIER_POS: "كاشير" };
const PAY_LABEL: Record<PaymentStatus, string> = {
  UNPAID: "غير مدفوع", PENDING_COLLECTION: "في انتظار التحصيل", PARTIAL: "مدفوع جزئيًا", PAID: "مدفوع", REFUNDED: "مرتجع", CANCELLED: "ملغي",
};
const PAY_TONE: Record<PaymentStatus, string> = {
  UNPAID: "bg-red-500/12 text-red-700 dark:text-red-400",
  PENDING_COLLECTION: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  PARTIAL: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  PAID: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  REFUNDED: "bg-foreground/8 text-muted-foreground", CANCELLED: "bg-foreground/8 text-muted-foreground",
};
const METHOD_LABEL: Record<"CASH" | "CARD" | "WALLET", string> = { CASH: "كاش", CARD: "فيزا", WALLET: "محفظة" };

function fmtTime(v: string) {
  return new Date(v).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
}
function sinceLabel(startedAt: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000), 0);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `منذ ${m} دقيقة`;
  if (h === 1) return `منذ ساعة${m ? ` و ${m} د` : ""}`;
  return `منذ ${h} ساعات${m ? ` و ${m} د` : ""}`;
}

// POS "فواتير الترابيزة": collapsible invoice cards + session summary for the
// selected dine-in table's open session.
export function TableInvoices({
  branchId, tableNumber, reloadKey, onChanged,
}: {
  branchId: string; tableNumber: string; reloadKey: number; onChanged?: () => void;
}) {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);
  const canCollect = canKey("tables.collect_payment") || canKey("pos.collect_payment");
  const canClose = canKey("tables.close");
  const canManage = canKey("tables.manage");
  const canRedeem = canKey("loyalty.redeem_points");
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const initFor = useRef<string | null>(null);

  // Collect dialog: either a single invoice (orderId) or the whole table.
  const [collect, setCollect] = useState<null | { kind: "invoice"; orderId: string; remaining: number; label: string } | { kind: "table-full"; remaining: number } | { kind: "table-partial"; remaining: number }>(null);
  // Post-payment receipt actions (طباعة الريسيت / تحصيل دفعة أخرى).
  const [receipt, setReceipt] = useState<null | { paymentId: string | null; scope: "order" | "table" }>(null);
  // Loyalty redemption inside table settlement (بيانات العميل والنقاط).
  const [tiPhone, setTiPhone] = useState("");
  const [tiCustomer, setTiCustomer] = useState<null | { id: string; name: string | null; phone: string; loyaltyPointsBalance: number }>(null);
  const [tiLoyalty, setTiLoyalty] = useState<null | { enabled: boolean; pointValueAmount: number; minPointsToRedeem: number; maxRedeemPercentageOfOrder: number }>(null);
  const [tiPoints, setTiPoints] = useState("");
  const tiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced customer lookup for the settlement dialog.
  useEffect(() => {
    setTiCustomer(null);
    const digits = tiPhone.replace(/\D/g, "");
    if (digits.length < 10) return;
    if (tiTimer.current) clearTimeout(tiTimer.current);
    tiTimer.current = setTimeout(async () => {
      try {
        const r = await api<{ customer: typeof tiCustomer; loyalty: NonNullable<typeof tiLoyalty> }>(
          `/api/customers/lookup?phone=${encodeURIComponent(tiPhone)}`
        );
        setTiCustomer(r.customer);
        setTiLoyalty(r.loyalty);
      } catch { /* quiet */ }
    }, 400);
    return () => { if (tiTimer.current) clearTimeout(tiTimer.current); };
  }, [tiPhone]);

  const tiPointsNum = Math.floor(Number(tiPoints) || 0);
  const tiDiscount = tiLoyalty ? Math.round(tiPointsNum * tiLoyalty.pointValueAmount * 100) / 100 : 0;
  const [amount, setAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");

  const load = useCallback(async () => {
    if (!branchId || !tableNumber) { setSummary(null); setInvoices(null); return; }
    try {
      const data = await api<{ session: SessionSummary | null; invoices?: Invoice[] }>(
        `/api/tables/session?branchId=${branchId}&tableNumber=${encodeURIComponent(tableNumber)}`
      );
      setSummary(data.session);
      const inv = data.invoices ?? [];
      setInvoices(inv);
      // Expand the latest invoice when a new one appears; keep toggles otherwise.
      const latest = inv.length ? inv[inv.length - 1].id : null;
      if (latest && initFor.current !== latest) {
        setExpanded(new Set([latest]));
        initFor.current = latest;
      } else if (!latest) {
        initFor.current = null;
      }
    } catch {
      // e.g. no permission — hide silently
      setSummary(null); setInvoices([]);
    }
  }, [branchId, tableNumber]);

  useEffect(() => { load(); }, [load, reloadKey]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function refresh() { await load(); onChanged?.(); }

  async function submitCollect() {
    if (!collect) return;
    const amt = Number(amount) || 0;
    setBusy(true);
    try {
      let paymentId = "";
      let scope: "order" | "table" = "order";
      if (collect.kind === "invoice") {
        if (amt <= 0 || amt > collect.remaining + 0.001) { setBusy(false); return toast.error("مبلغ غير صحيح"); }
        const r = await api<{ payments: { id: string }[] }>("/api/payments", {
          method: "POST", body: { orderId: collect.orderId, amount: amt, method: payMethod },
        });
        paymentId = r.payments[0]?.id ?? "";
      } else if (summary) {
        const mode = collect.kind === "table-full" ? "FULL" : "PARTIAL";
        const body: Record<string, unknown> = { mode, method: payMethod };
        if (mode === "PARTIAL") body.amount = amt;
        if (mode === "PARTIAL" && (amt <= 0 || amt > collect.remaining + 0.001)) { setBusy(false); return toast.error("مبلغ غير صحيح"); }
        // Loyalty redemption against the table account (server re-validates).
        if (tiPointsNum > 0 && tiCustomer) {
          body.loyaltyPointsToRedeem = tiPointsNum;
          body.customerPhone = tiCustomer.phone;
        }
        const r = await api<{ paymentIds: string[] }>(`/api/tables/${summary.id}/pay`, { method: "POST", body });
        paymentId = r.paymentIds?.[0] ?? "";
        scope = "table";
      }
      toast.success("تم تحصيل الدفع بنجاح");
      setCollect(null); setAmount(""); setTiPhone(""); setTiPoints(""); setTiCustomer(null);
      setReceipt({ paymentId: paymentId || null, scope });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحصيل");
    } finally {
      setBusy(false);
    }
  }

  async function closeTable() {
    if (!summary) return;
    if (summary.remainingAmount > 0.001 && !canManage) return toast.error("لا يمكن قفل الترابيزة قبل تحصيل باقي الحساب");
    setBusy(true);
    try {
      await api(`/api/tables/${summary.id}/close`, { method: "POST" });
      toast.success("تم قفل الترابيزة بنجاح");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل القفل");
    } finally {
      setBusy(false);
    }
  }

  if (invoices === null) return null; // not loaded / no table

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">فواتير الترابيزة</p>

      {invoices.length === 0 ? (
        <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">لا توجد فواتير على هذه الترابيزة حتى الآن</p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto pe-0.5">
          {invoices.map((inv) => {
            const open = expanded.has(inv.id);
            return (
              <div key={inv.id} className="rounded-xl border bg-card">
                {/* Header */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 p-2.5">
                  <span className="text-sm font-bold tabular-nums">فاتورة #{inv.orderNumber}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground/70">{SOURCE_LABEL[inv.source]}</span>
                  <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", PAY_TONE[inv.paymentStatus])}>{PAY_LABEL[inv.paymentStatus]}</span>
                  <span className="text-[11px] text-muted-foreground">{fmtTime(inv.createdAt)}</span>
                  <span className="ms-auto text-sm font-bold tabular-nums">{fmt(inv.total)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 pb-2 text-[11px] text-muted-foreground">
                  <span>{inv.itemCount} صنف</span>
                  {inv.remainingAmount > 0.001 && <span className="text-amber-600 dark:text-amber-400">المتبقي {fmt(inv.remainingAmount)}</span>}
                  <button className="ms-auto font-medium text-foreground/70 underline" onClick={() => toggle(inv.id)}>
                    {open ? "إخفاء التفاصيل" : "عرض التفاصيل"}
                  </button>
                </div>

                {/* Expanded */}
                {open && (
                  <div className="space-y-2 border-t px-2.5 py-2">
                    <div className="space-y-1">
                      {inv.items.map((it) => (
                        <div key={it.id} className="flex items-start justify-between gap-2 text-xs">
                          <span className="min-w-0">
                            <span className="tabular-nums">{it.quantity}×</span> {it.productName}
                            {it.variantName && <span className="text-muted-foreground"> ({it.variantName})</span>}
                            {it.addOns.length > 0 && <span className="text-muted-foreground"> + {it.addOns.map((a) => a.name).join("، ")}</span>}
                            {it.notes && <span className="block text-[10px] text-amber-700 dark:text-amber-400">📝 {it.notes}</span>}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(it.lineTotal)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-0.5 border-t pt-1.5 text-xs">
                      <Row label="الإجمالي قبل الخصم" value={fmt(inv.subtotal)} />
                      {inv.discountAmount > 0 && <Row label="الخصم" value={`- ${fmt(inv.discountAmount)}`} />}
                      {inv.serviceChargeAmount > 0 && <Row label="السيرفيس" value={fmt(inv.serviceChargeAmount)} />}
                      {inv.taxAmount > 0 && <Row label="الضريبة" value={fmt(inv.taxAmount)} />}
                      <Row label="الإجمالي النهائي" value={fmt(inv.total)} bold />
                      <Row label="المدفوع" value={fmt(inv.paidAmount)} />
                      {inv.remainingAmount > 0.001 && <Row label="المتبقي" value={fmt(inv.remainingAmount)} bold />}
                    </div>
                    {canCollect && inv.remainingAmount > 0.001 && (
                      <Button size="sm" className="w-full" onClick={() => { setPayMethod("CASH"); setAmount(String(inv.remainingAmount)); setCollect({ kind: "invoice", orderId: inv.id, remaining: inv.remainingAmount, label: `#${inv.orderNumber}` }); }}>
                        تحصيل الفاتورة
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Session summary */}
      {summary && (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-2.5">
          <p className="text-xs font-semibold">ملخص حساب الترابيزة</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            <span className="text-muted-foreground">عدد الفواتير: <span className="tabular-nums text-foreground">{summary.invoiceCount}</span></span>
            <span className="text-muted-foreground">مدة الجلوس: <span className="text-foreground">{sinceLabel(summary.startedAt)}</span></span>
            <span className="text-muted-foreground">الإجمالي: <span className="tabular-nums text-foreground">{fmt(summary.totalAmount)}</span></span>
            <span className="text-muted-foreground">المدفوع: <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(summary.paidAmount)}</span></span>
            <span className="text-muted-foreground">المتبقي: <span className="tabular-nums font-semibold text-amber-600 dark:text-amber-400">{fmt(summary.remainingAmount)}</span></span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {canCollect && summary.remainingAmount > 0.001 && (
              <>
                <Button size="sm" className="h-7 px-2 text-xs" onClick={() => { setPayMethod("CASH"); setAmount(String(summary.remainingAmount)); setCollect({ kind: "table-full", remaining: summary.remainingAmount }); }}>تحصيل كامل الحساب</Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setPayMethod("CASH"); setAmount(""); setCollect({ kind: "table-partial", remaining: summary.remainingAmount }); }}>تحصيل جزئي</Button>
              </>
            )}
            {canClose && (
              <Button size="sm" variant={summary.remainingAmount <= 0.001 ? "default" : "outline"} className="h-7 px-2 text-xs" disabled={busy} onClick={closeTable}>🔒 قفل الترابيزة</Button>
            )}
          </div>
          {summary.remainingAmount > 0.001 && (
            <p className="text-[10px] text-muted-foreground">لا يمكن قفل الترابيزة قبل تحصيل باقي الحساب</p>
          )}
        </div>
      )}

      {/* Post-payment receipt actions */}
      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>تم تحصيل الدفع بنجاح ✅</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {receipt?.paymentId ? (
              <>
                <Button
                  className="h-11 w-full"
                  onClick={() => {
                    const scopeQs = receipt.scope === "table" ? "&scope=table" : "";
                    window.open(`/receipts/payment/${receipt.paymentId}?print=1${scopeQs}`, "_blank");
                  }}
                >
                  🖨️ طباعة الريسيت
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-full"
                  onClick={() => {
                    const scopeQs = receipt.scope === "table" ? "?scope=table" : "";
                    window.open(`/receipts/payment/${receipt.paymentId}${scopeQs}`, "_blank");
                  }}
                >
                  عرض الريسيت
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                تم سداد الحساب بخصم النقاط بالكامل — لا توجد دفعة نقدية لطباعتها.
              </p>
            )}
            {summary && summary.remainingAmount > 0.001 && (
              <Button
                variant="outline"
                className="h-10 w-full text-sm"
                onClick={() => setReceipt(null)}
              >
                تحصيل دفعة أخرى
              </Button>
            )}
            <Button variant="ghost" className="h-10 w-full text-muted-foreground" onClick={() => setReceipt(null)}>
              إغلاق
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Collect dialog */}
      <Dialog open={collect !== null} onOpenChange={(o) => !o && !busy && setCollect(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>
              {collect?.kind === "invoice" ? `تحصيل الفاتورة ${collect.label}` : collect?.kind === "table-full" ? "تحصيل كامل الحساب" : "تحصيل جزئي"}
            </DialogTitle>
          </DialogHeader>
          {collect && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/40 p-2 text-sm">
                المتبقي: <span className="font-bold tabular-nums">{fmt(collect.remaining)}</span>
                {collect.kind !== "invoice" && tiDiscount > 0 && (
                  <span className="block text-xs text-amber-700 dark:text-amber-400">
                    خصم نقاط الولاء: −{fmt(tiDiscount)} · المطلوب تحصيله: <b className="tabular-nums">{fmt(Math.max(collect.remaining - tiDiscount, 0))}</b>
                  </span>
                )}
              </div>

              {/* بيانات العميل والنقاط — table settlement only (invoice
                  collections use the order's linked customer via POS panel). */}
              {collect.kind !== "invoice" && canRedeem && (
                <div className="space-y-1.5 rounded-lg border p-2">
                  <p className="text-xs font-semibold">بيانات العميل والنقاط</p>
                  <Input
                    dir="ltr" inputMode="tel" className="h-9"
                    placeholder="رقم موبايل العميل — 01xx xxx xxxx"
                    value={tiPhone}
                    onChange={(e) => { setTiPhone(e.target.value); setTiPoints(""); }}
                  />
                  {tiCustomer && (
                    <>
                      <p className="rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-800 dark:text-blue-300">
                        عميل موجود{tiCustomer.name ? `: ${tiCustomer.name}` : ""} · رصيد النقاط:{" "}
                        <b className="tabular-nums">{tiCustomer.loyaltyPointsBalance}</b> نقطة
                      </p>
                      {tiLoyalty?.enabled && tiCustomer.loyaltyPointsBalance >= (tiLoyalty?.minPointsToRedeem ?? 0) ? (
                        <>
                          <Input
                            type="number" dir="ltr" className="h-9"
                            placeholder={`عدد النقاط المستخدمة (أقل عدد ${tiLoyalty.minPointsToRedeem})`}
                            value={tiPoints}
                            onChange={(e) => setTiPoints(e.target.value)}
                          />
                          {tiPointsNum > 0 && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-400">
                              سيتم استخدام نقاط هذا العميل كخصم على حساب الترابيزة
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">لا يوجد رصيد نقاط كافي للاستخدام</p>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>مبلغ التحصيل</Label>
                <Input type="number" min="0" step="0.01" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)}
                  disabled={collect.kind === "table-full"} />
              </div>
              <div className="space-y-1.5">
                <Label>طريقة الدفع</Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["CASH", "CARD", "WALLET"] as const).map((m) => (
                    <button key={m} onClick={() => setPayMethod(m)}
                      className={cn("rounded-lg border px-2 py-1.5 text-xs font-medium", payMethod === m ? "border-foreground bg-foreground text-background" : "border-border")}>
                      {METHOD_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCollect(null)} disabled={busy}>إلغاء</Button>
            <Button onClick={submitCollect} disabled={busy}>تأكيد التحصيل</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cn("flex justify-between", bold && "font-semibold")}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
