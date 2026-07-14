"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportMode, RawImportRow } from "@/lib/menu-import";
import { DownloadMenuTemplateButton } from "./download-template-button";
import { MenuImportUploader } from "./menu-import-uploader";
import { MenuImportPreviewTable, type PreviewRow } from "./menu-import-preview-table";
import { MenuImportModeSelector } from "./menu-import-mode-selector";
import {
  MenuImportSummary,
  type FailedRow,
  type ImportSummary,
} from "./menu-import-summary";

type Step = "upload" | "preview" | "result";

const STEPS: { key: Step | "template" | "mode" | "confirm"; label: string }[] = [
  { key: "template", label: "١. تحميل القالب" },
  { key: "upload", label: "٢. رفع الملف" },
  { key: "preview", label: "٣. معاينة البيانات" },
  { key: "mode", label: "٤. طريقة الاستيراد" },
  { key: "confirm", label: "٥. تأكيد الاستيراد" },
  { key: "result", label: "٦. النتيجة" },
];

// استيراد المنيو من Excel — the whole wizard in one dialog.
export function MenuImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [rawRows, setRawRows] = useState<RawImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewStats, setPreviewStats] = useState<{
    ready: number;
    errors: number;
    newProducts: number;
    existingProducts: number;
  } | null>(null);
  const [ignored, setIgnored] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<ImportMode>("upsert");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [failedRows, setFailedRows] = useState<FailedRow[]>([]);

  function reset() {
    setStep("upload");
    setRawRows([]);
    setFileName("");
    setPreviewRows([]);
    setPreviewStats(null);
    setIgnored(new Set());
    setMode("upsert");
    setSummary(null);
    setFailedRows([]);
  }

  async function handleParsed(rows: RawImportRow[], name: string) {
    setBusy(true);
    try {
      const result = await api<{
        rows: PreviewRow[];
        stats: { ready: number; errors: number; newProducts: number; existingProducts: number };
      }>("/api/menu-import/preview", { method: "POST", body: { rows } });
      setRawRows(rows);
      setFileName(name);
      setPreviewRows(result.rows);
      setPreviewStats(result.stats);
      setIgnored(new Set());
      setStep("preview");
      if (result.stats.errors > 0) {
        toast.warning("بعض الصفوف بها أخطاء — راجع المعاينة");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشلت معاينة الملف");
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    setBusy(true);
    try {
      const result = await api<{ summary: ImportSummary; failedRows: FailedRow[] }>(
        "/api/menu-import",
        {
          method: "POST",
          body: {
            rows: rawRows,
            mode,
            fileName,
            ignoredRowNumbers: [...ignored],
          },
        }
      );
      setSummary(result.summary);
      setFailedRows(result.failedRows);
      setStep("result");
      onImported();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الاستيراد");
    } finally {
      setBusy(false);
    }
  }

  const importableCount = previewRows.filter(
    (r) => r.status === "ready" && !ignored.has(r.rowNumber)
  ).length;

  const activeIndex = step === "upload" ? 1 : step === "preview" ? 2 : 5;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>استيراد المنيو من Excel</DialogTitle>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                i <= activeIndex || (step === "result" && i === 5)
                  ? "border-primary bg-primary/10 font-medium"
                  : "text-muted-foreground"
              )}
            >
              {s.label}
            </span>
          ))}
        </div>

        {/* ── Step: upload ── */}
        {step === "upload" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">مش عندك ملف جاهز؟</p>
                <p className="text-xs text-muted-foreground">
                  حمّل القالب واملأه بمنتجاتك — الأعمدة المطلوبة: القسم، اسم
                  المنتج، سعر البيع.
                </p>
              </div>
              <DownloadMenuTemplateButton />
            </div>
            <MenuImportUploader onParsed={handleParsed} />
            {busy && (
              <p className="text-center text-sm text-muted-foreground">
                جاري تجهيز المعاينة…
              </p>
            )}
          </div>
        )}

        {/* ── Step: preview + mode + confirm ── */}
        {step === "preview" && previewStats && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">معاينة المنيو</h3>
              <Badge variant="secondary">
                {previewStats.ready} جاهز للاستيراد
              </Badge>
              {previewStats.errors > 0 && (
                <Badge variant="destructive">{previewStats.errors} يوجد خطأ</Badge>
              )}
              <Badge variant="outline">
                {previewStats.newProducts} منتج جديد · {previewStats.existingProducts} موجود
              </Badge>
              <span className="ms-auto text-xs text-muted-foreground" dir="ltr">
                {fileName}
              </span>
            </div>

            <MenuImportPreviewTable
              rows={previewRows}
              ignored={ignored}
              onToggleIgnore={(rowNumber) =>
                setIgnored((prev) => {
                  const next = new Set(prev);
                  if (next.has(rowNumber)) next.delete(rowNumber);
                  else next.add(rowNumber);
                  return next;
                })
              }
            />

            <div className="space-y-2">
              <h3 className="font-semibold">طريقة الاستيراد</h3>
              <MenuImportModeSelector mode={mode} onChange={setMode} />
            </div>

            {previewStats.errors > 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                ⚠️ بعض الصفوف بها أخطاء — الصفوف السليمة بس هي اللي هتتستورد،
                والصفوف الغلط هتظهر في تقرير الأخطاء.
              </p>
            )}

            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={reset}>
                رجوع لرفع ملف تاني
              </Button>
              <Button
                onClick={confirmImport}
                disabled={busy || importableCount === 0}
              >
                {busy
                  ? "جاري الاستيراد…"
                  : `تأكيد الاستيراد (${importableCount} صف)`}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: result ── */}
        {step === "result" && summary && (
          <MenuImportSummary
            summary={summary}
            failedRows={failedRows}
            onClose={() => {
              onOpenChange(false);
              reset();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
