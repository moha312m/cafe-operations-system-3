"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { ROLE_LABELS } from "@/lib/permissions";
import { APPROVAL_MODE_LABEL } from "@/lib/qr-approval";
import type { Role, QrApprovalMode } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { QrApprovalSettingsDialog } from "@/components/qr-approval-settings-dialog";

type OrderItem = {
  id: string; productName: string; variantName: string | null;
  unitPrice: number; quantity: number; lineTotal: number; notes: string | null;
};
type PendingOrder = {
  id: string; orderNumber: number; tableNumber: string | null;
  customerName: string | null; notes: string | null; total: number; createdAt: string;
  approvalMode: QrApprovalMode | null; assignedRole: Role | null; assignedUser: string | null;
  items: OrderItem[];
};

type EditState = {
  order: PendingOrder;
  quantities: Record<string, number>;
  tableNumber: string; customerName: string; notes: string;
};

function assignedLabel(o: PendingOrder): string {
  if (o.assignedUser) return o.assignedUser;
  if (o.assignedRole) return ROLE_LABELS[o.assignedRole];
  return "أي موظف مصرّح له";
}

function waitLabel(createdAt: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000), 0);
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `منذ ${h}س${m ? ` ${m}د` : ""}`;
}

export default function ApprovalsPage() {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [perms, setPerms] = useState({ canApprove: false, canReject: false, canEdit: false });
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<PendingOrder | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const canEditSettings = canKey("settings.edit_qr_approval");

  const load = useCallback(async () => {
    try {
      const data = await api<{ orders: PendingOrder[]; canApprove: boolean; canReject: boolean; canEdit: boolean }>(
        "/api/qr-orders/pending"
      );
      setOrders(data.orders);
      setPerms({ canApprove: data.canApprove, canReject: data.canReject, canEdit: data.canEdit });
    } catch {
      // polling failure is non-fatal
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 20_000); // lightweight refresh
    return () => clearInterval(timer);
  }, [load]);

  async function approve(order: PendingOrder) {
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/approve`, { method: "POST" });
      toast.success("تم تأكيد الطلب وإرساله للتحضير");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التأكيد");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true);
    try {
      await api(`/api/orders/${rejecting.id}/reject`, { method: "POST", body: { reason } });
      toast.success("تم رفض الطلب");
      setRejecting(null); setReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الرفض");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(order: PendingOrder) {
    setEditing({
      order,
      quantities: Object.fromEntries(order.items.map((i) => [i.id, i.quantity])),
      tableNumber: order.tableNumber ?? "",
      customerName: order.customerName ?? "",
      notes: order.notes ?? "",
    });
  }

  async function saveEditAndApprove(approveAfter: boolean) {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/orders/${editing.order.id}`, {
        method: "PATCH",
        body: {
          tableNumber: editing.tableNumber || null,
          customerName: editing.customerName || null,
          notes: editing.notes || null,
          items: Object.entries(editing.quantities).map(([id, quantity]) => ({ id, quantity })),
        },
      });
      if (approveAfter) {
        await api(`/api/orders/${editing.order.id}/approve`, { method: "POST" });
        toast.success("تم حفظ التعديل وتأكيد الطلب");
      } else {
        toast.success("تم حفظ التعديل");
      }
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التعديل");
    } finally {
      setBusy(false);
    }
  }

  const editTotal = editing
    ? editing.order.items.reduce((sum, item) => {
        const qty = editing.quantities[item.id] ?? item.quantity;
        return sum + item.unitPrice * qty;
      }, 0) * (1 + (cafe?.taxRate ?? 0) / 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold">طلبات المنيو في انتظار التأكيد</h1>
          <p className="text-sm text-muted-foreground">
            طلبات العملاء من منيو الـ QR — تحتاج تأكيد قبل ما تروح للتحضير
          </p>
        </div>
        <Badge variant={orders.length > 0 ? "destructive" : "secondary"} className="text-sm">{orders.length}</Badge>
        {canEditSettings && (
          <Button variant="outline" size="sm" className="ms-auto" onClick={() => setSettingsOpen(true)}>
            ⚙️ إعدادات تأكيد طلبات المنيو
          </Button>
        )}
      </div>

      {orders.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          <p className="text-3xl">📱</p>
          <p className="mt-2 text-sm">مفيش طلبات مستنية التأكيد دلوقتي.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-lg font-bold">#{order.orderNumber}</p>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge variant="outline">{t.orderStatus.PENDING_WAITER_APPROVAL}</Badge>
                  <span className="rounded-full bg-blue-500/12 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                    موجه إلى: {assignedLabel(order)}
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {order.tableNumber ? `ترابيزة ${order.tableNumber}` : "من غير ترابيزة"}
                {order.customerName && ` · ${order.customerName}`}
                {" · "}{formatTime(order.createdAt)} · {waitLabel(order.createdAt)}
              </p>
              <ul className="space-y-0.5 border-y py-2 text-sm">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium tabular-nums">{item.quantity}×</span>{" "}
                    {item.productName}
                    {item.variantName && <span className="text-muted-foreground"> ({item.variantName})</span>}
                    {item.notes && <span className="block ps-5 text-xs text-amber-700 dark:text-amber-400">📝 {item.notes}</span>}
                  </li>
                ))}
              </ul>
              {order.notes && <p className="text-xs text-muted-foreground">📝 {order.notes}</p>}
              <div className="flex items-center justify-between pt-1">
                <p className="font-bold tabular-nums">{money(order.total, currency)}</p>
                <div className="flex gap-1">
                  {perms.canApprove && (
                    <Button size="sm" disabled={busy} onClick={() => approve(order)}>تأكيد الطلب</Button>
                  )}
                  {perms.canEdit && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => startEdit(order)}>تعديل</Button>
                  )}
                  {perms.canReject && (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy}
                      onClick={() => { setReason(""); setRejecting(order); }}>رفض</Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Reject dialog ── */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>رفض طلب رقم {rejecting?.orderNumber}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>سبب الرفض *</Label>
            <Textarea rows={2} placeholder="مثلاً: الترابيزة مش موجودة، طلب مكرر، صنف خلص…"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="destructive" disabled={busy || reason.trim().length < 2} onClick={reject}>
              {busy ? "جاري الرفض…" : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog ── */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
          <DialogHeader><DialogTitle>تعديل طلب رقم {editing?.order.orderNumber} قبل التأكيد</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                {editing.order.items.map((item) => {
                  const qty = editing.quantities[item.id] ?? item.quantity;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {item.productName}{item.variantName && <span className="text-muted-foreground"> · {item.variantName}</span>}
                        </p>
                        <p className="text-xs tabular-nums text-muted-foreground">{money(item.unitPrice, currency)}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button variant="outline" size="sm" className="size-7 p-0"
                          onClick={() => setEditing({ ...editing, quantities: { ...editing.quantities, [item.id]: Math.max(0, qty - 1) } })}>−</Button>
                        <span className="w-6 text-center text-sm tabular-nums">{qty}</span>
                        <Button variant="outline" size="sm" className="size-7 p-0"
                          onClick={() => setEditing({ ...editing, quantities: { ...editing.quantities, [item.id]: qty + 1 } })}>+</Button>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">الكمية صفر = حذف الصنف من الطلب</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>رقم الترابيزة</Label>
                  <Input value={editing.tableNumber} onChange={(e) => setEditing({ ...editing, tableNumber: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>اسم العميل</Label>
                  <Input value={editing.customerName} onChange={(e) => setEditing({ ...editing, customerName: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>ملاحظات</Label>
                <Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
              </div>
              <p className="text-sm font-semibold tabular-nums">الإجمالي الجديد تقريباً: {money(editTotal, currency)}</p>
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => saveEditAndApprove(false)} disabled={busy}>حفظ فقط</Button>
            {perms.canApprove && (
              <Button onClick={() => saveEditAndApprove(true)} disabled={busy}>حفظ وتأكيد</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {settingsOpen && (
        <QrApprovalSettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); load(); }} />
      )}
    </div>
  );
}

export { APPROVAL_MODE_LABEL };
