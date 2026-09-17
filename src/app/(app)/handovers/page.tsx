"use client";

// SH-24 — the door SH-23's own test named.
//
// "The service is unreachable without a door, and a door SH-24's UI cannot
// open is not production reachability" (tests/handover-007). Custody handover
// has been fully built and tested since SH-13; the nav has pointed at
// /handovers, gated on `handover.view`, and the link answered 404. This page
// is that destination: it lists what the server lists, opens what the server
// will open, and sends what a person decided. Every guard stays on the
// server — nothing here grants anything.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { HandoverList, type HandoverRow } from "@/components/handovers/handover-list";
import { HandoverDetail } from "@/components/handovers/handover-detail";
import { OpeningVerificationPanel } from "@/components/handovers/opening-verification-panel";
import {
  HANDOVER_STATUSES,
  HANDOVER_STATUS_LABEL,
} from "@/components/handovers/handover-labels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY = "ALL";

export default function HandoversPage() {
  const { canKey, features } = useApp();
  const [handovers, setHandovers] = useState<HandoverRow[]>([]);
  const [status, setStatus] = useState<string>(ANY);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allowed = canKey("handover.view");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Only statuses the enum actually has. The list route passes this
      // straight into a Prisma filter, so an invented value is a 500 rather
      // than an empty result — the picker is the guard.
      if (status !== ANY) params.set("status", status);
      const { handovers } = await api<{ handovers: HandoverRow[] }>(
        `/api/handovers?${params.toString()}`
      );
      setHandovers(handovers);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تحميل التسليمات");
      setHandovers([]);
    } finally {
      setLoading(false);
    }
  }, [allowed, status]);

  useEffect(() => {
    load();
  }, [load]);

  if (!allowed) {
    return (
      <main className="p-6">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          ليس لديك صلاحية لعرض التسليم والاستلام
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
        <h1 className="text-lg font-semibold">التسليم والاستلام</h1>
        <div className="ms-auto">
          <Select value={status} onValueChange={(v) => setStatus(v ?? ANY)}>
            <SelectTrigger className="w-56" aria-label="الحالة">
              <SelectValue placeholder="الحالة" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>كل الحالات</SelectItem>
              {HANDOVER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {HANDOVER_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        الأسباب بتتكتب بالمعرّف (reasonCodeId) لغاية ما يبقى في endpoint بيرجّع قائمة
        الأسباب.
      </p>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-dashed bg-muted/30" />
      ) : (
        <HandoverList
          handovers={handovers}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <OpeningVerificationPanel />

      <HandoverDetail
        handoverId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={load}
      />
    </main>
  );
}
