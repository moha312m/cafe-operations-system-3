"use client";

import { cn } from "@/lib/utils";
import { menuCategoryIcon } from "./types";

// Horizontal scroll chips, sticky right under the sticky header (top offset
// = header height). Scrollbar hidden; chips sized for thumbs.
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
        "flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
        active === id
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "bg-card active:bg-accent"
      )}
    >
      {icon && <span>{icon}</span>}
      {label}
    </button>
  );

  return (
    <div className="sticky top-[61px] z-10 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tab("all", "الكل")}
      {categories.map((c) => tab(c.id, c.name, menuCategoryIcon(c.name)))}
    </div>
  );
}
