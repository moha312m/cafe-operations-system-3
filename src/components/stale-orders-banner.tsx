"use client";

// Orders left unserved or unpaid for longer than the owner's threshold, with
// the way out beside each one. Every action goes through the ordinary order
// routes, so the same payment, stock and custody rules apply as anywhere else.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, money } from "@/lib/client";

type StaleAction = "SERVE" | "CANCEL" | "APPROVE" | "COLLECT";
type StaleOrder = {
  id: string;
  orderNumber: number;
  branchName: string;
  status: string;
  tableNumber: string | null;
  remaining: number;
  since: string;
  actions: StaleAction[];
};
type Summary = { staleHours: number; stale: StaleOrder[]; staleCount: number };

const DISMISS_KEY = "stale-orders-banner-dismissed";
const STATUS_AR: Record<string, string> = {
  PENDING_WAITER_APPROVAL: "مستني موافقة",
  CONFIRMED: "مؤكد ومتبدأش",
  PREPARING: "بيتحضر",
  READY: "جاهز ومتقدمش",
  SERVED: "اتقدم ومتحصّلش",
};

function ageLabel(since: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60_000));
  if (mins < 60) return `من ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `من ${hours} ساعة`;
  return `من ${Math.floor(hours / 24)} يوم`;
}

const signature = (s: Summary) => s.stale.map((o) => `${o.id}:${o.status}`).join("|") + `#${s.staleCount}`;

export function StaleOrdersBanner({
  pathname,
  showBranch,
  currency,
}: {
  pathname: string;
  showBranch: boolean;
  currency: string;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/orders/open-summary", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Summary>) : null))
        .then((d) => {
          setSummary(d);
          setDismissed(sessionStorage.getItem(DISMISS_KEY));
        })
        .catch(() => {}),
    []
  );

  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (!stop) load();
    };
    tick();
    const timer = setInterval(tick, 60_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [load, pathname]);

  async function act(order: StaleOrder, status: "SERVED" | "CANCELLED") {
    if (status === "CANCELLED" && !window.confirm(`متأكد إنك عايز تلغي الطلب #${order.orderNumber}؟`)) return;
    const reason = status === "CANCELLED" ? window.prompt("اكتب سبب طلب الإلغاء (٣ أحرف على الأقل):")?.trim() : undefined;
    if (status === "CANCELLED" && (!reason || reason.length < 3)) return;
    setBusyId(order.id);
    try {
      await api(`/api/orders/${order.id}/status`, { method: "PATCH", body: { status, ...(reason ? { reason } : {}) } });
      toast.success(status === "SERVED" ? `الطلب #${order.orderNumber} اتقدم` : `تم إرسال طلب إلغاء #${order.orderNumber} للمالك؛ الطلب ما زال قائمًا حتى الموافقة والتنفيذ`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحديث الطلب");
    } finally {
      setBusyId(null);
    }
  }

  if (!summary || summary.staleCount === 0) return null;
  const sig = signature(summary);
  if (dismissed === sig) return null;

  return (
    <div
      role="alert"
      data-testid="stale-orders-banner"
      className="mb-6 rounded-xl border-2 border-orange-300 bg-orange-50 p-4 text-sm text-orange-950 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-100"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">
          ⏰ في {summary.staleCount} أوردر منسي بقاله أكتر من {summary.staleHours} ساعة
        </span>
        <span className="flex-1" />
        <button type="button" className="font-medium underline underline-offset-2" onClick={() => setOpen((v) => !v)}>
          {open ? "إخفاء القائمة" : "اعرض وحلّها"}
        </button>
        <button
          type="button"
          className="text-xs opacity-70 hover:opacity-100"
          onClick={() => {
            sessionStorage.setItem(DISMISS_KEY, sig);
            setDismissed(sig);
          }}
        >
          إخفاء
        </button>
      </div>

      {open && (
        <ul className="mt-3 space-y-1.5">
          {summary.stale.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-xs">
              <span className="font-semibold">#{o.orderNumber}</span>
              {showBranch && <span className="opacity-70">({o.branchName})</span>}
              {o.tableNumber && <span>ترابيزة {o.tableNumber}</span>}
              <span>{STATUS_AR[o.status] ?? o.status}</span>
              <span className="opacity-70">{ageLabel(o.since)}</span>
              {o.remaining > 0 && <span>باقي {money(o.remaining, currency)}</span>}
              <span className="flex-1" />
              {o.actions.includes("SERVE") && (
                <button
                  type="button"
                  disabled={busyId !== null}
                  className="rounded-md bg-emerald-600 px-2 py-1 font-medium text-white disabled:opacity-50"
                  onClick={() => act(o, "SERVED")}
                >
                  اتقدم
                </button>
              )}
              {o.actions.includes("CANCEL") && (
                <button
                  type="button"
                  disabled={busyId !== null}
                  className="rounded-md border border-red-400 px-2 py-1 font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
                  onClick={() => act(o, "CANCELLED")}
                >
                  اتلغى
                </button>
              )}
              {o.actions.includes("APPROVE") && (
                <Link href="/approvals" className="rounded-md border px-2 py-1 font-medium">
                  راجع الموافقة
                </Link>
              )}
              {o.actions.includes("COLLECT") && (
                <Link href={`/pos?collectOrderId=${o.id}`} className="rounded-md border px-2 py-1 font-medium">
                  حصّل
                </Link>
              )}
            </li>
          ))}
          {summary.staleCount > summary.stale.length && (
            <li className="text-xs opacity-70">و{summary.staleCount - summary.stale.length} غيرهم في صفحة الطلبات</li>
          )}
        </ul>
      )}
    </div>
  );
}
