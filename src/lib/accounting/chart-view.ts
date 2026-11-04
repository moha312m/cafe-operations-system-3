// ── Chart of accounts view (Step 4B.1) ───────────────────────────────
// Pure shaping of the existing AccountingAccount hierarchy for the read-only
// chart screen, plus the DRAFT expense-category mapping proposals. Nothing
// here touches the database or decides a posting: the proposals are for the
// accountant to review, and the operational category stays the filter key.
import { z } from "zod";

export const chartQuery = z.object({ q: z.string().trim().max(60, "البحث طويل").optional() }).strict();

export type ChartAccountInput = {
  id: string; code: string; name: string; type: string; normalBalance: string;
  systemKey: string | null; isPostable: boolean; isActive: boolean; parentId: string | null;
};
export type ChartRow = ChartAccountInput & {
  depth: number; parentCode: string | null; parentName: string | null; childCount: number;
  /** True when the row itself matches the search; false for ancestors kept only to show where a match sits. */
  matched: boolean;
  /** Only postable accounts take journal lines, so only they have a ledger to open. */
  ledgerEligible: boolean;
};

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Search form: Latin digits, no diacritics or tatweel, alef/ya/ta-marbuta variants folded, lower case. */
export function normalizeSearch(value: string) {
  return value
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

/** Depth-first rows ordered by code within each parent; with a query, matches plus their ancestors. */
export function buildChartRows(accounts: readonly ChartAccountInput[], query?: string): ChartRow[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const children = new Map<string | null, ChartAccountInput[]>();
  for (const a of accounts) {
    // A parent outside the loaded set is treated as a root so the account is never lost.
    const key = a.parentId && byId.has(a.parentId) ? a.parentId : null;
    children.set(key, [...(children.get(key) ?? []), a]);
  }
  for (const list of children.values()) list.sort((x, y) => x.code.localeCompare(y.code));

  const q = query ? normalizeSearch(query) : "";
  const matches = (a: ChartAccountInput) => !q || a.code.toLowerCase().includes(q) || normalizeSearch(a.name).includes(q);
  const keep = new Set<string>();
  if (q) {
    for (const a of accounts) {
      if (!matches(a)) continue;
      // Walk up with a visited guard: a corrupt cycle must not hang the request.
      const seen = new Set<string>();
      for (let cur: ChartAccountInput | undefined = a; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        seen.add(cur.id);
        keep.add(cur.id);
      }
    }
  }

  const rows: ChartRow[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const a of children.get(parentId) ?? []) {
      if (visited.has(a.id)) continue;
      visited.add(a.id);
      if (!q || keep.has(a.id)) {
        const parent = a.parentId ? byId.get(a.parentId) : undefined;
        rows.push({ ...a, depth, parentCode: parent?.code ?? null, parentName: parent?.name ?? null, childCount: children.get(a.id)?.length ?? 0, matched: matches(a), ledgerEligible: a.isPostable });
      }
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// ── Draft mapping: operational expense category → proposed account ────

export type MappingProposal = { key: string; keywords: readonly string[]; code: string; name: string; scope: string; payroll?: boolean };
export const OPERATING_EXPENSE_HEADER_PROPOSAL = { code: "5400", name: "مصروفات التشغيل", parentCode: "5000" } as const;

/** Working proposals from the 4B review draft. Not accounts, not a saved mapping. */
export const MAPPING_PROPOSALS: readonly MappingProposal[] = [
  { key: "cleaning", keywords: ["نظاف"], code: "5410", name: "نظافة ومستلزمات نظافة", scope: "النظافة الدورية ومستلزماتها" },
  { key: "maintenance", keywords: ["صيان"], code: "5420", name: "صيانة وإصلاحات", scope: "الإصلاحات والصيانة الدورية" },
  { key: "wages", keywords: ["رواتب", "اجور", "مرتبات"], code: "5430", name: "رواتب وأجور", scope: "تصنيف مصروف الأجور ومصدر الاعتراف به", payroll: true },
  { key: "utilities", keywords: ["مرافق", "كهرب", "مياه"], code: "5440", name: "مرافق", scope: "الكهرباء والمياه وما يماثلها" },
  { key: "rent", keywords: ["ايجار"], code: "5450", name: "إيجار", scope: "مصروف الإيجار وفترة الاعتراف" },
] as const;

export type MappingStatus = "PROPOSED" | "PAYROLL_PENDING" | "AMBIGUOUS" | "UNMAPPED";
export type CodeState = { state: "free" } | { state: "taken"; account: { code: string; name: string; isPostable: boolean; systemKey: string | null } };

export type MappingCategory = { id: string; code: string; nameAr: string; archivedAt: Date | string | null };
export type MappingAccount = { code: string; name: string; isPostable: boolean; systemKey: string | null };

function codeState(code: string, accounts: readonly MappingAccount[]): CodeState {
  const hit = accounts.find((a) => a.code === code);
  return hit ? { state: "taken", account: { code: hit.code, name: hit.name, isPostable: hit.isPostable, systemKey: hit.systemKey } } : { state: "free" };
}

/**
 * Matches each actual category to at most one proposal by its Arabic name.
 * A name that fits several proposals, or none, is not guessed: it stays
 * visibly pending. Wages are always flagged, since recognition is undecided.
 */
export function buildMappingDraft(categories: readonly MappingCategory[], accounts: readonly MappingAccount[]) {
  const rows = categories.map((c) => {
    const name = normalizeSearch(c.nameAr);
    const fits = MAPPING_PROPOSALS.filter((p) => p.keywords.some((k) => name.includes(normalizeSearch(k))));
    const proposal = fits.length === 1 ? fits[0] : null;
    const status: MappingStatus = fits.length > 1 ? "AMBIGUOUS" : !proposal ? "UNMAPPED" : proposal.payroll ? "PAYROLL_PENDING" : "PROPOSED";
    return {
      categoryId: c.id, categoryCode: c.code, categoryName: c.nameAr, archived: !!c.archivedAt, status,
      proposal: proposal ? { key: proposal.key, code: proposal.code, name: proposal.name, scope: proposal.scope, codeState: codeState(proposal.code, accounts) } : null,
      candidates: fits.length > 1 ? fits.map((p) => ({ code: p.code, name: p.name })) : [],
    };
  });
  const matchedKeys = new Set(rows.flatMap((r) => (r.proposal ? [r.proposal.key] : [])));
  return {
    header: { ...OPERATING_EXPENSE_HEADER_PROPOSAL, codeState: codeState(OPERATING_EXPENSE_HEADER_PROPOSAL.code, accounts) },
    rows,
    proposalsWithoutCategory: MAPPING_PROPOSALS.filter((p) => !matchedKeys.has(p.key)).map((p) => ({ key: p.key, code: p.code, name: p.name, codeState: codeState(p.code, accounts) })),
    summary: {
      categories: rows.length,
      proposed: rows.filter((r) => r.status === "PROPOSED").length,
      payrollPending: rows.filter((r) => r.status === "PAYROLL_PENDING").length,
      unmapped: rows.filter((r) => r.status === "UNMAPPED" || r.status === "AMBIGUOUS").length,
      conflicts: rows.filter((r) => r.proposal?.codeState.state === "taken").length,
    },
  };
}

// ── Mapping eligibility and protection (Step 4B.2 closeout) ────────────
/**
 * System accounts whose posting meaning is not an ordinary operating expense:
 * cost of sales, purchase discounts, inventory loss and cash differences.
 * Decided by stable system identity only — never by code prefix or Arabic name.
 * The database holds the same list in expense_mapping_excluded_key().
 */
export const NON_OPERATING_EXPENSE_KEYS = ["COST_OF_SALES", "PURCHASE_DISCOUNTS", "INVENTORY_LOSS", "CASH_OVER_SHORT"] as const;

/** Postable, active expense account that is not one of the excluded system accounts. */
export function isOperatingExpenseAccount(a: { type: string; isPostable: boolean; isActive: boolean; systemKey: string | null }) {
  return a.type === "EXPENSE" && a.isPostable && a.isActive && !(NON_OPERATING_EXPENSE_KEYS as readonly string[]).includes(a.systemKey ?? "");
}

export type MappingRowInput = { categoryId: string; accountId: string | null; effectiveFrom: string };

/**
 * Accounts a mapping still needs on or after `today` (Cairo date): the row in force today
 * for each category and every row that starts later. Mirrors the deactivation guard in the
 * database. An account whose intervals have all ended is not protected.
 */
export function protectedMappingAccountIds(rows: readonly MappingRowInput[], today: string) {
  const byCategory = new Map<string, MappingRowInput[]>();
  for (const r of rows) byCategory.set(r.categoryId, [...(byCategory.get(r.categoryId) ?? []), r]);
  const needed = new Set<string>();
  for (const list of byCategory.values()) {
    const sorted = [...list].sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom));
    const inForce = sorted.filter((r) => r.effectiveFrom <= today).at(-1);
    if (inForce?.accountId) needed.add(inForce.accountId);
    for (const r of sorted) if (r.effectiveFrom > today && r.accountId) needed.add(r.accountId);
  }
  return needed;
}

// ── What an owner may change on an account, and why not ────────────────
export type AccountFacts = { lineCount: number; closedPeriodLines: boolean; hasChildren: boolean; mappedInForce: boolean; mappedEver: boolean };
export type AccountLocks = {
  facts: AccountFacts;
  /** Type, side and group/posting designation never change through the API; this says what pins them for this account. */
  identity: string;
  /** null = the change is available. */
  code: string | null;
  deactivate: string | null;
  move: string | null;
};

export function accountLocks(a: { systemKey: string | null; isPostable: boolean; isActive: boolean }, f: AccountFacts): AccountLocks {
  const pins = [
    a.systemKey ? "حساب نظام (الترحيل بيوصله بمفتاحه)" : null,
    f.lineCount > 0 ? `عليه ${f.lineCount} سطر قيد مرحّل` : null,
    f.mappedEver ? "اتربط بتصنيف مصروف" : null,
    f.hasChildren ? "تحته حسابات فرعية" : null,
  ].filter(Boolean);
  const identity = `النوع والجانب وكونه ${a.isPostable ? "حساب يقبل قيود" : "حساب رئيسي"} ثابتين بعد الإنشاء لأن تغييرهم بيغيّر معنى التقارير.${pins.length ? ` هنا: ${pins.join("، ")}.` : ""} لو فيه غلط، أنشئ حساب جديد وانقل الربط.`;
  return {
    facts: f, identity,
    code: null,
    deactivate: !a.isActive ? null
      : a.systemKey ? "حساب نظام: الترحيل بيوصله بمفتاحه، فمايتوقفش"
      : f.mappedInForce ? "مطلوب لربط تصنيف مصروف ساري أو مجدول. غيّر الربط الأول"
      : null,
    move: a.systemKey ? "حساب نظام: مكانه ثابت"
      : f.closedPeriodLines ? "عليه قيود (أو حسابات تحته) في فترة مقفولة، فماينفعش يتنقل"
      : null,
  };
}
