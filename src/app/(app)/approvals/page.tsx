"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OrderItem = {
  id: string;
  productName: string;
  variantName: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
  notes: string | null;
  addOns: { id: string; addOnName: string; price: string }[];
};

type PendingOrder = {
  id: string;
  orderNumber: number;
  status: string;
  source: "QR_MENU" | "WAITER" | "CASHIER_POS";
  customerName: string | null;
  customerPhone: string | null;
  tableNumber: string | null;
  notes: string | null;
  total: string;
  createdAt: string;
  branch: { id: string; name: string };
  items: OrderItem[];
};

type EditState = {
  order: PendingOrder;
  quantities: Record<string, number>;
  tableNumber: string;
  customerName: string;
  notes: string;
};

export default function ApprovalsPage() {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<PendingOrder | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);

  const load = useCallback(async () => {
    try {
      const { orders } = await api<{ orders: PendingOrder[] }>(
        "/api/orders?status=PENDING_WAITER_APPROVAL"
      );
      // Only QR menu orders belong in the approval queue (staff orders
      // are confirmed at creation and never land here anyway).
      setOrders(orders.filter((o) => o.source === "QR_MENU"));
    } catch {
      // polling failure is non-fatal
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function approve(order: PendingOrder) {
    setBusy(true);
    try {
      const { order: approved } = await api<{
        order: { approvedBy: { name: string } | null };
      }>(`/api/orders/${order.id}/approve`, { method: "POST" });
      toast.success(
        `تمت الموافقة على طلب رقم ${order.orderNumber} — راح للمطبخ` +
          (approved.approvedBy
            ? ` · ${t.staffInfo.approvedBy}: ${approved.approvedBy.name}`
            : "")
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشلت الموافقة");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true);
    try {
      await api(`/api/orders/${rejecting.id}/reject`, {
        method: "POST",
        body: { reason },
      });
      toast.success(`اترفض طلب رقم ${rejecting.orderNumber}`);
      setRejecting(null);
      setReason("");
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

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/orders/${editing.order.id}`, {
        method: "PATCH",
        body: {
          tableNumber: editing.tableNumber || null,
          customerName: editing.customerName || null,
          notes: editing.notes || null,
          items: Object.entries(editing.quantities).map(([id, quantity]) => ({
            id,
            quantity,
          })),
        },
      });
      toast.success(`اتعدّل طلب رقم ${editing.order.orderNumber}`);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التعديل");
    } finally {
      setBusy(false);
    }
  }

  // Live total preview while editing (unit price + add-ons per line).
  const editTotal = editing
    ? (() => {
        const subtotal = editing.order.items.reduce((sum, item) => {
          const qty = editing.quantities[item.id] ?? item.quantity;
          const perUnit =
            Number(item.unitPrice) +
            item.addOns.reduce((s, a) => s + Number(a.price), 0);
          return sum + perUnit * qty;
        }, 0);
        return subtotal * (1 + (cafe?.taxRate ?? 0) / 100);
      })()
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t.nav.approvals}</h1>
          <p className="text-sm text-muted-foreground">
            طلبات العملاء من منيو الـ QR — لازم موافقة الويتر قبل ما تروح للمطبخ
          </p>
        </div>
        <Badge variant={orders.length > 0 ? "destructive" : "secondary"} className="text-sm">
          {orders.length}
        </Badge>
      </div>

      {orders.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          <p className="text-3xl">📱</p>
          <p className="mt-2 text-sm">مفيش طلبات مستنية الموافقة دلوقتي.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-lg font-bold">#{order.orderNumber}</p>
                <div className="flex gap-1">
                  <Badge>{t.orderSource[order.source]}</Badge>
                  <Badge variant="outline">
                    {t.orderStatus.PENDING_WAITER_APPROVAL}
                  </Badge>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {order.branch.name}
                {" · "}
                {order.tableNumber ? `ترابيزة ${order.tableNumber}` : "من غير ترابيزة"}
                {order.customerName && ` · ${order.customerName}`}
                {order.customerPhone && (
                  <span dir="ltr"> · {order.customerPhone}</span>
                )}
                {" · "}
                {formatTime(order.createdAt)}
              </p>
              <ul className="space-y-0.5 border-y py-2 text-sm">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium tabular-nums">{item.quantity}×</span>{" "}
                    {item.productName}
                    {item.variantName && (
                      <span className="text-muted-foreground"> ({item.variantName})</span>
                    )}
                    {item.addOns.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {" "}+ {item.addOns.map((a) => a.addOnName).join("، ")}
                      </span>
                    )}
                    {item.notes && (
                      <span className="block ps-5 text-xs text-amber-700 dark:text-amber-400">
                        📝 {item.notes}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {order.notes && (
                <p className="text-xs text-muted-foreground">📝 {order.notes}</p>
              )}
              <div className="flex items-center justify-between pt-1">
                <p className="font-bold tabular-nums">{money(order.total, currency)}</p>
                <div className="flex gap-1">
                  <Button size="sm" disabled={busy} onClick={() => approve(order)}>
                    موافقة
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => startEdit(order)}
                  >
                    تعديل الطلب
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setRejecting(order);
                    }}
                  >
                    رفض
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Reject dialog ─────────────────────────────────────── */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>رفض طلب رقم {rejecting?.orderNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>سبب الرفض *</Label>
            <Textarea
              rows={2}
              placeholder="مثلاً: الترابيزة مش موجودة، طلب مكرر، صنف خلص…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 2}
              onClick={reject}
            >
              {busy ? "جاري الرفض…" : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog ───────────────────────────────────────── */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تعديل طلب رقم {editing?.order.orderNumber}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                {editing.order.items.map((item) => {
                  const qty = editing.quantities[item.id] ?? item.quantity;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {item.productName}
                          {item.variantName && (
                            <span className="text-muted-foreground">
                              {" "}· {item.variantName}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {money(item.unitPrice, currency)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="size-7 p-0"
                          onClick={() =>
                            setEditing({
                              ...editing,
                              quantities: {
                                ...editing.quantities,
                                [item.id]: Math.max(0, qty - 1),
                              },
                            })
                          }
                        >
                          −
                        </Button>
                        <span className="w-6 text-center text-sm tabular-nums">
                          {qty}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="size-7 p-0"
                          onClick={() =>
                            setEditing({
                              ...editing,
                              quantities: {
                                ...editing.quantities,
                                [item.id]: qty + 1,
                              },
                            })
                          }
                        >
                          +
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  الكمية صفر = حذف الصنف من الطلب
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>رقم الترابيزة</Label>
                  <Input
                    value={editing.tableNumber}
                    onChange={(e) =>
                      setEditing({ ...editing, tableNumber: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>اسم العميل</Label>
                  <Input
                    value={editing.customerName}
                    onChange={(e) =>
                      setEditing({ ...editing, customerName: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>ملاحظات</Label>
                <Textarea
                  rows={2}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </div>
              <p className="text-sm font-semibold tabular-nums">
                الإجمالي الجديد تقريباً: {money(editTotal, currency)}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveEdit} disabled={busy}>
              {busy ? "جاري الحفظ…" : "حفظ التعديلات"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
