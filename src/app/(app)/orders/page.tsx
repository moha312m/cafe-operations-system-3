"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, money, ApiRequestError } from "@/lib/client";
import { collectOrderPages, type OrderPage } from "@/lib/order-pages-client";
import { t, formatTime } from "@/lib/i18n";
import { collectedAmount } from "@/lib/order-payments";
import { handledBy } from "@/lib/order-staff";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  quantity: number;
  lineTotal: string;
  notes: string | null;
  addOns: { id: string; addOnName: string }[];
  voidedAt: string | null;
  voidedBy: { id: string; name: string } | null;
  voidReason: string | null;
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
  paymentStatus: "UNPAID" | "PENDING_COLLECTION" | "PARTIAL" | "PAID" | "REFUNDED" | "CANCELLED";
  createdAt: string;
  branch: { id: string; name: string };
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
  approvedAt: string | null;
  items: OrderItem[];
  payments: Payment[];
  handoverCarries?: {
    createdAt: string;
    statusAtHandover: Order["status"];
    shift: { shiftNumber: number; cashier: { name: string } };
  }[];
  deferredStockDeduction?: { servedAt: string; appliedAt: string | null } | null;
};

function carriedFrom(order: Order) {
  return order.handoverCarries?.[0] ?? null;
}

function stockPending(order: Order) {
  return order.deferredStockDeduction != null && order.deferredStockDeduction.appliedAt === null;
}

const COLUMNS = [
  { status: "CONFIRMED", label: t.orderStatus.CONFIRMED, next: "PREPARING", nextLabel: "ابدأ التحضير" },
  { status: "PREPARING", label: t.orderStatus.PREPARING, next: "READY", nextLabel: "جاهز" },
  { status: "READY", label: t.orderStatus.READY, next: "SERVED", nextLabel: "تسليم" },
] as const;

function paidAmount(order: Order): number {
  // Collections less refunds — see @/lib/order-payments (REFUND-005).
  return collectedAmount(order.payments);
}

