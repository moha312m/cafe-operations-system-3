"use client";

import { t } from "@/lib/i18n";
import { PageHeader, Panel } from "@/components/admin/ui";

// Platform settings — placeholder surface. The super admin's own account
// is managed like any other; cafe-level settings live inside each cafe.
export default function AdminSettingsPage() {
  return (
    <>
      <PageHeader title={t.admin.nav.settings} subtitle="إعدادات المنصة" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="المنصة">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">اسم المنصة</dt><dd className="font-medium">{t.admin.brand}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">العملة الافتراضية</dt><dd className="font-medium">EGP — ج.م</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">اللغة</dt><dd className="font-medium">العربية (RTL)</dd></div>
          </dl>
        </Panel>
        <Panel title="ملاحظات">
          <p className="text-sm leading-relaxed text-slate-500">
            إعدادات كل كافيه (العملة، الضريبة، الفروع، المنيو) بتتدار من داخل صفحة الكافيه نفسه.
            الأدوار والصلاحيات ثابتة في النظام لضمان عزل البيانات بين الكافيهات.
          </p>
        </Panel>
      </div>
    </>
  );
}
