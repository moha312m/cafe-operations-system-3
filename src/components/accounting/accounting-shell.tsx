"use client";

// Frame for every accounting page: the experimental notice, the section tabs
// and the permission gate. The API enforces access; this only avoids
// rendering a page the reader cannot load.
import Link from "next/link";
import { PageHeader } from "@/components/cafe/ui";
import { usePathname } from "next/navigation";
import { useApp } from "@/components/app-shell";

const TABS = [
  { href: "/accounting/pnl", label: "الأرباح والخسائر (P&L)" },
  { href: "/accounting/trial-balance", label: "ميزان المراجعة" },
  { href: "/accounting/ledger", label: "دفتر الأستاذ" },
  { href: "/accounting/journal", label: "دفتر القيود" },
  { href: "/accounting/chart", label: "دليل الحسابات" },
  { href: "/accounting/statements", label: "الميزانية العمومية" },
  { href: "/accounting/status", label: "حالة النظام" },
];

export function AccountingShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { canKey } = useApp();
  if (!canKey("accounting.view")) {
    return <p role="alert" className="rounded-lg border p-4">ليس لديك صلاحية عرض المحاسبة.</p>;
  }
  return (
    <div className="workspace-page">
      <PageHeader title="المحاسبة والماليات">
        <span className="rounded-full border border-caramel-line bg-caramel-soft px-3 py-1 text-sm font-medium text-caramel-ink" data-testid="shadow-badge">تجريبي — غير معتمد</span>
      </PageHeader>
      <p className="rounded-xl border border-caramel-line bg-caramel-soft p-4 text-sm text-caramel-ink">
        دي دفاتر تجريبية للمراجعة بس، ومش دفاتر رسمية. الأرقام محتاجة مراجعة المحاسب، ومفيش تاريخ بداية ولا أرصدة افتتاحية معتمدة لحد دلوقتي.
      </p>
      {canKey("expenses.view") && <Link href="/expenses" className="underline">تسجيل ومراجعة مصروفات الدرج</Link>}
      <nav aria-label="أقسام المحاسبة" className="workspace-tabs">
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
