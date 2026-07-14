"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MenuImportDialog } from "@/components/menu-import/menu-import-dialog";
import { RecipeEditor } from "@/components/menu/recipe-editor";
import { ProductCostReport } from "@/components/menu/product-cost-report";

// ─────────────────────────── Types ───────────────────────────

type Category = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  showInCustomerMenu: boolean;
  _count: { products: number };
};
type AddOn = { id: string; name: string; price: string; isActive: boolean };
type Branch = { id: string; name: string };
type VariantRow = { name: string; price: string; isAvailable: boolean };
type Product = {
  id: string;
  name: string;
  description: string | null;
  basePrice: string;
  costPrice: string | null;
  imageUrl: string | null;
  isActive: boolean;
  showInCustomerMenu: boolean;
  showInPOS: boolean;
  isAvailable: boolean;
  sortOrder: number;
  category: { id: string; name: string };
  variants: { id: string; name: string; price: string; isActive: boolean }[];
  addOns: { addOn: AddOn }[];
  branchPrices: { branchId: string; price: string }[];
  // Attached only when the caller has cost:read.
  hasRecipe?: boolean;
  cost?: number;
  profit?: number;
  margin?: number;
  tier?: "high" | "medium" | "low" | "loss" | "no-recipe";
};

type ProductForm = {
  id: string | null;
  name: string;
  description: string;
  categoryId: string;
  basePrice: string;
  costPrice: string;
  imageUrl: string;
  showInCustomerMenu: boolean;
  showInPOS: boolean;
  isAvailable: boolean;
  sortOrder: string;
  variants: VariantRow[];
  addOnIds: Set<string>;
  branchPricing: boolean; // false = سعر موحد لكل الفروع
  branchPrices: Record<string, string>; // branchId → price
};

type CategoryForm = {
  id: string | null;
  name: string;
  sortOrder: string;
  isActive: boolean;
  showInCustomerMenu: boolean;
};

const emptyProductForm = (categoryId = ""): ProductForm => ({
  id: null,
  name: "",
  description: "",
  categoryId,
  basePrice: "",
  costPrice: "",
  imageUrl: "",
  showInCustomerMenu: true,
  showInPOS: true,
  isAvailable: true,
  sortOrder: "0",
  variants: [],
  addOnIds: new Set(),
  branchPricing: false,
  branchPrices: {},
});

type AvailabilityFilter = "all" | "available" | "unavailable";
type VisibilityFilter = "all" | "visible" | "hidden";

// ─────────────────────────── Page ───────────────────────────

