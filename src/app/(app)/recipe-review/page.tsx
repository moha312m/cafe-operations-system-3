"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { PageHeader, LoadingState, EmptyState } from "@/components/cafe/ui";
import { RecipeEditor } from "@/components/menu/recipe-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
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
import { PROFIT_LABEL, type Profitability } from "@/lib/costing";
import { cn } from "@/lib/utils";

type Status = "VERIFIED" | "INCOMPLETE" | "NOT_APPLICABLE";
type CostStatus = "AVAILABLE" | "RECIPE_INCOMPLETE" | "NOT_APPLICABLE";
type NextAction = "CREATE_RECIPE" | "EDIT_RECIPE" | "CONFIRM" | "ENTER_COST" | null;
type BoardFilter = "ALL" | "AVAILABLE" | "NEEDS_REVIEW" | "NEEDS_CONFIRMATION" | "NOT_APPLICABLE";

type Row = {
  productId: string;
  productName: string;
  category: string | null;
  variantId: string | null;
  variantName: string | null;
  recipeId: string | null;
  defaultRecipeId: string | null;
  status: Status;
  source: string;
  structurallyValid: boolean;
  confirmed: boolean;
  costAvailable: boolean;
  varianceEligible: boolean;
  issues: string[];
  sellingPrice: number;
  costStatus: CostStatus;
  cost: number | null;
  profit: number | null;
  margin: number | null;
  tier: Profitability | null;
  nextAction: NextAction;
};

type AddOnRow = {
  addOnId: string;
  addOnName: string;
  recipeId: string | null;
  status: Status;
  confirmed: boolean;
  issues: string[];
};

type Payload = {
  rows: Row[];
  addOns: AddOnRow[];
  summary: {
    products: number;
    sellableConfigurations: number;
    verified: number;
    incomplete: number;
    notApplicable: number;
    costAvailable: number;
    needsReview: number;
    varianceEligiblePct: number;
    addOnsTotal: number;
    addOnsVerified: number;
  };
};

const ISSUE_LABELS: Record<string, string> = {
  MISSING_RECIPE: "لا توجد وصفة",
  MISSING_VARIANT_RECIPE: "وصفة الحجم غير موجودة ولا يوجد تعميم معتمد",
  MISSING_ADDON_RECIPE: "وصفة الإضافة ناقصة",
  INCOMPATIBLE_UNIT: "وحدة القياس غير متوافقة مع الخامة",
  INVALID_QUANTITY: "كمية الوصفة غير صالحة",
  MISSING_COST: "تكلفة خامة واحدة أو أكثر غير مدخلة",
  INACTIVE_INGREDIENT: "خامة الوصفة غير مفعّلة",
  NO_INGREDIENTS: "الوصفة لا تحتوي على خامات",
  NOT_CONFIRMED: "الوصفة صحيحة بنيويًا لكنها تحتاج تأكيدًا تشغيليًا",
  STALE_CONFIRMATION: "الوصفة عُدّلت بعد آخر تأكيد",
};

const SOURCE_LABELS: Record<string, string> = {
  VARIANT: "وصفة الحجم الدقيقة",
  PRODUCT_DEFAULT: "الوصفة الأساسية",
  PRODUCT_DEFAULT_ALL_VARIANTS: "وصفة أساسية مؤكدة لكل الأحجام",
  NONE: "لا يوجد مصدر وصفة موثوق",
};

const FILTERS: { value: BoardFilter; label: string }[] = [
  { value: "ALL", label: "الكل" },
  { value: "AVAILABLE", label: "مكتملة" },
  { value: "NEEDS_REVIEW", label: "تحتاج مراجعة" },
  { value: "NEEDS_CONFIRMATION", label: "تحتاج تأكيدًا" },
  { value: "NOT_APPLICABLE", label: "لا تنطبق" },
];

