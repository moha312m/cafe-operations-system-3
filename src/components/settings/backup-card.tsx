"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Database, Download, FileJson, ShieldCheck, AlertCircle } from "lucide-react";

interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupDetails: unknown;
  passcodeConfigured: boolean;
}

export function BackupCard() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"sql" | "json">("sql");
  const [passcode, setPasscode] = useState("");
  const [downloading, setDownloading] = useState(false);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/backup/export?status=true");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (e) {
      console.error("Failed to load backup status", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchStatus(), 0);
    return () => clearTimeout(timer);
  }, []);

  function handleOpenModal(format: "sql" | "json") {
    setExportFormat(format);
    setPasscode("");
    setModalOpen(true);
  }

  async function handleDownload() {
    if (!passcode || passcode.length < 6) {
      toast.error("أدخل رمز موافقة المالك المكون من ٦ إلى ١٢ رقمًا");
      return;
    }

    setDownloading(true);
    try {
      const res = await fetch(`/api/backup/export?format=${exportFormat}`, {
        headers: {
          "x-owner-override-code": passcode,
        },
      });

      if (!res.ok) {
        let errorMsg = "فشل تنزيل النسخة الاحتياطية";
        try {
          const errData = await res.json();
          errorMsg = errData.error || errData.message || errorMsg;
        } catch {
          // fallback if response is not json
        }
        toast.error(errorMsg);
        return;
      }

      // Extract filename from header if present
      const disposition = res.headers.get("content-disposition");
      let filename = `nextcup-backup-${new Date().toISOString().slice(0, 10)}.${exportFormat}`;
      if (disposition) {
        const match = disposition.match(/filename="?([^";]+)"?/i);
        if (match?.[1]) {
          filename = match[1];
        }
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      toast.success(`تم تنزيل النسخة الاحتياطية بنجاح: ${filename}`);
      setModalOpen(false);
      setPasscode("");
      fetchStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "حدث خطأ أثناء تنزيل النسخة الاحتياطية");
    } finally {
      setDownloading(false);
    }
  }

  const formatTimestamp = (iso: string | null) => {
    if (!iso) return "لم يتم تصدير نسخ سابقة بعد";
    try {
      const d = new Date(iso);
      return d.toLocaleString("ar-EG", {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  };

  return (
    <>
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            النسخ الاحتياطي والأمان (قاعدة البيانات)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            تصدير وتنزيل نسخة احتياطية شاملة ومطهرة من جميع بيانات الكافيه (الفروع، المنتجات، المبيعات، المخزون، الحسابات واليوميات) بصيغة SQL متوافقة مع PostgreSQL أو JSON مهيكل.
          </p>

          <div className="rounded-lg border bg-muted/40 p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">آخر نسخة تم تنزيلها:</span>
              <span className="font-medium font-mono text-foreground" dir="ltr">
                {loading ? "جاري التحميل..." : formatTimestamp(status?.lastBackupAt ?? null)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>الحماية والأمان: يتم تطهير كلمات المرور ورموز الدخول السرية تلقائيًا لحماية الأمان.</span>
            </div>
          </div>

          {!loading && !status?.passcodeConfigured && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">باسكود المالك غير مضبوط</p>
                <p className="text-xs mt-1">
                  لتنزيل النسخة الاحتياطية، يجب ضبط باسكود المالك أولاً من بطاقة «موافقات المالك» في هذه الصفحة.
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              onClick={() => handleOpenModal("sql")}
              disabled={loading || !status?.passcodeConfigured || downloading}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              تنزيل نسخة احتياطية (SQL)
            </Button>

            <Button
              variant="outline"
              onClick={() => handleOpenModal("json")}
              disabled={loading || !status?.passcodeConfigured || downloading}
              className="flex items-center gap-2"
            >
              <FileJson className="h-4 w-4" />
              تصدير JSON مهيكل
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              تأكيد تصدير النسخة الاحتياطية ({exportFormat.toUpperCase()})
            </DialogTitle>
            <DialogDescription className="text-sm">
              لأسباب أمنية ولحماية بيانات الكافيه، يرجى إدخال رمز موافقة المالك (Passcode من ٦–١٢ رقمًا).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="backup-passcode">رمز موافقة المالك (Passcode)</Label>
              <Input
                id="backup-passcode"
                type="password"
                inputMode="numeric"
                maxLength={12}
                autoComplete="off"
                dir="ltr"
                placeholder="أدخل ٦ إلى ١٢ رقمًا"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && passcode.length >= 6 && !downloading) {
                    handleDownload();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                الرمز الذي تم ضبطه في إعدادات موافقات المالك.
              </p>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={downloading}>
              إلغاء
            </Button>
            <Button
              onClick={handleDownload}
              disabled={downloading || passcode.length < 6}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              {downloading ? "جاري التجهيز والتنزيل..." : "تأكيد وتنزيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
