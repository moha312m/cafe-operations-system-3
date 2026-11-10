"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { mayExecuteExpense } from "@/lib/expense-rules";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api, money } from "@/lib/client";
import { formatDateTime, t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { openingRequirementText, ShiftControls, type Shift } from "@/components/pos/shift-controls";
import { PageHeader, StatCard } from "@/components/cafe/ui";
import { BranchScopeSelect } from "@/components/stock-counts/branch-scope-select";

// Single source of truth: ShiftControls fetches the active shift once and
// hands the full object up via onActiveChange. The page derives its stat
// cards from that — no separate fetch, so there's no refetch/re-render loop
// and the layout stays stable.
function CurrentShiftWorkspace() {
  const { cafe, user, canKey, permKeys } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const currency = cafe?.currency ?? "EGP";
  const canViewReports = canKey("shifts.view_reports");
  const canOperate = canKey("shifts.view_current");
  const canChooseBranch = user.role === "CAFE_OWNER" && !user.branchId;
  const branchId = canChooseBranch ? params.get("branchId") ?? "" : user.branchId ?? "";
  const [personal, setPersonal] = useState<{ branchId: string; shift: Shift | null; pending: Shift | null } | null>(null);
  const loaded = personal?.branchId === branchId;
  const shift = loaded ? personal.shift : null;
  const pendingShift = loaded ? personal.pending : null;

  // Only cafe owners may pick a branch without an employee assignment; the picker starts on the first active one.
  const selectBranch = useCallback((id: string) => {
    if (id !== branchId) router.replace(`/current-shift?branchId=${encodeURIComponent(id)}`);
  }, [branchId, router]);

  // Only changes identity when the branch changes.
  const handleActive = useCallback((_active: boolean, s?: Shift | null, pending?: Shift | null) => {
    setPersonal({ branchId, shift: s ?? null, pending: pending ?? null });
  }, [branchId]);
  const current = shift ?? pendingShift;

  const stats = shift
    ? [
        { label: t.shifts.openingCash, value: money(shift.openingCashAmount, currency), icon: "🔓", accent: "slate" as const },
        ...(canKey("shifts.view_reports") ? [
          { label: t.shifts.totalSales, value: money(shift.totalSales ?? 0, currency), icon: "💵", accent: "emerald" as const },
          { label: t.shifts.cashSales, value: money(shift.totalCashSales ?? 0, currency), icon: "💰", accent: "emerald" as const },
          { label: t.shifts.cardSales, value: money(shift.totalCardSales ?? 0, currency), icon: "💳", accent: "blue" as const },
          { label: t.shifts.walletSales, value: money(shift.totalWalletSales ?? 0, currency), icon: "📱", accent: "violet" as const },
          { label: t.shifts.discounts, value: money(shift.totalDiscounts ?? 0, currency), icon: "🏷️", accent: "amber" as const },
          { label: t.shifts.refunds, value: money(shift.totalRefunds ?? 0, currency), icon: "↩️", accent: "red" as const },
          { label: t.shifts.orderCount, value: String(shift.orderCount ?? 0), icon: "🧾", accent: "blue" as const },
        ] : []),
        ...(canKey("shifts.view_reports") && shift.expectedCashAmount
          ? [{ label: t.shifts.expectedCash, value: money(shift.expectedCashAmount, currency), icon: "🧮", accent: "emerald" as const }]
          : []),
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t.shifts.current} subtitle={t.shifts.details} />
      {canChooseBranch && <div className="mb-3" data-testid="current-shift-branch"><BranchScopeSelect value={branchId} onChange={selectBranch} /></div>}
      {shift && mayExecuteExpense(user.role, new Set(permKeys)) && canKey("expenses.view") && <Link href="/expenses" className="mb-3 inline-block rounded-lg border px-4 py-2">تسجيل مصروف من الدرج</Link>}

      {!canChooseBranch && !branchId ? (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
          حسابك غير معيّن على فرع. اطلب من المدير تعيين الفرع قبل فتح الشيفت.
        </p>
      ) : !canOperate ? null : branchId ? (
        <ShiftControls
          key={branchId}
          branchId={branchId}
          currency={currency}
          onActiveChange={handleActive}
        />
      ) : (
        <div className="h-[52px] animate-pulse rounded-xl border border-dashed bg-muted/30" />
      )}
      {current && <dl className="mt-3 grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 text-sm" dir="rtl">
        <div><dt className="text-muted-foreground">فتح الشيفت بواسطة</dt><dd>{current.openedBy?.name ?? "غير متاح"}</dd></div>
        <div><dt className="text-muted-foreground">وقت الفتح</dt><dd><time dateTime={current.openedAt}>{formatDateTime(current.openedAt)}</time></dd></div>
      </dl>}
      {canViewReports && branchId && <BranchOpenShifts
        key={`${branchId}:${current?.id ?? ""}:${current?.waitingFor?.join(",") ?? ""}`}
        branchId={branchId}
      />}

      {/* Fixed-height grid area — shows skeletons, stats, or the gate hint
          without the container height jumping between states. */}
      <div className="mt-4">
        {!canOperate || (!branchId && !canChooseBranch) ? null : !loaded ? (
          <StatGrid>
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-[92px] animate-pulse rounded-2xl border border-border bg-card" />
            ))}
          </StatGrid>
        ) : shift ? (
          <StatGrid>
            {stats.map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} accent={s.accent} />
            ))}
          </StatGrid>
        ) : !pendingShift ? (
          <div className="rounded-2xl border border-dashed bg-muted/20 py-12 text-center text-sm text-muted-foreground">
            {t.shifts.mustOpen}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function CurrentShiftPage() {
  return <Suspense fallback={<p role="status">جاري تحميل الشيفت…</p>}><CurrentShiftWorkspace /></Suspense>;
}

function BranchOpenShifts({ branchId }: { branchId: string }) {
  const [result, setResult] = useState<{ shifts: Shift[] } | { error: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ branchId, status: "OPEN" });
    void api<{ shifts: Shift[] }>(`/api/shifts?${query}`, { signal: controller.signal, readTimeoutMs: 20_000 })
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ error: "تعذّر تحميل الشيفتات المفتوحة في الفرع." });
      });
    return () => controller.abort();
  }, [branchId]);

  return (
    <section dir="rtl" className="mt-4 space-y-3 rounded-xl border bg-card p-4" aria-label="الشيفتات المفتوحة في الفرع" data-testid="branch-open-shifts">
      <h2 className="font-semibold">الشيفتات المفتوحة في الفرع</h2>
      {!result ? <p role="status" className="text-sm text-muted-foreground">جاري تحميل الشيفتات…</p>
        : "error" in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
        : result.shifts.length === 0 ? <p className="text-sm text-muted-foreground">مفيش شيفتات مفتوحة في الفرع ده.</p>
        : <ul className="divide-y">
          {result.shifts.map((shift) => (
            <li key={shift.id} className="grid gap-2 py-3 text-sm sm:grid-cols-4">
              <strong>شيفت <bdi>#{shift.shiftNumber}</bdi></strong>
              <div><span className="block text-muted-foreground">فتح الشيفت بواسطة</span><span>{shift.openedBy?.name ?? "غير متاح"}</span></div>
              <div><span className="block text-muted-foreground">وقت الفتح</span><time dateTime={shift.openedAt}>{formatDateTime(shift.openedAt)}</time></div>
              <div>
                <p className={shift.waitingFor?.length ? "font-medium text-caramel-ink" : "font-medium text-primary"}>
                  {shift.waitingFor?.length ? "في انتظار إجراء" : "جاهز للبيع"}
                </p>
                {shift.waitingFor?.map((requirement) => <p key={requirement} className="text-muted-foreground">{openingRequirementText[requirement]}</p>)}
              </div>
            </li>
          ))}
        </ul>}
    </section>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">{children}</div>;
}