function statusFor(row: Row) {
  if (row.costStatus === "AVAILABLE") {
    return { label: "مكتملة", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
  }
  if (row.costStatus === "NOT_APPLICABLE") {
    return { label: "لا تنطبق", className: "bg-muted text-muted-foreground" };
  }
  if (row.structurallyValid && !row.confirmed) {
    return { label: "تحتاج تأكيدًا", className: "bg-sky-500/15 text-sky-700 dark:text-sky-400" };
  }
  return { label: "تحتاج مراجعة", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
}

function isShown(row: Row, filter: BoardFilter) {
  if (filter === "ALL") return true;
  if (filter === "AVAILABLE") return row.costStatus === "AVAILABLE";
  if (filter === "NOT_APPLICABLE") return row.costStatus === "NOT_APPLICABLE";
  if (filter === "NEEDS_CONFIRMATION") {
    return row.costStatus === "RECIPE_INCOMPLETE" && row.structurallyValid && !row.confirmed;
  }
  return row.costStatus === "RECIPE_INCOMPLETE" && !(row.structurallyValid && !row.confirmed);
}

function UnavailableValue({ row }: { row: Row }) {
  const label = row.costStatus === "NOT_APPLICABLE" ? "لا تنطبق" : "التكلفة غير متاحة";
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

export default function RecipeReviewPage() {
  const { cafe, can } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const canManageRecipes = can("recipe:manage");
  const canManageInventory = can("inventory:manage");
  const [data, setData] = useState<Payload | null>(null);
  const [filter, setFilter] = useState<BoardFilter>("ALL");
  const [category, setCategory] = useState("ALL");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorRow, setEditorRow] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setData(await api<Payload>("/api/recipes/review"));
    } catch (error) {
      // The server is the authority here and refuses this board to anyone
      // without profit visibility. Say so plainly instead of leaving an
      // unauthorised user watching a spinner that will never resolve.
      const message = error instanceof Error ? error.message : "فشل تحميل دقة وتكلفة المنتجات";
      setLoadError(message);
      toast.error(message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set((data?.rows ?? []).map((row) => row.category).filter(Boolean) as string[])].sort(),
    [data]
  );

  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ar");
    return (data?.rows ?? []).filter((row) => {
      const matchesText = !query || `${row.productName} ${row.variantName ?? ""}`.toLocaleLowerCase("ar").includes(query);
      const matchesCategory = category === "ALL" || row.category === category;
      return matchesText && matchesCategory && isShown(row, filter);
    });
  }, [category, data, filter, search]);

  async function confirm(recipeId: string) {
    setBusy(true);
    try {
      await api(`/api/recipes/${recipeId}/verify`, { method: "POST", body: {} });
      toast.success("تم تأكيد الوصفة التشغيلية");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "فشل تأكيد الوصفة");
    } finally {
      setBusy(false);
    }
  }

  async function copyDefault(row: Row) {
    if (!row.variantId) return;
    setBusy(true);
    try {
      await api("/api/recipes/copy-to-variants", {
        method: "POST",
        body: { productId: row.productId, variantIds: [row.variantId] },
      });
      toast.success("نُسخت الوصفة كمسودة؛ راجع كميات هذا الحجم ثم أكّدها");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "فشل نسخ الوصفة");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <EmptyState
        icon="🔒"
        message={`${loadError} — شاشة التكلفة والربحية متاحة لمن لديه صلاحية عرض الأرباح فقط.`}
      />
    );
  }
  if (!data) return <LoadingState />;

  const s = data.summary;

  return (
    <>
      <PageHeader
        title="دقة وتكلفة المنتجات"
        subtitle="تكلفة وربحية كل منتج وحجم من وصفته الفعلية فقط — بدون بدائل أو متوسطات مضللة"
      >
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
          ↻ تحديث
        </Button>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          ["الأصناف والأحجام المباعة", String(s.sellableConfigurations)],
          ["تكلفتها موثوقة", String(s.costAvailable)],
          ["تحتاج مراجعة", String(s.needsReview)],
          ["مؤهلة لحساب الفروقات", `${s.varianceEligiblePct}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 font-heading text-xl font-bold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 grid gap-2 rounded-xl border bg-card p-3 lg:grid-cols-[minmax(220px,1fr)_220px]">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="ابحث باسم المنتج أو الحجم…"
          aria-label="البحث في دقة وتكلفة المنتجات"
        />
        <Select value={category} onValueChange={(value) => setCategory(value ?? "ALL")}>
          <SelectTrigger className="w-full" aria-label="تصفية حسب التصنيف">
            <SelectValue>{category === "ALL" ? "كل التصنيفات" : category}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">كل التصنيفات</SelectItem>
            {categories.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1.5 lg:col-span-2">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                filter === item.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState message="لا توجد أصناف تطابق البحث والفلاتر" icon="📋" />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>المنتج / الحجم</TableHead>
                <TableHead>سعر البيع</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>COGS</TableHead>
                <TableHead>الربح المتوقع</TableHead>
                <TableHead>المارجن</TableHead>
                <TableHead className="min-w-64">السبب / مصدر الوصفة</TableHead>
                <TableHead>الإجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => {
                const status = statusFor(row);
                const trusted = row.costStatus === "AVAILABLE";
                return (
                  <TableRow key={`${row.productId}-${row.variantId ?? "base"}`}>
                    <TableCell>
                      <p className="font-medium">{row.productName}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.variantName ?? "بدون حجم"}{row.category ? ` · ${row.category}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="tabular-nums">{money(row.sellingPrice, currency)}</TableCell>
                    <TableCell><Badge className={status.className}>{status.label}</Badge></TableCell>
                    <TableCell className="tabular-nums">
                      {trusted && row.cost !== null ? money(row.cost, currency) : <UnavailableValue row={row} />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {trusted && row.profit !== null ? money(row.profit, currency) : <UnavailableValue row={row} />}
                    </TableCell>
                    <TableCell>
                      {trusted && row.margin !== null && row.tier ? (
                        <div>
                          <span className="font-medium tabular-nums">{row.margin}%</span>
                          <p className="text-[11px] text-muted-foreground">{PROFIT_LABEL[row.tier]}</p>
                        </div>
                      ) : <UnavailableValue row={row} />}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {row.issues.length > 0 ? (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          {row.issues.map((issue) => ISSUE_LABELS[issue] ?? issue).join(" · ")}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">{SOURCE_LABELS[row.source] ?? row.source}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {canManageRecipes && row.nextAction === "CONFIRM" && row.recipeId ? (
                        <Button size="sm" disabled={busy} onClick={() => void confirm(row.recipeId!)}>تأكيد الوصفة</Button>
                      ) : canManageRecipes && row.nextAction === "CREATE_RECIPE" && row.defaultRecipeId && row.variantId ? (
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void copyDefault(row)}>نسخ كمسودة</Button>
                          <Button size="sm" onClick={() => setEditorRow(row)}>إنشاء يدويًا</Button>
                        </div>
                      ) : canManageRecipes && (row.nextAction === "CREATE_RECIPE" || row.nextAction === "EDIT_RECIPE" || trusted) ? (
                        <Button size="sm" variant={trusted ? "outline" : "default"} onClick={() => setEditorRow(row)}>
                          {trusted ? "فتح الوصفة" : row.nextAction === "CREATE_RECIPE" ? "إنشاء الوصفة" : "مراجعة الوصفة"}
                        </Button>
                      ) : row.nextAction === "ENTER_COST" && canManageInventory ? (
                        <Button size="sm" nativeButton={false} render={<Link href="/inventory" />}>
                          إدخال تكلفة الخامة
                        </Button>
                      ) : row.nextAction === "ENTER_COST" ? (
                        <span className="text-xs text-muted-foreground">راجع مسؤول المخزون</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-heading text-lg font-semibold">
          دقة وصفات الإضافات ({s.addOnsVerified}/{s.addOnsTotal})
        </h2>
        <div className="divide-y rounded-xl border bg-card">
          {data.addOns.map((addOn) => (
            <div key={addOn.addOnId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{addOn.addOnName}</p>
                {addOn.issues.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {addOn.issues.map((issue) => ISSUE_LABELS[issue] ?? issue).join(" · ")}
                  </p>
                )}
              </div>
              <Badge variant="outline">
                {addOn.status === "VERIFIED" ? "مكتملة" : addOn.status === "NOT_APPLICABLE" ? "لا تنطبق" : "تحتاج مراجعة"}
              </Badge>
            </div>
          ))}
        </div>
      </section>

      <Dialog open={editorRow !== null} onOpenChange={(open) => !open && setEditorRow(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editorRow?.productName}{editorRow?.variantName ? ` — ${editorRow.variantName}` : ""}
            </DialogTitle>
          </DialogHeader>
          {editorRow && (
            <RecipeEditor
              productId={editorRow.productId}
              variantId={editorRow.variantId}
              sellingPrice={editorRow.sellingPrice}
              currency={currency}
              onSaved={async () => {
                setEditorRow(null);
                await load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
