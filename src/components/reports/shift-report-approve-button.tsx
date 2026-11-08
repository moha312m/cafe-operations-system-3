"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  handoverId: string;
  shiftId: string;
  shiftNumber: number;
  status: string;
  hasStockSession: boolean;
  lineCount: number;
  countedLineCount?: number;
};

export function ShiftReportApproveButton({
  handoverId,
  status,
  hasStockSession,
  lineCount,
  countedLineCount,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(status === "COMPLETED");

  const actualCounted = countedLineCount ?? lineCount;

  if (completed) {
    return (
      <div className="no-print my-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-start text-xs text-emerald-800 dark:text-emerald-300">
        <p className="font-bold flex items-center gap-1.5 text-sm">
          <span>✓</span>
          <span>تم اعتماد جرد الخامات وتحديث أرصدة المخزون بالسيستم</span>
        </p>
        <p className="mt-1 text-muted-foreground">
          أرصدة الخامات الرسمية على الرف مطابقة للكميات الفعلية المعتمدة لهذا الشيفت، والشيفت مغلق نهائياً.
        </p>
      </div>
    );
  }

  if (!hasStockSession) {
    return null;
  }

  if (lineCount > 0 && actualCounted === 0) {
    return (
      <div className="no-print my-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-start text-xs text-amber-900 dark:text-amber-200">
        <p className="font-bold text-sm">⏳ بانتظار إدخال الجرد الفعلي من الموظف</p>
        <p className="mt-1 text-muted-foreground">
          لم يقم الموظف بإدخال كميات الجرد بعد ({lineCount} صنف مطلوب). بمجرد إدخال الكميات يمكنك اعتمادها وتحديث المخزون من هنا.
        </p>
      </div>
    );
  }

  async function handleApprove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/handovers/${handoverId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "تعذّر اعتماد الجرد");
      }

      toast.success(data.message || "تم اعتماد الجرد وتحديث أرصدة المخزون بنجاح!");
      setCompleted(true);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "حدث خطأ أثناء اعتماد الجرد");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="no-print my-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-start">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h3 className="font-bold text-sm sm:text-base text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
              <span>🛡️</span>
              <span>اعتماد جرد الخامات وتحديث المخزون (صلاحية الإدارة)</span>
            </h3>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
              تم تسجيل الجرد الفعلي للأصناف ({actualCounted} من {lineCount} صنف). يمكنك كمالك أو مدير اعتماد هذه الكميات لتعديل أرصدة المخزون الرسمية بالسيستم وتثبيت الفروقات وإغلاق العهدة.
            </p>
          </div>
          <Button
            type="button"
            className="shrink-0 font-bold bg-amber-600 hover:bg-amber-700 text-white"
            onClick={() => setOpen(true)}
          >
            اعتماد وتحديث المخزون
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl">
          <DialogHeader className="text-start">
            <DialogTitle>تأكيد اعتماد جرد الخامات وتحديث المخزون</DialogTitle>
            <DialogDescription className="text-start pt-2">
              هل أنت متأكد من رغبتك في اعتماد الجرد الفعلي؟
              <br />
              سيقوم السيستم بتطبيق تسوية جردية رسمية (Rebase) لتصبح أرصدة المخزن مطابقة للكميات الفعلية المسجلة، وتثبيت أي فروقات (عجز أو زيادة) على هذا الشيفت، وإغلاق التسليم رسمياً.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
              disabled={busy}
              onClick={() => void handleApprove()}
            >
              {busy ? "جارٍ الاعتماد وتحديث الأرصدة…" : "تأكيد الاعتماد وتحديث المخزون الآن"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              إلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
