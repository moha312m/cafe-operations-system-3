"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type Row = {
  id: string;
  name: string;
  category: string;
  sellingPrice: number;
  hasRecipe: boolean;
  cost: number;
  profit: number;
  margin: number;
  tier: Profitability;
};
type ReportData = {
  rows: Row[];
  summary: {
    total: number;
    withoutRecipe: number;
    lowMargin: number;
    topProfit: Row[];
    lowestProfit: Row[];
  };
};

const TIER_STYLE: Record<Profitability, string> = {
  high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  loss: "bg-destructive/10 text-destructive",
  "no-recipe": "bg-muted text-muted-foreground",
};

type ProfitFilter = "all" | "high" | "medium" | "low" | "loss" | "no-recipe";

export function ProductCostReport({ currency = "EGP" }: { currency?: string }) {
  const [data, setData] = useState<ReportData | null>(null);
  const [profitFilter, setProfitFilter] = useState<ProfitFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      setData(await api<ReportData>("/api/reports/product-cost"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل التقرير");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set(data?.rows.map((r) => r.category) ?? [])],
    [data]
  );

  const visible = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      if (profitFilter === "no-recipe") return !r.hasRecipe;
      if (profitFilter !== "all") return r.hasRecipe && r.tier === profitFilter;
      return true;
    });
  }, [data, profitFilter, categoryFilter]);

  if (!data) return <p className="text-muted-foreground">جاري التحميل…</p>;

  const cards = [
    { label: "إجمالي المنتجات", value: data.summary.total },
    { label: "منتجات بدون وصفة", value: data.summary.withoutRecipe, tone: "text-amber-600" },
    { label: "منتجات ذات هامش ضعيف", value: data.summary.lowMargin, tone: "text-destructive" },
    {
      label: "أعلى منتج ربحًا",
      value: data.summary.topProfit[0]
        ? `${data.summary.topProfit[0].name} (${data.summary.topProfit[0].margin}٪)`
        : "—",
      small: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {c.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn(c.small ? "text-base font-semibold" : "text-2xl font-semibold tabular-nums", c.tone)}>
                {c.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "all")}>
          <SelectTrigger className="w-40">
            <SelectValue>{categoryFilter === "all" ? "كل الأقسام" : categoryFilter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الأقسام</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={profitFilter} onValueChange={(v) => setProfitFilter((v ?? "all") as ProfitFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue>
              {profitFilter === "all" ? "كل الحالات" : PROFIT_LABEL[profitFilter as Profitability]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="high">ربح عالي</SelectItem>
            <SelectItem value="medium">ربح متوسط</SelectItem>
            <SelectItem value="low">ربح ضعيف</SelectItem>
            <SelectItem value="loss">هامش ضعيف</SelectItem>
            <SelectItem value="no-recipe">المنتجات بدون وصفة</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>المنتج</TableHead>
            <TableHead>القسم</TableHead>
            <TableHead>سعر البيع</TableHead>
            <TableHead>تكلفة المنتج</TableHead>
            <TableHead>الربح المتوقع</TableHead>
            <TableHead>هامش الربح</TableHead>
            <TableHead>حالة الربحية</TableHead>
            <TableHead>وصفة؟</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{r.category}</TableCell>
              <TableCell className="tabular-nums">{money(r.sellingPrice, currency)}</TableCell>
              <TableCell className="tabular-nums">{r.hasRecipe ? money(r.cost, currency) : "—"}</TableCell>
              <TableCell className="tabular-nums">{r.hasRecipe ? money(r.profit, currency) : "—"}</TableCell>
              <TableCell className="tabular-nums">{r.hasRecipe ? `${r.margin}٪` : "—"}</TableCell>
              <TableCell>
                <Badge className={TIER_STYLE[r.tier]}>{PROFIT_LABEL[r.tier]}</Badge>
              </TableCell>
              <TableCell>
                {r.hasRecipe ? (
                  <span className="text-emerald-600">✓</span>
                ) : (
                  <Badge variant="outline">لا</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
          {visible.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                مفيش منتجات مطابقة.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
