"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, X } from "lucide-react";
import { useApp } from "@/components/app-shell";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "pending-corrections-banner-dismissed";

export function PendingCorrectionsBanner({ pathname }: { pathname: string }) {
  const { user, canKey, features } = useApp();
  const [count, setCount] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const canApprove =
    (user?.role === "CAFE_OWNER" ||
      user?.role === "BRANCH_MANAGER" ||
      user?.role === "SUPER_ADMIN" ||
      canKey("stock_count.approve_correction")) &&
    (!features || features.inventoryEnabled);

  useEffect(() => {
    if (!canApprove) return;
    let stop = false;

    const check = async () => {
      try {
        const res = await fetch("/api/corrections/pending?countOnly=1", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        if (!stop) {
          const currentCount = data.count ?? 0;
          setCount(currentCount);
          setDismissed(sessionStorage.getItem(DISMISS_KEY));
        }
      } catch {
        // Quiet on connection error
      }
    };

    void check();
    const timer = setInterval(check, 20_000);
    const onFocus = () => void check();
    const onCustomUpdate = () => void check();

    window.addEventListener("focus", onFocus);
    window.addEventListener("stock-correction-updated", onCustomUpdate);

    return () => {
      stop = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("stock-correction-updated", onCustomUpdate);
    };
  }, [canApprove, pathname]);

  if (!canApprove || count === 0) return null;

  // Don't show banner on /approvals since the user is already on the approvals page
  if (pathname === "/approvals") return null;

  const sig = `corrections-count:${count}`;
  if (dismissed === sig) return null;

  return (
    <aside
      aria-label="تنبيه طلبات تصحيح الجرد المعلقة"
      className={cn(
        "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-amber-400 bg-amber-50/90 px-4 py-3 text-amber-950 shadow-sm dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100",
        "animate-in fade-in slide-in-from-top-2"
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
          <AlertCircle className="size-4" />
        </span>
        <p className="text-sm font-semibold">
          يوجد {count} {count === 1 ? "طلب تصحيح جرد معلق" : "طلبات تصحيح جرد معلقة"} بانتظار اعتماد المالك أو المدير.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href="/approvals"
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        >
          <span>مراجعة واعتماد الآن</span>
          <ArrowLeft className="size-3.5" />
        </Link>
        <button
          type="button"
          onClick={() => {
            sessionStorage.setItem(DISMISS_KEY, sig);
            setDismissed(sig);
          }}
          className="rounded p-1 text-amber-700 opacity-70 hover:opacity-100 dark:text-amber-300"
          title="إخفاء مؤقت"
        >
          <X className="size-4" />
        </button>
      </div>
    </aside>
  );
}
