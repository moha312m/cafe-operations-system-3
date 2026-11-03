"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { ShiftCloseFlow } from "@/components/pos/shift-close-flow";

// HND-UX-004: «إنهاء الشيفت» opens here from the POS and the current-shift
// page. One focused task at a time: money, then materials when due.
export default function CloseShiftPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const canChooseBranch = user.role === "CAFE_OWNER" && !user.branchId;
  const [ownerBranchId, setOwnerBranchId] = useState("");
  useEffect(() => {
    if (!canChooseBranch) return;
    const requested = new URLSearchParams(window.location.search).get("branchId");
    if (requested) { setOwnerBranchId(requested); return; }
    api<{ branches: { id: string }[] }>("/api/branches").then((r) => r.branches[0] && setOwnerBranchId(r.branches[0].id)).catch(() => {});
  }, [canChooseBranch]);
  const branchId = canChooseBranch ? ownerBranchId : (user.branchId ?? "");
  if (!canChooseBranch && !branchId) {
    return <p role="alert" className="mx-auto max-w-2xl rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">حسابك غير معيّن على فرع.</p>;
  }
  if (!branchId) return <div className="mx-auto h-64 max-w-2xl animate-pulse rounded-2xl border bg-muted/30" />;
  return <div className="px-0 py-2 sm:py-4"><ShiftCloseFlow key={branchId} branchId={branchId} currency={currency} /></div>;
}
