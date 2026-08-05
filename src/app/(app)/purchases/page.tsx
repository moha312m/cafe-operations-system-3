"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import {
  INVOICE_STATUS_LABEL, PAYMENT_STATUS_LABEL, PURCHASE_METHOD_LABEL,
} from "@/lib/purchases";
import { UNIT_LABEL } from "@/lib/inventory";
import type {
  PurchaseInvoiceStatus, PurchasePaymentStatus, PurchasePaymentMethod, InventoryUnit,
} from "@prisma/client";
import { PageHeader, StatCard, Panel, EmptyState, LoadingState } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type Summary = { todayTotal: number; monthTotal: number; unpaidCount: number; partialCount: number; activeSuppliers: number };
type InvoiceRow = {
  id: string; invoiceNumber: string; supplier: string | null; branch: string;
  invoiceDate: string; itemCount: number; totalAmount: number; paidAmount: number;
  remainingAmount: number; paymentStatus: PurchasePaymentStatus; status: PurchaseInvoiceStatus;
};
type Supplier = { id: string; name: string };
type Branch = { id: string; name: string };
type InvItem = { id: string; name: string; unit: InventoryUnit; costPerUnit: string | number };

type Detail = {
  id: string; invoiceNumber: string; supplier: { id: string; name: string; phone: string | null } | null;
  branch: string; invoiceDate: string; status: PurchaseInvoiceStatus; confirmedAt: string | null;
  paymentStatus: PurchasePaymentStatus; subtotalAmount: number; discountAmount: number;
  taxAmount: number; totalAmount: number; paidAmount: number; remainingAmount: number;
  notes: string | null; createdBy: string | null;
  items: { id: string; name: string; quantity: number; unit: InventoryUnit; unitCost: number; totalCost: number; expiryDate: string | null }[];
  payments: { id: string; amount: number; method: PurchasePaymentMethod; note: string | null; paidAt: string; createdBy: string | null }[];
};

