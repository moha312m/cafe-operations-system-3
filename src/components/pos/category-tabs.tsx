"use client";

import { cn } from "@/lib/utils";
import { categoryIcon, type Category } from "./types";

export function CategoryTabs({
  categories,
  active,
  counts,
  onChange,
}: {
  categories: Category[];
  active: string; // "all" or category id
  counts: Map<string, number>; // category id → product count
  onChange: (id: string) => void;
}) {
  const tab = (id: string, label: string, icon?: string) => (
    <button
      key={id}
      type="button"
      onClick={() => onChange(id)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
        active === id
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card hover:bg-accent"
      )}
    >
      {icon && <span>{icon}</span>}
      {label}
      {counts.has(id) && (
        <span
          className={cn(
            "rounded-full px-1.5 text-xs tabular-nums",
            active === id ? "bg-primary-foreground/20" : "bg-muted"
          )}
        >
          {counts.get(id)}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {tab("all", "الكل")}
      {categories.map((c) => tab(c.id, c.name, categoryIcon(c.name)))}
    </div>
  );
}
