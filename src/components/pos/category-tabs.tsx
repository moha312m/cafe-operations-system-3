"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
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
  const choices = [{ id: "all", name: "كل المنتجات" }, ...categories];
  const [panelOpen, setPanelOpen] = useState(false);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const selected = choices.find(c => c.id === active)?.name ?? "التصنيف غير متاح — اختر تصنيفًا";
  const activeCat = categories.find(c => c.id === active);
  const inTopThree = categories.slice(0, 3).some(c => c.id === active);
  function choose(id: string) {
    onChange(id);
    setPanelOpen(false);
  }
  const tab = (id: string, label: string, icon?: string) => (
    <button
      key={id}
      type="button"
      aria-pressed={active === id}
      onClick={() => choose(id)}
      className={cn(
        "category-choice flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-start text-sm font-semibold transition-colors",
        active === id
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card hover:bg-accent"
      )}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span className="min-w-0 flex-1 whitespace-normal" title={label}>{label}</span>
      {counts.has(id) && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 text-xs tabular-nums",
            active === id ? "bg-primary-foreground/20" : "bg-muted"
          )}
        >
          {counts.get(id)}
        </span>
      )}
    </button>
  );

  return (
    <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
    <section aria-label="تصنيفات المنتجات" className="cashier-categories flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-xl bg-card p-2">
      <Button size="sm" variant={active === "all" ? "default" : "outline"} aria-pressed={active === "all"} onClick={() => choose("all")}>كل المنتجات</Button>
      <div className="hidden min-w-0 flex-1 gap-1 min-[1100px]:flex">{categories.slice(0, 3).map(c => tab(c.id, c.name, categoryIcon(c.name)))}</div>
      {active !== "all" && (
        <div
          data-testid="active-category-pill"
          className={cn(
            "flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-primary bg-primary px-2.5 py-1 text-sm font-semibold text-primary-foreground",
            inTopThree && "min-[1100px]:hidden"
          )}
        >
          {activeCat && <span aria-hidden="true">{categoryIcon(activeCat.name)}</span>}
          <span className="truncate" title={selected}>{selected}</span>
          {activeCat && counts.has(activeCat.id) && (
            <span className="shrink-0 rounded-full bg-primary-foreground/20 px-1.5 text-xs tabular-nums">
              {counts.get(activeCat.id)}
            </span>
          )}
          <button
            type="button"
            aria-label={`مسح تصنيف ${selected}`}
            onClick={() => choose("all")}
            className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-foreground/20 text-xs hover:bg-primary-foreground/30"
          >
            ✕
          </button>
        </div>
      )}
      <span className="sr-only" role="status">التصنيف المحدد: {selected}</span>
      {categories.length > 0 && <DialogTrigger render={<Button size="sm" className="ms-auto" variant="outline" aria-controls={dialogId} />} onClick={() => setQuery("")}>كل التصنيفات</DialogTrigger>}
        <DialogContent id={dialogId} className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader><DialogTitle>كل التصنيفات — اختر تصنيفًا</DialogTitle></DialogHeader>
          <Input aria-label="البحث في التصنيفات" placeholder="اسم التصنيف بالعربية أو الإنجليزية" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{choices.filter(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(c => tab(c.id,c.name,categoryIcon(c.name)))}</div>
          {!choices.some(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p role="status">لا توجد تصنيفات بهذا الاسم. غيّر البحث.</p>}
          <DialogFooter>
            {active !== "all" && <Button variant="ghost" onClick={() => choose("all")}>مسح التصنيف</Button>}
            <Button variant="outline" onClick={() => setPanelOpen(false)}>رجوع للمنتجات</Button>
          </DialogFooter>
        </DialogContent>
    </section>
    </Dialog>
  );
}
