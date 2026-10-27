"use client";
import {KitchenAmendmentTickets} from '@/components/sales/kitchen-amendment-tickets';

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, money, ApiRequestError } from "@/lib/client";
import { collectOrderPages, type OrderPage } from "@/lib/order-pages-client";
import { t, formatTime } from "@/lib/i18n";
import { isOrderFullyPaid } from "@/lib/order-payments";
import { handledBy } from "@/lib/order-staff";
import { useApp } from "@/components/app-shell";
import { FeatureGate } from "@/components/feature-gate";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─────────────────────────── Types ───────────────────────────

type KitchenItem = {
  id: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  notes: string | null;
  kitchenStatus: string;
  addOns: { id: string; addOnName: string }[];
};

type KitchenOrder = {
  id: string;
  orderNumber: number;
  type: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  source: "QR_MENU" | "WAITER" | "CASHIER_POS";
  status: "CONFIRMED" | "PREPARING" | "READY";
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  tableNumber: string | null;
  notes: string | null;
  total: string;
  createdAt: string;
  approvedAt: string | null;
  preparationStartedAt: string | null;
  readyAt: string | null;
  branch: { id: string; name: string };
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
  items: KitchenItem[];
  payments: { amount: string; status: string }[];
};

type Branch = { id: string; name: string };

const COLUMNS = [
  { status: "CONFIRMED", title: "طلبات جديدة", action: "بدء التحضير", next: "PREPARING" },
  { status: "PREPARING", title: "جاري التحضير", action: "تم التجهيز", next: "READY" },
  { status: "READY", title: "جاهز للتسليم", action: "تم التسليم", next: "SERVED" },
] as const;

// ── Wait time (Arabic plural forms) ───────────────────────────
function waitLabel(minutes: number): string {
  if (minutes < 1) return "دلوقتي";
  if (minutes === 1) return "من دقيقة";
  if (minutes === 2) return "من دقيقتين";
  if (minutes <= 10) return `من ${minutes} دقائق`;
  return `من ${minutes} دقيقة`;
}

function isPaid(order: KitchenOrder): boolean {
  // Collections less refunds — a refund row also carries status PAID, so
  // summing by status alone marked a refunded order as paid (REFUND-005).
  return isOrderFullyPaid({ total: order.total, payments: order.payments });
}

// Short two-tone chime via WebAudio — no asset files needed.
function playChime() {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const play = (freq: number, start: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.4);
    };
    play(880, 0);
    play(1174, 0.18);
    setTimeout(() => ctx.close(), 1200);
  } catch {
    // no audio available — silently skip
  }
}

// ─────────────────────────── Page ───────────────────────────

