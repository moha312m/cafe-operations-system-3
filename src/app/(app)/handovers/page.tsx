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

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { BranchScopeSelect } from "@/components/stock-counts/branch-scope-select";
import { HandoverList, type HandoverRow } from "@/components/handovers/handover-list";
import { pendingHandover } from "@/components/handovers/workflow-state";
import { HandoverDetail } from "@/components/handovers/handover-detail";
import { OpeningVerificationPanel } from "@/components/handovers/opening-verification-panel";
import { PlaceReceiptPanel } from "@/components/handovers/place-receipt-panel";
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

function HandoversWorkspace() {
  const { canKey, features, user } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const [handovers, setHandovers] = useState<HandoverRow[]>([]);
  const branchId = user.branchId ?? params.get("branchId") ?? "";
  const [status, setStatus] = useState<string>(ANY);
  const [loading, setLoading] = useState(true);
  const selectionScope = `${branchId}:${params.toString()}`;
  const [selectionState, setSelectionState] = useState<{scope: string; id: string | null} | null>(null);
  const selection = selectionState?.scope === selectionScope ? selectionState.id : undefined;
  const setSelectedId = (id: string | null | undefined) => setSelectionState(id === undefined ? null : {scope: selectionScope, id});
  const selectedId = selection === undefined ? params.get("handoverId") : selection;
  const selectBranch = (id: string) => { router.replace(`/handovers?branchId=${encodeURIComponent(id)}`); };

  const loadSequence = useRef(0);
  const allowed = canKey("handover.view");

  const load = useCallback(async () => {
    if (!allowed || !branchId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const listParams = new URLSearchParams({ branchId });
      // Only statuses the enum actually has. The list route passes this
      // straight into a Prisma filter, so an invented value is a 500 rather
      // than an empty result — the picker is the guard.
      if (status !== ANY) listParams.set("status", status);
      const { handovers } = await api<{ handovers: HandoverRow[] }>(
        `/api/handovers?${listParams.toString()}`
      );
      if (sequence !== loadSequence.current) return;
      setHandovers(handovers);
      if (!params.get("handoverId")) {
        const pending = pendingHandover(handovers, branchId);
        if (pending) setSelectionState(previous => previous?.scope === selectionScope ? previous : {scope: selectionScope, id: pending.id});
      }
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      toast.error(e instanceof Error ? e.message : "تعذّر تحميل التسليمات");
      setHandovers([]);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [allowed, status, branchId, params, selectionScope]);

  useEffect(() => {
    const sequence = loadSequence;
    void load();
    return () => { sequence.current++; };
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
        <BranchScopeSelect value={branchId} onChange={selectBranch} />
        <h1 className="text-lg font-semibold">تسليم الشيفت</h1>
        <div className="ms-auto">
          <Select value={status} onValueChange={(v) => setStatus(v ?? ANY)}>
            <SelectTrigger className="w-56" aria-label="الحالة">
              <SelectValue>{status === ANY ? "كل الحالات" : HANDOVER_STATUS_LABEL[status as keyof typeof HANDOVER_STATUS_LABEL]}</SelectValue>
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


      {!selectedId && (loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-dashed bg-muted/30" />
      ) : (
        <HandoverList
          handovers={handovers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          viewerUserId={user.id}
          canReviewDraft={canKey("stock_count.confirm") && canKey("stock_count.view")}
        />
      ))}



      <HandoverDetail
        key={`${branchId}:${selectedId ?? "none"}`}
        embedded
        expectedBranchId={branchId}
        reviewSessionId={handovers.find(row => row.id === selectedId && row.branchId === branchId)?.stockCountSessionId}
        handoverId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={load}
      />
      <OpeningVerificationPanel key={`opening:${branchId}:${selectedId ?? "list"}`} branchId={branchId} />
      <PlaceReceiptPanel key={`place:${branchId}:${selectedId ?? "list"}`} branchId={branchId} />
    </main>
  );
}

export default function HandoversPage() {
  return <Suspense fallback={<main className="p-4">جاري تحميل التسليم…</main>}><HandoversWorkspace /></Suspense>;
}
