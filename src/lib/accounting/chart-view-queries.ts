// Read-only queries for the chart of accounts screen (Step 4B.1). Reading
// never creates books: a café without an accounting entity reads as
// unconfigured. The chart itself is café-wide reference data (as the account
// selector already is); the mapping draft is returned only to readers who
// may also view expenses.
import { db } from "@/lib/db";
import { dateStrInTz } from "@/lib/date-range";
import { accountLocks, buildChartRows, buildMappingDraft, isOperatingExpenseAccount, protectedMappingAccountIds, type AccountFacts } from "@/lib/accounting/chart-view";
import { SHADOW_NOTICE, type Scope } from "@/lib/accounting/queries";

type SavedMapping = { id: string; effectiveFrom: string; accountId: string | null; accountCode: string | null; accountName: string | null; reason: string; approvalRef: string };

export async function chartOfAccountsView(scope: Scope, opts: { q?: string; includeMapping: boolean; canSetup?: boolean; canExport?: boolean }) {
  const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId }, select: { id: true, name: true } });
  if (!entity) return { configured: false as const, notice: SHADOW_NOTICE };
  const accounts = await db.accountingAccount.findMany({
    where: { entityId: entity.id, cafeId: scope.cafeId },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true, normalBalance: true, systemKey: true, isPostable: true, isActive: true, parentId: true },
  });
  const q = opts.q || undefined;
  const built = buildChartRows(accounts, q);
  // Facts that decide which edits are available are read only for owners who can make them.
  let rows = built.map((r) => ({ ...r }));
  if (opts.canSetup) {
    const today = dateStrInTz(new Date());
    const [lines, mappingRows] = await Promise.all([
      db.$queryRaw<{ accountId: string; n: number; closed: number }[]>`
        SELECT l."accountId", count(*)::int AS n, count(*) FILTER (WHERE p."status" = 'CLOSED')::int AS closed
          FROM "JournalLine" l JOIN "JournalEntry" j ON j."id" = l."entryId" JOIN "AccountingPeriod" p ON p."id" = j."periodId"
         WHERE l."cafeId" = ${scope.cafeId} GROUP BY l."accountId"`,
      db.expenseCategoryAccountMapping.findMany({ where: { entityId: entity.id }, select: { categoryId: true, accountId: true, effectiveFrom: true } }),
    ]);
    const lineBy = new Map(lines.map((l) => [l.accountId, l]));
    const needed = protectedMappingAccountIds(mappingRows.map((m) => ({ categoryId: m.categoryId, accountId: m.accountId, effectiveFrom: m.effectiveFrom.toISOString().slice(0, 10) })), today);
    const everMapped = new Set(mappingRows.flatMap((m) => (m.accountId ? [m.accountId] : [])));
    const kids = new Map<string, string[]>();
    for (const a of accounts) if (a.parentId) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a.id]);
    const closedUnder = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      return (lineBy.get(id)?.closed ?? 0) > 0 || (kids.get(id) ?? []).some((k) => closedUnder(k, seen));
    };
    rows = rows.map((r) => {
      const facts: AccountFacts = { lineCount: lineBy.get(r.id)?.n ?? 0, closedPeriodLines: closedUnder(r.id), hasChildren: (kids.get(r.id)?.length ?? 0) > 0, mappedInForce: needed.has(r.id), mappedEver: everMapped.has(r.id) };
      return { ...r, locks: accountLocks(r, facts) };
    });
  }
  let mapping = null;
  if (opts.includeMapping) {
    const categories = await db.expenseCategory.findMany({ where: { cafeId: scope.cafeId }, orderBy: [{ archivedAt: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true, archivedAt: true } });
    const draft = buildMappingDraft(categories, accounts);
    const saved = await db.expenseCategoryAccountMapping.findMany({ where: { cafeId: scope.cafeId, entityId: entity.id }, orderBy: { effectiveFrom: "asc" }, include: { account: { select: { code: true, name: true } } } });
    const today = dateStrInTz(new Date());
    const history = new Map<string, SavedMapping[]>();
    for (const m of saved) {
      const row: SavedMapping = { id: m.id, effectiveFrom: m.effectiveFrom.toISOString().slice(0, 10), accountId: m.accountId, accountCode: m.account?.code ?? null, accountName: m.account?.name ?? null, reason: m.reason, approvalRef: m.approvalRef };
      history.set(m.categoryId, [...(history.get(m.categoryId) ?? []), row]);
    }
    const rows = draft.rows.map((r) => {
      const list = history.get(r.categoryId) ?? [];
      const inForce = list.filter((m) => m.effectiveFrom <= today).at(-1) ?? null;
      return { ...r, saved: { current: inForce && inForce.accountId ? inForce : null, ended: !!inForce && !inForce.accountId, latestEffectiveFrom: list.at(-1)?.effectiveFrom ?? null, history: list } };
    });
    mapping = {
      ...draft, rows,
      // A taken proposal code is a conflict only until a saved mapping points at that very account.
      summary: { ...draft.summary, conflicts: rows.filter((r) => r.proposal?.codeState.state === "taken" && r.saved.current?.accountCode !== r.proposal.code).length, saved: rows.filter((r) => r.saved.current).length },
      expenseAccounts: accounts.filter((a) => isOperatingExpenseAccount(a)).map((a) => ({ id: a.id, code: a.code, name: a.name })),
    };
  }
  return {
    configured: true as const, notice: SHADOW_NOTICE, entity: { name: entity.name },
    query: q ?? "", total: accounts.length, matchCount: q ? rows.filter((r) => r.matched).length : accounts.length,
    rows, mapping, mappingAllowed: opts.includeMapping, canSetup: !!opts.canSetup, canExport: !!opts.canExport,
  };
}