export default function MenuPage() {
  const { cafe, can } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const showCost = can("cost:read");

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [addOns, setAddOns] = useState<AddOn[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [availabilityFilter, setAvailabilityFilter] =
    useState<AvailabilityFilter>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all");

  // Dialogs / inline edit
  const [productForm, setProductForm] = useState<ProductForm | null>(null);
  const [categoryForm, setCategoryForm] = useState<CategoryForm | null>(null);
  const [priceEditId, setPriceEditId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");

  // Add-ons tab
  const [addOnName, setAddOnName] = useState("");
  const [addOnPrice, setAddOnPrice] = useState("");

  // استيراد المنيو من Excel
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, p, a, b] = await Promise.all([
        api<{ categories: Category[] }>("/api/categories"),
        api<{ products: Product[] }>("/api/products"),
        api<{ addOns: AddOn[] }>("/api/addons"),
        api<{ branches: Branch[] }>("/api/branches"),
      ]);
      setCategories(c.categories);
      setProducts(p.products);
      setAddOns(a.addOns);
      setBranches(b.branches);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل المنيو");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "حصل خطأ");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ── Filtering ────────────────────────────────────────────────
  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((p) => {
      if (categoryFilter !== "all" && p.category.id !== categoryFilter) return false;
      if (availabilityFilter === "available" && !p.isAvailable) return false;
      if (availabilityFilter === "unavailable" && p.isAvailable) return false;
      if (visibilityFilter === "visible" && !p.showInCustomerMenu) return false;
      if (visibilityFilter === "hidden" && p.showInCustomerMenu) return false;
      if (term && !p.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [products, search, categoryFilter, availabilityFilter, visibilityFilter]);

  // ── Product save ─────────────────────────────────────────────
  async function saveProduct() {
    if (!productForm) return;
    const body = {
      name: productForm.name,
      description: productForm.description || undefined,
      categoryId: productForm.categoryId,
      basePrice: Number(productForm.basePrice),
      costPrice: productForm.costPrice === "" ? null : Number(productForm.costPrice),
      imageUrl: productForm.imageUrl.trim() || "",
      showInCustomerMenu: productForm.showInCustomerMenu,
      showInPOS: productForm.showInPOS,
      isAvailable: productForm.isAvailable,
      sortOrder: Number(productForm.sortOrder) || 0,
      variants: productForm.variants
        .filter((v) => v.name.trim() !== "" && v.price !== "")
        .map((v, i) => ({
          name: v.name,
          price: Number(v.price),
          isAvailable: v.isAvailable,
          sortOrder: i,
        })),
      addOnIds: [...productForm.addOnIds],
      branchPrices: productForm.branchPricing
        ? Object.entries(productForm.branchPrices)
            .filter(([, price]) => price !== "")
            .map(([branchId, price]) => ({ branchId, price: Number(price) }))
        : [],
    };
    const ok = await run(
      () =>
        productForm.id
          ? api(`/api/products/${productForm.id}`, { method: "PATCH", body })
          : api("/api/products", { method: "POST", body }),
      productForm.id ? "اتعدّل المنتج" : "اتضاف المنتج"
    );
    if (ok) setProductForm(null);
  }

  function editProduct(p: Product) {
    setProductForm({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      categoryId: p.category.id,
      basePrice: String(p.basePrice),
      costPrice: p.costPrice === null ? "" : String(p.costPrice),
      imageUrl: p.imageUrl ?? "",
      showInCustomerMenu: p.showInCustomerMenu,
      showInPOS: p.showInPOS,
      isAvailable: p.isAvailable,
      sortOrder: String(p.sortOrder),
      variants: p.variants.map((v) => ({
        name: v.name,
        price: String(v.price),
        isAvailable: v.isActive,
      })),
      addOnIds: new Set(p.addOns.map((a) => a.addOn.id)),
      branchPricing: p.branchPrices.length > 0,
      branchPrices: Object.fromEntries(
        p.branchPrices.map((bp) => [bp.branchId, String(bp.price)])
      ),
    });
  }

  // ── Quick actions ────────────────────────────────────────────
  function quickToggleAvailability(p: Product) {
    run(
      () =>
        api(`/api/products/${p.id}`, {
          method: "PATCH",
          body: { isAvailable: !p.isAvailable },
        }),
      p.isAvailable ? `«${p.name}» بقى غير متاح` : `«${p.name}» بقى متاح`
    );
  }

  async function commitQuickPrice(p: Product) {
    const newPrice = Number(priceDraft);
    setPriceEditId(null);
    if (!priceDraft || isNaN(newPrice) || newPrice < 0 || newPrice === Number(p.basePrice)) {
      return;
    }
    await run(
      () =>
        api(`/api/products/${p.id}`, {
          method: "PATCH",
          body: { basePrice: newPrice },
        }),
      `سعر «${p.name}» بقى ${money(newPrice, currency)}`
    );
  }

  // ── Category save ────────────────────────────────────────────
  async function saveCategory() {
    if (!categoryForm) return;
    const body = {
      name: categoryForm.name,
      sortOrder: Number(categoryForm.sortOrder) || 0,
      showInCustomerMenu: categoryForm.showInCustomerMenu,
      ...(categoryForm.id ? { isActive: categoryForm.isActive } : {}),
    };
    const ok = await run(
      () =>
        categoryForm.id
          ? api(`/api/categories/${categoryForm.id}`, { method: "PATCH", body })
          : api("/api/categories", { method: "POST", body }),
      categoryForm.id ? "اتعدّل القسم" : "اتضاف القسم"
    );
    if (ok) setCategoryForm(null);
  }

  // ─────────────────────────── Render ───────────────────────────
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">المنيو والأسعار</h1>
        <p className="text-sm text-muted-foreground">
          المصدر الوحيد للمنتجات والأسعار — أي تعديل هنا بيظهر فوراً في الكاشير
          ومنيو العميل. العملة: جنيه مصري.
        </p>
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">المنتجات</TabsTrigger>
          <TabsTrigger value="categories">أقسام المنيو</TabsTrigger>
          <TabsTrigger value="addons">الإضافات</TabsTrigger>
          {showCost && (
            <TabsTrigger value="cost-report">تقرير التكلفة</TabsTrigger>
          )}
        </TabsList>

        {/* ════════════════════ المنتجات ════════════════════ */}
        <TabsContent value="products">
          <div className="flex flex-col gap-4 lg:flex-row">
            {/* ── Categories side panel ── */}
            <aside className="w-full shrink-0 space-y-1 lg:w-52">
              <p className="px-1 pb-1 text-xs font-semibold text-muted-foreground">
                أقسام المنيو
              </p>
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                  categoryFilter === "all" && "bg-accent"
                )}
              >
                كل الأقسام
                <Badge variant="secondary">{products.length}</Badge>
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryFilter(c.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                    categoryFilter === c.id && "bg-accent",
                    !c.isActive && "opacity-50"
                  )}
                >
                  <span className="truncate">{c.name}</span>
                  <Badge variant="secondary">{c._count.products}</Badge>
                </button>
              ))}
            </aside>

            {/* ── Products main ── */}
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="ابحث عن منتج..."
                  className="w-56"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Select
                  value={availabilityFilter}
                  onValueChange={(v) => setAvailabilityFilter((v ?? "all") as AvailabilityFilter)}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue>
                      {availabilityFilter === "all"
                        ? "كل المنتجات"
                        : availabilityFilter === "available"
                          ? "المنتجات المتاحة"
                          : "المنتجات غير المتاحة"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل المنتجات</SelectItem>
                    <SelectItem value="available">المنتجات المتاحة</SelectItem>
                    <SelectItem value="unavailable">المنتجات غير المتاحة</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={visibilityFilter}
                  onValueChange={(v) => setVisibilityFilter((v ?? "all") as VisibilityFilter)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue>
                      {visibilityFilter === "all"
                        ? "منيو العميل: الكل"
                        : visibilityFilter === "visible"
                          ? "ظاهرة في منيو العميل"
                          : "مخفية من منيو العميل"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">منيو العميل: الكل</SelectItem>
                    <SelectItem value="visible">ظاهرة في منيو العميل</SelectItem>
                    <SelectItem value="hidden">مخفية من منيو العميل</SelectItem>
                  </SelectContent>
                </Select>
                <div className="ms-auto flex gap-2">
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    📄 استيراد المنيو من Excel
                  </Button>
                  <Button
                    onClick={() =>
                      setProductForm(
                        emptyProductForm(
                          categoryFilter !== "all"
                            ? categoryFilter
                            : categories[0]?.id ?? ""
                        )
                      )
                    }
                    disabled={categories.length === 0}
                  >
                    إضافة منتج جديد
                  </Button>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>اسم المنتج</TableHead>
                    <TableHead>القسم</TableHead>
                    <TableHead>سعر البيع</TableHead>
                    {showCost && <TableHead>تكلفة المنتج</TableHead>}
                    {showCost && <TableHead>الربح / الهامش</TableHead>}
                    <TableHead>الأحجام</TableHead>
                    <TableHead>الظهور</TableHead>
                    <TableHead>متاح للطلب</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleProducts.map((p) => (
                    <TableRow key={p.id} className={cn(!p.isActive && "opacity-50")}>
                      <TableCell className="font-medium">
                        {p.name}
                        {p.branchPrices.length > 0 && (
                          <span className="ms-1 text-xs text-muted-foreground">
                            🏬 سعر حسب الفرع
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.category.name}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {priceEditId === p.id ? (
                          <Input
                            autoFocus
                            type="number"
                            min="0"
                            step="0.5"
                            dir="ltr"
                            className="h-8 w-24"
                            value={priceDraft}
                            onChange={(e) => setPriceDraft(e.target.value)}
                            onBlur={() => commitQuickPrice(p)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitQuickPrice(p);
                              if (e.key === "Escape") setPriceEditId(null);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="rounded px-1 font-semibold underline decoration-dotted underline-offset-4 hover:bg-accent"
                            title="اضغط لتعديل السعر"
                            onClick={() => {
                              setPriceDraft(String(p.basePrice));
                              setPriceEditId(p.id);
                            }}
                          >
                            {money(p.basePrice, currency)}
                          </button>
                        )}
                      </TableCell>
                      {showCost && (
                        <TableCell className="tabular-nums">
                          {p.hasRecipe ? money(p.cost ?? 0, currency) : "—"}
                        </TableCell>
                      )}
                      {showCost && (
                        <TableCell>
                          {p.hasRecipe ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                                p.tier === "high"
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                  : p.tier === "medium"
                                    ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                                    : p.tier === "low"
                                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                      : "bg-destructive/10 text-destructive"
                              )}
                            >
                              {money(p.profit ?? 0, currency)} · {p.margin}٪
                            </span>
                          ) : (
                            <Badge variant="outline">لا توجد وصفة</Badge>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-xs text-muted-foreground">
                        {p.variants.length > 0
                          ? p.variants
                              .map((v) => `${v.name} ${money(v.price, currency)}`)
                              .join(" · ")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Badge variant={p.showInCustomerMenu ? "secondary" : "outline"}>
                            {p.showInCustomerMenu ? "يظهر للعميل" : "مخفي عن العميل"}
                          </Badge>
                          <Badge variant={p.showInPOS ? "secondary" : "outline"}>
                            {p.showInPOS ? "يظهر للكاشير" : "مخفي عن الكاشير"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant={p.isAvailable ? "outline" : "destructive"}
                          disabled={busy}
                          onClick={() => quickToggleAvailability(p)}
                        >
                          {p.isAvailable ? "متاح ✓" : "غير متاح"}
                        </Button>
                      </TableCell>
                      <TableCell className="text-end [&>button]:ms-1">
                        <Button size="sm" variant="outline" onClick={() => editProduct(p)}>
                          تعديل
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () =>
                                api(`/api/products/${p.id}`, {
                                  method: "PATCH",
                                  body: { isActive: !p.isActive },
                                }),
                              p.isActive ? "المنتج اتأرشف" : "المنتج رجع تاني"
                            )
                          }
                        >
                          {p.isActive ? "أرشفة" : "استرجاع"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleProducts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={showCost ? 9 : 7} className="py-8 text-center text-muted-foreground">
                        مفيش منتجات مطابقة للفلاتر.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>

        {/* ════════════════════ أقسام المنيو ════════════════════ */}
        <TabsContent value="categories" className="space-y-3">
          <Button
            onClick={() =>
              setCategoryForm({
                id: null,
                name: "",
                sortOrder: String(categories.length),
                isActive: true,
                showInCustomerMenu: true,
              })
            }
          >
            إضافة قسم جديد
          </Button>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>اسم القسم</TableHead>
                <TableHead>ترتيب الظهور</TableHead>
                <TableHead>عدد المنتجات</TableHead>
                <TableHead>منيو العميل</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="tabular-nums">{c.sortOrder}</TableCell>
                  <TableCell className="tabular-nums">{c._count.products}</TableCell>
                  <TableCell>
                    <Badge variant={c.showInCustomerMenu ? "secondary" : "outline"}>
                      {c.showInCustomerMenu ? "يظهر في منيو العميل" : "مخفي"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.isActive ? "secondary" : "outline"}>
                      {c.isActive ? "متاح" : "موقوف"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end [&>button]:ms-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setCategoryForm({
                          id: c.id,
                          name: c.name,
                          sortOrder: String(c.sortOrder),
                          isActive: c.isActive,
                          showInCustomerMenu: c.showInCustomerMenu,
                        })
                      }
                    >
                      تعديل
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy || c._count.products > 0}
                      title={c._count.products > 0 ? "انقل المنتجات الأول" : undefined}
                      onClick={() =>
                        run(
                          () => api(`/api/categories/${c.id}`, { method: "DELETE" }),
                          "اتحذف القسم"
                        )
                      }
                    >
                      حذف
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* ════════════════════ الإضافات ════════════════════ */}
        <TabsContent value="addons" className="space-y-3">
          <form
            className="flex max-w-md gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  api("/api/addons", {
                    method: "POST",
                    body: { name: addOnName, price: Number(addOnPrice) },
                  }),
                "اتضافت الإضافة"
              ).then((ok) => {
                if (ok) {
                  setAddOnName("");
                  setAddOnPrice("");
                }
              });
            }}
          >
            <Input
              placeholder="اسم الإضافة"
              value={addOnName}
              onChange={(e) => setAddOnName(e.target.value)}
              required
            />
            <Input
              type="number"
              step="0.5"
              min="0"
              placeholder="سعر الإضافة"
              className="w-32"
              value={addOnPrice}
              onChange={(e) => setAddOnPrice(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy}>
              إضافة جديدة
            </Button>
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>اسم الإضافة</TableHead>
                <TableHead>سعر الإضافة</TableHead>
                <TableHead>مرتبطة بـ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {addOns.map((a) => {
                const linked = products.filter((p) =>
                  p.addOns.some((x) => x.addOn.id === a.id)
                );
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="tabular-nums">
                      {money(a.price, currency)}
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                      {linked.length > 0
                        ? linked.map((p) => p.name).join("، ")
                        : "غير مرتبطة بمنتجات"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TabsContent>

        {showCost && (
          <TabsContent value="cost-report" className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">تقرير تكلفة المنتجات</h2>
              <p className="text-sm text-muted-foreground">
                التكلفة محسوبة من وصفات المنتجات وأسعار الخامات في المخزون.
              </p>
            </div>
            <ProductCostReport currency={currency} />
          </TabsContent>
        )}
      </Tabs>

      {/* ════════════════ Product dialog ════════════════ */}
      <Dialog open={productForm !== null} onOpenChange={(o) => !o && setProductForm(null)}>
        <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {productForm?.id ? "تعديل منتج" : "إضافة منتج جديد"}
            </DialogTitle>
          </DialogHeader>
          {productForm && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>اسم المنتج</Label>
                  <Input
                    value={productForm.name}
                    onChange={(e) =>
                      setProductForm({ ...productForm, name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>القسم</Label>
                  <Select
                    value={productForm.categoryId}
                    onValueChange={(v) =>
                      setProductForm({ ...productForm, categoryId: v ?? "" })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="اختار">
                        {categories.find((c) => c.id === productForm.categoryId)?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Pricing */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label>سعر البيع (جنيه)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    dir="ltr"
                    value={productForm.basePrice}
                    onChange={(e) =>
                      setProductForm({ ...productForm, basePrice: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>تكلفة المنتج (اختياري)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    dir="ltr"
                    value={productForm.costPrice}
                    onChange={(e) =>
                      setProductForm({ ...productForm, costPrice: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>ترتيب الظهور</Label>
                  <Input
                    type="number"
                    dir="ltr"
                    value={productForm.sortOrder}
                    onChange={(e) =>
                      setProductForm({ ...productForm, sortOrder: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>الوصف</Label>
                <Textarea
                  rows={2}
                  value={productForm.description}
                  onChange={(e) =>
                    setProductForm({ ...productForm, description: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>صورة المنتج (رابط)</Label>
                <Input
                  dir="ltr"
                  placeholder="https://…"
                  value={productForm.imageUrl}
                  onChange={(e) =>
                    setProductForm({ ...productForm, imageUrl: e.target.value })
                  }
                />
              </div>

              {/* Visibility */}
              <div className="flex flex-wrap gap-4">
                {(
                  [
                    ["isAvailable", "متاح للبيع"],
                    ["showInCustomerMenu", "يظهر في منيو العميل"],
                    ["showInPOS", "يظهر في الكاشير"],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={productForm[key]}
                      onChange={(e) =>
                        setProductForm({ ...productForm, [key]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>

              <Separator />

              {/* Variants — absolute prices */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>الأحجام (كل حجم بسعره النهائي)</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setProductForm({
                        ...productForm,
                        variants: [
                          ...productForm.variants,
                          { name: "", price: "", isAvailable: true },
                        ],
                      })
                    }
                  >
                    إضافة حجم
                  </Button>
                </div>
                {productForm.variants.map((v, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="اسم الحجم (صغير/وسط/كبير)"
                      value={v.name}
                      onChange={(e) => {
                        const variants = [...productForm.variants];
                        variants[i] = { ...v, name: e.target.value };
                        setProductForm({ ...productForm, variants });
                      }}
                    />
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      dir="ltr"
                      className="w-28"
                      placeholder="سعر الحجم"
                      value={v.price}
                      onChange={(e) => {
                        const variants = [...productForm.variants];
                        variants[i] = { ...v, price: e.target.value };
                        setProductForm({ ...productForm, variants });
                      }}
                    />
                    <label className="flex shrink-0 cursor-pointer items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={v.isAvailable}
                        onChange={(e) => {
                          const variants = [...productForm.variants];
                          variants[i] = { ...v, isAvailable: e.target.checked };
                          setProductForm({ ...productForm, variants });
                        }}
                      />
                      متاح
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() =>
                        setProductForm({
                          ...productForm,
                          variants: productForm.variants.filter((_, j) => j !== i),
                        })
                      }
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                {productForm.variants.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    لو في أحجام، سعر الحجم هو اللي بيتحاسب بيه — مش سعر البيع الأساسي.
                  </p>
                )}
              </div>

              {/* Add-ons */}
              {addOns.length > 0 && (
                <div className="space-y-2">
                  <Label>الإضافات المتاحة للمنتج</Label>
                  <div className="flex flex-wrap gap-2">
                    {addOns.map((a) => (
                      <Button
                        key={a.id}
                        size="sm"
                        variant={productForm.addOnIds.has(a.id) ? "default" : "outline"}
                        onClick={() => {
                          const addOnIds = new Set(productForm.addOnIds);
                          if (addOnIds.has(a.id)) addOnIds.delete(a.id);
                          else addOnIds.add(a.id);
                          setProductForm({ ...productForm, addOnIds });
                        }}
                      >
                        {a.name} (+{money(a.price, currency)})
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <Separator />

              {/* Branch pricing */}
              <div className="space-y-2">
                <Label>التسعير حسب الفرع</Label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={!productForm.branchPricing ? "default" : "outline"}
                    onClick={() =>
                      setProductForm({ ...productForm, branchPricing: false })
                    }
                  >
                    سعر موحد لكل الفروع
                  </Button>
                  <Button
                    size="sm"
                    variant={productForm.branchPricing ? "default" : "outline"}
                    onClick={() =>
                      setProductForm({ ...productForm, branchPricing: true })
                    }
                  >
                    سعر مختلف حسب الفرع
                  </Button>
                </div>
                {productForm.branchPricing && (
                  <div className="space-y-2 rounded-md border p-3">
                    {branches.map((b) => (
                      <div key={b.id} className="flex items-center gap-2">
                        <span className="w-40 truncate text-sm">سعر {b.name}</span>
                        <Input
                          type="number"
                          step="0.5"
                          min="0"
                          dir="ltr"
                          className="w-28"
                          placeholder={productForm.basePrice || "السعر"}
                          value={productForm.branchPrices[b.id] ?? ""}
                          onChange={(e) =>
                            setProductForm({
                              ...productForm,
                              branchPrices: {
                                ...productForm.branchPrices,
                                [b.id]: e.target.value,
                              },
                            })
                          }
                        />
                        <span className="text-xs text-muted-foreground">
                          سيبه فاضي = السعر الأساسي
                        </span>
                      </div>
                    ))}
                    {productForm.variants.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        فرق سعر الفرع بيتطبق تلقائياً على كل الأحجام.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* الوصفة والتكلفة — only for saved products, cost-privileged roles */}
              {showCost && productForm.id && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <Label className="text-base font-semibold">الوصفة والتكلفة</Label>
                    <RecipeEditor
                      productId={productForm.id}
                      sellingPrice={Number(productForm.basePrice) || 0}
                      currency={currency}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            {showCost && !productForm?.id && (
              <p className="me-auto self-center text-xs text-muted-foreground">
                احفظ المنتج الأول عشان تضيفله وصفة.
              </p>
            )}
            <Button
              onClick={saveProduct}
              disabled={
                busy ||
                !productForm?.name ||
                !productForm?.categoryId ||
                productForm?.basePrice === ""
              }
            >
              {busy ? "جاري الحفظ…" : "حفظ المنتج"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════════ Menu import wizard ════════════════ */}
      <MenuImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={load}
      />

      {/* ════════════════ Category dialog ════════════════ */}
      <Dialog open={categoryForm !== null} onOpenChange={(o) => !o && setCategoryForm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {categoryForm?.id ? "تعديل قسم" : "إضافة قسم جديد"}
            </DialogTitle>
          </DialogHeader>
          {categoryForm && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>اسم القسم</Label>
                <Input
                  value={categoryForm.name}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>ترتيب الظهور</Label>
                <Input
                  type="number"
                  dir="ltr"
                  value={categoryForm.sortOrder}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, sortOrder: e.target.value })
                  }
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={categoryForm.showInCustomerMenu}
                  onChange={(e) =>
                    setCategoryForm({
                      ...categoryForm,
                      showInCustomerMenu: e.target.checked,
                    })
                  }
                />
                يظهر في منيو العميل
              </label>
              {categoryForm.id && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={categoryForm.isActive}
                    onChange={(e) =>
                      setCategoryForm({ ...categoryForm, isActive: e.target.checked })
                    }
                  />
                  متاح
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveCategory} disabled={busy || !categoryForm?.name}>
              {busy ? "جاري الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
