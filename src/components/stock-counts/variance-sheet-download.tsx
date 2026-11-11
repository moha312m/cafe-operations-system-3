"use client";

// Download of the variances workbook (`GET /api/stock-counts/variances/export`).
// A plain link: the file is built by the server under the reader's own
// permissions, and only confirmed counts are in it.

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

export function varianceSheetHref(params: { branchId?: string | null; from?: string; to?: string; sessionId?: string }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `/api/stock-counts/variances/export?${q.toString()}`;
}

/** Period picker and download button for the stock counts page. */
export function VarianceSheetDownload({ branchId }: { branchId: string }) {
  const [from, setFrom] = useState(() => `${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const valid = !!from && !!to && from <= to;
  return (
    <section className="flex flex-wrap items-end gap-2 rounded-xl border bg-muted/20 p-3" aria-label="شيت الفروقات">
      <div className="me-auto space-y-0.5">
        <p className="text-sm font-medium">شيت فروقات الجرد</p>
        <p className="text-xs text-muted-foreground">العجز والزيادة لكل صنف وقيمتها وأثرها على الأرباح — للجرود المؤكدة بس</p>
      </div>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">من</span>
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" aria-label="من تاريخ" />
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">إلى</span>
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" aria-label="إلى تاريخ" />
      </label>
      <a
        href={valid ? varianceSheetHref({ branchId, from, to }) : undefined}
        aria-disabled={!valid}
        className={cn(buttonVariants({ size: "sm" }), "h-9 gap-1.5", !valid && "pointer-events-none opacity-50")}
        data-testid="download-variance-sheet"
      >
        <FileSpreadsheet className="size-4" aria-hidden />
        تنزيل شيت الفروقات
      </a>
    </section>
  );
}
