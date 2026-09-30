"use client";

// SH-24 — the door to stock counting.
//
// `/stock-counts` has been in the navigation, gated on `stock_count.view`,
// since the keys were catalogued; it answered 404. Everything below is a
// client of endpoints that already existed and were already tested. No
// quantity, disposition or status is computed here: the count is the
// server's record, and this screen shows it and sends what a person typed.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import {
  StockCountList,
  type CountSessionRow,
} from "@/components/stock-counts/stock-count-list";
import { StockCountDetail } from "@/components/stock-counts/stock-count-detail";
import {
  COUNT_STATUSES,
  COUNT_STATUS_LABEL,
} from "@/components/stock-counts/stock-count-labels";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY = "ALL";

export default function StockCountsPage() {
  const { canKey, user, features } = useApp();
  const [sessions, setSessions] = useState<CountSessionRow[]>([]);
  const [status, setStatus] = useState<string>(ANY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allowed = canKey("stock_count.view");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== ANY) params.set("status", status);
      const { sessions } = await api<{ sessions: CountSessionRow[] }>(
        `/api/stock-counts?${params.toString()}`
      );
      setSessions(sessions);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تحميل الجرد");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [allowed, status]);

  useEffect(() => {
    load();
  }, [load]);

  async function start(type: "CRITICAL" | "FULL") {
    setBusy(true);
    try {
      // The branch comes from the session for a pinned user; an unpinned one
      // must say which branch, and the server refuses rather than guessing.
      const { session } = await api<{ session: { id: string } }>("/api/stock-counts", {
        method: "POST",
        body: { type, branchId: user.branchId ?? undefined },
      });
      toast.success("اتفتحت جلسة جرد");
      await load();
      setSelectedId(session.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر بدء الجرد");
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          ليس لديك صلاحية لعرض الجرد
        </p>
      </main>
    );
  }

  if (features && !features.inventoryEnabled) {
    return (
      <main className="p-6">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          خاصية المخزون مقفولة في الكافيه ده
        </p>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">جرد المخزون</h1>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v ?? ANY)}>
            <SelectTrigger className="w-44" aria-label="الحالة">
              <SelectValue placeholder="الحالة" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>كل الحالات</SelectItem>
              {COUNT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {COUNT_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canKey("stock_count.start") && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => start("CRITICAL")}
                data-testid="start-critical-count"
              >
                جرد أصناف حرجة
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => start("FULL")}
                data-testid="start-full-count"
              >
                جرد كامل
              </Button>
            </>
          )}
        </div>
      </header>

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        أسباب المخزون بتتكتب بالمعرّف (reasonCodeId) لغاية ما يبقى في endpoint
        بيرجّع قائمة الأسباب.
      </p>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-dashed bg-muted/30" />
      ) : (
        <StockCountList
          sessions={sessions}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <StockCountDetail
        sessionId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={load}
      />
    </main>
  );
}
