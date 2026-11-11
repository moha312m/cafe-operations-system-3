"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ManagerHandoverActionDialog } from "@/components/handovers/manager-handover-action";

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
              تم تسجيل الجرد الفعلي للأصناف ({actualCounted} من {lineCount} صنف). يمكنك كمالك أو مدير اعتماد التسليم بعد تأكيد الجرد، بسبب مكتوب يتسجل باسمك.
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

      <ManagerHandoverActionDialog
        kind="approve"
        open={open}
        handoverId={handoverId}
        onClose={() => setOpen(false)}
        onDone={() => { setCompleted(true); router.refresh(); }}
      />
    </>
  );
}
