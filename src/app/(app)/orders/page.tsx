"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatTime } from "@/lib/i18n";
import { handledBy } from "@/lib/order-staff";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  quantity: number;
  lineTotal: string;
  notes: string | null;
  addOns: { id: string; addOnName: string }[];
};
type Payment = { id: string; amount: string; status: string };
type Order = {
  id: string;
  orderNumber: number;
  type: string;
  source: "QR_MENU" | "WAITER" | "CASHIER_POS";
  status:
    | "PENDING_WAITER_APPROVAL"
    | "CONFIRMED"
    | "PREPARING"
    | "READY"
    | "SERVED"
    | "CANCELLED"
    | "REJECTED";
  customerName: string | null;
  tableNumber: string | null;
  total: string;
  createdAt: string;
  branch: { id: string; name: string };
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
  approvedAt: string | null;
  items: OrderItem[];
  payments: Payment[];
};

const COLUMNS = [
  { status: "CONFIRMED", label: t.orderStatus.CONFIRMED, next: "PREPARING", nextLabel: "ابدأ التحضير" },
  { status: "PREPARING", label: t.orderStatus.PREPARING, next: "READY", nextLabel: "جاهز" },
  { status: "READY", label: t.orderStatus.READY, next: "SERVED", nextLabel: "تسليم" },
] as const;

function paidAmount(order: Order): number {
  return order.payments
    .filter((p) => p.status === "PAID")
    .reduce((s, p) => s + Number(p.amount), 0);
}

