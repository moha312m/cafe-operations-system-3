// Navigation hints only. The existing services remain the transition authority.
export function handoverStep(status: string, countStatus: string | null) {
  if (status === "COMPLETED") return "complete";
  if (["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(status)) return "receive";
  if (status === "REJECTED") return "count";
  if (!["DRAFT", "REJECTED"].includes(status)) return "unknown";
  if (countStatus === "CONFIRMED") return "submit";
  if (["SUBMITTED", "RECOUNT_REQUIRED"].includes(countStatus ?? "")) return "review";
  return "count";
}

export function pendingHandover<T extends { id: string; branchId: string; status: string }>(rows: T[], branchId: string): T | null {
  const pending = rows.filter(row => row.branchId === branchId &&
    ["DRAFT", "REJECTED", "OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(row.status));
  return pending.length === 1 ? pending[0] : null;
}
