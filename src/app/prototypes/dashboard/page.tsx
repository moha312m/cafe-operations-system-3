"use client";

import * as React from "react";
import {
  MOCK_DASHBOARD_PERIODS,
  type DashboardPeriod,
  type ActionInboxItem,
} from "../_data/mock-data";
import { formatMoney } from "@/lib/currency";
import {
  TrendingUp,
  Wallet,
  Receipt,
  Store,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Flame,
  ArrowUpRight,
  Coffee,
  Check,
  Building2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function DashboardPrototypePage() {
  const [period, setPeriod] = React.useState<DashboardPeriod>("today");
  const [resolvedActionIds, setResolvedActionIds] = React.useState<string[]>([]);

  const currentData = MOCK_DASHBOARD_PERIODS[period];

  const actionInbox = React.useMemo(() => {
    return currentData.actionInbox.filter((item: ActionInboxItem) => !resolvedActionIds.includes(item.id));
  }, [currentData, resolvedActionIds]);

  // Resolve Action Inbox Item
  const handleResolveAction = (id: string, actionType: string) => {
    setResolvedActionIds((prev) => [...prev, id]);
    if (actionType === "SHIFT_CLOSE") {
      toast.success(`تم اعتماد إغلاق الوردية ومطابقة النقدية بنجاح`);
    } else if (actionType === "EXPENSE_APPROVAL") {
      toast.success(`تم اعتماد صرف الفاتورة بنجاح وتحويلها لقسم الحسابات`);
    } else if (actionType === "OVERDUE_TASK") {
      toast.info(`تم إرسال إشعار تنبيه عاجل إلى مشرف الوردية`);
    } else {
      toast.success(`تم رفع طلب تحويل المخزون إلى المستودع المركزي`);
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Header & Period Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#E2E4DE] pb-4">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-[#17221E]">
            لوحة المالك الشاملة (Owner Overview)
          </h1>
          <p className="text-sm text-[#64746B]">
            مؤشرات الإيرادات الحية، كفاءة التحصيل، مراقبة المصروفات، وصندوق القرارات العاجلة
          </p>
        </div>

        {/* Period Switcher (min-h 44px touch targets) */}
        <div className="flex items-center rounded-2xl bg-white p-1 border border-[#E2E4DE] shadow-2xs self-start sm:self-auto">
          {(
            [
              { id: "today", label: "اليوم" },
              { id: "week", label: "هذا الأسبوع" },
              { id: "month", label: "هذا الشهر" },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={cn(
                "flex min-h-[44px] items-center px-4 rounded-xl text-xs sm:text-sm font-bold transition-all outline-none",
                "focus-visible:ring-2 focus-visible:ring-[#27695B]",
                period === p.id
                  ? "bg-[#27695B] text-white shadow-xs"
                  : "text-[#64746B] hover:text-[#17221E] hover:bg-[#F6F7F4]"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* 4 Concise KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Net Sales */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              صافي المبيعات
            </span>
            <div className="flex size-10 items-center justify-center rounded-xl bg-[#27695B]/10 text-[#27695B]">
              <TrendingUp className="size-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-[#17221E] tabular-nums">
              {formatMoney(currentData.kpis.netSales, "EGP")}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-emerald-600 font-bold">
              <ArrowUpRight className="size-3.5" />
              <span>{currentData.kpis.netSalesTrend}</span>
            </div>
          </div>
        </div>

        {/* KPI 2: Collections */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              التحصيلات النقدية والبنكية
            </span>
            <div className="flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Wallet className="size-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-[#17221E] tabular-nums">
              {formatMoney(currentData.kpis.collections, "EGP")}
            </div>
            <div className="mt-1 text-xs text-blue-600 font-medium">
              <span>{currentData.kpis.collectionsRatio}</span>
            </div>
          </div>
        </div>

        {/* KPI 3: Expenses */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              المصروفات التشغيلية
            </span>
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
              <Receipt className="size-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-[#B45309] tabular-nums">
              {formatMoney(currentData.kpis.expenses, "EGP")}
            </div>
            <div className="mt-1 text-xs text-[#B45309] font-medium">
              <span>{currentData.kpis.expensesRatio}</span>
            </div>
          </div>
        </div>

        {/* KPI 4: Open Shifts & Branches */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              الورديات وحالة الفروع
            </span>
            <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <Store className="size-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="font-heading text-xl sm:text-2xl font-bold text-[#17221E]">
              {currentData.kpis.openShifts} ورديات مفتوحة
            </div>
            <div className="mt-1 text-xs text-[#27695B] font-medium">
              من أصل {currentData.kpis.activeBranches} فروع نشطة
            </div>
          </div>
        </div>
      </div>

      {/* Grid: Action Inbox (Top / Side) + Analytics Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Right in RTL / Main Content: Action Inbox (7 cols) */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-[#27695B] text-white">
                <Flame className="size-4" />
              </div>
              <div>
                <h2 className="font-heading text-lg font-bold text-[#17221E]">
                  صندوق القرارات والمهام العاجلة (Action Inbox)
                </h2>
                <span className="text-xs text-[#64746B]">
                  {actionInbox.length} بنود تتطلب موافقة وتدخل المالك
                </span>
              </div>
            </div>

            {actionInbox.length > 0 && (
              <span className="rounded-full bg-rose-50 border border-rose-200 px-2.5 py-0.5 text-xs font-bold text-rose-700">
                أولوية مرتفعة
              </span>
            )}
          </div>

          {/* Action Inbox Items List */}
          <div className="flex flex-col gap-3">
            {actionInbox.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border p-4 bg-white shadow-2xs transition-all",
                  item.severity === "URGENT"
                    ? "border-rose-200 bg-rose-50/20"
                    : item.severity === "HIGH"
                    ? "border-amber-200"
                    : "border-[#E2E4DE]"
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl",
                      item.severity === "URGENT"
                        ? "bg-rose-100 text-rose-700"
                        : item.severity === "HIGH"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-blue-100 text-blue-700"
                    )}
                  >
                    {item.severity === "URGENT" ? (
                      <AlertTriangle className="size-5" />
                    ) : item.type === "EXPENSE_APPROVAL" ? (
                      <Receipt className="size-5" />
                    ) : (
                      <Clock className="size-5" />
                    )}
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-heading text-sm font-bold text-[#17221E]">
                        {item.titleAr}
                      </h3>
                      <span className="rounded-md bg-[#F6F7F4] px-1.5 py-0.5 text-[10px] text-[#64746B]">
                        {item.branchName}
                      </span>
                      <span className="text-[10px] text-[#8D9B93]">
                        {item.timeAgoAr}
                      </span>
                    </div>

                    <p className="text-xs text-[#64746B] leading-relaxed">
                      {item.descriptionAr}
                    </p>
                  </div>
                </div>

                {/* Primary Action Button (min-h 44px) */}
                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                  <button
                    type="button"
                    onClick={() => handleResolveAction(item.id, item.type)}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#27695B] px-4 text-xs font-bold text-white shadow-xs hover:bg-[#1e5348] active:scale-95 transition-all"
                  >
                    <Check className="size-3.5" />
                    <span>{item.actionLabelAr}</span>
                  </button>
                </div>
              </div>
            ))}

            {actionInbox.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#E2E4DE] bg-white p-10 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 mb-2">
                  <CheckCircle2 className="size-6" />
                </div>
                <p className="font-heading text-base font-bold text-[#17221E]">
                  رائع! تم حسم جميع القرارات والاعتمادات العاجلة
                </p>
                <p className="text-xs text-[#64746B] mt-0.5">
                  لا توجد مهام تنتظر توقيع أو مراجعة المالك حالياً.
                </p>
              </div>
            )}
          </div>

          {/* Sales Channel Breakdown Bar */}
          <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs">
            <h3 className="font-heading text-base font-bold text-[#17221E] mb-3">
              توزيع المبيعات حسب القنوات (Sales by Channel)
            </h3>

            {/* Visual Stacked Bar */}
            <div className="flex h-4 w-full overflow-hidden rounded-full bg-[#F6F7F4] mb-4">
              <div
                style={{ width: `${currentData.channelBreakdown[0].percentage}%` }}
                className="bg-[#27695B] transition-all"
                title="صالات"
              />
              <div
                style={{ width: `${currentData.channelBreakdown[1].percentage}%` }}
                className="bg-emerald-400 transition-all"
                title="سفري واستلام"
              />
              <div
                style={{ width: `${currentData.channelBreakdown[2].percentage}%` }}
                className="bg-amber-400 transition-all"
                title="توصيل"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {currentData.channelBreakdown.map((ch, idx) => (
                <div key={ch.channel} className="flex items-center gap-2.5 rounded-xl bg-[#F6F7F4]/60 p-2.5">
                  <div
                    className={cn(
                      "size-3 rounded-full shrink-0",
                      idx === 0 ? "bg-[#27695B]" : idx === 1 ? "bg-emerald-400" : "bg-amber-400"
                    )}
                  />
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold text-[#17221E]">
                      {ch.channelNameAr} ({ch.percentage}%)
                    </span>
                    <span className="font-mono text-xs text-[#64746B] tabular-nums">
                      {formatMoney(ch.amount, "EGP")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Left in RTL / Side Column: Top Products & Branch Performance (5 cols) */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col gap-5">
          {/* Top Selling Products */}
          <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-base font-bold text-[#17221E]">
                أعلى الأصناف طلباً وإيراداً
              </h3>
              <Coffee className="size-4 text-[#27695B]" />
            </div>

            <div className="space-y-3">
              {currentData.topProducts.map((p, idx) => (
                <div
                  key={p.nameAr}
                  className="flex items-center justify-between border-b border-[#F6F7F4] pb-2.5 last:border-0 last:pb-0"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-6 items-center justify-center rounded-md bg-[#F6F7F4] font-mono text-xs font-bold text-[#64746B]">
                      {idx + 1}
                    </span>
                    <div className="flex flex-col">
                      <span className="font-heading text-sm font-bold text-[#17221E]">
                        {p.nameAr}
                      </span>
                      <span className="text-[11px] text-[#64746B]">
                        {p.ordersCount} طلب
                      </span>
                    </div>
                  </div>

                  <span className="font-mono text-sm font-bold text-[#27695B] tabular-nums">
                    {formatMoney(p.revenue, "EGP")}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Branch Performance Comparison */}
          <div className="rounded-2xl border border-[#E2E4DE] bg-white p-5 shadow-2xs">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading text-base font-bold text-[#17221E]">
                مقارنة أداء الفروع
              </h3>
              <Building2 className="size-4 text-[#27695B]" />
            </div>

            <div className="space-y-4">
              {currentData.branchPerformance.map((b) => (
                <div key={b.branchName} className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="font-bold text-[#17221E]">{b.branchName}</span>
                    <span className="font-mono font-bold text-[#27695B] tabular-nums">
                      {formatMoney(b.revenue, "EGP")} ({b.percentage}%)
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="h-2 w-full rounded-full bg-[#F6F7F4] overflow-hidden">
                    <div
                      style={{ width: `${b.percentage}%` }}
                      className="h-full rounded-full bg-[#27695B]"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
