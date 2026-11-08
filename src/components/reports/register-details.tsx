"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { currencySymbol } from "@/lib/currency";
import type { ShiftReport } from "@/lib/shift-report";

const METHOD_AR: Record<string, string> = {
  CASH: "الدفع النقدي (كاش)",
  CARD: "بطاقة بنكية (فيزا / كارت)",
  WALLET: "محفظة إلكترونية",
};

const STATUS_AR: Record<string, string> = {
  OPEN: "مفتوحة الآن",
  AWAITING_HANDOVER: "بانتظار التسليم",
  CLOSED: "مغلقة",
};

function fmtMoney(n: number | null | undefined, sym: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "حتى الآن (مفتوحة)";
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function RegisterDetailsContent({
  report,
  canClose = false,
}: {
  report: ShiftReport;
  canClose?: boolean;
}) {
  const sym = currencySymbol(report.cafe.currency ?? "EGP");
  const eq = report.totals.equation;
  const totalProdQty = report.productsSold.reduce((s, r) => s + r.quantity, 0);
  const totalProdAmt = Math.round(report.productsSold.reduce((s, r) => s + r.total, 0) * 100) / 100;
  const totalCatQty = report.productsByCategory.reduce((s, r) => s + r.quantity, 0);
  const totalCatAmt = Math.round(report.productsByCategory.reduce((s, r) => s + r.total, 0) * 100) / 100;
  const isOpen = report.status === "OPEN";
  const diff = report.cash.difference;

  return (
    <div dir="rtl" className="space-y-5 text-sm" data-testid="register-details-content">
      {/* Header banner */}
      <div className="rounded-xl border bg-muted/30 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold">
              تفاصيل سجل الوردية #{report.shiftNumber} ({fmtDateTime(report.openedAt)} — {fmtDateTime(report.closedAt)})
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {report.cafe.name} · الفرع: <strong className="text-foreground">{report.branch.name}</strong> · الموظف:{" "}
              <strong className="text-foreground">{report.cashierName}</strong>
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              isOpen
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300"
            }`}
          >
            {STATUS_AR[report.status] ?? report.status}
          </span>
        </div>
      </div>

      {/* 1. Payment Methods Breakdown Table (Sell vs Refund vs Expense) */}
      <section className="space-y-2">
        <h4 className="font-semibold">ملخص وسائل الدفع والمصروفات</h4>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full whitespace-nowrap text-start text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2.5 text-start font-medium">وسيلة الدفع</th>
                <th className="p-2.5 text-start font-medium">المبيعات (تحصيل)</th>
                <th className="p-2.5 text-start font-medium">المرتجعات</th>
                <th className="p-2.5 text-start font-medium">المصروفات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="p-2.5 font-medium">رصيد بداية الوردية (Cash in hand)</td>
                <td className="p-2.5 tabular-nums" dir="ltr">
                  {fmtMoney(report.cash.opening, sym)}
                </td>
                <td className="p-2.5 text-muted-foreground">—</td>
                <td className="p-2.5 text-muted-foreground">—</td>
              </tr>
              {report.paymentBreakdown.map((row) => (
                <tr key={row.method}>
                  <td className="p-2.5 font-medium">
                    {METHOD_AR[row.method] ?? row.method}
                    {row.sellCount > 0 && (
                      <span className="ms-1.5 text-xs text-muted-foreground">({row.sellCount} حركة)</span>
                    )}
                  </td>
                  <td className="p-2.5 tabular-nums" dir="ltr">
                    {fmtMoney(row.sell, sym)}
                  </td>
                  <td className="p-2.5 tabular-nums" dir="ltr">
                    {fmtMoney(row.refund, sym)}
                  </td>
                  <td className="p-2.5 tabular-nums" dir="ltr">
                    {fmtMoney(row.expense, sym)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Totals Summary Block + Closing Equation */}
      <section className="space-y-2 rounded-xl border bg-card p-3.5">
        <dl className="divide-y text-sm">
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-muted-foreground">إجمالي التحصيلات (Total Sales)</dt>
            <dd className="font-semibold tabular-nums" dir="ltr">
              {fmtMoney(report.totals.totalSales, sym)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-muted-foreground">إجمالي المرتجعات (Total Refund)</dt>
            <dd className="tabular-nums" dir="ltr">
              {fmtMoney(report.totals.totalRefund, sym)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <dt className="font-semibold">صافي المقبوضات (Total Payment)</dt>
            <dd className="font-bold tabular-nums" dir="ltr">
              {fmtMoney(report.totals.totalPayment, sym)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-muted-foreground">مبيعات آجلة / مرحلة غير محصلة (Credit Sales)</dt>
            <dd className="tabular-nums" dir="ltr">
              {fmtMoney(report.totals.creditSales, sym)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-muted-foreground">إجمالي مصروفات الدرج (Total Expense)</dt>
            <dd className="tabular-nums" dir="ltr">
              {fmtMoney(report.totals.totalExpense, sym)}
            </dd>
          </div>
          {!isOpen && (
            <>
              <div className="flex items-center justify-between py-1.5">
                <dt className="text-muted-foreground">النقد الفعلي المعدود (Counted Cash)</dt>
                <dd className="font-semibold tabular-nums" dir="ltr">
                  {fmtMoney(report.cash.actual, sym)}
                </dd>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <dt className="text-muted-foreground">فرق النقدية (Cash Over/Short)</dt>
                <dd
                  className={`font-bold tabular-nums ${
                    diff === null || diff === 0
                      ? ""
                      : diff < 0
                        ? "text-destructive"
                        : "text-emerald-600 dark:text-emerald-400"
                  }`}
                  dir="ltr"
                >
                  {diff === null ? "—" : `${diff > 0 ? "+" : ""}${fmtMoney(diff, sym)}`}
                </dd>
              </div>
            </>
          )}
        </dl>
        <div
          className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold leading-6 tabular-nums"
          data-testid="register-details-equation"
        >
          الإجمالي النقدي بالدرج = <bdi>{fmtMoney(eq.opening, sym)}</bdi> (افتتاحي) +{" "}
          <bdi>{fmtMoney(eq.sale, sym)}</bdi> (مبيعات نقدية) − <bdi>{fmtMoney(eq.refund, sym)}</bdi> (مرتجع) −{" "}
          <bdi>{fmtMoney(eq.expense, sym)}</bdi> (مصروف) = <bdi>{fmtMoney(eq.total, sym)}</bdi>
        </div>
      </section>

      {/* 3. Details of products sold */}
      <section className="space-y-2">
        <h4 className="font-semibold">تفاصيل الأصناف المباعة (Details of products sold)</h4>
        {report.productsSold.length === 0 ? (
          <p className="rounded-xl border p-3 text-xs text-muted-foreground">لا توجد أصناف مباعة في هذه الوردية.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full whitespace-nowrap text-start text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5 text-start font-medium">#</th>
                  <th className="p-2.5 text-start font-medium">SKU</th>
                  <th className="p-2.5 text-start font-medium">الصنف</th>
                  <th className="p-2.5 text-start font-medium">الكمية</th>
                  <th className="p-2.5 text-start font-medium">الإجمالي</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.productsSold.map((item, idx) => (
                  <tr key={`${item.sku ?? ""}:${item.productName}:${item.variantName ?? ""}:${idx}`}>
                    <td className="p-2.5 tabular-nums">{idx + 1}</td>
                    <td className="p-2.5 tabular-nums">
                      <bdi>{item.sku ?? "—"}</bdi>
                    </td>
                    <td className="p-2.5 font-medium">
                      {item.productName}
                      {item.variantName ? ` (${item.variantName})` : ""}
                    </td>
                    <td className="p-2.5 tabular-nums">{item.quantity}</td>
                    <td className="p-2.5 tabular-nums" dir="ltr">
                      {fmtMoney(item.total, sym)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-muted/40 font-bold">
                <tr>
                  <td className="p-2.5" colSpan={3}>
                    الإجمالي الكلي (Grand Total)
                  </td>
                  <td className="p-2.5 tabular-nums">{totalProdQty}</td>
                  <td className="p-2.5 tabular-nums" dir="ltr">
                    {fmtMoney(totalProdAmt, sym)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* 4. Details of products sold by Category */}
      <section className="space-y-2">
        <h4 className="font-semibold">المبيعات حسب التصنيف (Details of products sold by Category)</h4>
        {report.productsByCategory.length === 0 ? (
          <p className="rounded-xl border p-3 text-xs text-muted-foreground">لا توجد تصنيفات مباعة في هذه الوردية.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full whitespace-nowrap text-start text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5 text-start font-medium">#</th>
                  <th className="p-2.5 text-start font-medium">التصنيف</th>
                  <th className="p-2.5 text-start font-medium">الكمية</th>
                  <th className="p-2.5 text-start font-medium">الإجمالي</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.productsByCategory.map((cat, idx) => (
                  <tr key={`${cat.categoryName}:${idx}`}>
                    <td className="p-2.5 tabular-nums">{idx + 1}</td>
                    <td className="p-2.5 font-medium">{cat.categoryName}</td>
                    <td className="p-2.5 tabular-nums">{cat.quantity}</td>
                    <td className="p-2.5 tabular-nums" dir="ltr">
                      {fmtMoney(cat.total, sym)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-muted/40 font-bold">
                <tr>
                  <td className="p-2.5" colSpan={2}>
                    الإجمالي الكلي (Grand Total)
                  </td>
                  <td className="p-2.5 tabular-nums">{totalCatQty}</td>
                  <td className="p-2.5 tabular-nums" dir="ltr">
                    {fmtMoney(totalCatAmt, sym)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Link
          href={`/reports/shift/${encodeURIComponent(report.shiftId)}`}
          target="_blank"
          className="inline-flex min-h-10 items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          🖨️ طباعة A4 / التقرير الكامل
        </Link>
        <Link
          href={`/reports/shift/${encodeURIComponent(report.shiftId)}?format=thermal`}
          target="_blank"
          className="inline-flex min-h-10 items-center rounded-lg border bg-background px-4 py-2 text-sm font-semibold hover:bg-muted"
        >
          🧾 طباعة حرارية (80mm)
        </Link>
        {isOpen && canClose && (
          <Link
            href={`/close-shift?branchId=${encodeURIComponent(report.branch.id)}`}
            className="inline-flex min-h-10 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/20"
          >
            ⏹️ إغلاق الوردية
          </Link>
        )}
      </div>
    </div>
  );
}

export function RegisterDetailsDialog({
  shiftId,
  open,
  onOpenChange,
  canClose = false,
  finalFocus,
}: {
  shiftId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canClose?: boolean;
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const [loaded, setLoaded] = useState<{
    shiftId: string;
    report: ShiftReport | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !shiftId) return;
    const controller = new AbortController();
    api<{ report: ShiftReport }>(`/api/reports/shift/${encodeURIComponent(shiftId)}/details`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) {
          setLoaded({ shiftId, report: res.report, error: "" });
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setLoaded({
            shiftId,
            report: null,
            error: err instanceof Error ? err.message : "تعذر تحميل تفاصيل الوردية",
          });
        }
      });
    return () => controller.abort();
  }, [open, shiftId]);

  const current = open && shiftId && loaded?.shiftId === shiftId ? loaded : null;
  const loading = Boolean(open && shiftId && !current);
  const error = current?.error ?? "";
  const report = current?.report ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent finalFocus={finalFocus} className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" dir="rtl">
        <DialogTitle>تفاصيل سجل الوردية (Register Details)</DialogTitle>
        {loading && (
          <div role="status" className="py-8 text-center text-sm text-muted-foreground animate-pulse">
            جارٍ تحميل تفاصيل الوردية والأصناف المباعة…
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}
        {report && <RegisterDetailsContent report={report} canClose={canClose} />}
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            إغلاق النافذة
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
