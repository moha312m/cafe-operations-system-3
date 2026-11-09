"use client";

import * as React from "react";
import {
  MOCK_EXPENSES,
  type ExpenseItem,
  type ExpenseCategory,
  type ExpenseStatus,
} from "../_data/mock-data";
import { formatMoney } from "@/lib/currency";
import { ExpenseStatusBadge } from "@/components/prototypes/status-chip";
import {
  Plus,
  Receipt,
  TrendingDown,
  Clock,
  Coffee,
  Calendar,
  Search,
  CheckCircle2,
  X,
  UploadCloud,
  FileText,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  COFFEE_BEANS: "خامات ومستلزمات بن",
  DAIRY_MILK: "ألبان ومنتجات طازجة",
  MAINTENANCE: "صيانة ومعدات",
  PACKAGING: "أدوات وتغليف ومطبوعات",
  UTILITIES: "مرافق وفواتير كهرباء",
  CLEANING: "نظافة وتطهير",
  TECH_SUBSCRIPTION: "اشتراكات واتصالات",
  FRESH_PRODUCE: "فواكه وخامات موسمية",
};

export default function ExpensesPrototypePage() {
  const [expenses, setExpenses] = React.useState<ExpenseItem[]>([...MOCK_EXPENSES]);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState<string>("all");
  const [selectedBranch, setSelectedBranch] = React.useState<string>("all");
  const [selectedStatus, setSelectedStatus] = React.useState<string>("all");

  // Fast Entry Sheet/Modal State
  const [entryModalOpen, setEntryModalOpen] = React.useState(false);
  const [detailExpense, setDetailExpense] = React.useState<ExpenseItem | null>(null);

  // New Expense Form State
  const [formCategory, setFormCategory] = React.useState<ExpenseCategory>("COFFEE_BEANS");
  const [formAmount, setFormAmount] = React.useState<string>("");
  const [formBranch, setFormBranch] = React.useState<string>("فرع وسط البلد");
  const [formPaymentMethod, setFormPaymentMethod] = React.useState<string>("عهدة نقدية للفرع");
  const [formVendor, setFormVendor] = React.useState<string>("");
  const [formDescription, setFormDescription] = React.useState<string>("");
  const [formDate, setFormDate] = React.useState<string>(
    new Date().toISOString().split("T")[0]
  );
  const [formNotes, setFormNotes] = React.useState<string>("");
  const [formHasReceiptMock, setFormHasReceiptMock] = React.useState<boolean>(false);

  // Dynamic KPI Calculations
  const kpis = React.useMemo(() => {
    const totalMonth = expenses.reduce((acc, curr) => acc + curr.amount, 0);

    // This week (expenses from 2026-11-05 onwards)
    const thisWeekExpenses = expenses.filter((e) => e.date >= "2026-11-05");
    const totalWeek = thisWeekExpenses.reduce((acc, curr) => acc + curr.amount, 0);

    const pendingExpenses = expenses.filter((e) => e.status === "PENDING");
    const totalPendingAmount = pendingExpenses.reduce((acc, curr) => acc + curr.amount, 0);

    // Top Category
    const categoryTotals: Record<string, number> = {};
    expenses.forEach((e) => {
      categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
    });

    let topCat = "COFFEE_BEANS";
    let topCatAmount = 0;
    Object.entries(categoryTotals).forEach(([cat, val]) => {
      if (val > topCatAmount) {
        topCat = cat;
        topCatAmount = val;
      }
    });

    const topCatPercentage = Math.round((topCatAmount / totalMonth) * 100) || 0;

    return {
      totalMonth,
      totalWeek,
      weekCount: thisWeekExpenses.length,
      pendingCount: pendingExpenses.length,
      pendingAmount: totalPendingAmount,
      topCategoryName: CATEGORY_LABELS[topCat as ExpenseCategory] || "خامات ومستلزمات بن",
      topCategoryAmount: topCatAmount,
      topCategoryPercentage: topCatPercentage,
    };
  }, [expenses]);

  // Filtered List
  const filteredExpenses = React.useMemo(() => {
    return expenses.filter((item) => {
      const matchSearch =
        searchQuery === "" ||
        item.descriptionAr.includes(searchQuery) ||
        item.vendorName.includes(searchQuery) ||
        item.code.toLowerCase().includes(searchQuery.toLowerCase());
      const matchCat =
        selectedCategory === "all" || item.category === selectedCategory;
      const matchBranch =
        selectedBranch === "all" || item.branchName === selectedBranch;
      const matchStatus =
        selectedStatus === "all" || item.status === selectedStatus;
      return matchSearch && matchCat && matchBranch && matchStatus;
    });
  }, [expenses, searchQuery, selectedCategory, selectedBranch, selectedStatus]);

  // Add Expense Handler
  const handleSaveExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseFloat(formAmount);

    if (!formAmount || isNaN(amountNum) || amountNum <= 0) {
      toast.error("يرجى إدخال مبلغ صحيح");
      return;
    }
    if (!formVendor.trim()) {
      toast.error("يرجى إدخال اسم المورد أو الجهة");
      return;
    }

    const newExpense: ExpenseItem = {
      id: `exp-${Date.now()}`,
      code: `EXP-2026-${Math.floor(100 + Math.random() * 900)}`,
      date: formDate,
      category: formCategory,
      categoryNameAr: CATEGORY_LABELS[formCategory],
      descriptionAr: formDescription || `مصروف ${CATEGORY_LABELS[formCategory]}`,
      amount: amountNum,
      paymentMethodAr: formPaymentMethod,
      vendorName: formVendor.trim(),
      branchName: formBranch,
      status: "APPROVED",
      notes: formNotes || undefined,
      receiptThumbnailUrl: formHasReceiptMock ? "/mock-receipt.jpg" : undefined,
    };

    setExpenses((prev) => [newExpense, ...prev]);
    toast.success(`تم تسجيل المصروف ${newExpense.code} بقيمة ${formatMoney(amountNum, "EGP")}`);

    // Reset Form
    setFormAmount("");
    setFormVendor("");
    setFormDescription("");
    setFormNotes("");
    setFormHasReceiptMock(false);
    setEntryModalOpen(false);
  };

  // Quick Approve Pending Expense
  const handleApproveExpense = (id: string) => {
    setExpenses((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status: "APPROVED" as ExpenseStatus } : item
      )
    );
    toast.success("تم اعتماد المصروف بنجاح وتحويل حالته إلى معتمد");
    if (detailExpense && detailExpense.id === id) {
      setDetailExpense((prev) => (prev ? { ...prev, status: "APPROVED" } : null));
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Header & Quick Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#E2E4DE] pb-4">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-[#17221E]">
            المصروفات التشغيلية (Operating Expenses)
          </h1>
          <p className="text-sm text-[#64746B]">
            تسجيل ومتابعة عهد الفروع، فواتير التوريد، ومراقبة الميزانيات التقديرية
          </p>
        </div>

        <button
          type="button"
          onClick={() => setEntryModalOpen(true)}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#27695B] px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#1e5348] active:scale-98 transition-all"
        >
          <Plus className="size-5" />
          <span>تسجيل مصروف جديد</span>
        </button>
      </div>

      {/* 4 Concise KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Monthly */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-4 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              إجمالي مصروفات الشهر
            </span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-[#27695B]/10 text-[#27695B]">
              <Receipt className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-mono text-2xl font-bold text-[#17221E] tabular-nums">
              {formatMoney(kpis.totalMonth, "EGP")}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
              <TrendingDown className="size-3.5" />
              <span>-4.2% مقارنة بالشهر السابق</span>
            </div>
            <div className="mt-1 text-[11px] text-[#64746B]">
              الميزانية التقديرية 160,000 ج.م
            </div>
          </div>
        </div>

        {/* Card 2: This Week */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-4 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              مصروفات هذا الأسبوع
            </span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <Calendar className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-mono text-2xl font-bold text-[#17221E] tabular-nums">
              {formatMoney(kpis.totalWeek, "EGP")}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-blue-600 font-medium">
              <span>ضمن المعدل الطبيعي الأسبوعي</span>
            </div>
            <div className="mt-1 text-[11px] text-[#64746B]">
              {kpis.weekCount} بنود مسجلة
            </div>
          </div>
        </div>

        {/* Card 3: Pending Invoices */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-4 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              فواتير معلقة للاعتماد
            </span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
              <Clock className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-mono text-2xl font-bold text-[#B45309] tabular-nums">
              {kpis.pendingCount} فواتير
            </div>
            <div className="mt-1 text-xs text-[#B45309] font-medium">
              بقيمة {formatMoney(kpis.pendingAmount, "EGP")}
            </div>
            <div className="mt-1 text-[11px] text-[#64746B]">
              تتطلب موافقة المالك للصرف
            </div>
          </div>
        </div>

        {/* Card 4: Top Category */}
        <div className="rounded-2xl border border-[#E2E4DE] bg-white p-4 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#64746B]">
              أعلى تصنيف إنفاق
            </span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <Coffee className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-heading text-lg font-bold text-[#17221E] line-clamp-1">
              {kpis.topCategoryName}
            </div>
            <div className="mt-1 font-mono text-xs text-[#27695B] font-bold tabular-nums">
              {formatMoney(kpis.topCategoryAmount, "EGP")} ({kpis.topCategoryPercentage}%)
            </div>
            <div className="mt-1 text-[11px] text-[#64746B]">
              النسبة الأعلى من كلفة المبيعات
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row gap-3 rounded-2xl bg-white p-3 border border-[#E2E4DE]">
        <div className="relative flex-1">
          <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-[#64746B]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث بالبيان، المورد، أو كود المصروف..."
            className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white pe-4 ps-10 text-xs sm:text-sm outline-none focus:border-[#27695B]"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Category Filter */}
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع التصنيفات</option>
            {Object.entries(CATEGORY_LABELS).map(([catKey, label]) => (
              <option key={catKey} value={catKey}>
                {label}
              </option>
            ))}
          </select>

          {/* Branch Filter */}
          <select
            value={selectedBranch}
            onChange={(e) => setSelectedBranch(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع الفروع</option>
            <option value="فرع وسط البلد">فرع وسط البلد</option>
            <option value="فرع التجمع الخامس">فرع التجمع الخامس</option>
            <option value="فرع الشيخ زايد">فرع الشيخ زايد</option>
            <option value="كافيه الإدارة (توزيع فروع)">كافيه الإدارة</option>
          </select>

          {/* Status Filter */}
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع الحالات</option>
            <option value="APPROVED">معتمد</option>
            <option value="PAID">مدفوع</option>
            <option value="PENDING">معلق</option>
          </select>
        </div>
      </div>

      {/* Responsive Expense List: Table on Desktop, Compact 2-line cards on Mobile */}
      <div className="w-full">
        {/* Desktop Table View (>= lg) */}
        <div className="hidden lg:block rounded-2xl border border-[#E2E4DE] bg-white overflow-hidden shadow-2xs">
          <table className="w-full text-start text-sm">
            <thead className="bg-[#F6F7F4] border-b border-[#E2E4DE] text-xs font-bold text-[#64746B]">
              <tr>
                <th className="py-3.5 px-4 text-start">الكود والتاريخ</th>
                <th className="py-3.5 px-4 text-start">البيان والمورد</th>
                <th className="py-3.5 px-4 text-start">التصنيف</th>
                <th className="py-3.5 px-4 text-start">الفرع وطريقة الدفع</th>
                <th className="py-3.5 px-4 text-start">الحالة</th>
                <th className="py-3.5 px-4 text-end">المبلغ</th>
                <th className="py-3.5 px-4 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F6F7F4]">
              {filteredExpenses.map((expense) => (
                <tr
                  key={expense.id}
                  className="hover:bg-[#F6F7F4]/60 transition-colors group cursor-pointer"
                  onClick={() => setDetailExpense(expense)}
                >
                  <td className="py-3 px-4">
                    <span className="font-mono text-xs font-bold text-[#17221E] block" dir="ltr">
                      {expense.code}
                    </span>
                    <span className="text-[11px] text-[#64746B]">{expense.date}</span>
                  </td>

                  <td className="py-3 px-4">
                    <span className="font-medium text-[#17221E] block">{expense.descriptionAr}</span>
                    <span className="text-xs text-[#64746B]">مورد: {expense.vendorName}</span>
                  </td>

                  <td className="py-3 px-4">
                    <span className="inline-flex items-center rounded-lg bg-[#F6F7F4] px-2.5 py-1 text-xs text-[#17221E]">
                      {expense.categoryNameAr}
                    </span>
                  </td>

                  <td className="py-3 px-4">
                    <span className="text-xs font-medium text-[#17221E] block">{expense.branchName}</span>
                    <span className="text-[11px] text-[#64746B]">{expense.paymentMethodAr}</span>
                  </td>

                  <td className="py-3 px-4">
                    <ExpenseStatusBadge status={expense.status} />
                  </td>

                  <td className="py-3 px-4 text-end font-mono font-bold text-[#17221E] tabular-nums">
                    {formatMoney(expense.amount, "EGP")}
                  </td>

                  <td className="py-3 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                    {expense.status === "PENDING" ? (
                      <button
                        type="button"
                        onClick={() => handleApproveExpense(expense.id)}
                        className="rounded-lg bg-emerald-50 text-emerald-700 px-3 py-1.5 text-xs font-bold hover:bg-emerald-100 transition-colors"
                      >
                        اعتماد الآن
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDetailExpense(expense)}
                        className="rounded-lg bg-[#F6F7F4] text-[#64746B] p-2 hover:bg-[#E2E4DE] transition-colors"
                        aria-label="عرض التفاصيل"
                      >
                        <Eye className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile View (< lg): Compact 2-line Card Rows with Zero Horizontal Scroll */}
        <div className="lg:hidden flex flex-col gap-2.5">
          {filteredExpenses.map((expense) => (
            <div
              key={expense.id}
              onClick={() => setDetailExpense(expense)}
              className="flex flex-col gap-1.5 rounded-2xl border border-[#E2E4DE] bg-white p-3.5 shadow-2xs active:bg-[#F6F7F4] transition-colors cursor-pointer"
            >
              {/* Line 1: Vendor/Description + Amount */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-heading text-sm font-bold text-[#17221E] line-clamp-1">
                    {expense.vendorName}
                  </span>
                  <span className="text-xs text-[#64746B] line-clamp-1">
                    {expense.descriptionAr}
                  </span>
                </div>

                <span className="font-mono text-base font-bold text-[#27695B] tabular-nums shrink-0">
                  {formatMoney(expense.amount, "EGP")}
                </span>
              </div>

              {/* Line 2: Date + Category chip + Status badge */}
              <div className="flex items-center justify-between border-t border-[#F6F7F4] pt-2 text-xs">
                <div className="flex items-center gap-1.5 text-[#64746B]">
                  <span className="font-mono text-[11px]">{expense.date}</span>
                  <span>•</span>
                  <span className="rounded-md bg-[#F6F7F4] px-1.5 py-0.5 text-[10px]">
                    {expense.branchName.replace("فرع ", "")}
                  </span>
                </div>

                <ExpenseStatusBadge status={expense.status} />
              </div>
            </div>
          ))}
        </div>

        {filteredExpenses.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#E2E4DE] bg-white p-12 text-center">
            <Receipt className="size-12 text-[#8D9B93] mb-3" />
            <p className="font-heading text-base font-bold text-[#17221E]">
              لا توجد مصروفات مطابقة للبحث أو التصفية
            </p>
          </div>
        )}
      </div>

      {/* Fast Expense Entry Modal (Explicitly uses sm:max-w-2xl to avoid 384px clamping!) */}
      {entryModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setEntryModalOpen(false)}
        >
          <div
            className="flex w-full sm:max-w-2xl flex-col rounded-3xl bg-white p-5 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E2E4DE] pb-4">
              <div>
                <h3 className="font-heading text-lg font-bold text-[#17221E]">
                  تسجيل مصروف تشغيلي جديد
                </h3>
                <p className="text-xs text-[#64746B]">
                  سداد فوري من العهدة أو تسجيل فاتورة آجلة بانتظار الاعتماد
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEntryModalOpen(false)}
                aria-label="إغلاق نافذة تسجيل المصروف"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#64746B] hover:bg-[#F6F7F4] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            <form onSubmit={handleSaveExpense} className="flex flex-col gap-4 py-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Category */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    تصنيف المصروف *
                  </label>
                  <select
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value as ExpenseCategory)}
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([catKey, label]) => (
                      <option key={catKey} value={catKey}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Amount */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    المبلغ بالجنيه المصري (ج.م) *
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={formAmount}
                    onChange={(e) => setFormAmount(e.target.value)}
                    placeholder="مثال: 4500"
                    required
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 font-mono font-bold text-sm outline-none focus:border-[#27695B]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Branch */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    الفرع المعني *
                  </label>
                  <select
                    value={formBranch}
                    onChange={(e) => setFormBranch(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                  >
                    <option value="فرع وسط البلد">فرع وسط البلد</option>
                    <option value="فرع التجمع الخامس">فرع التجمع الخامس</option>
                    <option value="فرع الشيخ زايد">فرع الشيخ زايد</option>
                    <option value="كافيه الإدارة (توزيع فروع)">كافيه الإدارة</option>
                  </select>
                </div>

                {/* Payment Method */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    طريقة الدفع *
                  </label>
                  <select
                    value={formPaymentMethod}
                    onChange={(e) => setFormPaymentMethod(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                  >
                    <option value="عهدة نقدية للفرع">عهدة نقدية للفرع</option>
                    <option value="بطاقة بنكية للشركة">بطاقة بنكية للشركة</option>
                    <option value="تحويل بنكي / إنستاباي">تحويل بنكي / إنستاباي</option>
                    <option value="فاتورة آجلة (للاعتماد)">فاتورة آجلة (للاعتماد)</option>
                    <option value="شيك مصرفي">شيك مصرفي</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Vendor Name */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    اسم المورد أو الجهة *
                  </label>
                  <input
                    type="text"
                    value={formVendor}
                    onChange={(e) => setFormVendor(e.target.value)}
                    placeholder="مثال: شركة البن الأخضر للتجارة"
                    required
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                  />
                </div>

                {/* Date */}
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                    تاريخ السند / الفاتورة *
                  </label>
                  <input
                    type="date"
                    value={formDate}
                    onChange={(e) => setFormDate(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                  />
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                  بيان المصروف وتفاصيله
                </label>
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="مثال: توريد 20 كجم بن كولومبيا تحميص طازج"
                  className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-sm outline-none focus:border-[#27695B]"
                />
              </div>

              {/* Receipt Upload Mock */}
              <div>
                <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                  مرفق الفاتورة أو إيصال السداد
                </label>
                <div
                  onClick={() => {
                    setFormHasReceiptMock(!formHasReceiptMock);
                    toast.info(formHasReceiptMock ? "تمت إزالة المرفق" : "تم إرفاق صورة الفاتورة بنجاح");
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors min-h-[80px]",
                    formHasReceiptMock
                      ? "border-emerald-500 bg-emerald-50/60"
                      : "border-[#E2E4DE] hover:border-[#27695B] bg-[#F6F7F4]/40"
                  )}
                >
                  {formHasReceiptMock ? (
                    <div className="flex items-center gap-2 text-emerald-700 font-bold text-xs">
                      <CheckCircle2 className="size-5" />
                      <span>تم إرفاق الفاتورة (invoice_scan_089.jpg) بنجاح - انقر للحذف</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-[#64746B]">
                      <UploadCloud className="size-6 text-[#27695B]" />
                      <span className="text-xs font-semibold text-[#17221E]">
                        انقر لمحاكاة رفع صورة الفاتورة
                      </span>
                      <span className="text-[10px]">يدعم JPG, PNG, PDF</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-bold text-[#17221E] block mb-1.5">
                  ملاحظات إضافية
                </label>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  placeholder="أي ملاحظات تخص الفحص أو الاعتماد..."
                  className="w-full rounded-xl border border-[#E2E4DE] bg-white p-3 text-xs outline-none focus:border-[#27695B]"
                />
              </div>

              {/* Submit Buttons */}
              <div className="border-t border-[#E2E4DE] pt-4 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEntryModalOpen(false)}
                  className="min-h-[44px] rounded-xl border border-[#E2E4DE] px-4 text-xs font-bold text-[#17221E] hover:bg-[#F6F7F4]"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="min-h-[44px] rounded-xl bg-[#27695B] px-6 text-xs font-bold text-white shadow-md hover:bg-[#1e5348] active:scale-98 transition-all"
                >
                  حفظ وتسجيل المصروف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Expense Detail Drawer (sm:max-w-xl) */}
      {detailExpense && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setDetailExpense(null)}
        >
          <div
            className="flex w-full sm:max-w-xl flex-col rounded-3xl bg-white p-5 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E2E4DE] pb-4">
              <div className="flex items-center gap-2">
                <FileText className="size-5 text-[#27695B]" />
                <div>
                  <h3 className="font-heading text-base font-bold text-[#17221E]">
                    تفاصيل سند المصروف ({detailExpense.code})
                  </h3>
                  <span className="text-xs text-[#64746B]">{detailExpense.date}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDetailExpense(null)}
                aria-label="إغلاق تفاصيل المصروف"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#64746B] hover:bg-[#F6F7F4] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-sm">
              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">المبلغ:</span>
                <span className="font-mono text-xl font-bold text-[#27695B] tabular-nums">
                  {formatMoney(detailExpense.amount, "EGP")}
                </span>
              </div>

              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">الحالة:</span>
                <ExpenseStatusBadge status={detailExpense.status} />
              </div>

              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">الفرع:</span>
                <span className="font-bold text-[#17221E]">{detailExpense.branchName}</span>
              </div>

              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">المورد / الجهة:</span>
                <span className="font-bold text-[#17221E]">{detailExpense.vendorName}</span>
              </div>

              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">طريقة الدفع:</span>
                <span>{detailExpense.paymentMethodAr}</span>
              </div>

              <div className="flex justify-between border-b border-[#F6F7F4] pb-2">
                <span className="text-[#64746B]">البيان:</span>
                <span className="text-[#17221E] text-start max-w-xs">{detailExpense.descriptionAr}</span>
              </div>

              {detailExpense.notes && (
                <div className="rounded-xl bg-[#F6F7F4] p-3 text-xs text-[#17221E]">
                  <span className="font-bold block mb-1">ملاحظات التدقيق:</span>
                  <p>{detailExpense.notes}</p>
                </div>
              )}
            </div>

            <div className="border-t border-[#E2E4DE] pt-4 flex gap-2 justify-end">
              {detailExpense.status === "PENDING" && (
                <button
                  type="button"
                  onClick={() => handleApproveExpense(detailExpense.id)}
                  className="min-h-[44px] rounded-xl bg-[#27695B] px-5 text-xs font-bold text-white shadow-sm hover:bg-[#1e5348]"
                >
                  اعتماد الصرف الآن
                </button>
              )}
              <button
                type="button"
                onClick={() => setDetailExpense(null)}
                className="min-h-[44px] rounded-xl border border-[#E2E4DE] px-4 text-xs font-bold text-[#17221E] hover:bg-[#F6F7F4]"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
