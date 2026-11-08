"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  RotateCcw,
  ShieldAlert,
  Loader2,
  Calendar,
  Store,
  CheckCircle2,
  PackageOpen,
} from "lucide-react";

interface BranchOption {
  id: string;
  name: string;
}

interface RestoredItem {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  branchId: string;
}

interface ResetPreview {
  orderCount: number;
  totalAmount: number;
  paidAmount: number;
  itemsToRestore: RestoredItem[];
  affectedShiftCount: number;
  orderIds: string[];
}

export function SalesResetCard({ branches = [] }: { branches?: BranchOption[] }) {
  const [branchId, setBranchId] = useState<string>("ALL");
  const [resetMode, setResetMode] = useState<"ALL" | "PERIOD">("PERIOD");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const [passcode, setPasscode] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [executing, setExecuting] = useState(false);

  const isPhraseValid =
    confirmPhrase.trim() === "تصفير المبيعات" ||
    confirmPhrase.trim().toUpperCase() === "RESET";

  async function handleFetchPreview() {
    if (resetMode === "PERIOD" && !from && !to) {
      toast.error("يرجى تحديد تاريخ البداية أو النهاية أولاً عند اختيار فترة زمنية محددة");
      return;
    }

    setLoadingPreview(true);
    try {
      const res = await fetch("/api/sales/reset/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: branchId === "ALL" ? undefined : branchId,
          from: resetMode === "PERIOD" && from ? from : undefined,
          to: resetMode === "PERIOD" && to ? to : undefined,
          resetAll: resetMode === "ALL",
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || "فشل جلب المعاينة");
      }

      const data = await res.json();
      setPreview(data.preview);
      setModalOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "حدث خطأ أثناء معاينة التصفير");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleExecuteReset() {
    if (!preview || preview.orderCount === 0) {
      toast.error("لا توجد مبيعات لتصفيرها");
      return;
    }

    if (!isPhraseValid) {
      toast.error("يرجى كتابة عبارة التأكيد بشكل صحيح ('تصفير المبيعات' أو 'RESET')");
      return;
    }

    if (passcode.length < 6) {
      toast.error("يرجى إدخال رمز موافقة المالك (6 أرقام على الأقل)");
      return;
    }

    setExecuting(true);
    try {
      const res = await fetch("/api/sales/reset/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-owner-override-code": passcode,
        },
        body: JSON.stringify({
          branchId: branchId === "ALL" ? undefined : branchId,
          from: resetMode === "PERIOD" && from ? from : undefined,
          to: resetMode === "PERIOD" && to ? to : undefined,
          resetAll: resetMode === "ALL",
          confirmPhrase,
          code: passcode,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || "فشل تنفيذ تصفير المبيعات");
      }

      const data = await res.json();
      toast.success(
        `تم تصفير ${data.result.orderCount} طلب واسترجاع ${data.result.restoredItemsCount} صنف خامات للمخزون بنجاح`
      );

      // Reset state and close modal
      setModalOpen(false);
      setPreview(null);
      setPasscode("");
      setConfirmPhrase("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "حدث خطأ أثناء تنفيذ التصفير");
    } finally {
      setExecuting(false);
    }
  }

  return (
    <>
      <Card className="border-destructive/30 bg-destructive/5 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            <CardTitle className="text-base font-semibold">
              تصفير المبيعات واسترجاع المخزون (Sales Reset)
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            أداة مخصصة للمالك فقط لتطهير مبيعات وفواتير التجارب والتدريب، واسترجاع الخامات
            المستهلكة إلى رصيد المخزون، وإعادة ضبط الورديات قبل الافتتاح الرسمي.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-1">
          {/* Branch & Mode Selection */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1">
                <Store className="h-3.5 w-3.5 text-muted-foreground" />
                الفرع المستهدف
              </Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger className="h-9 bg-background">
                  <SelectValue placeholder="اختر الفرع" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">كل الفروع (تطهير شامل)</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1">
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                نطاق التصفير
              </Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg border bg-background p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setResetMode("PERIOD")}
                  className={`rounded py-1.5 font-medium transition-colors ${
                    resetMode === "PERIOD"
                      ? "bg-destructive text-destructive-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  فترة زمنية محددة
                </button>
                <button
                  type="button"
                  onClick={() => setResetMode("ALL")}
                  className={`rounded py-1.5 font-medium transition-colors ${
                    resetMode === "ALL"
                      ? "bg-destructive text-destructive-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  تصفير شامل للكل
                </button>
              </div>
            </div>
          </div>

          {/* Date range pickers for Period mode */}
          {resetMode === "PERIOD" && (
            <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-dashed border-destructive/20 bg-background/50 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="sales-reset-from" className="text-xs font-medium flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  من تاريخ
                </Label>
                <Input
                  id="sales-reset-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 bg-background"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sales-reset-to" className="text-xs font-medium flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  إلى تاريخ
                </Label>
                <Input
                  id="sales-reset-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 bg-background"
                />
              </div>
            </div>
          )}

          {/* Action Button: Preview first */}
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              لن يتم حذف أي بيانات قبل المعاينة وتأكيد كود المالك
            </p>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleFetchPreview}
              disabled={loadingPreview}
              className="gap-1.5"
            >
              {loadingPreview ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  جارِ المعاينة...
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4" />
                  معاينة التأثير أولاً
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Preview & Execution Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <DialogTitle className="text-base font-bold">
                معاينة وتأكيد تصفير المبيعات واسترجاع الخامات
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              راجع الأثر الحسابي والمخزني بدقة قبل الإقرار النهائي؛ هذه العملية لا يمكن الرجوع عنها.
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-4 py-2 text-sm">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg border bg-muted/40 p-2.5">
                  <span className="text-xs text-muted-foreground block">عدد الفواتير المستهدفة</span>
                  <span className="text-lg font-bold text-foreground">
                    {preview.orderCount}
                  </span>
                </div>
                <div className="rounded-lg border bg-muted/40 p-2.5">
                  <span className="text-xs text-muted-foreground block">إجمالي مبالغ المبيعات</span>
                  <span className="text-lg font-bold text-foreground">
                    {preview.totalAmount.toLocaleString()} ج.م
                  </span>
                </div>
                <div className="rounded-lg border bg-muted/40 p-2.5">
                  <span className="text-xs text-muted-foreground block">المبالغ المحصلة</span>
                  <span className="text-lg font-bold text-foreground">
                    {preview.paidAmount.toLocaleString()} ج.م
                  </span>
                </div>
                <div className="rounded-lg border bg-muted/40 p-2.5">
                  <span className="text-xs text-muted-foreground block">الورديات المتأثرة</span>
                  <span className="text-lg font-bold text-foreground">
                    {preview.affectedShiftCount}
                  </span>
                </div>
              </div>

              {/* Items to restore */}
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                  <span className="flex items-center gap-1">
                    <PackageOpen className="h-4 w-4 text-emerald-600" />
                    الخامات التي سيتم استرجاعها للمخزون ({preview.itemsToRestore.length})
                  </span>
                </div>

                {preview.itemsToRestore.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    لا توجد حركات استهلاك مخزون مسجلة لهذه الفواتير (لم يتم خصم خامات).
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto divide-y rounded border text-xs">
                    {preview.itemsToRestore.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between px-3 py-1.5 bg-background/50 hover:bg-muted/30"
                      >
                        <span className="font-medium">{item.name}</span>
                        <span className="font-mono text-emerald-600 font-semibold dir-ltr">
                          +{item.quantity} {item.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {preview.orderCount === 0 ? (
                <div className="rounded-lg bg-muted p-3 text-center text-xs text-muted-foreground">
                  لا توجد أي فواتير تطابق النطاق والفرع المحددين. لن يتم اتخاذ أي إجراء.
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-xs font-semibold text-destructive flex items-center gap-1">
                    <ShieldAlert className="h-4 w-4" />
                    خطوات التحقق الإلزامية لتنفيذ التصفير:
                  </p>

                  {/* Owner Passcode */}
                  <div className="space-y-1 rounded border border-dashed border-destructive/30 p-2.5 bg-background/80">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="sales-reset-passcode" className="text-xs font-semibold text-foreground">
                        رمز موافقة المالك (Passcode)
                      </Label>
                      <span className="text-[11px] font-bold text-destructive">إلزامي (6-12 رقم)</span>
                    </div>
                    <Input
                      id="sales-reset-passcode"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={12}
                      dir="ltr"
                      placeholder="••••••"
                      className="h-9 font-mono tracking-widest text-center bg-background"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ""))}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      رمز موافقة المالك المعتمد لعمليات الحذف والتصفير الحساسة.
                    </p>
                  </div>

                  {/* Confirmation text */}
                  <div className="space-y-1">
                    <Label htmlFor="confirm-reset-phrase" className="text-xs font-medium">
                      اكتب <span className="font-bold text-destructive">«تصفير المبيعات»</span> أو{" "}
                      <span className="font-bold text-destructive">«RESET»</span> لتأكيد التنفيذ:
                    </Label>
                    <Input
                      id="confirm-reset-phrase"
                      value={confirmPhrase}
                      onChange={(e) => setConfirmPhrase(e.target.value)}
                      placeholder="تصفير المبيعات"
                      className="h-9 bg-background"
                      autoComplete="off"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setModalOpen(false)}
              disabled={executing}
            >
              إلغاء
            </Button>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleExecuteReset}
              disabled={
                !preview ||
                preview.orderCount === 0 ||
                !isPhraseValid ||
                passcode.length < 6 ||
                executing
              }
              className="gap-1.5"
            >
              {executing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  جارِ تنفيذ التصفير والاسترجاع...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  تأكيد وتصفير المبيعات الآن
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