export default function OrdersPage() {
  const router = useRouter();
  const { cafe, can, user } = useApp();
  const currency = cafe?.currency ?? "USD";
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [historyPages, setHistoryPages] = useState(1);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const loadVersion = useRef(0);
  const [detail, setDetail] = useState<Order | null>(null);
  const [custodyNotice, setCustodyNotice] = useState<{ branchId: string; branchName: string; message: string; recovery: "RESUME_SHIFT" | "HANDOVER" } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoadingOrders(true);
    const source = sourceFilter === "all" ? "" : `&source=${sourceFilter}`;
    const read = (url: string) => (cursor: string | null) => api<OrderPage<Order>>(
      url + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    try {
      const [live, history] = await Promise.all([
        collectOrderPages(read(`/api/orders?status=CONFIRMED,PREPARING,READY${source}`)),
        collectOrderPages(read(`/api/orders?status=SERVED,CANCELLED&pageSize=50${source}`), historyPages, true),
      ]);
      if (version !== loadVersion.current) return;
      setOrders([...live.orders, ...history.orders]);
      setHasMoreHistory(history.pageInfo.hasMore);
      setLoadError(null);
    } catch (error) {
      if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : "تعذر تحديث الطلبات");
    } finally {
      if (version === loadVersion.current) setLoadingOrders(false);
    }
  }, [sourceFilter, historyPages]);

  useEffect(() => {
    const versionRef = loadVersion;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => { await load(); if (!stopped) timer = setTimeout(refresh, 5000); };
    timer = setTimeout(refresh, 0);
    return () => { stopped = true; clearTimeout(timer); versionRef.current++; };
  }, [load]);

  async function setStatus(order: Order, status: string, reason?: string) {
    setBusy(true);
    try {
      const result = await api<{ stockDeferred?: boolean; request?: { id: string; status: string } }>(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        body: { status, ...(reason ? { reason } : {}) },
      });
      if (status === "CANCELLED" && result.request) toast.success("تم إرسال طلب الإلغاء للمالك؛ الطلب لسه قائم لحد الموافقة والتنفيذ");
      if (result.stockDeferred) toast.info("اتسلّم ✓ — المخزون متجمّد للتسليم، والخصم هيتسجّل بعد الاستلام");
      await load();
    } catch (e) {
      if (e instanceof ApiRequestError && e.payload && typeof e.payload === "object" &&
          "code" in e.payload && e.payload.code === "STOCK_CUSTODY_REQUIRED") {
        const recovery = "recovery" in e.payload && e.payload.recovery === "HANDOVER" ? "HANDOVER" : "RESUME_SHIFT";
        setCustodyNotice({ branchId: order.branch.id, branchName: order.branch.name, message: e.message, recovery });
      } else toast.error(e instanceof Error ? e.message : "فشل تحديث الطلب");
    } finally {
      setBusy(false);
    }
  }

  async function requestItemVoid(order: Order, item: OrderItem) {
    const reason = window.prompt(`سبب طلب حذف ${item.productName} من الطلب #${order.orderNumber}:`)?.trim();
    if (!reason || reason.length < 3) return;
    setBusy(true);
    try {
      await api("/api/owner-action-requests", { method: "POST", body: {
        action: "VOID_ORDER_ITEM", orderId: order.id, orderItemId: item.id,
        reason, idempotencyKey: crypto.randomUUID(),
      } });
      toast.success("تم إرسال طلب حذف الصنف للمالك؛ الصنف ما زال ضمن الطلب حتى الموافقة والتنفيذ");
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر إرسال طلب حذف الصنف"); }
    finally { setBusy(false); }
  }

  async function resumeCustody() {
    if (!custodyNotice) return;
    setBusy(true);
    try {
      const result = await api<{ shift: { branchId: string; custodyGateReason: string | null } }>("/api/shifts", {
        method: "POST", body: { resumeOnly: true,
          ...(user.role === "CAFE_OWNER" || user.role === "SUPER_ADMIN" ? { branchId: custodyNotice.branchId } : {}),
        },
      });
      if (result.shift.branchId !== custodyNotice.branchId) {
        router.refresh();
        throw new Error("تم تغيير فرعك — حدّث الصفحة وراجع الطلب في فرعه");
      }
      if (result.shift.custodyGateReason) throw new Error("الشيفت في انتظار التسليم أو التحقق الافتتاحي — أكمل الإجراءات من صفحة التسليم والاستلام");
      setCustodyNotice(null);
      toast.success("تم استئناف الشيفت وربط العهدة — تقدر تسلّم الطلب الآن");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "فشل استئناف الشيفت");
    } finally { setBusy(false); }
  }

  // NOTE: money collection moved to the POS cashier screen — this page
  // only shows payment status and deep-links into /pos?collectOrderId=…

  const finished = orders
    .filter((o) => (o.status === "SERVED" || o.status === "CANCELLED") &&
      (sourceFilter === "all" || o.source === sourceFilter));

  return (
    <div className="space-y-4">
      <Dialog open={custodyNotice !== null} onOpenChange={(open) => !busy && !open && setCustodyNotice(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>استكمال العهدة قبل تسليم الطلب</DialogTitle></DialogHeader>
          <p className="text-sm">{custodyNotice?.message}</p>
          <p className="text-sm text-muted-foreground">الفرع: {custodyNotice?.branchName}</p>
          <DialogFooter>
            {custodyNotice?.recovery === "RESUME_SHIFT" && can("shifts:operate") && (
              <Button disabled={busy} onClick={() => void resumeCustody()}>استئناف شيفتي</Button>
            )}
            {can("shifts:operate") && <Button variant="outline" disabled={busy} onClick={() => router.push(custodyNotice?.recovery === "HANDOVER" ? "/handovers" : "/pos")}>
              {custodyNotice?.recovery === "HANDOVER" ? "التسليم والاستلام" : "فتح الشيفت من نقطة البيع"}
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !busy && !open && setCancelTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>طلب إلغاء الطلب #{cancelTarget?.orderNumber}</DialogTitle></DialogHeader>
          <div className="space-y-2"><Label htmlFor="cancel-order-reason">سبب الإلغاء *</Label><Textarea id="cancel-order-reason" rows={3} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="اكتب سبب الإلغاء" /></div>
          <p className="text-xs text-muted-foreground">سيظهر الطلب للمالك للموافقة أو الرفض، ولن يتغير وضعه قبل التنفيذ.</p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCancelTarget(null)}>رجوع</Button>
            <Button variant="destructive" disabled={busy || cancelReason.trim().length < 3 || !cancelTarget} onClick={async () => {
              if (!cancelTarget) return;
              const target = cancelTarget;
              await setStatus(target, "CANCELLED", cancelReason.trim());
              setCancelTarget(null); setCancelReason("");
            }}>إرسال طلب الإلغاء</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
              onClick={() => { setHistoryPages(1); setSourceFilter(f.value); }}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {loadError && <p role="alert" className="text-sm text-destructive">تعذر تحديث الطلبات؛ البيانات المعروضة قديمة: {loadError}</p>}
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
                const carry = carriedFrom(order);
                return (
                  <Card key={order.id} className={carry ? "border-amber-400 dark:border-amber-600" : undefined}>
                    <CardContent className="space-y-2 p-3">
                      {carry && (
                        <p
                          data-testid="carried-order-badge"
                          className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          📥 مستلم من شيفت #{carry.shift.shiftNumber} ({carry.shift.cashier.name}) · كان {t.orderStatus[carry.statusAtHandover]}
                        </p>
                      )}
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
                          <Badge
                            variant={
                              order.paymentStatus === "PAID"
                                ? "default"
                                : order.paymentStatus === "PARTIAL"
                                  ? "secondary"
                                  : order.paymentStatus === "PENDING_COLLECTION"
                                    ? "outline"
                                    : "destructive"
                            }
                          >
                            {t.paymentStatus[order.paymentStatus] ?? "غير مدفوع"}
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
                          {/* التحصيل يتم من شاشة الكاشير فقط — navigate with context */}
                          {!isPaid && can("payments:create") && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => router.push(`/pos?collectOrderId=${order.id}`)}
                            >
                              💵 تحصيل من الكاشير
                            </Button>
                          )}
                          {can("orders:cancel") &&
                            (order.status === "CONFIRMED" || order.status === "PREPARING") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => { setCancelTarget(order); setCancelReason(""); }}
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
        <section aria-labelledby="order-history-heading" className="space-y-2">
          <h2 id="order-history-heading" className="font-medium text-muted-foreground">اتخلصوا قريب</h2>
          <ul className="flex flex-wrap gap-2">
            {finished.map((order) => (
              <li key={order.id} className="min-w-0 max-w-full">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-9 max-w-full flex-wrap whitespace-normal py-2 text-start"
                  aria-haspopup="dialog"
                  onClick={() => setDetail(order)}
                >
                  <span className="sr-only">عرض تفاصيل الطلب </span>
                  {carriedFrom(order) && "📥 "}
                  #{order.orderNumber} · {t.orderStatus[order.status]} ·{" "}
                  {money(order.total, currency)}
                  {stockPending(order) && (
                    <span data-testid="stock-pending-badge" className="ms-1 text-amber-700 dark:text-amber-400">
                      · المخزون يتخصم بعد الاستلام
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* تفاصيل الطلب + بيانات الموظف */}
      {hasMoreHistory && <Button variant="outline" disabled={loadingOrders}
        onClick={() => setHistoryPages(pages => pages + 1)}>عرض طلبات أقدم</Button>}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-md" scrollable>
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

                {(() => {
                  const carry = carriedFrom(detail);
                  return carry ? (
                    <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      📥 الأوردر ده اترحّل من شيفت #{carry.shift.shiftNumber} ({carry.shift.cashier.name}) وقت التسليم
                      {" "}({formatTime(carry.createdAt)})، وكان وقتها {t.orderStatus[carry.statusAtHandover]}.
                    </p>
                  ) : null;
                })()}
                {stockPending(detail) && (
                  <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                    اتسلّم والمخزون متجمّد للتسليم — الخصم هيتسجّل تلقائيًا على عهدة المستلم أول ما الاستلام يكتمل.
                  </p>
                )}

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
                      {item.voidedAt ? <span className="ms-2 text-xs text-muted-foreground">ملغي بموافقة المالك بواسطة {item.voidedBy?.name ?? "موظف"} — {item.voidReason}</span>
                        : can("orders:cancel") && (detail.status === "CONFIRMED" || detail.status === "PREPARING") && <Button className="ms-2 h-7" size="sm" variant="outline" disabled={busy} onClick={() => void requestItemVoid(detail, item)}>طلب حذف الصنف</Button>}
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

    </div>
  );
}
