"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, Panel, EmptyState, LoadingState, SourceBadge, StatusBadge } from "@/components/cafe/ui";
import type { OrderStatus, OrderSource } from "@prisma/client";

type DisplayStatus = "OCCUPIED" | "PENDING_COLLECTION" | "PARTIAL" | "READY_TO_CLOSE";

type SessionCard = {
  id: string;
  tableNumber: string;
  branch: string;
  displayStatus: DisplayStatus;
  startedAt: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  customerName: string | null;
  orderCount: number;
  lastOrderAt: string | null;
};

type ClosedCard = {
  id: string; tableNumber: string; branch: string;
  startedAt: string; closedAt: string; totalAmount: number; paidAmount: number;
};

type Detail = {
  session: {
    id: string; tableNumber: string; branch: string; status: string;
    displayStatus: DisplayStatus; startedAt: string; closedAt: string | null;
    totalAmount: number; paidAmount: number; remainingAmount: number;
    customerName: string | null; notes: string | null;
  };
  orders: {
    id: string; orderNumber: number; source: OrderSource; status: OrderStatus;
    paymentStatus: string; total: number; paidAmount: number; remainingAmount: number;
    createdAt: string; createdBy: string | null;
    items: {
      id: string; productName: string; variantName: string | null; unitPrice: number;
      quantity: number; lineTotal: number; notes: string | null; kitchenStatus: string;
      paidQuantity: number; remainingQuantity: number;
      addOns: { name: string; price: number }[];
    }[];
  }[];
  payments: {
    id: string; amount: number; method: string; status: string; note: string | null;
    receivedBy: string; createdAt: string;
  }[];
};

type Branch = { id: string; name: string };

