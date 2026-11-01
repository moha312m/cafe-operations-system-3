"use client";

// Frame for every accounting page: the experimental notice, the section tabs
// and the permission gate. The API enforces access; this only avoids
// rendering a page the reader cannot load.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/components/app-shell";

const TABS = [
  { href: "/accounting", label: "نظرة عامة" },
  { href: "/accounting/trial-balance", label: "ميزان المراجعة" },
  { href: "/accounting/ledger", label: "دفتر الأستاذ" },
  { href: "/accounting/journal", label: "القيود" },
];

export function AccountingShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { canKey } = useApp();
  if (!canKey("accounting.view")) {
    return <p role="alert" className="rounded-lg border p-4">ليس لديك صلاحية عرض المحاسبة.</p>;
  }
  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">المحاسبة والماليات</h1>
        <span className="rounded-full border border-amber-500 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="shadow-badge">تجريبي — غير معتمد</span>
      </div>
      <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
        دي دفاتر تجريبية للمراجعة بس، ومش دفاتر رسمية. الأرقام محتاجة مراجعة المحاسب، ومفيش تاريخ بداية ولا أرصدة افتتاحية معتمدة لحد دلوقتي.
      </p>
      {canKey("expenses.view") && <Link href="/expenses" className="underline">تسجيل ومراجعة مصروفات الدرج</Link>}
      <nav aria-label="أقسام المحاسبة" className="flex flex-wrap gap-2 border-b pb-2">
        {TABS.map((tab) => {
          const active = tab.href === "/accounting" ? pathname === tab.href : pathname === tab.href || pathname.startsWith(tab.href + "/");
          return (
            <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}

export function statusLabel(status: string) {
  return status === "OPEN" ? "مفتوحة" : status === "CLOSED" ? "مقفولة" : status;
}

export const SOURCE_LABELS: Record<string, string> = {
  SALE: "بيع", SALE_REVISION: "تعديل فاتورة", COLLECTION: "تحصيل", REFUND: "مرتجع", LEGACY_REFUND: "مرتجع قديم",
  CASH_TO_SAFE: "كاش للخزنة", STORED_CASH_MOVEMENT: "حركة خزنة", CASH_VARIANCE: "فرق كاش",
  PURCHASE_INVOICE: "فاتورة شراء", PURCHASE_CANCEL: "إلغاء فاتورة شراء", SUPPLIER_PAYMENT: "دفعة مورد",
  OPERATING_EXPENSE: "مصروف تشغيلي", OPERATING_EXPENSE_RETURN: "رد نقد مصروف",
  STOCK_MOVEMENT: "حركة مخزون", OPENING_BALANCE: "أرصدة افتتاحية", REVERSAL: "قيد عكسي",
};

export const ISSUE_LABELS: Record<string, string> = {
  UNPOSTABLE: "مايقدرش يترحّل", CHANGED: "المصدر اتغير", DISAPPEARED: "المصدر اختفى",
  FAILED: "فشل الترحيل", LATE_EVENT: "حدث متأخر في فترة مقفولة", ASSUMED_DATE: "تاريخ بالافتراض",
};