export default function KitchenPage() {
  const { cafe, user } = useApp();
  const router = useRouter();
  // Whether an unpaid order may be handed over is configuration, resolved per
  // branch and per order type. Without it the screen would keep blocking
  // handover at a café that has chosen to serve first and bill later.
  const [policy, setPolicy] = useState<{
    dineIn: "ALLOW_BEFORE_PAYMENT" | "REQUIRE_PAYMENT_FIRST";
    takeaway: "ALLOW_BEFORE_PAYMENT" | "REQUIRE_PAYMENT_FIRST";
  } | null>(null);
  const currency = cafe?.currency ?? "EGP";

  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [soundOn, setSoundOn] = useState(false);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);
  const [, setTick] = useState(0); // re-render for wait timers
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<KitchenOrder | null>(null);

  const knownIds = useRef<Set<string> | null>(null);
  const soundRef = useRef(false);

  // Persisted sound preference
  useEffect(() => {
    const saved = localStorage.getItem("kitchen-sound") === "1";
    setSoundOn(saved);
    soundRef.current = saved;
  }, []);
  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    soundRef.current = next;
    localStorage.setItem("kitchen-sound", next ? "1" : "0");
    if (next) playChime(); // also unlocks audio on user gesture
  }

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const branchQuery =
        !user.branchId && branchFilter !== "all" ? `&branchId=${branchFilter}` : "";
      const { orders } = await collectOrderPages(cursor => api<OrderPage<KitchenOrder>>(
        `/api/orders?status=CONFIRMED,PREPARING,READY${branchQuery}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")));
      if (version !== loadVersion.current) return;
      // New-order detection for the chime (first load doesn't beep).
      if (knownIds.current) {
        const fresh = orders.filter(
          (o) => o.status === "CONFIRMED" && !knownIds.current!.has(o.id)
        );
        if (fresh.length > 0 && soundRef.current) {
          playChime();
          toast.info(`وصل طلب جديد رقم ${fresh[0].orderNumber} 🔔`);
        }
      }
      knownIds.current = new Set(orders.map((o) => o.id));
      setOrders(orders);
      setLoadError(null);
      setSecondsAgo(0);
    } catch (error) {
      if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : "تعذر تحديث الطلبات");
    }
  }, [branchFilter, user.branchId]);

  useEffect(() => {
    const id = user.branchId ?? (branchFilter !== "all" ? branchFilter : null);
    if (!id) return;
    api<{ policy: { dineIn: "ALLOW_BEFORE_PAYMENT" | "REQUIRE_PAYMENT_FIRST"; takeaway: "ALLOW_BEFORE_PAYMENT" | "REQUIRE_PAYMENT_FIRST" } }>(
      `/api/branches/${id}/serving-policy`
    )
      .then((r) => setPolicy(r.policy))
      .catch(() => setPolicy(null));
  }, [branchFilter, user.branchId]);

  useEffect(() => {
    const versionRef = loadVersion;
    let stopped = false;
    let poll: ReturnType<typeof setTimeout>;
    const refresh = async () => { await load(); if (!stopped) poll = setTimeout(refresh, 7000); };
    poll = setTimeout(refresh, 0);
    // One ticker drives both the "آخر تحديث" counter and wait-time labels.
    const timers = setInterval(() => {
      setSecondsAgo((s) => (s === null ? null : s + 10));
      setTick((n) => n + 1);
    }, 10_000);
    return () => {
      stopped = true;
      clearTimeout(poll);
      versionRef.current++;
      clearInterval(timers);
    };
  }, [load]);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches")
        .then((b) => setBranches(b.branches))
        .catch(() => {});
    }
  }, [user.branchId]);

  // The same recovery /orders offers when serving is refused because the branch's stock custody has no responsible shift:
  // resume the caller's own open shift (POST /api/shifts {resumeOnly}) or, mid-handover, go to the handover page. Nothing is retried automatically.
  async function resumeShiftForCustody(branchId: string) {
    try {
      const result = await api<{ shift: { custodyGateReason: string | null } }>("/api/shifts", {
        method: "POST",
        body: { resumeOnly: true, ...(user.role === "CAFE_OWNER" || user.role === "SUPER_ADMIN" ? { branchId } : {}) },
      });
      if (result.shift.custodyGateReason) throw new Error("الشيفت في انتظار التسليم أو التحقق الافتتاحي — أكمل الإجراءات من صفحة التسليم والاستلام");
      toast.success("تم استئناف الشيفت وربط العهدة — جرّب تسليم الطلب تاني");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل استئناف الشيفت");
    }
  }
  function showCustodyRecovery(e: unknown, branchId: string): boolean {
    if (!(e instanceof ApiRequestError) || !e.payload || typeof e.payload !== "object" || !("code" in e.payload) || e.payload.code !== "STOCK_CUSTODY_REQUIRED") return false;
    const handover = "recovery" in e.payload && e.payload.recovery === "HANDOVER";
    toast.error(e.message, {
      duration: 15_000,
      action: handover
        ? { label: "التسليم والاستلام", onClick: () => router.push("/handovers") }
        : { label: "استئناف الشيفت", onClick: () => void resumeShiftForCustody(branchId) },
    });
    return true;
  }

  async function advance(order: KitchenOrder, next: string) {
    setBusy(true);
    try {
      const result = await api<{ stockDeferred?: boolean }>(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        body: { status: next },
      });
      if (next === "SERVED") {
        toast.success(
          `طلب رقم ${order.orderNumber} اتسلّم ✅`,
          result.stockDeferred ? { description: "المخزون متجمّد للتسليم — الخصم هيتسجّل بعد الاستلام" } : undefined,
        );
      }
      setDetail(null);
      await load();
    } catch (e) {
      if (!showCustodyRecovery(e, order.branch.id)) toast.error(e instanceof Error ? e.message : "فشل تحديث الحالة");
    } finally {
      setBusy(false);
    }
  }

  const filtered = orders.filter(
    (o) =>
      (typeFilter === "all" || o.type === typeFilter) &&
      (sourceFilter === "all" || o.source === sourceFilter)
  );

  // Until the policy loads, keep the stricter behaviour rather than letting
  // an order out that this café would not allow.
  function serveBlockedFor(order: KitchenOrder): boolean {
    const mustPayFirst =
      order.type === "DINE_IN"
        ? policy?.dineIn !== "ALLOW_BEFORE_PAYMENT"
        : order.type === "TAKEAWAY"
          ? policy?.takeaway !== "ALLOW_BEFORE_PAYMENT"
          : true; // delivery is not configurable yet
    return mustPayFirst && !isPaid(order);
  }

  // One request per order, in turn, through the ordinary status route — so
  // every payment, stock and custody rule still applies to each one, and a
  // refusal stops only that order.
  async function serveMany(list: KitchenOrder[], label: string) {
    if (list.length === 0) return;
    setBusy(true);
    const failed: string[] = [];
    let custodyError: { error: unknown; branchId: string } | null = null;
    let served = 0;
    for (const order of list) {
      try {
        await api(`/api/orders/${order.id}/status`, { method: "PATCH", body: { status: "SERVED" } });
        served += 1;
      } catch (e) {
        if (e instanceof ApiRequestError && e.payload && typeof e.payload === "object" && "code" in e.payload && e.payload.code === "STOCK_CUSTODY_REQUIRED") custodyError ??= { error: e, branchId: order.branch.id };
        failed.push(`#${order.orderNumber}: ${e instanceof Error ? e.message : "فشل"}`);
      }
    }
    if (served > 0) toast.success(`${label}: اتقدم ${served} طلب ✅`);
    if (failed.length > 0) toast.error(`متقدمش ${failed.length}: ${failed.join(" · ")}`, { duration: 10_000 });
    if (custodyError) showCustodyRecovery(custodyError.error, custodyError.branchId);
    setDetail(null);
    await load();
    setBusy(false);
  }



  return (
    <FeatureGate feature="kitchenScreenEnabled">
    <div className="space-y-4">
      <KitchenAmendmentTickets/>
      {loadError && <p role="alert" className="text-sm text-destructive">تعذر تحديث المطبخ؛ البيانات المعروضة قديمة: {loadError}</p>}
      {/* ── Header & filters ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">شاشة البار</h1>
          <p className="text-sm text-muted-foreground">
            آخر تحديث:{" "}
            {secondsAgo === null
              ? "…"
              : secondsAgo < 10
                ? "منذ لحظات"
                : `منذ ${secondsAgo} ثانية`}
          </p>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">فلترة الطلبات:</span>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? "all")}>
            <SelectTrigger className="h-10 w-32">
              <SelectValue>
                {typeFilter === "all"
                  ? "كل الأنواع"
                  : t.orderTypes[typeFilter as keyof typeof t.orderTypes]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأنواع</SelectItem>
              <SelectItem value="DINE_IN">صالة</SelectItem>
              <SelectItem value="TAKEAWAY">تيك أواي</SelectItem>
              <SelectItem value="DELIVERY">دليفري</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v ?? "all")}>
            <SelectTrigger className="h-10 w-36">
              <SelectValue>
                {sourceFilter === "all"
                  ? "كل المصادر"
                  : t.orderSource[sourceFilter as keyof typeof t.orderSource]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل المصادر</SelectItem>
              <SelectItem value="QR_MENU">منيو العميل</SelectItem>
              <SelectItem value="WAITER">الويتر</SelectItem>
              <SelectItem value="CASHIER_POS">الكاشير</SelectItem>
            </SelectContent>
          </Select>
          {!user.branchId && branches.length > 1 && (
            <Select value={branchFilter} onValueChange={(v) => setBranchFilter(v ?? "all")}>
              <SelectTrigger className="h-10 w-36">
                <SelectValue>
                  {branchFilter === "all"
                    ? "كل الفروع"
                    : branches.find((b) => b.id === branchFilter)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الفروع</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={soundOn}
              onChange={toggleSound}
            />
            🔔 تنبيه صوتي
          </label>
          <a
            data-testid="open-customer-display"
            href={`/display${!user.branchId && branchFilter !== "all" ? `?branchId=${branchFilter}` : ""}`}
            target="_blank"
            rel="noopener"
            className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            📺 شاشة العملاء
          </a>
        </div>
      </div>

      {/* ── Kanban columns ───────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const colOrders = filtered
            .filter((o) => o.status === col.status)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // oldest first
          const servable = col.status === "READY" ? colOrders.filter((o) => !serveBlockedFor(o)) : [];
          return (
            <div key={col.status} className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3">
                <h2 className="text-lg font-bold">{col.title}</h2>
                <Badge className="text-base tabular-nums">{colOrders.length}</Badge>
                {servable.length > 1 && (
                  <Button
                    size="sm"
                    data-testid="serve-all-ready"
                    className="ms-auto"
                    disabled={busy}
                    onClick={() => serveMany(servable, "قدّم الكل")}
                  >
                    قدّم الكل ({servable.length})
                  </Button>
                )}
              </div>
              {colOrders.length === 0 && (
                <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
                  مفيش طلبات
                </p>
              )}
              {colOrders.map((order) => {
                const waitMins = Math.floor(
                  (Date.now() - new Date(order.createdAt).getTime()) / 60_000
                );
                const late = waitMins >= 15;
                const veryLate = waitMins >= 25;
                const serveBlocked = col.next === "SERVED" && serveBlockedFor(order);
                const sameTable =
                  col.status === "READY" && order.tableNumber
                    ? servable.filter((o) => o.tableNumber === order.tableNumber && o.branch.id === order.branch.id)
                    : [];
                return (
                  <div
                    key={order.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetail(order)}
                    className={cn(
                      "cursor-pointer space-y-2.5 rounded-xl border-2 bg-card p-4 shadow-sm transition-colors hover:border-primary/40",
                      veryLate
                        ? "border-destructive/70"
                        : late
                          ? "border-amber-400/70"
                          : "border-border"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-2xl font-bold tabular-nums">
                        طلب رقم {order.orderNumber}
                      </p>
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-sm font-semibold tabular-nums",
                          veryLate
                            ? "bg-destructive text-destructive-foreground"
                            : late
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                              : "bg-muted text-muted-foreground"
                        )}
                      >
                        ⏱ {waitLabel(waitMins)}
                        {veryLate ? " · متأخر جدًا" : late ? " · متأخر" : ""}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <Badge variant="outline" className="text-sm">
                        {t.orderTypes[order.type]}
                      </Badge>
                      <Badge
                        variant={order.source === "QR_MENU" ? "default" : "secondary"}
                        className="text-sm"
                      >
                        {t.orderSource[order.source]}
                      </Badge>
                      {order.tableNumber && (
                        <Badge variant="outline" className="text-sm">
                          ترابيزة {order.tableNumber}
                        </Badge>
                      )}
                      {order.customerName && (
                        <span className="text-muted-foreground">
                          {order.customerName}
                        </span>
                      )}
                      <span className="ms-auto text-xs text-muted-foreground">
                        {formatTime(order.createdAt)}
                      </span>
                    </div>

                    {(() => {
                      const staff = handledBy(order);
                      return staff ? (
                        <p className="text-xs font-medium text-muted-foreground">
                          👤 {staff.label}: {staff.name}
                        </p>
                      ) : null;
                    })()}

                    <ul className="space-y-1.5 border-y py-2.5">
                      {order.items.map((item) => (
                        <li key={item.id} className="text-lg leading-snug">
                          <span className="font-bold tabular-nums">
                            {item.quantity}×
                          </span>{" "}
                          {item.productName}
                          {item.variantName && (
                            <span className="text-muted-foreground">
                              {" "}({item.variantName})
                            </span>
                          )}
                          {item.addOns.length > 0 && (
                            <span className="block ps-6 text-sm text-muted-foreground">
                              + {item.addOns.map((a) => a.addOnName).join("، ")}
                            </span>
                          )}
                          {item.notes && (
                            <span className="block ps-6 text-sm font-medium text-amber-700 dark:text-amber-400">
                              📝 {item.notes}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {order.notes && (
                      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                        📝 ملاحظات: {order.notes}
                      </p>
                    )}

                    <Button
                      size="lg"
                      className="h-13 w-full text-lg font-bold"
                      disabled={busy || serveBlocked}
                      onClick={(e) => {
                        e.stopPropagation();
                        advance(order, col.next);
                      }}
                    >
                      {col.action}
                    </Button>
                    {sameTable.length > 1 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          serveMany(sameTable, `ترابيزة ${order.tableNumber}`);
                        }}
                      >
                        قدّم كل طلبات ترابيزة {order.tableNumber} ({sameTable.length})
                      </Button>
                    )}
                    {serveBlocked && (
                      <div className="space-y-1.5">
                        <p className="text-center text-xs text-destructive">
                          {t.servingPolicy.mustCollectFirst}
                        </p>
                        {/* The way forward, not just the refusal: this opens
                            the POS already pointed at this order. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/pos?collectOrderId=${order.id}`);
                          }}
                        >
                          💵 {t.servingPolicy.collectNow}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Details modal ────────────────────────────────────── */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[88vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تفاصيل الطلب — رقم {detail?.orderNumber}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{t.orderTypes[detail.type]}</Badge>
                <Badge variant="secondary">{t.orderSource[detail.source]}</Badge>
                <Badge>{t.orderStatus[detail.status]}</Badge>
                {detail.tableNumber && (
                  <Badge variant="outline">ترابيزة {detail.tableNumber}</Badge>
                )}
                <Badge variant={isPaid(detail) ? "default" : "destructive"}>
                  {isPaid(detail) ? "مدفوع" : "لسه متدفعش"}
                </Badge>
              </div>

              {(detail.customerName || detail.customerPhone || detail.deliveryAddress) && (
                <div className="rounded-md border p-3 text-sm">
                  {detail.customerName && <p>العميل: {detail.customerName}</p>}
                  {detail.customerPhone && (
                    <p>
                      رقم الموبايل: <span dir="ltr">{detail.customerPhone}</span>
                    </p>
                  )}
                  {detail.deliveryAddress && <p>العنوان: {detail.deliveryAddress}</p>}
                </div>
              )}

              {/* بيانات الموظف */}
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p className="mb-1.5 font-semibold">{t.staffInfo.section}</p>
                <p>
                  {t.staffInfo.sourceLabel}: {t.orderSource[detail.source]}
                </p>
                <p>
                  {t.staffInfo.createdBy}: {detail.createdBy?.name ?? "العميل (منيو QR)"}
                </p>
                {detail.approvedBy && (
                  <p>
                    {t.staffInfo.approvedBy}: {detail.approvedBy.name}
                  </p>
                )}
                {detail.approvedAt && (
                  <p>
                    {t.staffInfo.approvedAt}: {formatTime(detail.approvedAt)}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="font-semibold">المنتجات</p>
                {detail.items.map((item) => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>
                      {item.quantity}× {item.productName}
                      {item.variantName && ` (${item.variantName})`}
                      {item.addOns.length > 0 &&
                        ` + ${item.addOns.map((a) => a.addOnName).join("، ")}`}
                      {item.notes && (
                        <span className="block ps-4 text-xs text-amber-700 dark:text-amber-400">
                          📝 {item.notes}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">{money(item.lineTotal, currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-2 font-bold">
                  <span>الإجمالي</span>
                  <span className="tabular-nums">{money(detail.total, currency)}</span>
                </div>
              </div>

              {/* Status timeline */}
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-semibold">سجل حالة الطلب</p>
                <p>وقت الطلب: {formatTime(detail.createdAt)}</p>
                {detail.approvedAt && (
                  <p>موافقة الويتر: {formatTime(detail.approvedAt)}</p>
                )}
                {detail.preparationStartedAt && (
                  <p>بدء التحضير: {formatTime(detail.preparationStartedAt)}</p>
                )}
                {detail.readyAt && <p>جاهز: {formatTime(detail.readyAt)}</p>}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDetail(null)}>
              إغلاق
            </Button>
            {detail && (
              <Button
                disabled={
                  busy ||
                  (detail.status === "READY" && !isPaid(detail))
                }
                onClick={() =>
                  advance(
                    detail,
                    COLUMNS.find((c) => c.status === detail.status)!.next
                  )
                }
              >
                تحديث الحالة —{" "}
                {COLUMNS.find((c) => c.status === detail.status)!.action}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </FeatureGate>
  );
}