const STATUS_TONE: Record<PurchaseInvoiceStatus, string> = {
  DRAFT: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  CONFIRMED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  CANCELLED: "bg-foreground/8 text-muted-foreground",
};
const PAY_TONE: Record<PurchasePaymentStatus, string> = {
  UNPAID: "bg-red-500/12 text-red-700 dark:text-red-400",
  PARTIAL: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  PAID: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

type NewItem = { inventoryItemId: string; quantity: string; unitCost: string; expiryDate: string };

export default function PurchasesPage() {
  const { cafe, user, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [invItems, setInvItems] = useState<InvItem[]>([]);
  const [busy, setBusy] = useState(false);

  // filters
  const [fDate, setFDate] = useState("");
  const [fSupplier, setFSupplier] = useState("ALL");
  const [fBranch, setFBranch] = useState("ALL");
  const [fPay, setFPay] = useState("ALL");
  const [fStatus, setFStatus] = useState("ALL");

  // create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cBranch, setCBranch] = useState(user.branchId ?? "");
  const [cSupplier, setCSupplier] = useState("");
  const [cDate, setCDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [cNumber, setCNumber] = useState("");
  const [cNotes, setCNotes] = useState("");
  const [cDiscount, setCDiscount] = useState("");
  const [cTax, setCTax] = useState("");
  const [cItems, setCItems] = useState<NewItem[]>([{ inventoryItemId: "", quantity: "", unitCost: "", expiryDate: "" }]);
  const [cPayMode, setCPayMode] = useState<"UNPAID" | "PARTIAL" | "PAID">("UNPAID");
  const [cPayMethod, setCPayMethod] = useState<PurchasePaymentMethod>("CASH");
  const [cPayAmount, setCPayAmount] = useState("");

  // detail + payment
  const [detail, setDetail] = useState<Detail | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PurchasePaymentMethod>("CASH");
  const [payNote, setPayNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const canView = canKey("purchases.view");
  const canCreate = canKey("purchases.create");
  const canConfirm = canKey("purchases.confirm");
  const canPay = canKey("purchases.record_payment");
  const canCancel = canKey("purchases.cancel");
  const canEdit = canKey("purchases.edit");

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (fDate) qs.set("date", fDate);
      if (fSupplier !== "ALL") qs.set("supplierId", fSupplier);
      if (fBranch !== "ALL") qs.set("branchId", fBranch);
      if (fPay !== "ALL") qs.set("paymentStatus", fPay);
      if (fStatus !== "ALL") qs.set("status", fStatus);
      const data = await api<{ summary: Summary; invoices: InvoiceRow[] }>(`/api/purchases?${qs}`);
      setSummary(data.summary);
      setInvoices(data.invoices);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل المشتريات");
    }
  }, [fDate, fSupplier, fBranch, fPay, fStatus]);

  useEffect(() => { if (canView) load(); }, [canView, load]);

  useEffect(() => {
    if (!canView) return;
    api<{ suppliers: Supplier[] }>("/api/suppliers?active=1").then((r) => setSuppliers(r.suppliers)).catch(() => {});
    if (!user.branchId) api<{ branches: Branch[] }>("/api/branches").then((r) => setBranches(r.branches)).catch(() => {});
  }, [canView, user.branchId]);

  // Load branch inventory for the item picker whenever the create branch changes.
  useEffect(() => {
    if (!createOpen || !cBranch) return;
    api<{ items: InvItem[] }>(`/api/inventory?branchId=${cBranch}`).then((r) => setInvItems(r.items)).catch(() => setInvItems([]));
  }, [createOpen, cBranch]);

  function openCreate() {
    setCBranch(user.branchId ?? (branches[0]?.id ?? ""));
    setCSupplier(""); setCNumber(""); setCNotes(""); setCDiscount(""); setCTax("");
    setCItems([{ inventoryItemId: "", quantity: "", unitCost: "", expiryDate: "" }]);
    setCPayMode("UNPAID"); setCPayMethod("CASH"); setCPayAmount("");
    setCreateOpen(true);
  }

  const validItems = cItems.filter((i) => i.inventoryItemId && Number(i.quantity) > 0 && Number(i.unitCost) >= 0);
  const cSubtotal = validItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unitCost), 0);
  const cTotal = Math.max(cSubtotal - (Number(cDiscount) || 0) + (Number(cTax) || 0), 0);

  async function createInvoice() {
    if (!cBranch) return toast.error("اختار الفرع");
    if (validItems.length === 0) return toast.error("أضف صنف واحد على الأقل");
    setBusy(true);
    try {
      const payment =
        cPayMode === "UNPAID"
          ? undefined
          : {
              method: cPayMethod,
              amount: cPayMode === "PAID" ? cTotal : Number(cPayAmount) || 0,
            };
      if (payment && payment.amount <= 0) { setBusy(false); return toast.error("مبلغ الدفعة غير صحيح"); }
      await api("/api/purchases", {
        method: "POST",
        body: {
          branchId: cBranch,
          supplierId: cSupplier || null,
          invoiceNumber: cNumber.trim() || undefined,
          invoiceDate: cDate,
          discountAmount: Number(cDiscount) || 0,
          taxAmount: Number(cTax) || 0,
          notes: cNotes.trim() || undefined,
          items: validItems.map((i) => ({
            inventoryItemId: i.inventoryItemId,
            quantity: Number(i.quantity),
            unitCost: Number(i.unitCost),
            expiryDate: i.expiryDate || undefined,
          })),
          payment,
        },
      });
      toast.success("تم إنشاء فاتورة الشراء");
      setCreateOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الإنشاء");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(id: string) {
    try {
      const { invoice } = await api<{ invoice: Detail }>(`/api/purchases/${id}`);
      setDetail(invoice);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل التفاصيل");
    }
  }
  async function refreshDetail(id: string) {
    await load();
    try { const { invoice } = await api<{ invoice: Detail }>(`/api/purchases/${id}`); setDetail(invoice); }
    catch { setDetail(null); }
  }

  async function confirmInvoice() {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/purchases/${detail.id}/confirm`, { method: "POST" });
      toast.success("تم تأكيد فاتورة الشراء وإضافة الكميات للمخزون");
      setConfirmOpen(false);
      await refreshDetail(detail.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التأكيد");
    } finally {
      setBusy(false);
    }
  }

  async function recordPayment() {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/purchases/${detail.id}/payments`, {
        method: "POST",
        body: { amount: Number(payAmount) || 0, method: payMethod, note: payNote.trim() || undefined },
      });
      toast.success("تم تسجيل الدفعة");
      setPayOpen(false); setPayAmount(""); setPayNote("");
      await refreshDetail(detail.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تسجيل الدفعة");
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvoice() {
    if (!detail) return;
    if (!confirm(`إلغاء فاتورة الشراء ${detail.invoiceNumber}؟`)) return;
    setBusy(true);
    try {
      await api(`/api/purchases/${detail.id}/cancel`, { method: "POST" });
      toast.success("تم إلغاء الفاتورة");
      setDetail(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الإلغاء");
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader title="المشتريات" />
        <p className="text-destructive">ليس لديك صلاحية للوصول لهذه الصفحة</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="فواتير المشتريات" subtitle="مشتريات الخامات وتحصيل الموردين">
        {canCreate && <Button onClick={openCreate}>+ إضافة فاتورة شراء</Button>}
      </PageHeader>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="مشتريات اليوم" value={fmt(summary.todayTotal)} icon="🛒" accent="emerald" />
          <StatCard label="مشتريات الشهر" value={fmt(summary.monthTotal)} icon="📅" accent="blue" />
          <StatCard label="فواتير غير مدفوعة" value={summary.unpaidCount} icon="⏳" accent={summary.unpaidCount > 0 ? "red" : "slate"} />
          <StatCard label="مدفوعة جزئيًا" value={summary.partialCount} icon="💸" accent={summary.partialCount > 0 ? "violet" : "slate"} />
          <StatCard label="موردين نشطين" value={summary.activeSuppliers} icon="🚚" accent="slate" href="/suppliers" />
        </div>
      )}

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input type="date" className="w-40" value={fDate} onChange={(e) => setFDate(e.target.value)} />
        <select value={fSupplier} onChange={(e) => setFSupplier(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-sm">
          <option value="ALL">كل الموردين</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {!user.branchId && (
          <select value={fBranch} onChange={(e) => setFBranch(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-sm">
            <option value="ALL">كل الفروع</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <select value={fPay} onChange={(e) => setFPay(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-sm">
          <option value="ALL">كل حالات الدفع</option>
          {(["UNPAID", "PARTIAL", "PAID"] as const).map((s) => <option key={s} value={s}>{PAYMENT_STATUS_LABEL[s]}</option>)}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-sm">
          <option value="ALL">كل حالات الفاتورة</option>
          {(["DRAFT", "CONFIRMED", "CANCELLED"] as const).map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABEL[s]}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="mt-4">
        {invoices === null ? (
          <LoadingState />
        ) : invoices.length === 0 ? (
          <EmptyState message="لا توجد فواتير مشتريات حتى الآن" icon="🛒" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <Table>
              <TableHeader><TableRow>
                <TableHead>رقم الفاتورة</TableHead>
                <TableHead>المورد</TableHead>
                <TableHead>الفرع</TableHead>
                <TableHead>التاريخ</TableHead>
                <TableHead className="text-center">الأصناف</TableHead>
                <TableHead className="text-end">الإجمالي</TableHead>
                <TableHead className="text-end">المدفوع</TableHead>
                <TableHead className="text-end">المتبقي</TableHead>
                <TableHead>حالة الدفع</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium tabular-nums">{inv.invoiceNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{inv.supplier ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{inv.branch}</TableCell>
                    <TableCell className="text-xs">{formatTime(inv.invoiceDate)}</TableCell>
                    <TableCell className="text-center tabular-nums">{inv.itemCount}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmt(inv.totalAmount)}</TableCell>
                    <TableCell className="text-end tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(inv.paidAmount)}</TableCell>
                    <TableCell className="text-end tabular-nums text-amber-600 dark:text-amber-400">{fmt(inv.remainingAmount)}</TableCell>
                    <TableCell><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PAY_TONE[inv.paymentStatus]}`}>{PAYMENT_STATUS_LABEL[inv.paymentStatus]}</span></TableCell>
                    <TableCell><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[inv.status]}`}>{INVOICE_STATUS_LABEL[inv.status]}</span></TableCell>
                    <TableCell><Button size="sm" variant="ghost" onClick={() => openDetail(inv.id)}>تفاصيل</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ── Create invoice dialog ── */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && !busy && setCreateOpen(false)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>فاتورة شراء جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>المورد</Label>
                <select value={cSupplier} onChange={(e) => setCSupplier(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">— بدون مورد —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {!user.branchId && (
                <div className="space-y-1.5">
                  <Label>الفرع</Label>
                  <select value={cBranch} onChange={(e) => setCBranch(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                    <option value="">اختار الفرع</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>تاريخ الفاتورة</Label>
                <Input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>رقم الفاتورة (اختياري)</Label>
                <Input dir="ltr" placeholder="يُنشأ تلقائيًا" value={cNumber} onChange={(e) => setCNumber(e.target.value)} />
              </div>
            </div>

            {/* Items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>الأصناف</Label>
                <Button size="sm" variant="outline" onClick={() => setCItems([...cItems, { inventoryItemId: "", quantity: "", unitCost: "", expiryDate: "" }])}>+ صنف</Button>
              </div>
              {!cBranch && <p className="text-xs text-muted-foreground">اختار الفرع لعرض خامات المخزون.</p>}
              {cItems.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center gap-1.5">
                  <select
                    value={it.inventoryItemId}
                    onChange={(e) => {
                      const inv = invItems.find((x) => x.id === e.target.value);
                      const next = [...cItems];
                      next[idx] = { ...it, inventoryItemId: e.target.value, unitCost: it.unitCost || (inv ? String(Number(inv.costPerUnit)) : "") };
                      setCItems(next);
                    }}
                    className="col-span-5 h-9 rounded-lg border border-input bg-background px-2 text-sm">
                    <option value="">اختار الخامة</option>
                    {invItems.map((x) => <option key={x.id} value={x.id}>{x.name} ({UNIT_LABEL[x.unit]})</option>)}
                  </select>
                  <Input className="col-span-2" type="number" min="0" step="0.001" dir="ltr" placeholder="الكمية"
                    value={it.quantity} onChange={(e) => { const n = [...cItems]; n[idx] = { ...it, quantity: e.target.value }; setCItems(n); }} />
                  <Input className="col-span-2" type="number" min="0" step="0.01" dir="ltr" placeholder="التكلفة"
                    value={it.unitCost} onChange={(e) => { const n = [...cItems]; n[idx] = { ...it, unitCost: e.target.value }; setCItems(n); }} />
                  <span className="col-span-2 text-end text-xs tabular-nums text-muted-foreground">
                    {fmt(Number(it.quantity) * Number(it.unitCost) || 0)}
                  </span>
                  <button className="col-span-1 text-muted-foreground hover:text-destructive"
                    onClick={() => setCItems(cItems.length > 1 ? cItems.filter((_, i) => i !== idx) : cItems)}>✕</button>
                </div>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>الخصم</Label>
                <Input type="number" min="0" step="0.01" dir="ltr" value={cDiscount} onChange={(e) => setCDiscount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>الضريبة</Label>
                <Input type="number" min="0" step="0.01" dir="ltr" value={cTax} onChange={(e) => setCTax(e.target.value)} />
              </div>
            </div>

            <div className="rounded-lg bg-muted/40 p-2.5 text-sm">
              الإجمالي: <span className="font-bold tabular-nums">{fmt(cTotal)}</span>
            </div>

            {/* Payment */}
            <div className="space-y-1.5">
              <Label>الدفع</Label>
              <div className="flex gap-2">
                {([["UNPAID", "غير مدفوعة"], ["PARTIAL", "مدفوعة جزئيًا"], ["PAID", "مدفوعة بالكامل"]] as const).map(([m, lbl]) => (
                  <button key={m} onClick={() => setCPayMode(m)}
                    className={`flex-1 rounded-lg border px-2 py-2 text-xs font-medium ${cPayMode === m ? "border-foreground bg-foreground text-background" : "border-border"}`}>{lbl}</button>
                ))}
              </div>
              {cPayMode !== "UNPAID" && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {cPayMode === "PARTIAL" && (
                    <Input type="number" min="0" step="0.01" dir="ltr" placeholder="مبلغ الدفعة" value={cPayAmount} onChange={(e) => setCPayAmount(e.target.value)} />
                  )}
                  <select value={cPayMethod} onChange={(e) => setCPayMethod(e.target.value as PurchasePaymentMethod)}
                    className={`h-9 rounded-lg border border-input bg-background px-3 text-sm ${cPayMode === "PAID" ? "col-span-2" : ""}`}>
                    {(["CASH", "CARD", "WALLET", "BANK_TRANSFER"] as const).map((m) => <option key={m} value={m}>{PURCHASE_METHOD_LABEL[m]}</option>)}
                  </select>
                </div>
              )}
            </div>

            <Textarea rows={2} placeholder="ملاحظات" value={cNotes} onChange={(e) => setCNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={createInvoice} disabled={busy || validItems.length === 0}>حفظ كمسودة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Detail dialog ── */}
      <Dialog open={detail !== null && !payOpen && !confirmOpen} onOpenChange={(o) => !o && !busy && setDetail(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  فاتورة شراء {detail.invoiceNumber}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[detail.status]}`}>{INVOICE_STATUS_LABEL[detail.status]}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PAY_TONE[detail.paymentStatus]}`}>{PAYMENT_STATUS_LABEL[detail.paymentStatus]}</span>
                </DialogTitle>
              </DialogHeader>

              <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl border bg-muted/30 p-3 text-sm">
                <span>المورد: {detail.supplier?.name ?? "—"}</span>
                <span>الفرع: {detail.branch}</span>
                <span>التاريخ: {formatTime(detail.invoiceDate)}</span>
                {detail.createdBy && <span>أنشأها: {detail.createdBy}</span>}
              </div>

              {/* Items */}
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>الخامة</TableHead>
                    <TableHead className="text-end">الكمية</TableHead>
                    <TableHead className="text-end">تكلفة الوحدة</TableHead>
                    <TableHead className="text-end">الإجمالي</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {detail.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell>{it.name}</TableCell>
                        <TableCell className="text-end tabular-nums">{it.quantity} {UNIT_LABEL[it.unit]}</TableCell>
                        <TableCell className="text-end tabular-nums">{fmt(it.unitCost)}</TableCell>
                        <TableCell className="text-end tabular-nums">{fmt(it.totalCost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Totals */}
              <div className="ms-auto w-full max-w-xs space-y-1 text-sm">
                <Row label="الإجمالي الفرعي" value={fmt(detail.subtotalAmount)} />
                {detail.discountAmount > 0 && <Row label="الخصم" value={`- ${fmt(detail.discountAmount)}`} />}
                {detail.taxAmount > 0 && <Row label="الضريبة" value={fmt(detail.taxAmount)} />}
                <Row label="الإجمالي" value={fmt(detail.totalAmount)} bold />
                <Row label="المدفوع" value={fmt(detail.paidAmount)} />
                <Row label="المتبقي" value={fmt(detail.remainingAmount)} bold />
              </div>

              {/* Payments */}
              {detail.payments.length > 0 && (
                <div className="space-y-1 rounded-xl border p-3 text-sm">
                  <p className="font-semibold">المدفوعات</p>
                  {detail.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between">
                      <span>{PURCHASE_METHOD_LABEL[p.method]}{p.createdBy ? ` · ${p.createdBy}` : ""}{p.note ? ` — ${p.note}` : ""}</span>
                      <span className="tabular-nums">{fmt(p.amount)} <span className="text-xs text-muted-foreground">{formatTime(p.paidAt)}</span></span>
                    </div>
                  ))}
                </div>
              )}

              {detail.status === "CONFIRMED" && (
                <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  ✓ تم تأكيد الفاتورة وإضافة الكميات للمخزون{detail.confirmedAt ? ` — ${formatTime(detail.confirmedAt)}` : ""}
                </p>
              )}

              {/* Actions */}
              <DialogFooter className="flex-wrap gap-2">
                {detail.status === "DRAFT" && canConfirm && (
                  <Button onClick={() => setConfirmOpen(true)} disabled={busy}>تأكيد الفاتورة</Button>
                )}
                {detail.status !== "CANCELLED" && detail.remainingAmount > 0 && canPay && (
                  <Button variant="outline" onClick={() => { setPayMethod("CASH"); setPayAmount(String(detail.remainingAmount)); setPayOpen(true); }} disabled={busy}>تسجيل دفعة</Button>
                )}
                {detail.status !== "CANCELLED" && canCancel && (
                  <Button variant="ghost" className="text-destructive" onClick={cancelInvoice} disabled={busy}>إلغاء الفاتورة</Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirm warning ── */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !o && !busy && setConfirmOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>تأكيد فاتورة الشراء</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            سيتم إضافة كميات كل الأصناف إلى المخزون وتحديث تكلفة الشراء. لا يمكن التراجع عن هذا الإجراء.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={confirmInvoice} disabled={busy}>تأكيد وإضافة للمخزون</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Record payment ── */}
      <Dialog open={payOpen} onOpenChange={(o) => !o && !busy && setPayOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>تسجيل دفعة للمورد</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/40 p-2.5 text-sm">المتبقي: <span className="font-bold tabular-nums">{fmt(detail.remainingAmount)}</span></div>
              <div className="space-y-1.5">
                <Label>مبلغ الدفعة</Label>
                <Input type="number" min="0" step="0.01" dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>طريقة الدفع</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(["CASH", "CARD", "WALLET", "BANK_TRANSFER"] as const).map((m) => (
                    <button key={m} onClick={() => setPayMethod(m)}
                      className={`rounded-lg border px-2 py-2 text-sm font-medium ${payMethod === m ? "border-foreground bg-foreground text-background" : "border-border"}`}>
                      {PURCHASE_METHOD_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>
              <Input placeholder="ملاحظة (اختياري)" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={recordPayment} disabled={busy || Number(payAmount) <= 0 || (detail ? Number(payAmount) > detail.remainingAmount + 0.001 : true)}>تسجيل الدفعة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "border-t pt-1 font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