const STATUS_META: Record<DisplayStatus, { label: string; cls: string; card: string }> = {
  OCCUPIED: { label: "مشغولة", cls: "bg-blue-500/12 text-blue-700 dark:text-blue-400", card: "border-blue-500/40" },
  PENDING_COLLECTION: { label: "في انتظار التحصيل", cls: "bg-amber-500/12 text-amber-700 dark:text-amber-400", card: "border-amber-500/40" },
  PARTIAL: { label: "مدفوعة جزئيًا", cls: "bg-violet-500/12 text-violet-700 dark:text-violet-400", card: "border-violet-500/40" },
  READY_TO_CLOSE: { label: "جاهزة للقفل", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", card: "border-emerald-500/40" },
};

const METHOD_LABELS: Record<string, string> = { CASH: "كاش", CARD: "فيزا", WALLET: "محفظة" };

// Lightweight sitting-time label, refreshed every 60s without touching
// the rest of the layout.
function Duration({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const mins = Math.max(Math.floor((Date.now() - new Date(since).getTime()) / 60_000), 0);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const label =
    h === 0 ? `منذ ${m} دقيقة`
    : h === 1 ? `منذ ساعة${m > 0 ? ` و ${m} دقيقة` : ""}`
    : h === 2 ? `منذ ساعتين${m > 0 ? ` و ${m} دقيقة` : ""}`
    : `منذ ${h} ساعات${m > 0 ? ` و ${m} دقيقة` : ""}`;
  return <span className="tabular-nums">{label}</span>;
}

export default function TablesPage() {
  const { cafe, user, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);

  const [sessions, setSessions] = useState<SessionCard[] | null>(null);
  const [closedToday, setClosedToday] = useState<ClosedCard[]>([]);
  const [available, setAvailable] = useState<{ id: string; tableNumber: string; area: string | null; seatsCount: number | null }[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("ALL");
  const [filter, setFilter] = useState<"ALL" | DisplayStatus>("ALL");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);

  // Payment dialog state
  const [payMode, setPayMode] = useState<null | "FULL" | "PARTIAL" | "ITEMS">(null);
  const [payMethod, setPayMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");
  const [payAmount, setPayAmount] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payNote, setPayNote] = useState("");
  const [itemQty, setItemQty] = useState<Record<string, number>>({});

  const canCollect = canKey("tables.collect_payment");
  const canClose = canKey("tables.close");
  const canManage = canKey("tables.manage");

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (branchId !== "ALL") qs.set("branchId", branchId);
      const data = await api<{ sessions: SessionCard[]; closedToday: ClosedCard[] }>(
        `/api/tables?${qs.toString()}`
      );
      setSessions(data.sessions);
      setClosedToday(data.closedToday);

      // Configured tables without an open session → "available" cards.
      // Requires a specific branch (the selector is branch-scoped).
      if (branchId !== "ALL") {
        try {
          const sel = await api<{ tables: { id: string; tableNumber: string; area: string | null; seatsCount: number | null; session: unknown }[] }>(
            `/api/tables/selector?branchId=${branchId}`
          );
          setAvailable(sel.tables.filter((t) => !t.session).map((t) => ({ id: t.id, tableNumber: t.tableNumber, area: t.area, seatsCount: t.seatsCount })));
        } catch { setAvailable([]); }
      } else {
        setAvailable([]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الترابيزات");
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);
  // Keep the board fresh (new QR orders appear without a manual refresh).
  useEffect(() => {
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches").then((r) => setBranches(r.branches)).catch(() => {});
    }
  }, [user.branchId]);

  async function openDetail(id: string) {
    try {
      setDetail(await api<Detail>(`/api/tables/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل التفاصيل");
    }
  }

  async function refreshDetail(id: string) {
    await load();
    try { setDetail(await api<Detail>(`/api/tables/${id}`)); } catch { setDetail(null); }
  }

  function openPay(mode: "FULL" | "PARTIAL" | "ITEMS") {
    setPayMethod("CASH");
    setPayAmount("");
    setPayerName("");
    setPayNote("");
    setItemQty({});
    setPayMode(mode);
  }

  async function submitPay() {
    if (!detail || !payMode) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { mode: payMode, method: payMethod };
      if (payerName.trim()) body.payerName = payerName.trim();
      if (payNote.trim()) body.note = payNote.trim();
      if (payMode === "PARTIAL") body.amount = Number(payAmount) || 0;
      if (payMode === "ITEMS") {
        body.items = Object.entries(itemQty)
          .filter(([, q]) => q > 0)
          .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
      }
      const res = await api<{ collected: number; remainingAmount: number }>(
        `/api/tables/${detail.session.id}/pay`,
        { method: "POST", body }
      );
      toast.success(
        payMode === "ITEMS" ? "تم تحصيل الأصناف المحددة"
        : payMode === "PARTIAL" ? "تم تحصيل دفعة جزئية"
        : `تم تحصيل ${fmt(res.collected)}`
      );
      setPayMode(null);
      await refreshDetail(detail.session.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحصيل");
    } finally {
      setBusy(false);
    }
  }

  async function closeTable() {
    if (!detail) return;
    if (detail.session.remainingAmount > 0.001 && !canManage) {
      toast.error("لا يمكن قفل الترابيزة قبل تحصيل باقي الحساب");
      return;
    }
    if (!confirm(`قفل الترابيزة رقم ${detail.session.tableNumber}؟`)) return;
    setBusy(true);
    try {
      await api(`/api/tables/${detail.session.id}/close`, { method: "POST" });
      toast.success("تم قفل الترابيزة بنجاح");
      setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل القفل");
    } finally {
      setBusy(false);
    }
  }

  async function transferTable() {
    if (!detail) return;
    const target = prompt("رقم الترابيزة الجديدة:");
    if (!target?.trim()) return;
    setBusy(true);
    try {
      await api(`/api/tables/${detail.session.id}/transfer`, {
        method: "POST", body: { tableNumber: target.trim() },
      });
      toast.success(`تم نقل الجلسة إلى الترابيزة ${target.trim()}`);
      await refreshDetail(detail.session.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل النقل");
    } finally {
      setBusy(false);
    }
  }

  async function mergeTable() {
    if (!detail) return;
    const target = prompt("دمج مع الترابيزة رقم:");
    if (!target?.trim()) return;
    setBusy(true);
    try {
      await api(`/api/tables/${detail.session.id}/merge`, {
        method: "POST", body: { targetTableNumber: target.trim() },
      });
      toast.success(`تم دمج الجلسة مع الترابيزة ${target.trim()}`);
      setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الدمج");
    } finally {
      setBusy(false);
    }
  }

  const filtered = (sessions ?? []).filter((s) => filter === "ALL" || s.displayStatus === filter);
  const selectedItemsTotal = detail
    ? Object.entries(itemQty).reduce((sum, [itemId, qty]) => {
        for (const o of detail.orders) {
          const it = o.items.find((i) => i.id === itemId);
          if (it) return sum + (it.lineTotal / it.quantity) * qty;
        }
        return sum;
      }, 0)
    : 0;

  return (
    <>
      <PageHeader title="الترابيزات" subtitle="جلسات الترابيزات المفتوحة وحساباتها">
        <div className="flex flex-wrap items-center gap-2">
          {!user.branchId && branches.length > 1 && (
            <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "ALL")}>
              <SelectTrigger className="w-40">
                <SelectValue>
                  {branchId === "ALL" ? t.common.allBranches : branches.find((b) => b.id === branchId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t.common.allBranches}</SelectItem>
                {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {canManage && (
            <Link href="/tables/setup" className={buttonVariants({ size: "sm", variant: "outline" })}>
              إدارة أرقام الترابيزات
            </Link>
          )}
          <Button size="sm" variant="outline" onClick={load}>↻ {t.dashboard.refresh}</Button>
        </div>
      </PageHeader>

      {/* Status filter */}
      <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-border bg-card p-0.5 text-sm w-fit">
        {([["ALL", "كل الترابيزات"], ["OCCUPIED", "المشغولة"], ["PENDING_COLLECTION", "في انتظار التحصيل"], ["PARTIAL", "مدفوعة جزئيًا"], ["READY_TO_CLOSE", "جاهزة للقفل"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setFilter(k as typeof filter)}
            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${filter === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>
            {lbl}
          </button>
        ))}
      </div>

      {sessions === null ? (
        <LoadingState />
      ) : filtered.length === 0 && available.length === 0 ? (
        <EmptyState
          message={branchId === "ALL" ? "لا توجد ترابيزات مفتوحة حاليًا" : "لا توجد ترابيزات مضافة لهذا الفرع"}
          icon="🍽️"
        />
      ) : (
        <div className="space-y-5">
          {filtered.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((s) => {
                const meta = STATUS_META[s.displayStatus];
                return (
                  <button key={s.id} onClick={() => openDetail(s.id)}
                    className={`rounded-2xl border-2 bg-card p-4 text-start shadow-sm transition-shadow hover:shadow-md ${meta.card}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-heading text-xl font-bold text-foreground">🍽️ ترابيزة {s.tableNumber}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.branch}{s.customerName ? ` · ${s.customerName}` : ""}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">⏱ <Duration since={s.startedAt} /></p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <div><p className="text-muted-foreground">الإجمالي</p><p className="mt-0.5 font-bold tabular-nums text-foreground">{fmt(s.totalAmount)}</p></div>
                      <div><p className="text-muted-foreground">المدفوع</p><p className="mt-0.5 font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(s.paidAmount)}</p></div>
                      <div><p className="text-muted-foreground">المتبقي</p><p className="mt-0.5 font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmt(s.remainingAmount)}</p></div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {s.orderCount} طلب{s.lastOrderAt ? ` · آخر طلب ${formatTime(s.lastOrderAt)}` : ""}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          {/* Available configured tables (no open session) */}
          {available.length > 0 && (filter === "ALL") && (
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">الترابيزات المتاحة ({available.length})</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
                {available.map((tbl) => (
                  <div key={tbl.id} className="flex flex-col items-center gap-0.5 rounded-xl border border-dashed border-border bg-card px-2 py-3 text-center">
                    <span className="font-heading text-lg font-bold text-foreground">{tbl.tableNumber}</span>
                    <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">متاحة</span>
                    {tbl.area && <span className="text-[10px] text-muted-foreground">{tbl.area}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Closed today */}
      {closedToday.length > 0 && (
        <Panel title="الترابيزات المقفولة اليوم" className="mt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>الترابيزة</TableHead>
                <TableHead>الفرع</TableHead>
                <TableHead>بدأت</TableHead>
                <TableHead>اتقفلت</TableHead>
                <TableHead className="text-end">الإجمالي</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {closedToday.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">ترابيزة {s.tableNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{s.branch}</TableCell>
                    <TableCell className="text-xs">{formatTime(s.startedAt)}</TableCell>
                    <TableCell className="text-xs">{formatTime(s.closedAt)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmt(s.totalAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}

      {/* ── Table detail dialog ── */}
      <Dialog open={detail !== null && payMode === null} onOpenChange={(o) => !o && !busy && setDetail(null)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>تفاصيل الترابيزة رقم {detail.session.tableNumber}</DialogTitle>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-muted/30 p-3 text-sm">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_META[detail.session.displayStatus].cls}`}>
                  {STATUS_META[detail.session.displayStatus].label}
                </span>
                <span>بدأت: {formatTime(detail.session.startedAt)}</span>
                <span>وقت الجلوس: <Duration since={detail.session.startedAt} /></span>
                <span className="font-semibold">الإجمالي: <span className="tabular-nums">{fmt(detail.session.totalAmount)}</span></span>
                <span className="text-emerald-600 dark:text-emerald-400">المدفوع: <span className="tabular-nums">{fmt(detail.session.paidAmount)}</span></span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">المتبقي: <span className="tabular-nums">{fmt(detail.session.remainingAmount)}</span></span>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                {canCollect && detail.session.remainingAmount > 0 && (
                  <>
                    <Button size="sm" onClick={() => openPay("FULL")}>تحصيل كامل الحساب</Button>
                    <Button size="sm" variant="outline" onClick={() => openPay("PARTIAL")}>تحصيل جزئي</Button>
                    <Button size="sm" variant="outline" onClick={() => openPay("ITEMS")}>تحصيل أصناف محددة</Button>
                  </>
                )}
                {canManage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={transferTable} disabled={busy}>نقل الترابيزة</Button>
                    <Button size="sm" variant="ghost" onClick={mergeTable} disabled={busy}>دمج ترابيزة</Button>
                  </>
                )}
                {canClose && (
                  <Button size="sm" variant={detail.session.remainingAmount <= 0.001 ? "default" : "outline"}
                    className="ms-auto" onClick={closeTable} disabled={busy}>
                    🔒 قفل الترابيزة
                  </Button>
                )}
              </div>

              {/* Orders + items */}
              <div className="space-y-3">
                <h3 className="font-heading text-sm font-semibold">الطلبات ({detail.orders.length})</h3>
                {detail.orders.map((o) => (
                  <div key={o.id} className="rounded-xl border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold tabular-nums">#{o.orderNumber}</span>
                      <SourceBadge source={o.source} />
                      <StatusBadge status={o.status} />
                      <span className="text-xs text-muted-foreground">{formatTime(o.createdAt)}</span>
                      {o.createdBy && <span className="text-xs text-muted-foreground">· {o.createdBy}</span>}
                      <span className="ms-auto font-semibold tabular-nums">{fmt(o.total)}</span>
                    </div>
                    <div className="mt-2 space-y-1 text-sm">
                      {o.items.map((it) => (
                        <div key={it.id} className="flex items-center justify-between gap-2">
                          <span>
                            {it.productName}{it.variantName ? ` (${it.variantName})` : ""} × {it.quantity}
                            {it.paidQuantity > 0 && (
                              <span className="ms-2 rounded bg-emerald-500/12 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                                مدفوع {it.paidQuantity}/{it.quantity}
                              </span>
                            )}
                            {it.notes && <span className="ms-1 text-xs text-muted-foreground">({it.notes})</span>}
                          </span>
                          <span className="tabular-nums text-muted-foreground">{fmt(it.lineTotal)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Payments */}
                <h3 className="font-heading text-sm font-semibold">المدفوعات ({detail.payments.length})</h3>
                {detail.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا توجد مدفوعات بعد.</p>
                ) : (
                  <div className="space-y-1 rounded-xl border p-3 text-sm">
                    {detail.payments.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {METHOD_LABELS[p.method] ?? p.method} · {p.receivedBy}
                          {p.note && <span className="text-xs text-muted-foreground"> — {p.note}</span>}
                          {p.status === "REFUNDED" && <span className="ms-1 text-xs text-red-600">(مرتجع)</span>}
                        </span>
                        <span className="tabular-nums">
                          {fmt(p.amount)} <span className="text-xs text-muted-foreground">{formatTime(p.createdAt)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Payment dialog ── */}
      <Dialog open={payMode !== null} onOpenChange={(o) => !o && !busy && setPayMode(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          {detail && payMode && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {payMode === "FULL" ? "تحصيل كامل الحساب" : payMode === "PARTIAL" ? "تحصيل جزئي" : "تحصيل أصناف محددة"}
                  {" — ترابيزة "}{detail.session.tableNumber}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-3">
                <div className="rounded-lg bg-muted/40 p-2.5 text-sm">
                  المبلغ المتبقي: <span className="font-bold tabular-nums">{fmt(detail.session.remainingAmount)}</span>
                </div>

                {payMode === "PARTIAL" && (
                  <div className="space-y-1.5">
                    <Label>المبلغ المدفوع</Label>
                    <Input type="number" min="0" step="0.01" dir="ltr" placeholder="0.00"
                      value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                  </div>
                )}

                {payMode === "ITEMS" && (
                  <div className="space-y-1.5">
                    <Label>اختار الأصناف</Label>
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
                      {detail.orders.flatMap((o) =>
                        o.items
                          .filter((it) => it.remainingQuantity > 0)
                          .map((it) => {
                            const qty = itemQty[it.id] ?? 0;
                            const unit = it.lineTotal / it.quantity;
                            return (
                              <div key={it.id} className="flex items-center justify-between gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate">
                                  {it.productName}{it.variantName ? ` (${it.variantName})` : ""}
                                  <span className="ms-1 text-xs text-muted-foreground">
                                    {fmt(unit)} × متبقي {it.remainingQuantity}
                                  </span>
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button size="sm" variant="outline" className="size-7 p-0"
                                    onClick={() => setItemQty({ ...itemQty, [it.id]: Math.max(qty - 1, 0) })}>−</Button>
                                  <span className="w-6 text-center tabular-nums">{qty}</span>
                                  <Button size="sm" variant="outline" className="size-7 p-0"
                                    onClick={() => setItemQty({ ...itemQty, [it.id]: Math.min(qty + 1, it.remainingQuantity) })}>+</Button>
                                </div>
                              </div>
                            );
                          })
                      )}
                    </div>
                    {selectedItemsTotal > 0 && (
                      <p className="text-sm font-semibold">إجمالي المحدد: <span className="tabular-nums">{fmt(selectedItemsTotal)}</span></p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label>طريقة الدفع</Label>
                  <div className="flex gap-2">
                    {(["CASH", "CARD", "WALLET"] as const).map((m) => (
                      <button key={m} onClick={() => setPayMethod(m)}
                        className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${payMethod === m ? "border-foreground bg-foreground text-background" : "border-border"}`}>
                        {METHOD_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>اسم الشخص (اختياري)</Label>
                    <Input value={payerName} onChange={(e) => setPayerName(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>ملاحظة (اختياري)</Label>
                    <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} />
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setPayMode(null)} disabled={busy}>إلغاء</Button>
                <Button onClick={submitPay}
                  disabled={
                    busy ||
                    (payMode === "PARTIAL" && (Number(payAmount) <= 0 || Number(payAmount) > detail.session.remainingAmount + 0.001)) ||
                    (payMode === "ITEMS" && selectedItemsTotal <= 0)
                  }>
                  {payMode === "FULL" ? "تأكيد التحصيل" : payMode === "PARTIAL" ? "تحصيل الدفعة" : "تحصيل المحدد"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
