import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { dateStrInTz } from "@/lib/date-range";
import { signReportOutput } from "@/lib/report-output";
import { resolvePermissions } from "@/lib/perms/effective";
import { accountingScope } from "@/lib/accounting/api-scope";
import { parseDate, trialBalanceView, SHADOW_NOTICE } from "@/lib/accounting/queries";

// GET /api/accounting/trial-balance?from=&to= — opening, debit, credit,
// movement and closing per account, with a signed snapshot for print/CSV/XLSX.
export async function GET(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request);
    const params = request.nextUrl.searchParams;
    const today = dateStrInTz(new Date());
    const tb = await trialBalanceView(scope, parseDate(params.get("from"), `${today.slice(0, 7)}-01`), parseDate(params.get("to"), today));
    // The export snapshot is issued only to readers who may export the books.
    const canExport = (await resolvePermissions(session)).keys.has("accounting.export");
    const outputSnapshot = canExport ? signReportOutput(session.id, {
      title: "ميزان المراجعة — تجريبي غير معتمد",
      reporting: { mode: "accounting", from: tb.from, to: tb.to, branchId: tb.branchId, notice: SHADOW_NOTICE },
      labels: { "totals.debit": "إجمالي المدين", "totals.credit": "إجمالي الدائن", "totals.balanced": "متوازن" },
      metrics: { totals: tb.totals },
      rows: tb.rows.map((r) => ({ section: "trialBalance", الكود: r.code, الحساب: r.name, "رصيد أول المدة": r.opening, مدين: r.debit, دائن: r.credit, الحركة: r.movement, "رصيد آخر المدة": r.closing })),
      generatedAt: new Date().toISOString(),
    }) : null;
    return NextResponse.json({ ...tb, notice: SHADOW_NOTICE, outputSnapshot });
  } catch (error) {
    return handleApiError(error);
  }
}
