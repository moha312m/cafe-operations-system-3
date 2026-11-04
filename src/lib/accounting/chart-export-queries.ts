// Builds the export file for one café's chart (read-only). Tenant scope comes from the already
// authorised Scope; nothing here creates books, and no internal id reaches the file.
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { dateStrInTz } from "@/lib/date-range";
import { buildChartRows } from "@/lib/accounting/chart-view";
import { chartCsv, chartWorkbook, mappingTable, type ExportQuery, type MappingExportInput } from "@/lib/accounting/chart-export";
import type { Scope } from "@/lib/accounting/queries";

const cairoStamp = (at: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "medium" }).format(at);

export async function chartExportFile(scope: Scope, query: ExportQuery) {
  const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId }, select: { id: true, name: true } });
  if (!entity) throw new ApiError(409, "الدفاتر لسه ماتجهزتش للكافيه ده");
  const accounts = await db.accountingAccount.findMany({
    where: { entityId: entity.id, cafeId: scope.cafeId }, orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true, normalBalance: true, systemKey: true, isPostable: true, isActive: true, parentId: true },
  });
  const now = new Date(), today = dateStrInTz(now);
  const q = query.scope === "filtered" ? query.q : undefined;
  const rows = buildChartRows(accounts, q);
  const meta = { businessName: entity.name, exportedAt: cairoStamp(now), scope: query.scope, query: q ?? "" };

  let mapping: ReturnType<typeof mappingTable> | undefined;
  if (query.includeMapping === "1" || query.dataset === "mapping") {
    const [categories, saved] = await Promise.all([
      db.expenseCategory.findMany({ where: { cafeId: scope.cafeId }, orderBy: [{ archivedAt: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true } }),
      db.expenseCategoryAccountMapping.findMany({ where: { cafeId: scope.cafeId, entityId: entity.id }, include: { account: { select: { code: true, name: true } } } }),
    ]);
    const inputs: MappingExportInput[] = categories.map((c) => ({
      category: { code: c.code, nameAr: c.nameAr },
      history: saved.filter((m) => m.categoryId === c.id).map((m) => ({ effectiveFrom: m.effectiveFrom.toISOString().slice(0, 10), accountCode: m.account?.code ?? null, accountName: m.account?.name ?? null })),
    }));
    mapping = mappingTable(inputs, today);
  }

  const stamp = `${today}-${query.scope === "full" ? "full" : "filtered"}`;
  if (query.format === "xlsx") {
    return { body: chartWorkbook(meta, rows, mapping), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `chart-of-accounts-${stamp}.xlsx` };
  }
  const csv = query.dataset === "mapping" ? chartCsv(mapping ?? []) : chartCsv(undefined, rows);
  return { body: Buffer.from(csv, "utf8"), contentType: "text/csv; charset=utf-8", filename: `${query.dataset === "mapping" ? "expense-category-mapping" : "chart-of-accounts"}-${stamp}.csv` };
}
