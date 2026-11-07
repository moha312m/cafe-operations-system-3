"use client";

import { useId } from "react";

export function OwnerOverrideField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1 rounded border border-dashed p-2 text-sm">
      <label htmlFor={id} className="block font-medium">كود تخويل المالك (اختياري)</label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        dir="ltr"
        className="min-h-11 w-full rounded border bg-background px-3"
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">أدخل رمز موافقة المالك لتجاوز الصلاحيات.</p>
    </div>
  );
}
