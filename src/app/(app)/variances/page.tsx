"use client";

// SH-24 — the door to variance accountability.
//
// The service, its state machine and its permission split have existed since
// SH-12; what did not exist was any way to reach them. The nav has pointed
// here (gated on `variance.view`) since the keys were introduced, and the
// link answered 404. This page is that link's destination and nothing more:
// it lists what `GET /api/variances` returns and moves cases with
// `POST /api/variances/:id/advance`. It computes no status of its own.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { VarianceList, type VarianceRow } from "@/components/variances/variance-list";
import { VarianceDetail } from "@/components/variances/variance-detail";
import {
  STATUS_LABEL,
  TYPE_LABEL,
  VARIANCE_STATUSES,
  VARIANCE_TYPES,
} from "@/components/variances/variance-labels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY = "ALL";

export default function VariancesPage() {
  const { canKey, cafe, features } = useApp();
  const [cases, setCases] = useState<VarianceRow[]>([]);
  const [status, setStatus] = useState<string>(ANY);
  const [type, setType] = useState<string>(ANY);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allowed = canKey("variance.view");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Only ever the values the server's own filter schema accepts; an
      // unknown status is a 400 there, and inventing one here would turn a
      // filter into an error message.
      if (status !== ANY) params.set("status", status);
      if (type !== ANY) params.set("type", type);
      const { cases } = await api<{ cases: VarianceRow[] }>(
        `/api/variances?${params.toString()}`
      );
      setCases(cases);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تحميل الفروقات");
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, [allowed, status, type]);

  useEffect(() => {
    load();
  }, [load]);

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          ليس لديك صلاحية لعرض حالات الفروقات
        </p>
      </main>
    );
  }

  if (features && !features.shiftManagementEnabled) {
    return (
      <main className="p-6">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          خاصية إدارة الورديات مقفولة في الكافيه ده
        </p>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">الفروقات</h1>
        <div className="ms-auto flex flex-wrap gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v ?? ANY)}>
            <SelectTrigger className="w-44" aria-label="الحالة">
              <SelectValue placeholder="الحالة" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>كل الحالات</SelectItem>
              {VARIANCE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => setType(v ?? ANY)}>
            <SelectTrigger className="w-40" aria-label="النوع">
              <SelectValue placeholder="النوع" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>كل الأنواع</SelectItem>
              {VARIANCE_TYPES.map((v) => (
                <SelectItem key={v} value={v}>
                  {TYPE_LABEL[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-dashed bg-muted/30" />
      ) : (
        <VarianceList
          cases={cases}
          currency={cafe?.currency ?? "EGP"}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <VarianceDetail
        caseId={selectedId}
        onClose={() => setSelectedId(null)}
        onAdvanced={load}
      />
    </main>
  );
}
