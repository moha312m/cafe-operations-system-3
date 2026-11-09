"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { api, money, ApiRequestError } from "@/lib/client";
import { formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import {
  INVOICE_STATUS_LABEL, PAYMENT_STATUS_LABEL, PURCHASE_METHOD_LABEL,
  PAYMENT_CHOICES, FUNDING_LABEL, retainedLineItem, type FundingSource, type PaymentChoice, type PickerItem,
} from "@/lib/purchases";
import { purchaseFormPreview, purchaseQuantityFromForm, purchaseUnitCostFromForm } from "@/lib/purchase-arithmetic";
import {
  beginPaymentIntent, completePaymentIntent, loadPaymentIntent, paymentIntentOwner, paymentIntentPath, paymentIntentSurvives,
  purchasePaymentBody, type PaymentIntent,
} from "@/lib/purchase-payment-intent";
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
  branchId: string; branch: string; invoiceDate: string; status: PurchaseInvoiceStatus; confirmedAt: string | null;
  paymentStatus: PurchasePaymentStatus; subtotalAmount: number; discountAmount: number;
  taxAmount: number; totalAmount: number; paidAmount: number; remainingAmount: number;
  notes: string | null; createdBy: string | null;
  items: { id: string; inventoryItemId: string; name: string; quantity: number; unit: InventoryUnit; unitCost: number; totalCost: number; expiryDate: string | null }[];
  payments: { id: string; amount: number; method: PurchasePaymentMethod; fundingSource: FundingSource | null; note: string | null; paidAt: string; createdBy: string | null }[];
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

const choiceOf = (key: PaymentChoice["key"]) => PAYMENT_CHOICES.find((c) => c.key === key)!;
const sourceLabel = (body: PaymentIntent["body"]) =>
  PAYMENT_CHOICES.find((c) => c.method === body.method && c.fundingSource === body.fundingSource)?.label ?? PURCHASE_METHOD_LABEL[body.method];
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

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
  const [cPayChoice, setCPayChoice] = useState<PaymentChoice["key"]>("SAFE_CASH");
  const [cPayAmount, setCPayAmount] = useState("");
  // Set while the form edits an existing draft instead of creating an invoice.
  const [editId, setEditId] = useState<string | null>(null);
  const [editPaid, setEditPaid] = useState(0);
  const [editDate, setEditDate] = useState("");
  // The invoice's own items, kept apart from the picker list so they stay visible
  // while that list loads, if it fails, or when an item is archived.
  const [editItems, setEditItems] = useState<Record<string, PickerItem>>({});
  const uid = useId();

  // detail + payment
  const [detail, setDetail] = useState<Detail | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payChoice, setPayChoice] = useState<PaymentChoice["key"]>("SAFE_CASH");
  const [payNote, setPayNote] = useState("");
  // A payment whose outcome the browser never saw, for this actor and invoice.
  // Until it is resolved with its own key, no new payment starts on the invoice.
  // State is tagged with the actor+invoice it was read for, so switching either
  // shows nothing stale and needs no reset.
  const intentOwner = paymentIntentOwner(user);
  const payPath = detail ? paymentIntentPath(detail.id) : "";
  const payScope = payPath ? intentOwner + payPath : "";
  const [payLoaded, setPayLoaded] = useState<{ scope: string; intent: PaymentIntent | null }>({ scope: "", intent: null });
  const [payErrorState, setPayErrorState] = useState({ scope: "", text: "" });
  const payReady = !!payScope && payLoaded.scope === payScope;
  const payPending = payReady ? payLoaded.intent : null;
  const payError = payErrorState.scope === payScope ? payErrorState.text : "";
  const setPayPending = (intent: PaymentIntent | null) => setPayLoaded({ scope: payScope, intent });
  const setPayError = (text: string) => setPayErrorState({ scope: payScope, text });
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

  // Read only this actor's pending payment for the open invoice. Another
  // actor's or invoice's saved request is neither shown nor removed.
  useEffect(() => {
    if (!payPath) return;
    let live = true;
    const scope = intentOwner + payPath;
    Promise.resolve().then(() => loadPaymentIntent(window.sessionStorage, intentOwner, payPath))
      .then((intent) => { if (live) setPayLoaded({ scope, intent }); })
      .catch((e) => { if (live) setPayErrorState({ scope, text: errorText(e, "تعذر قراءة الدفعة المعلّقة") }); });
    return () => { live = false; };
  }, [intentOwner, payPath]);

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
    setEditId(null); setEditPaid(0); setEditItems({});
    setCBranch(user.branchId ?? (branches[0]?.id ?? ""));
    setCSupplier(""); setCNumber(""); setCNotes(""); setCDiscount(""); setCTax("");
    setCItems([{ inventoryItemId: "", quantity: "", unitCost: "", expiryDate: "" }]);
    setCPayMode("UNPAID"); setCPayChoice("SAFE_CASH"); setCPayAmount("");
    setCreateOpen(true);
  }

  const preview = purchaseFormPreview({
    lines: cItems,
    discount: cDiscount,
    tax: cTax,
    payment: editId ? { recorded: editPaid } : { mode: cPayMode, amount: cPayAmount },
  });
  const cTotals = preview.summary;
  const cValid = preview.valid && !!cBranch;

  async function createInvoice() {
    if (!cBranch) return toast.error("اختار الفرع");
    if (!preview.valid || !cTotals) return toast.error("راجع الحقول المعلّمة قبل الحفظ");
    setBusy(true);
    try {
      // The request carries the normalized numbers the preview already proved valid.
      const items = cItems.map((i) => ({
        inventoryItemId: i.inventoryItemId,
        quantity: purchaseQuantityFromForm(i.quantity),
        unitCost: purchaseUnitCostFromForm(i.unitCost),
        expiryDate: i.expiryDate || undefined,
      }));
      if (editId) {
        // The server decides totals on the locked draft and keeps every
        // recorded payment; this request carries no payment at all.
        await api(`/api/purchases/${editId}`, {
          method: "PATCH",
          body: {
            supplierId: cSupplier || null,
            ...(editDate && cDate !== editDate ? { invoiceDate: cDate } : {}),
            notes: cNotes.trim() || null,
            discountAmount: cTotals.discount,
            taxAmount: cTotals.tax,
            items,
          },
        });
        toast.success("تم حفظ تعديلات المسودة");
        setCreateOpen(false);
        await refreshDetail(editId);
        return;
      }
      const payment =
        cPayMode === "UNPAID"
          ? undefined
          : {
              method: choiceOf(cPayChoice).method,
              fundingSource: choiceOf(cPayChoice).fundingSource,
              amount: preview.paymentAmount,
            };
      await api("/api/purchases", {
        method: "POST",
        body: {
          branchId: cBranch,
          supplierId: cSupplier || null,
          invoiceNumber: cNumber.trim() || undefined,
          invoiceDate: cDate,
          discountAmount: cTotals.discount,
          taxAmount: cTotals.tax,
          notes: cNotes.trim() || undefined,
          items,
          payment,
        },
      });
      toast.success("تم إنشاء فاتورة الشراء");
      setCreateOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : editId ? "فشل حفظ التعديل" : "فشل الإنشاء");
    } finally {
      setBusy(false);
    }
  }

  // Load the invoice again before editing, so the form starts from what the
  // server holds now; the server still decides whether it is a draft.
  async function openEdit() {
    if (!detail) return;
    setBusy(true);
    try {
      const { invoice } = await api<{ invoice: Detail }>(`/api/purchases/${detail.id}`);
      setDetail(invoice);
      if (invoice.status !== "DRAFT") { toast.error("لا يمكن تعديل فاتورة مؤكدة أو ملغية"); await load(); return; }
      setEditId(invoice.id); setEditPaid(invoice.paidAmount); setEditDate(invoice.invoiceDate.slice(0, 10));
      setEditItems(Object.fromEntries(invoice.items.map((it) => [it.inventoryItemId, { id: it.inventoryItemId, name: it.name, unit: it.unit }])));
      setCBranch(invoice.branchId); setCSupplier(invoice.supplier?.id ?? "");
      setCDate(invoice.invoiceDate.slice(0, 10)); setCNumber(invoice.invoiceNumber); setCNotes(invoice.notes ?? "");
      setCDiscount(invoice.discountAmount > 0 ? String(invoice.discountAmount) : "");
      setCTax(invoice.taxAmount > 0 ? String(invoice.taxAmount) : "");
      setCItems(invoice.items.map((it) => ({
        inventoryItemId: it.inventoryItemId, quantity: String(it.quantity), unitCost: String(it.unitCost),
        expiryDate: it.expiryDate ? it.expiryDate.slice(0, 10) : "",
      })));
      setCreateOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الفاتورة");
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

  // The intent is saved and read back before the first request; a payment
  // whose outcome is unknown is retried with the same key and payload only.
  async function recordPayment() {
    if (!detail || !payReady) return;
    setPayError("");
    const recovering = payPending !== null;
    const parsed = recovering ? null : purchasePaymentBody.safeParse({
      amount: payAmount.trim() === "" ? Number.NaN : Number(payAmount),
      method: choiceOf(payChoice).method,
      fundingSource: choiceOf(payChoice).fundingSource,
      ...(payNote.trim() ? { note: payNote.trim() } : {}),
    });
    if (parsed && !parsed.success) { setPayError(parsed.error.issues.map((i) => i.message).join("؛ ")); return; }
    setBusy(true);
    let intent = payPending;
    try {
      intent ??= beginPaymentIntent(window.sessionStorage, intentOwner, payPath, parsed?.data);
      setPayPending(intent);
      await api(intent.path, { method: "POST", body: intent.body, idempotencyKey: intent.key });
      if (!completePaymentIntent(window.sessionStorage, intentOwner, intent)) throw new Error("هوية الدفعة المعلّقة اتغيرت؛ راجع نتيجتها قبل أي دفعة جديدة");
      setPayPending(null);
      toast.success(recovering ? "تمت استعادة نتيجة الدفعة السابقة" : "تم تسجيل الدفعة");
      setPayOpen(false); setPayAmount(""); setPayNote("");
      await refreshDetail(detail.id);
    } catch (e) {
      let keep = !!intent && paymentIntentSurvives(e instanceof ApiRequestError ? e.status : null);
      if (intent && !keep) { try { completePaymentIntent(window.sessionStorage, intentOwner, intent); } catch { keep = true; } }
      setPayPending(keep ? intent : null);
      setPayError(errorText(e, "فشل تسجيل الدفعة") + (keep ? " — النتيجة غير محسومة؛ استعدها بنفس الطلب قبل أي دفعة جديدة." : ""));
    } finally {
      setBusy(false);
    }
  }

  function openPayment() {
    if (!detail) return;
    setPayError("");
    if (!payPending) { setPayChoice("SAFE_CASH"); setPayAmount(String(detail.remainingAmount)); setPayNote(""); }
    setPayOpen(true);
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

      {/* ── Create / edit invoice dialog ── */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && !busy && setCreateOpen(false)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? `تعديل فاتورة شراء ${cNumber}` : "فاتورة شراء جديدة"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-supplier`}>المورد</Label>
                <select id={`${uid}-supplier`} value={cSupplier} onChange={(e) => setCSupplier(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">— بدون مورد —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {!user.branchId && !editId && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-branch`}>الفرع</Label>
                  <select id={`${uid}-branch`} value={cBranch} onChange={(e) => setCBranch(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                    <option value="">اختار الفرع</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-date`}>تاريخ الفاتورة</Label>
                <Input id={`${uid}-date`} type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-number`}>رقم الفاتورة{editId ? "" : " (اختياري)"}</Label>
                <Input id={`${uid}-number`} dir="ltr" placeholder="يُنشأ تلقائيًا" value={cNumber} disabled={!!editId} onChange={(e) => setCNumber(e.target.value)} />
              </div>
            </div>

            {/* Items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>الأصناف</Label>
                <Button size="sm" variant="outline" onClick={() => setCItems([...cItems, { inventoryItemId: "", quantity: "", unitCost: "", expiryDate: "" }])}>+ صنف</Button>
              </div>
              {!cBranch && <p className="text-xs text-muted-foreground">اختار الفرع لعرض خامات المخزون.</p>}
              {cItems.map((it, idx) => {
                const lp = preview.lines[idx];
                const retained = retainedLineItem(invItems, it.inventoryItemId, editItems);
                const id = (field: string) => `${uid}-l${idx}-${field}`;
                const set = (patch: Partial<NewItem>) => { const n = [...cItems]; n[idx] = { ...it, ...patch }; setCItems(n); };
                return (
                  <fieldset key={idx} className="space-y-2 rounded-xl border p-2.5">
                    <legend className="px-1 text-xs text-muted-foreground">صنف {idx + 1}</legend>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2 space-y-1">
                        <Label htmlFor={id("item")}>الخامة</Label>
                        <select
                          id={id("item")} value={it.inventoryItemId}
                          aria-invalid={!!lp.errors.item} aria-describedby={lp.errors.item ? id("item-err") : undefined}
                          onChange={(e) => {
                            const inv = invItems.find((x) => x.id === e.target.value);
                            set({ inventoryItemId: e.target.value, unitCost: it.unitCost || (inv ? String(Number(inv.costPerUnit)) : "") });
                          }}
                          className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
                          <option value="">اختار الخامة</option>
                          {retained && <option value={retained.id}>{retained.name} ({UNIT_LABEL[retained.unit]}) — غير متاحة للاختيار الجديد</option>}
                          {invItems.map((x) => <option key={x.id} value={x.id}>{x.name} ({UNIT_LABEL[x.unit]})</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={id("qty")}>الكمية</Label>
                        <Input id={id("qty")} type="number" min="0" step="0.001" inputMode="decimal" dir="ltr"
                          aria-invalid={!!lp.errors.quantity} aria-describedby={lp.errors.quantity ? id("qty-err") : undefined}
                          value={it.quantity} onChange={(e) => set({ quantity: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={id("cost")}>تكلفة الوحدة</Label>
                        <Input id={id("cost")} type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                          aria-invalid={!!lp.errors.unitCost} aria-describedby={lp.errors.unitCost ? id("cost-err") : undefined}
                          value={it.unitCost} onChange={(e) => set({ unitCost: e.target.value })} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">إجمالي الصنف</span>
                      <span className="flex-1 text-end tabular-nums">{lp.totalCost === null ? "—" : fmt(lp.totalCost)}</span>
                      <button type="button" aria-label={`حذف الصنف ${idx + 1}`} className="px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => setCItems(cItems.length > 1 ? cItems.filter((_, i) => i !== idx) : cItems)}>✕</button>
                    </div>
                    {retained && <p className="text-xs text-muted-foreground">هذه الخامة غير متاحة للاختيار الجديد، وتبقى كما هي في الفاتورة.</p>}
                    {lp.errors.item && <p id={id("item-err")} role="alert" className="text-xs text-destructive">{lp.errors.item}</p>}
                    {lp.errors.quantity && <p id={id("qty-err")} role="alert" className="text-xs text-destructive">{lp.errors.quantity}</p>}
                    {lp.errors.unitCost && <p id={id("cost-err")} role="alert" className="text-xs text-destructive">{lp.errors.unitCost}</p>}
                    {lp.errors.line && <p role="alert" className="text-xs text-destructive">{lp.errors.line}</p>}
                  </fieldset>
                );
              })}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-discount`}>الخصم</Label>
                <Input id={`${uid}-discount`} type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                  aria-invalid={!!preview.errors.discount} aria-describedby={preview.errors.discount ? `${uid}-discount-err` : undefined}
                  value={cDiscount} onChange={(e) => setCDiscount(e.target.value)} />
                {preview.errors.discount && <p id={`${uid}-discount-err`} role="alert" className="text-xs text-destructive">{preview.errors.discount}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-tax`}>الضريبة</Label>
                <Input id={`${uid}-tax`} type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                  aria-invalid={!!preview.errors.tax} aria-describedby={preview.errors.tax ? `${uid}-tax-err` : undefined}
                  value={cTax} onChange={(e) => setCTax(e.target.value)} />
                {preview.errors.tax && <p id={`${uid}-tax-err`} role="alert" className="text-xs text-destructive">{preview.errors.tax}</p>}
              </div>
            </div>
            {preview.errors.summary && <p role="alert" className="text-sm text-destructive">{preview.errors.summary}</p>}

            {/* Live summary: the same helper the server writers use */}
            <section aria-label="ملخص الفاتورة" className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-sm">
              <Row label="الإجمالي الفرعي" value={cTotals ? fmt(cTotals.subtotal) : "—"} />
              <Row label="الخصم" value={cTotals ? `- ${fmt(cTotals.discount)}` : "—"} />
              <Row label="الضريبة" value={cTotals ? fmt(cTotals.tax) : "—"} />
              <Row label="الإجمالي" value={cTotals ? fmt(cTotals.total) : "—"} bold />
              <Row label="المدفوع" value={cTotals ? fmt(cTotals.paid) : "—"} />
              <Row label="المتبقي" value={cTotals ? fmt(cTotals.remaining) : "—"} bold />
            </section>

            {/* Payment */}
            {editId ? (
              <p className="rounded-lg border p-2.5 text-xs text-muted-foreground">
                المدفوعات المسجلة ({fmt(editPaid)}) تبقى كما هي ولا تتغير بتعديل المسودة.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label id={`${uid}-paymode`}>الدفع</Label>
                <div role="group" aria-labelledby={`${uid}-paymode`} className="flex flex-wrap gap-2">
                  {([["UNPAID", "غير مدفوعة"], ["PARTIAL", "مدفوعة جزئيًا"], ["PAID", "مدفوعة بالكامل"]] as const).map(([m, lbl]) => (
                    <button key={m} type="button" aria-pressed={cPayMode === m} onClick={() => setCPayMode(m)}
                      className={`flex-1 rounded-lg border px-2 py-2 text-xs font-medium ${cPayMode === m ? "border-foreground bg-foreground text-background" : "border-border"}`}>{lbl}</button>
                  ))}
                </div>
                {cPayMode !== "UNPAID" && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {cPayMode === "PARTIAL" && (
                      <div className="col-span-2 space-y-1 sm:col-span-1">
                        <Label htmlFor={`${uid}-payamount`}>مبلغ الدفعة</Label>
                        <Input id={`${uid}-payamount`} type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                          aria-invalid={!!preview.errors.payment} aria-describedby={preview.errors.payment ? `${uid}-payamount-err` : undefined}
                          value={cPayAmount} onChange={(e) => setCPayAmount(e.target.value)} />
                        {preview.errors.payment && <p id={`${uid}-payamount-err`} role="alert" className="text-xs text-destructive">{preview.errors.payment}</p>}
                        {preview.clamped && <p className="text-xs text-muted-foreground">الدفعة أكبر من الإجمالي، وسيُسجَّل منها إجمالي الفاتورة فقط.</p>}
                      </div>
                    )}
                    <div className={`space-y-1 ${cPayMode === "PAID" ? "col-span-2" : "col-span-2 sm:col-span-1"}`}>
                      <Label htmlFor={`${uid}-paysource`}>الفلوس طالعة منين</Label>
                      <select id={`${uid}-paysource`} value={cPayChoice} onChange={(e) => setCPayChoice(e.target.value as PaymentChoice["key"])}
                        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                        {PAYMENT_CHOICES.filter((c) => c.fundingSource !== "DRAWER").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </div>
                    {cPayMode === "PAID" && preview.errors.payment && <p role="alert" className="col-span-2 text-xs text-destructive">{preview.errors.payment}</p>}
                    <p className="col-span-2 text-xs text-muted-foreground">الدفع من درج الكاشير بيتسجل بعد إنشاء الفاتورة من زرار &quot;تسجيل دفعة&quot;، علشان يتخصم من الشيفت.</p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-notes`}>ملاحظات</Label>
              <Textarea id={`${uid}-notes`} rows={2} value={cNotes} onChange={(e) => setCNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={createInvoice} disabled={busy || !cValid}>{editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Detail dialog ── */}
      <Dialog open={detail !== null && !payOpen && !confirmOpen && !createOpen} onOpenChange={(o) => !o && !busy && setDetail(null)}>
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
                    <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{PURCHASE_METHOD_LABEL[p.method]}{p.fundingSource ? ` · ${FUNDING_LABEL[p.fundingSource]}` : ""}{p.createdBy ? ` · ${p.createdBy}` : ""}{p.note ? ` — ${p.note}` : ""}</span>
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

              {payPending && (
                <div role="status" className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-50 p-2.5 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                  <p>
                    يوجد دفعة سابقة بمبلغ <span className="font-semibold tabular-nums">{fmt(payPending.body.amount)}</span> ({sourceLabel(payPending.body)}) لم تُحسم نتيجتها.
                    استعدها بنفس الطلب قبل أي دفعة جديدة؛ لا تسلّم فلوسًا مرة ثانية أثناء الاستعادة.
                  </p>
                  {canPay && <Button size="sm" onClick={openPayment} disabled={busy || !payReady}>استعادة نتيجة الدفعة</Button>}
                </div>
              )}
              {payError && !payOpen && <p role="alert" className="text-sm text-destructive">{payError}</p>}

              {/* Actions */}
              <DialogFooter className="flex-wrap gap-2">
                {detail.status === "DRAFT" && canEdit && (
                  <Button variant="outline" onClick={openEdit} disabled={busy}>تعديل الفاتورة</Button>
                )}
                {detail.status === "DRAFT" && canConfirm && (
                  <Button onClick={() => setConfirmOpen(true)} disabled={busy}>تأكيد الفاتورة</Button>
                )}
                {detail.status !== "CANCELLED" && detail.remainingAmount > 0 && canPay && !payPending && (
                  <Button variant="outline" onClick={openPayment} disabled={busy || !payReady}>تسجيل دفعة</Button>
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
          <DialogHeader><DialogTitle>{payPending ? "استعادة نتيجة دفعة سابقة" : "تسجيل دفعة للمورد"}</DialogTitle></DialogHeader>
          {detail && payPending && (
            <div className="space-y-3 text-sm">
              <p role="status">
                الطلب ده اتبعت قبل كده ونتيجته ما وصلتش. الاستعادة بتبعته بنفس المبلغ والمصدر والمفتاح، فلو كان اتسجل مش هيتسجل تاني.
                لا تسلّم فلوسًا جديدة أثناء الاستعادة.
              </p>
              <section aria-label="بيانات الدفعة المعلّقة" className="space-y-1 rounded-lg bg-muted/40 p-2.5">
                <Row label="المبلغ" value={fmt(payPending.body.amount)} bold />
                <Row label="الفلوس طالعة منين" value={sourceLabel(payPending.body)} />
                {payPending.body.note && <Row label="ملاحظة" value={payPending.body.note} />}
              </section>
            </div>
          )}
          {detail && !payPending && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/40 p-2.5 text-sm">المتبقي: <span className="font-bold tabular-nums">{fmt(detail.remainingAmount)}</span></div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-pay-amount`}>مبلغ الدفعة</Label>
                <Input id={`${uid}-pay-amount`} type="number" min="0" step="0.01" inputMode="decimal" dir="ltr" value={payAmount}
                  aria-invalid={!!payError} aria-describedby={payError ? `${uid}-pay-err` : undefined}
                  onChange={(e) => setPayAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label id={`${uid}-pay-source`}>الفلوس طالعة منين؟</Label>
                <div role="group" aria-labelledby={`${uid}-pay-source`} className="grid grid-cols-2 gap-2">
                  {PAYMENT_CHOICES.map((c) => (
                    <button key={c.key} type="button" aria-pressed={payChoice === c.key} onClick={() => setPayChoice(c.key)}
                      className={`rounded-lg border px-2 py-2 text-sm font-medium ${payChoice === c.key ? "border-foreground bg-foreground text-background" : "border-border"}`}>
                      {c.label}
                    </button>
                  ))}
                </div>
                {payChoice === "DRAWER_CASH" && <p className="text-xs text-muted-foreground">بيتخصم من الكاش المتوقع في شيفتك المفتوح في نفس الفرع.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-pay-note`}>ملاحظة (اختياري)</Label>
                <Input id={`${uid}-pay-note`} maxLength={300} value={payNote} onChange={(e) => setPayNote(e.target.value)} />
              </div>
            </div>
          )}
          {payError && <p id={`${uid}-pay-err`} role="alert" className="text-sm text-destructive">{payError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={busy}>{payPending ? "إغلاق" : "إلغاء"}</Button>
            {payPending ? (
              <Button onClick={recordPayment} disabled={busy || !payReady}>{busy ? "جارٍ الاستعادة…" : "إعادة المحاولة واستعادة النتيجة"}</Button>
            ) : (
              <Button onClick={recordPayment} disabled={busy || !payReady || Number(payAmount) <= 0 || (detail ? Number(payAmount) > detail.remainingAmount + 0.001 : true)}>{busy ? "جارٍ التسجيل…" : "تسجيل الدفعة"}</Button>
            )}
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
