"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { InventoryUnit } from "@prisma/client";
import { UNIT_LABEL } from "@/lib/inventory";
import { cn } from "@/lib/utils";

type AlertItem = {
  id: string;
  name: string;
  unit: InventoryUnit;
  branchName: string;
  stock: number;
  threshold: number;
  status: "low" | "out";
};
type Alerts = { outCount: number; lowCount: number; items: AlertItem[] };

const DISMISS_KEY = "low-stock-banner-dismissed";
const fmt = (n: number) => Number(n.toFixed(3)).toString();

// Hidden only until the set of flagged items or their status changes, so a
// newly low ingredient always reappears even after the banner was dismissed.
const signature = (a: Alerts) =>
  a.items.map((i) => `${i.id}:${i.status}`).join("|") + `#${a.outCount}:${a.lowCount}`;

export function LowStockBanner({ pathname, showBranch }: { pathname: string; showBranch: boolean }) {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = () =>
      fetch("/api/inventory/alerts", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Alerts>) : null))
        .then((d) => {
          if (stop) return;
          setAlerts(d);
          setDismissed(sessionStorage.getItem(DISMISS_KEY));
        })
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 60_000);
    return () => { stop = true; clearInterval(timer); };
  }, [pathname]);

  if (!alerts || alerts.outCount + alerts.lowCount === 0) return null;
  const sig = signature(alerts);
  if (dismissed === sig) return null;

  const urgent = alerts.outCount > 0;
  const total = alerts.outCount + alerts.lowCount;

  return (
    <div
      role="alert"
      className={cn(
        "mb-6 rounded-xl border-2 p-4 text-sm",
        urgent
          ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">
          ⚠️ مخزون محتاج توريد:
          {alerts.lowCount > 0 && ` ${alerts.lowCount} خامة قربت تخلص`}
          {alerts.lowCount > 0 && alerts.outCount > 0 && " ·"}
          {alerts.outCount > 0 && ` ${alerts.outCount} خامة خلصت`}
        </span>
        <span className="flex-1" />
        <Link href="/inventory" className="font-medium underline underline-offset-2">
          افتح المخزون
        </Link>
        <button
          type="button"
          className="text-xs opacity-70 hover:opacity-100"
          onClick={() => { sessionStorage.setItem(DISMISS_KEY, sig); setDismissed(sig); }}
        >
          إخفاء
        </button>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs">
        {alerts.items.map((i) => (
          <li key={i.id}>
            <span className="font-medium">{i.name}</span>
            {showBranch && <span className="opacity-70"> ({i.branchName})</span>}
            {" — "}
            {i.status === "out"
              ? "خلصت"
              : `فاضل ${fmt(i.stock)} ${UNIT_LABEL[i.unit]} (التنبيه عند ${fmt(i.threshold)})`}
          </li>
        ))}
        {total > alerts.items.length && (
          <li className="opacity-70">و{total - alerts.items.length} خامة كمان في صفحة المخزون</li>
        )}
      </ul>
    </div>
  );
}