export default function OrdersPage() {
  const { cafe, can } = useApp();
  const currency = cafe?.currency ?? "USD";
  const [orders, setOrders] = useState<Order[]>([]);
  const [paying, setPaying] = useState<Order | null>(null);
  const [payMethod, setPayMethod] = useState("CASH");
  const [busy, setBusy] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [detail, setDetail] = useState<Order | null>(null);

  const load = useCallback(async () => {
    try {
      const { orders } = await api<{ orders: Order[] }>("/api/orders");
      setOrders(orders);
    } catch {
      // polling failure is non-fatal; next tick retries
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function setStatus(order: Order, status: string) {
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        body: { status },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحديث الطلب");
    } finally {
      setBusy(false);
    }
  }

  async function recordPayment() {
    if (!paying) return;
    setBusy(true);
    try {
      const remaining = Number(paying.total) - paidAmount(paying);
      await api("/api/payments", {
        method: "POST",
        body: { orderId: paying.id, amount: remaining, method: payMethod },
      });
      toast.success(`اتحصّلت فلوس طلب رقم ${paying.orderNumber}`);
      setPaying(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تسجيل الدفع");
    } finally {
      setBusy(false);
    }
  }

  const finished = orders
    .filter((o) => o.status === "SERVED" || o.status === "CANCELLED")
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{t.nav.orders}</h1>
          <p className="text-sm text-muted-foreground">
            شاشة مباشرة — بتتحدث كل ٥ ثواني
          </p>
        </div>
        {/* فلتر مصدر الطلب / الموظف */}
        <div className="flex gap-1">
          {[
            { value: "all", label: t.staffInfo.allStaff },
            { value: "WAITER", label: t.orderSource.WAITER },
            { value: "CASHIER_POS", label: t.orderSource.CASHIER_POS },
            { value: "QR_MENU", label: t.orderSource.QR_MENU },
          ].map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={sourceFilter === f.value ? "default" : "outline"}
              onClick={() => setSourceFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const colOrders = orders.filter(
            (o) =>
              o.status === col.status &&
              (sourceFilter === "all" || o.source === sourceFilter)
          );
          return (
            <div key={col.status} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{col.label}</h2>
                <Badge variant="secondary">{colOrders.length}</Badge>
              </div>
              {colOrders.length === 0 && (
                <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  مفيش طلبات
                </p>
              )}
              {colOrders.map((order) => {
                const paid = paidAmount(order);
                const isPaid = paid + 0.001 >= Number(order.total);
                return (
                  <Card key={order.id}>
                    <CardContent className="space-y-2 p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold">#{order.orderNumber}</p>
                        <div className="flex gap-1">
                          <Badge variant="outline">
                            {t.orderTypes[order.type as keyof typeof t.orderTypes] ?? order.type}
                          </Badge>
                          <Badge
                            variant={order.source === "QR_MENU" ? "default" : "secondary"}
                          >
                            {t.orderSource[order.source]}
                          </Badge>
                          <Badge variant="outline">{t.orderStatus[order.status]}</Badge>
                          <Badge variant={isPaid ? "default" : "destructive"}>
                            {isPaid ? "مدفوع" : "لسه متدفعش"}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {order.branch.name}
                        {order.tableNumber && ` · ترابيزة ${order.tableNumber}`}
                        {order.customerName && ` · ${order.customerName}`}
                        {" · "}
                        {formatTime(order.createdAt)}
                      </p>
                      {(() => {
                        const staff = handledBy(order);
                        return staff ? (
                          <p className="text-xs font-medium text-primary">
                            👤 {staff.label}: {staff.name}
                          </p>
                        ) : null;
                      })()}
                      <ul className="space-y-0.5 text-sm">
                        {order.items.map((item) => (
                          <li key={item.id}>
                            <span className="font-medium tabular-nums">
                              {item.quantity}×
                            </span>{" "}
                            {item.productName}
                            {item.variantName && (
                              <span className="text-muted-foreground">
                                {" "}({item.variantName})
                              </span>
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
                      <div className="flex items-center justify-between border-t pt-2">
                        <p className="text-sm font-semibold tabular-nums">
                          {money(order.total, currency)}
                        </p>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDetail(order)}
                          >
                            تفاصيل
                          </Button>
                          {!isPaid && can("payments:create") && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                setPayMethod("CASH");
                                setPaying(order);
                              }}
                            >
                              تحصيل
                            </Button>
                          )}
                          {can("orders:cancel") &&
                            (order.status === "CONFIRMED" || order.status === "PREPARING") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => setStatus(order, "CANCELLED")}
                              >
                                إلغاء
                              </Button>
                            )}
                          <Button
                            size="sm"
                            disabled={busy || (col.next === "SERVED" && !isPaid)}
                            onClick={() => setStatus(order, col.next)}
                          >
                            {col.nextLabel}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          );
        })}
      </div>

      {finished.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-muted-foreground">اتخلصوا قريب</h2>
          <div className="flex flex-wrap gap-2">
            {finished.map((order) => (
              <Badge
                key={order.id}
                variant={order.status === "SERVED" ? "secondary" : "outline"}
              >
                #{order.orderNumber} · {t.orderStatus[order.status]} ·{" "}
                {money(order.total, currency)}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* تفاصيل الطلب + بيانات الموظف */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-md">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>طلب رقم {detail.orderNumber}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary">{t.orderSource[detail.source]}</Badge>
                  <Badge variant="outline">{t.orderStatus[detail.status]}</Badge>
                  {detail.tableNumber && (
                    <Badge variant="outline">ترابيزة {detail.tableNumber}</Badge>
                  )}
                </div>

                <div className="rounded-lg border bg-muted/30 p-3">
                  <h3 className="mb-2 font-semibold">{t.staffInfo.section}</h3>
                  <dl className="space-y-1.5">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">{t.staffInfo.sourceLabel}</dt>
                      <dd>{t.orderSource[detail.source]}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">{t.staffInfo.createdBy}</dt>
                      <dd>{detail.createdBy?.name ?? "العميل (منيو QR)"}</dd>
                    </div>
                    {detail.approvedBy && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">{t.staffInfo.approvedBy}</dt>
                        <dd>{detail.approvedBy.name}</dd>
                      </div>
                    )}
                    {detail.approvedAt && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">{t.staffInfo.approvedAt}</dt>
                        <dd>{formatTime(detail.approvedAt)}</dd>
                      </div>
                    )}
                  </dl>
                </div>

                <ul className="space-y-0.5">
                  {detail.items.map((item) => (
                    <li key={item.id}>
                      <span className="font-medium tabular-nums">{item.quantity}×</span>{" "}
                      {item.productName}
                      {item.variantName && (
                        <span className="text-muted-foreground"> ({item.variantName})</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="border-t pt-2 font-semibold tabular-nums">
                  {money(detail.total, currency)}
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={paying !== null} onOpenChange={(o) => !o && setPaying(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>تحصيل — طلب رقم {paying?.orderNumber}</DialogTitle>
          </DialogHeader>
          {paying && (
            <div className="space-y-4">
              <p className="text-center text-3xl font-semibold tabular-nums">
                {money(Number(paying.total) - paidAmount(paying), currency)}
              </p>
              <div className="flex gap-2">
                {(["CASH", "CARD", "WALLET"] as const).map((m) => (
                  <Button
                    key={m}
                    variant={payMethod === m ? "default" : "outline"}
                    className="flex-1"
                    onClick={() => setPayMethod(m)}
                  >
                    {t.paymentMethods[m]}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={recordPayment} disabled={busy}>
              {busy ? "جاري التسجيل…" : "تسجيل الدفع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
