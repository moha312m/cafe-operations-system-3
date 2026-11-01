type Settlement = { method: string; expectedAmount: string; actualAmount: string | null; varianceAmount: string | null; status: string; reasonNote: string | null };

// Display committed facts only. A recorded ERP settlement is not evidence of
// terminal/provider reconciliation, and an absent count is never a zero.
export function paymentOverview(methods: string[], netSales: Record<string, string>, settlements: Settlement[]) {
  return [...new Set([...methods, ...settlements.map(row => row.method)])].map(method => {
    const row = settlements.find(row => row.method === method);
    return { method, netSales: netSales[method] ?? null, expected: row?.expectedAmount ?? null,
      actual: row?.actualAmount ?? null, variance: row?.varianceAmount ?? null,
      status: row?.status ?? null, reason: row?.reasonNote ?? null,
      externalReconciliation: "NOT_EVIDENCED" as const };
  });
}
