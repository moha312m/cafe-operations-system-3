"use client";

// Orders the previous shift handed over that still need serving or
// collecting. Shown to the shift on duty so nothing passed across a handover
// is forgotten; it disappears once every carried order is served and paid.

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, money } from "@/lib/client";

type CarriedOrder = {
  orderId: string;
  orderNumber: number;
  status: string;
  paymentStatus: string;
  remaining: number;
  tableNumber: string | null;
  fromShiftNumber: number;
  fromCashier: string;
};

const STATUS_AR: Record<string, string> = {
  PENDING_WAITER_APPROVAL: "مستني موافقة",
  CONFIRMED: "مؤكد",
  PREPARING: "بيتحضر",
  READY: "جاهز للتقديم",
  SERVED: "اتقدم",
};

export function CarriedOrdersStrip({ branchId, currency }: { branchId: string; currency: string }) {
  const [orders, setOrders] = useState<CarriedOrder[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<{ orders: CarriedOrder[] }>(`/api/handovers/carried-orders?branchId=${branchId}`)
        .then((r) => {
          if (!cancelled) setOrders(r.orders);
        })
        .catch(() => {
          /* informational only — the orders page remains the source of truth */
        });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [branchId]);

  if (orders.length === 0) return null;
  const unpaid = orders.reduce((s, o) => s + o.remaining, 0);

  return (
    <div
      data-testid="carried-orders-strip"
      className="space-y-1.5 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sky-800 dark:text-sky-300">
          📥 أوردرات مستلمة من الشيفت اللي قبلك ({orders.length})
        </span>
        {unpaid > 0 && (
          <span className="text-xs text-sky-900 dark:text-sky-200">
            مطلوب تحصيل {money(unpaid, currency)}
          </span>
        )}
        <Link href="/orders" className="ms-auto text-xs font-medium text-sky-700 underline dark:text-sky-300">
          افتح الطلبات
        </Link>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {orders.map((o) => (
          <li
            key={o.orderId}
            className="rounded-md border border-sky-500/30 bg-background/70 px-2 py-0.5 text-xs"
            title={`من شيفت #${o.fromShiftNumber} · ${o.fromCashier}`}
          >
            #{o.orderNumber}
            {o.tableNumber ? ` · ترابيزة ${o.tableNumber}` : ""}
            {" · "}
            {STATUS_AR[o.status] ?? o.status}
            {o.remaining > 0 ? ` · باقي ${money(o.remaining, currency)}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
