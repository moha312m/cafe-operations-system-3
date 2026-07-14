"use client";

import { cn } from "@/lib/utils";
import { IMPORT_MODE_LABELS, type ImportMode } from "@/lib/menu-import";

const MODE_HINTS: Record<ImportMode, string> = {
  create: "المنتجات الموجودة بنفس الاسم هتتجاهل",
  update: "المنتجات الجديدة اللي مش موجودة هتتجاهل",
  upsert: "الجديد يتضاف والموجود يتحدّث — الاختيار الأشمل",
};

export function MenuImportModeSelector({
  mode,
  onChange,
}: {
  mode: ImportMode;
  onChange: (mode: ImportMode) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {(Object.keys(IMPORT_MODE_LABELS) as ImportMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded-lg border p-3 text-start transition-colors",
            mode === m
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "hover:bg-accent"
          )}
        >
          <p className="text-sm font-semibold">{IMPORT_MODE_LABELS[m]}</p>
          <p className="mt-1 text-xs text-muted-foreground">{MODE_HINTS[m]}</p>
        </button>
      ))}
    </div>
  );
}
