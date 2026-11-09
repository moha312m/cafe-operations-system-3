"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { clientRequestUuid } from "@/lib/client-request-key";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  calculateMarginAndProfit,
  type RoundingMode,
  type MarginTier,
} from "@/lib/menu-pricing";

const TIER_STYLE: Record<MarginTier, string> = {
  high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  loss: "bg-destructive/10 text-destructive",
};

interface Branch {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

interface PreviewRow {
  targetType: "PRODUCT" | "VARIANT";
  targetKey: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  targetName: string;
  categoryName: string;
  costSource?: "RECIPE" | "DIRECT" | "NONE";
  costStatus: string;
  unitCost: number | null;
  currentPrice: number;
  rawSuggestedPrice: number | null;
  suggestedPrice: number | null;
  currentProfit: number | null;
  currentMargin: number | null;
  currentTier: MarginTier | null;
  suggestedProfit: number | null;
  suggestedMargin: number | null;
  suggestedTier: MarginTier | null;
  issues: string[];
}

interface WorkspaceRow extends PreviewRow {
  selected: boolean;
  finalPrice: string; // editable string in input
  isManualOverride: boolean;
}

interface BulkRepricingWorkspaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: Branch[];
  categories: Category[];
  currency?: string;
  onApplied?: () => void;
}

