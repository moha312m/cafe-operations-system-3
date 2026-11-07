"use client";

// SH-24 — the door to variance accountability.
//
// The service, its state machine and its permission split have existed since
// SH-12; what did not exist was any way to reach them. The nav has pointed
// here (gated on `variance.view`) since the keys were introduced, and the
// link answered 404. This page is that link's destination and nothing more:
// it lists what `GET /api/variances` returns and moves cases with
// `POST /api/variances/:id/advance`. It computes no status of its own.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { VarianceList, VarianceSummary, type VarianceBoardSummary, type VarianceRow } from "@/components/variances/variance-list";
import { matchesVarianceSearch } from "@/components/variances/variance-format";
import { Input } from "@/components/ui/input";
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
  const { canKey, cafe, features, user } = useApp();
  const [cases, setCases] = useState<VarianceRow[]>([]);
  const [summary, setSummary] = useState<VarianceBoardSummary | null>(null);
  const [status, setStatus] = useState<string>(ANY);
  const [type, setType] = useState<string>(ANY);
  // A pinned account is scoped to its branch by the server; only an unpinned owner picks one.
  const [branchId, setBranchId] = useState<string>(ANY);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState("");
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
      if (branchId !== ANY) params.set("branchId", branchId);
      const { cases, summary } = await api<{ cases: VarianceRow[]; summary: VarianceBoardSummary }>(
        `/api/variances?${params.toString()}`
      );
      setCases(cases);
      setSummary(summary ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تحميل الفروقات");
      setCases([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [allowed, status, type, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!allowed || user.branchId) return;
    api<{ branches: { id: string; name: string }[] }>("/api/branches").then((r) => setBranches(r.branches)).catch(() => setBranches([]));
  }, [allowed, user.branchId]);

  // Employee, item, branch or shift number, over the rows already loaded.
  const shown = useMemo(() => cases.filter((c) => matchesVarianceSearch(c, query)), [cases, query]);

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
        <Link className="text-primary underline" href="/reports/employee-variances">تقرير فروق الموظفين</Link>
      </header>

      <VarianceSummary summary={loading ? null : summary} currency={cafe?.currency ?? "EGP"} />

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="الحالة" data-testid="variance-status-tabs">
        {[ANY, ...VARIANCE_STATUSES].map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
          >
            {s === ANY ? "كل الحالات" : STATUS_LABEL[s as keyof typeof STATUS_LABEL]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={(v) => setType(v ?? ANY)}>
          <SelectTrigger className="w-40" aria-label="النوع">
            <SelectValue placeholder="النوع">{type === ANY ? "كل الأنواع" : TYPE_LABEL[type as keyof typeof TYPE_LABEL]}</SelectValue>
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
        {!user.branchId && branches.length > 1 && (
          <Select value={branchId} onValueChange={(v) => setBranchId(v ?? ANY)}>
            <SelectTrigger className="w-44" aria-label="الفرع">
              <SelectValue placeholder="الفرع">{branchId === ANY ? "كل الفروع" : branches.find((b) => b.id === branchId)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>كل الفروع</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          className="w-full sm:w-64"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث بالموظف أو الصنف أو رقم الشيفت"
          aria-label="بحث في الفروقات"
          data-testid="variance-search"
        />
      </div>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-dashed bg-muted/30" />
      ) : (
        <VarianceList
          cases={shown}
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
