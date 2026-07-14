"use client";

import { cn } from "@/lib/utils";
import { menuCategoryIcon } from "./types";

export function CustomerCategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: { id: string; name: string }[];
  active: string; // "all" or category id
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
    </button>
  );

  return (
    <div className="sticky top-0 z-10 -mx-4 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur">
      {tab("all", "كل المنتجات")}
      {categories.map((c) => tab(c.id, c.name, menuCategoryIcon(c.name)))}
    </div>
  );
}