export function BulkRepricingWorkspace({
  open,
  onOpenChange,
  branches,
  categories,
  currency = "EGP",
  onApplied,
}: BulkRepricingWorkspaceProps) {
  // Parameters
  const [referenceBranchId, setReferenceBranchId] = useState<string>("all");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("all");
  const [multiplier, setMultiplier] = useState<number>(2.5);
  const [roundingMode, setRoundingMode] = useState<RoundingMode>("NEAREST");
  const [roundingStep, setRoundingStep] = useState<number>(5);

  // Data & State
  const [loading, setLoading] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [previewFingerprint, setPreviewFingerprint] = useState<string>("");
  const [rows, setRows] = useState<WorkspaceRow[]>([]);

  // Load Preview from Server
  const fetchPreview = useCallback(async () => {
    if (!open) return;
    if (!multiplier || multiplier <= 0 || multiplier > 100) {
      toast.error("يرجى إدخال معامل تسعير صالح بين 0.001 و 100");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{
        rows: PreviewRow[];
        previewFingerprint: string;
      }>("/api/menu-pricing/preview", {
        method: "POST",
        body: {
          referenceBranchId: referenceBranchId === "all" ? null : referenceBranchId,
          categoryId: selectedCategoryId === "all" ? null : selectedCategoryId,
          multiplier,
          roundingMode,
          roundingStep: roundingMode === "NONE" ? null : roundingStep,
        },
      });

      setPreviewFingerprint(res.previewFingerprint);
      setRows((prevRows) => {
        const existingOverrides = new Map<string, string>();
        for (const r of prevRows) {
          if (r.isManualOverride) {
            existingOverrides.set(r.targetKey, r.finalPrice);
          }
        }

        return res.rows.map((r) => {
          const hasManual = existingOverrides.has(r.targetKey);
          const finalVal = hasManual
            ? existingOverrides.get(r.targetKey)!
            : r.suggestedPrice !== null
              ? String(r.suggestedPrice)
              : String(r.currentPrice);

          return {
            ...r,
            // Per spec: Do not default-select pinned manual override rows for a later automatic bulk overwrite
            selected: hasManual ? false : r.suggestedPrice !== null,
            finalPrice: finalVal,
            isManualOverride: hasManual,
          };
        });
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل تحميل معاينة الأسعار");
    } finally {
      setLoading(false);
    }
  }, [open, referenceBranchId, selectedCategoryId, multiplier, roundingMode, roundingStep]);

  useEffect(() => {
    if (open) {
      void fetchPreview();
    }
  }, [open, fetchPreview]);

  // Handle final price edits
  const handlePriceChange = (targetKey: string, newPriceStr: string) => {
    setRows((current) =>
      current.map((r) => {
        if (r.targetKey !== targetKey) return r;
        const suggestedStr = r.suggestedPrice !== null ? String(r.suggestedPrice) : "";
        const isManual = newPriceStr !== suggestedStr;
        return {
          ...r,
          finalPrice: newPriceStr,
          isManualOverride: isManual,
        };
      })
    );
  };

  // Reset to suggested price
  const resetToSuggested = (targetKey: string) => {
    setRows((current) =>
      current.map((r) => {
        if (r.targetKey !== targetKey) return r;
        return {
          ...r,
          finalPrice: r.suggestedPrice !== null ? String(r.suggestedPrice) : String(r.currentPrice),
          isManualOverride: false,
        };
      })
    );
  };

  // Bulk reset of all manual overrides
  const resetAllManualOverrides = () => {
    setRows((current) =>
      current.map((r) => {
        if (!r.isManualOverride) return r;
        return {
          ...r,
          finalPrice: r.suggestedPrice !== null ? String(r.suggestedPrice) : String(r.currentPrice),
          isManualOverride: false,
        };
      })
    );
    toast.info("تمت استعادة الأسعار المقترحة لجميع التعديلات اليدوية");
  };

  // Selection toggles
  const toggleSelect = (targetKey: string) => {
    setRows((current) =>
      current.map((r) => (r.targetKey === targetKey ? { ...r, selected: !r.selected } : r))
    );
  };

  const toggleSelectAll = (select: boolean) => {
    setRows((current) =>
      current.map((r) => (r.suggestedPrice !== null ? { ...r, selected: select } : r))
    );
  };

  // Summary counts
  const eligibleCount = useMemo(
    () => rows.filter((r) => r.suggestedPrice !== null).length,
    [rows]
  );
  const selectedCount = useMemo(
    () => rows.filter((r) => r.selected && r.finalPrice).length,
    [rows]
  );
  const allEligibleSelected = eligibleCount > 0 && selectedCount === eligibleCount;

  // Apply Changes
  const handleApply = async () => {
    const selectedRows = rows.filter((r) => r.selected && r.finalPrice);
    if (selectedRows.length === 0) {
      toast.error("يرجى اختيار صنف واحد على الأقل للتطبيق");
      return;
    }

    setApplying(true);
    try {
      const intentKey = clientRequestUuid();
      const payloadItems = selectedRows.map((r) => ({
        targetType: r.targetType,
        productId: r.productId,
        variantId: r.variantId,
        newPrice: Number(r.finalPrice),
        currentPrice: r.currentPrice,
      }));

      await api("/api/menu-pricing/apply", {
        method: "POST",
        idempotencyKey: intentKey,
        body: {
          intentKey,
          previewFingerprint,
          items: payloadItems,
        },
      });

      toast.success(`تم بنجاح تحديث أسعار ${selectedRows.length} صنف/حجم في المنيو!`);
      setConfirmOpen(false);
      onOpenChange(false);
      onApplied?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل تطبيق الأسعار");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden flex flex-col p-6">
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  <span>⚡ مساحة إعادة تسعير المنيو حسب التكلفة</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-1">
                  معاينة واقتراح أسعار البيع استناداً لتكاليف الوصفات (COGS) مع إمكانية التعديل اليدوي والاعتماد الذري المباشر.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Controls Bar */}
          <div className="shrink-0 my-3 rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Reference Branch */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">الفرع المرجعي للتكلفة:</Label>
                <Select value={referenceBranchId} onValueChange={(v) => setReferenceBranchId(v ?? "all")}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل الفروع (المركز الرئيسي)</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Category Filter */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">القسم المستهدف:</Label>
                <Select value={selectedCategoryId} onValueChange={(v) => setSelectedCategoryId(v ?? "all")}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل الأقسام</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Rounding Mode */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">وضع التقريب:</Label>
                <Select value={roundingMode} onValueChange={(v) => setRoundingMode((v ?? "NONE") as RoundingMode)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">بدون تقريب (قرشين)</SelectItem>
                    <SelectItem value="NEAREST">لأقرب خطوة (NEAREST)</SelectItem>
                    <SelectItem value="UP">سقف لأعلى (UP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Rounding Step */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">خطوة التقريب:</Label>
                <Select
                  disabled={roundingMode === "NONE"}
                  value={String(roundingStep)}
                  onValueChange={(v) => setRoundingStep(Number(v) || 5)}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 {currency}</SelectItem>
                    <SelectItem value="5">5 {currency}</SelectItem>
                    <SelectItem value="10">10 {currency}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Multiplier Presets and Custom */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border/50">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">معامل الاستثمار:</span>
                {[2.0, 2.5, 3.0, 3.5].map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={multiplier === m ? "default" : "outline"}
                    className="h-7 text-xs px-2.5"
                    onClick={() => setMultiplier(m)}
                  >
                    ×{m.toFixed(1)}
                  </Button>
                ))}
                <div className="flex items-center gap-1.5 ms-2">
                  <span className="text-xs text-muted-foreground">مخصص:</span>
                  <Input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="100"
                    className="h-7 w-20 text-xs tabular-nums"
                    value={multiplier}
                    onChange={(e) => setMultiplier(Number(e.target.value) || 0)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {rows.filter((r) => r.isManualOverride).length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-amber-600 border-amber-500/30 hover:bg-amber-500/10"
                    onClick={resetAllManualOverrides}
                  >
                    ↺ استعادة المقترح للتعديلات اليدوية ({rows.filter((r) => r.isManualOverride).length})
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loading}
                  className="h-7 text-xs"
                  onClick={fetchPreview}
                >
                  {loading ? "جاري التحديث..." : "🔄 إعادة حساب المعاينة"}
                </Button>
              </div>
            </div>
          </div>

          {/* Table Container */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10 shadow-xs">
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={allEligibleSelected}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                  </TableHead>
                  <TableHead>المنتج / الحجم</TableHead>
                  <TableHead>القسم</TableHead>
                  <TableHead className="tabular-nums">التكلفة</TableHead>
                  <TableHead className="tabular-nums">السعر الحالي</TableHead>
                  <TableHead className="tabular-nums">السعر المقترح</TableHead>
                  <TableHead className="w-36">السعر النهائي المحدد</TableHead>
                  <TableHead>الهامش والربح المتوقع</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const finalNum = Number(row.finalPrice) || 0;
                  const unitCost = row.unitCost ?? 0;
                  const isEligible = row.suggestedPrice !== null && row.unitCost !== null;

                  // Live profit and margin for final price
                  let liveMargin = null;
                  let liveProfit = null;
                  let liveTier: MarginTier | null = null;
                  if (isEligible && finalNum > 0) {
                    const computed = calculateMarginAndProfit(finalNum, unitCost);
                    liveMargin = computed.margin.toNumber();
                    liveProfit = computed.profit.toNumber();
                    liveTier = computed.tier;
                  }

                  return (
                    <TableRow
                      key={row.targetKey}
                      className={cn(!isEligible && "opacity-60 bg-muted/20")}
                    >
                      <TableCell className="text-center">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          disabled={!isEligible}
                          checked={row.selected}
                          onChange={() => toggleSelect(row.targetKey)}
                        />
                      </TableCell>

                      <TableCell className="font-medium">
                        <div>
                          <span>{row.targetName}</span>
                          {row.targetType === "VARIANT" && (
                            <Badge variant="outline" className="ms-1.5 text-[10px] py-0">
                              حجم
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="text-xs text-muted-foreground">
                        {row.categoryName}
                      </TableCell>

                      <TableCell className="tabular-nums text-xs">
                        {row.unitCost !== null ? (
                          <div>
                            <span>{money(row.unitCost, currency)}</span>
                            {row.costSource === "RECIPE" && (
                              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 block font-normal">
                                وصفة معتمدة
                              </span>
                            )}
                            {row.costSource === "DIRECT" && (
                              <span className="text-[10px] text-sky-600 dark:text-sky-400 block font-normal">
                                تكلفة مباشرة
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">غير متاح</span>
                        )}
                      </TableCell>

                      <TableCell className="tabular-nums text-xs text-muted-foreground">
                        {money(row.currentPrice, currency)}
                      </TableCell>

                      <TableCell className="tabular-nums text-xs font-semibold text-primary">
                        {row.suggestedPrice !== null
                          ? money(row.suggestedPrice, currency)
                          : "—"}
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            step="0.5"
                            min="0"
                            dir="ltr"
                            className={cn(
                              "h-7 w-24 text-xs tabular-nums",
                              row.isManualOverride && "border-amber-500 font-semibold text-amber-600"
                            )}
                            value={row.finalPrice}
                            disabled={!isEligible}
                            onChange={(e) => handlePriceChange(row.targetKey, e.target.value)}
                          />
                          {row.isManualOverride && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                              title="استعادة السعر المقترح"
                              onClick={() => resetToSuggested(row.targetKey)}
                            >
                              ↺
                            </Button>
                          )}
                        </div>
                        {row.isManualOverride && (
                          <span className="block text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                            تعديل يدوي
                          </span>
                        )}
                      </TableCell>

                      <TableCell>
                        {liveMargin !== null && liveProfit !== null && liveTier ? (
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                                TIER_STYLE[liveTier]
                              )}
                            >
                              {money(liveProfit, currency)} · {liveMargin.toFixed(1)}٪
                            </span>
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {row.costStatus === "NOT_APPLICABLE"
                              ? "لا ينطبق"
                              : "الوصفة غير مكتملة"}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}

                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                      لا توجد أصناف مطابقة للبحث أو الفلتر المختار.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Footer Bar */}
          <DialogFooter className="shrink-0 mt-3 flex items-center justify-between gap-3 sm:justify-between border-t pt-3">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>إجمالي الأصناف: <strong>{rows.length}</strong></span>
              <span>•</span>
              <span>المؤهلة للتسعير: <strong>{eligibleCount}</strong></span>
              <span>•</span>
              <span>المحددة للتطبيق: <strong className="text-primary">{selectedCount}</strong></span>
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                إغلاق
              </Button>
              <Button
                type="button"
                disabled={selectedCount === 0 || applying}
                onClick={() => setConfirmOpen(true)}
              >
                {applying ? "جاري الاعتماد..." : `اعتماد وتطبيق الأسعار (${selectedCount})`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تأكيد تطبيق أسعار المنيو الجديدة</DialogTitle>
            <DialogDescription className="text-sm pt-2">
              سيتم تحديث أسعار <strong>{selectedCount}</strong> صنف/حجم في قاعدة البيانات فورياً وبشكل ذري.
              سيبدأ الكاشير ومنيو العميل في احتساب الأسعار الجديدة فور الحفظ.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0 mt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={applying}
              onClick={() => setConfirmOpen(false)}
            >
              رجوع للمعاينة
            </Button>
            <Button
              type="button"
              disabled={applying}
              onClick={handleApply}
            >
              {applying ? "جاري الحفظ..." : "تأكيد واعتماد الأسعار الآن"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
