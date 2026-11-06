"use client";

import { useApp } from "@/components/app-shell";

// Drawer expenses and the treasury (accounts and transfers) are built for the Egyptian pound only: the
// database itself pins their currency. A cafe in another currency is told so instead of meeting a refusal
// on every save. Generalising them needs a reviewed migration of those tables' constraints.
export function EgpOnlyNotice({ what }: { what: string }) {
  const { cafe } = useApp();
  if (!cafe || cafe.currency === "EGP") return null;
  return (
    <p role="status" data-testid="egp-only-notice" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-base text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      {what} متاحة حاليًا بالجنيه المصري فقط، وعملة الكافيه ({cafe.currency}) غير مدعومة هنا بعد — محاولات الحفظ هتترفض.
    </p>
  );
}
