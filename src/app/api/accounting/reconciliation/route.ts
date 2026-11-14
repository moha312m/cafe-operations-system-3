import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { dateStrInTz } from "@/lib/date-range";
import { money } from "@/lib/money";
import { accountingScope } from "@/lib/accounting/api-scope";
import { parseDate, SHADOW_NOTICE } from "@/lib/accounting/queries";
import { accountingBridgeReadiness, inventoryReconciliation, supplierPosition } from "@/lib/accounting/subledgers";

// GET /api/accounting/reconciliation — read-only subledger vs GL reconciliation & F&B bridge readiness.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request, "accounting.reconcile");
    const today = dateStrInTz(new Date());
    const asOf = parseDate(request.nextUrl.searchParams.get("asOf"), today);

    const [inventory, suppliers, bridge] = await Promise.all([
      inventoryReconciliation({ cafeId: scope.cafeId, asOf, branchId: scope.branchId }),
      supplierPosition({ cafeId: scope.cafeId, asOf, branchId: scope.branchId }),
      accountingBridgeReadiness({ cafeId: scope.cafeId, asOf, branchId: scope.branchId }),
    ]);

    const glPayable = bridge.controlBalances.accountsPayable;
    const glAdvances = bridge.controlBalances.supplierAdvances;

    return NextResponse.json({
      asOf,
      branchScope: scope.branchId ?? null,
      notice: SHADOW_NOTICE,
      inventory,
      suppliers: {
        ...suppliers,
        glPayable,
        payableDiff: money(suppliers.payable - glPayable).toNumber(),
        glAdvances,
        advanceDiff: money(suppliers.advanceTotal - glAdvances).toNumber(),
      },
      bridge,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
