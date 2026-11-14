"use client";

// Frame for every accounting page: the experimental notice, operational links,
// section tabs, and permission gate. The API enforces access; this only avoids
// rendering a page the reader cannot load.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ShieldAlert, Wallet } from "lucide-react";
import { useApp } from "@/components/app-shell";
import { PageHeader, EmptyState } from "@/components/cafe/ui";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/accounting/pnl", label: "الأرباح والخسائر" },
  { href: "/accounting/trial-balance", label: "ميزان المراجعة" },
  { href: "/accounting/ledger", label: "دفتر الأستاذ" },
  { href: "/accounting/journal", label: "دفتر القيود" },
  { href: "/accounting/chart", label: "دليل الحسابات" },
  { href: "/accounting/statements", label: "القوائم المالية" },
  { href: "/accounting/status", label: "التحكم والمطابقة" },
];

export function AccountingShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { canKey } = useApp();
  if (!canKey("accounting.view")) {
    return (
      <div className="workspace-page">
        <EmptyState message="ليس لديك صلاحية عرض المحاسبة." icon="🔒" />
      </div>
    );
  }
  return (
    <div className="workspace-page">
      <PageHeader
        title="المحاسبة والماليات"
        subtitle="الدفاتر والقوائم المالية ومطابقة المخزون والموردين — متابعة لحظية لهوية الكافيه"
      >
        {canKey("expenses.view") && (
          <Link
            href="/expenses"
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <BookOpen className="size-4 text-primary" />
            <span>مصروفات الدرج</span>
          </Link>
        )}
        {canKey("treasury.view") && (
          <Link
            href="/treasury"
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <Wallet className="size-4 text-primary" />
            <span>الخزينة والتحويلات</span>
          </Link>
        )}
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-caramel-line bg-caramel-soft px-3.5 py-1.5 text-xs font-semibold text-caramel-ink"
          data-testid="shadow-badge"
        >
          <ShieldAlert className="size-3.5" />
          <span>تجريبي — غير معتمد</span>
        </span>
      </PageHeader>

      <div
        role="note"
        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-caramel-line bg-caramel-soft px-4 py-3 text-sm text-caramel-ink"
      >
        <p className="leading-relaxed">
          دي دفاتر تجريبية للمراجعة والرقابة التشغيلية، ومش دفاتر ضريبية رسمية. الأرقام والترحيلات الآلية للمصروفات والتحويلات والأرصدة الافتتاحية تحتاج اعتماد المحاسب.
        </p>
      </div>

      <nav
        aria-label="أقسام المحاسبة"
        className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-sm"
      >
        {TABS.map((tab) => {
          const active = tab.href === "/accounting" ? pathname === tab.href : pathname === tab.href || pathname.startsWith(tab.href + "/");
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-xl px-3.5 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
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
  SALE: "بيع",
  SALE_REVISION: "تعديل فاتورة",
  COLLECTION: "تحصيل",
  REFUND: "مرتجع",
  LEGACY_REFUND: "مرتجع قديم",
  CASH_TO_SAFE: "كاش للخزينة",
  STORED_CASH_MOVEMENT: "حركة خزنة",
  CASH_VARIANCE: "فرق كاش",
  PURCHASE_INVOICE: "فاتورة شراء",
  PURCHASE_CANCEL: "إلغاء فاتورة شراء",
  SUPPLIER_PAYMENT: "دفعة مورد",
  OPERATING_EXPENSE: "مصروف تشغيلي",
  OPERATING_EXPENSE_RETURN: "رد نقد مصروف",
  TREASURY_OPENING: "رصيد خزينة افتتاحي",
  TREASURY_TRANSFER_DISPATCH: "تحويل مالي صادر",
  TREASURY_TRANSFER_RECEIVE: "تحويل مالي وارد",
  STOCK_MOVEMENT: "حركة مخزون",
  OPENING_BALANCE: "أرصدة افتتاحية",
  REVERSAL: "قيد عكسي",
};

export const ISSUE_LABELS: Record<string, string> = {
  UNPOSTABLE: "غير قابل للترحيل الآلي",
  CHANGED: "المصدر تغيّر",
  DISAPPEARED: "المصدر اختفى",
  FAILED: "فشل الترحيل",
  LATE_EVENT: "حدث متأخر في فترة مقفولة",
  ASSUMED_DATE: "تاريخ بالافتراض",
};
