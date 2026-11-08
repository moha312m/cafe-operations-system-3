"use client";

import { useApp } from "@/components/app-shell";
import { SalesResetCard } from "@/components/settings/sales-reset-card";
import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";

export default function SalesResetPage() {
  const { user } = useApp();

  if (user.role !== "CAFE_OWNER") {
    return (
      <div className="mx-auto max-w-lg p-8 text-center" dir="rtl">
        <ShieldAlert className="mx-auto mb-3 size-10 text-destructive" />
        <h2 className="text-lg font-bold text-destructive">صلاحية غير مصرح بها</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          هذه الصفحة مخصصة فقط لمالك الكافيه (Owner) لإدارة وتصفير البيانات التجريبية.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          العودة للوحة التحكم
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-6" dir="rtl">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/settings" className="hover:underline flex items-center gap-1 text-primary">
          <ArrowRight className="size-4" /> العودة للإعدادات
        </Link>
        <span>/</span>
        <span className="text-foreground font-semibold">تصفير المبيعات واسترجاع المخزون</span>
      </div>

      <SalesResetCard />
    </div>
  );
}
