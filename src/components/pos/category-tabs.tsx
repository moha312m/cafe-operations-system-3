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
  const pageSize = 3;
  const activePage = Math.max(0, Math.floor(choices.findIndex(c => c.id === active) / pageSize));
  const [navigation, setNavigation] = useState(() => ({active, page: activePage}));
  const page = navigation.active === active ? navigation.page : activePage;
  function setPage(page: number) { setNavigation({active,page}); }
  const [panelOpen, setPanelOpen] = useState(false);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const pages = Math.ceil(choices.length / pageSize);
  const currentPage = Math.min(page, pages - 1);
  const selected = choices.find(c => c.id === active)?.name ?? "التصنيف غير متاح — اختر تصنيفًا";
  function choose(id: string) {
    onChange(id);
    setPage(Math.max(0, Math.floor(choices.findIndex(c => c.id === id) / pageSize)));
    setPanelOpen(false);
  }
  const tab = (id: string, label: string, icon?: string) => (
    <button
      key={id}
      type="button"
      aria-pressed={active === id}
      onClick={() => choose(id)}
      className={cn(
        "category-choice flex min-h-14 min-w-0 items-center gap-2 rounded-xl border-2 px-3 py-2 text-start text-sm font-semibold transition-colors active:scale-[0.98]",
        active === id
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card hover:bg-accent"
      )}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}{active === id && <span className="block text-xs">✓ محدد</span>}</span>
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
    <section aria-label="تصنيفات المنتجات" className="cashier-categories shrink-0 space-y-2 rounded-xl border bg-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">التصنيف المحدد: <strong>{selected}</strong></p>
        <Button className="category-all-products" variant="outline" aria-pressed={active === "all"} onClick={() => choose("all")}>كل المنتجات{active === "all" && " ✓ محدد"}</Button>
        {categories.length > 0 && <DialogTrigger render={<Button variant="outline" aria-controls={dialogId} />} onClick={() => setQuery("")}>كل التصنيفات ({categories.length})</DialogTrigger>}
      </div>
      <div className="category-pages grid grid-cols-2 gap-2 sm:grid-cols-3">{choices.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(c => tab(c.id,c.name,c.id === "all" ? "▦" : categoryIcon(c.name)))}</div>
      {pages > 1 && <div className="category-navigation flex items-center justify-between gap-2" aria-label="صفحات التصنيفات">
        <Button variant="outline" aria-label="التصنيفات السابقة" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>السابق</Button>
        <span role="status" className="text-sm">{currentPage + 1} / {pages}</span>
        <Button variant="outline" aria-label="التصنيفات التالية" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>التالي</Button>
      </div>}
        <DialogContent id={dialogId} className="sm:max-w-2xl" dir="rtl">
          <DialogHeader><DialogTitle>كل التصنيفات — اختر تصنيفًا</DialogTitle></DialogHeader>
          <Input aria-label="البحث في التصنيفات" placeholder="اسم التصنيف بالعربية أو الإنجليزية" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{choices.filter(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(c => tab(c.id,c.name,categoryIcon(c.name)))}</div>
          {!choices.some(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p role="status">لا توجد تصنيفات بهذا الاسم. غيّر البحث.</p>}
          <DialogFooter><Button variant="outline" onClick={() => setPanelOpen(false)}>رجوع للمنتجات</Button></DialogFooter>
        </DialogContent>
    </section>
    </Dialog>
  );
}
