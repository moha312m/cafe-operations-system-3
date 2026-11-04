// ── Account administration and expense category mapping (Step 4B.2) ───
// Owner-only (accounting.setup), café-wide writes over the existing books. They
// change the chart and the saved category→account mapping only: nothing here
// posts, reclassifies or reverses a journal entry. Every write runs in a
// protected transaction under the books' row lock (the same lock posting takes),
// leaves an audit row, and is retried safely through withIdempotency. The
// database guards (migration 20261104120000) are the last line; this layer
// checks first so the owner gets a reason instead of a constraint name.
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ApiError, requireKey, resolveReadScope } from "@/lib/api";
import { requestScope, withIdempotency } from "@/lib/idempotency";
import { accountingScope } from "@/lib/accounting/api-scope";
import { auditInTransaction } from "@/lib/audit";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { expenseSourceKey } from "@/lib/expense-rules";
import type { SessionUser } from "@/lib/auth";

type Tx = Prisma.TransactionClient;

const text = (min: number, max: number, label: string) => z.string().trim().min(min, `${label} مطلوب`).max(max, `${label} طويل`);
const reason = text(3, 300, "السبب");
const accountType = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
const code = z.string().trim().regex(/^\d{4}$/, "الكود 4 أرقام");

export const accountCreateInput = z.object({
  code, name: text(2, 100, "الاسم"), type: accountType, parentId: z.string().min(1, "الحساب الأب مطلوب"),
  isPostable: z.boolean(), contra: z.boolean().optional(), reason,
}).strict();
export const accountUpdateInput = z.object({
  name: text(2, 100, "الاسم").optional(), code: code.optional(), isActive: z.boolean().optional(), parentId: z.string().min(1).optional(), reason,
}).strict().refine((v) => v.name !== undefined || v.code !== undefined || v.isActive !== undefined || v.parentId !== undefined, "مفيش تغيير مطلوب");
export const mappingChangeInput = z.object({
  categoryId: z.string().min(1), accountId: z.string().min(1).nullable(), effectiveFrom: z.string().date(),
  expectedLatestEffectiveFrom: z.string().date().nullable(), reason, approvalRef: text(3, 120, "مرجع اعتماد المحاسب"),
  acknowledgePostedNotReclassified: z.boolean().optional(),
}).strict();
export const mappingPreviewQuery = z.object({ categoryId: z.string().min(1), effectiveFrom: z.string().date() }).strict();

const NORMAL = { ASSET: "DEBIT", EXPENSE: "DEBIT", LIABILITY: "CREDIT", EQUITY: "CREDIT", REVENUE: "CREDIT" } as const;

/** Database guard messages, translated. Anything else is left to handleApiError. */
const GUARD_MESSAGES: [RegExp, number, string][] = [
  [/System accounts/, 409, "حسابات النظام ماينفعش يتغير نوعها أو جانبها أو تتوقف"],
  [/posted lines/, 409, "الحساب عليه قيود مرحّلة، فنوعه وجانبه وكونه حساب قيود ماينفعوش يتغيروا"],
  [/Remap the expense categories/, 409, "الحساب مربوط بتصنيف مصروف حالي. غيّر الربط الأول"],
  [/closed period/, 409, "الحساب عليه قيود في فترة مقفولة، فماينفعش يتنقل"],
  [/children/, 409, "الحساب تحته حسابات فرعية، فيفضل حساب رئيسي من نفس النوع"],
  [/header account/, 400, "الحساب الأب لازم يكون حساب رئيسي"],
  [/same account type/, 400, "الحساب الأب لازم يكون من نفس النوع"],
  [/same books|another cafe|belong to the mapping cafe/, 400, "العنصر خارج دفاتر الكافيه"],
  [/under itself|too deep/, 400, "ترتيب الحسابات غير صحيح"],
  [/Mapped account must be/, 400, "لازم تختار حساب مصروفات نشط يقبل قيود"],
  [/only move forward/, 400, "تاريخ الربط لازم يكون بعد آخر ربط محفوظ"],
];
function guardError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ApiError(409, "الكود مستخدم لحساب تاني");
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, status, arabic] of GUARD_MESSAGES) if (pattern.test(message)) throw new ApiError(status, arabic);
  throw error;
}

/** Writes need the setup key and a café-wide reader; a branch-pinned user is refused whatever their keys say. */
export async function setupScope(request: NextRequest) {
  const { session, scope } = await accountingScope(request, "accounting.setup");
  if (resolveReadScope(session).branchId) throw new ApiError(403, "إعداد الدفاتر لصاحب الكافيه على مستوى الكافيه كله، مش لفرع");
  return { session, cafeId: scope.cafeId };
}

/** Takes the books' row lock — the one posting and chart sync take — so setup writes serialise with them. */
async function lockBooks(tx: Tx, cafeId: string) {
  const [entity] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AccountingEntity" WHERE "cafeId" = ${cafeId} FOR UPDATE`;
  if (!entity) throw new ApiError(409, "الدفاتر لسه ماتجهزتش للكافيه ده");
  return entity.id;
}

const accountDto = (a: { id: string; code: string; name: string; type: string; normalBalance: string; systemKey: string | null; isPostable: boolean; isActive: boolean; parentId: string | null }) =>
  ({ id: a.id, code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance, systemKey: a.systemKey, isPostable: a.isPostable, isActive: a.isActive, parentId: a.parentId });

export async function createAccount(tx: Tx, actor: SessionUser, cafeId: string, input: z.infer<typeof accountCreateInput>) {
  const entityId = await lockBooks(tx, cafeId);
  const parent = await tx.accountingAccount.findFirst({ where: { id: input.parentId, entityId, cafeId } });
  if (!parent) throw new ApiError(404, "الحساب الأب مش موجود");
  if (parent.isPostable) throw new ApiError(400, "الحساب الأب لازم يكون حساب رئيسي");
  if (parent.type !== input.type) throw new ApiError(400, "الحساب الأب لازم يكون من نفس النوع");
  const base = NORMAL[input.type];
  const normalBalance = input.contra ? (base === "DEBIT" ? "CREDIT" : "DEBIT") : base;
  try {
    const created = await tx.accountingAccount.create({ data: { cafeId, entityId, code: input.code, name: input.name, type: input.type, normalBalance, isPostable: input.isPostable, parentId: parent.id } });
    await auditInTransaction(tx, { cafeId, userId: actor.id, action: "ACCOUNTING_ACCOUNT_CREATED", entity: "AccountingAccount", entityId: created.id, details: { code: created.code, name: created.name, type: created.type, normalBalance, isPostable: created.isPostable, parentId: parent.id, parentCode: parent.code, contra: !!input.contra, reason: input.reason } });
    return { account: accountDto(created) };
  } catch (error) { return guardError(error); }
}

export async function updateAccount(tx: Tx, actor: SessionUser, cafeId: string, id: string, input: z.infer<typeof accountUpdateInput>) {
  const entityId = await lockBooks(tx, cafeId);
  const before = await tx.accountingAccount.findFirst({ where: { id, entityId, cafeId } });
  if (!before) throw new ApiError(404, "الحساب مش موجود");
  if (before.systemKey && (input.parentId !== undefined || input.isActive === false)) {
    throw new ApiError(409, "حسابات النظام ماينفعش تتنقل أو تتوقف. الاسم والكود بس اللي يتعدلوا");
  }
  const data: Prisma.AccountingAccountUncheckedUpdateInput = {};
  if (input.name !== undefined && input.name !== before.name) data.name = input.name;
  if (input.code !== undefined && input.code !== before.code) data.code = input.code;
  if (input.isActive !== undefined && input.isActive !== before.isActive) data.isActive = input.isActive;
  if (input.parentId !== undefined && input.parentId !== before.parentId) {
    const parent = await tx.accountingAccount.findFirst({ where: { id: input.parentId, entityId, cafeId } });
    if (!parent) throw new ApiError(404, "الحساب الأب مش موجود");
    data.parentId = parent.id;
  }
  if (Object.keys(data).length === 0) throw new ApiError(400, "مفيش تغيير فعلي في الحساب");
  try {
    const after = await tx.accountingAccount.update({ where: { id: before.id }, data });
    await auditInTransaction(tx, { cafeId, userId: actor.id, action: "ACCOUNTING_ACCOUNT_UPDATED", entity: "AccountingAccount", entityId: before.id, details: { before: accountDto(before), after: accountDto(after), reason: input.reason } });
    return { account: accountDto(after) };
  } catch (error) { return guardError(error); }
}

type Impact = { count: number; total: number; postedCount: number; postedTotal: number };

/** Operating expenses on or after the date for one category, and how many already have a journal entry. */
export async function mappingImpact(tx: Tx, entityId: string, cafeId: string, categoryId: string, effectiveFrom: string): Promise<Impact> {
  const start = zonedDayStart(effectiveFrom);
  const [row] = await tx.$queryRaw<{ n: number; total: string; posted: number; posted_total: string }[]>`
    SELECT count(*)::int AS n, coalesce(sum(e."amount"), 0)::text AS total,
           count(j."id")::int AS posted, coalesce(sum(e."amount") FILTER (WHERE j."id" IS NOT NULL), 0)::text AS posted_total
      FROM "OperatingExpense" e
      LEFT JOIN "JournalEntry" j ON j."entityId" = ${entityId} AND j."sourceType" = 'OPERATING_EXPENSE'
                                AND j."sourceKey" = 'operating-expense:' || e."id" || ':paid:v1'
     WHERE e."cafeId" = ${cafeId} AND e."categoryId" = ${categoryId} AND e."occurredAt" >= ${start}`;
  // The source key above must stay the one expenseSourceKey() produces.
  if (expenseSourceKey("expense", "x") !== "operating-expense:x:paid:v1") throw new Error("expense source key format changed");
  return { count: row?.n ?? 0, total: Number(row?.total ?? 0), postedCount: row?.posted ?? 0, postedTotal: Number(row?.posted_total ?? 0) };
}

async function latestMapping(tx: Tx, categoryId: string) {
  return tx.expenseCategoryAccountMapping.findFirst({ where: { categoryId }, orderBy: { effectiveFrom: "desc" }, include: { account: { select: { id: true, code: true, name: true } } } });
}
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Read-only: what a mapping change on this date would touch. */
export async function previewMapping(tx: Tx, cafeId: string, q: z.infer<typeof mappingPreviewQuery>) {
  const entity = await tx.accountingEntity.findUnique({ where: { cafeId }, select: { id: true } });
  if (!entity) throw new ApiError(409, "الدفاتر لسه ماتجهزتش للكافيه ده");
  const category = await tx.expenseCategory.findFirst({ where: { id: q.categoryId, cafeId }, select: { id: true } });
  if (!category) throw new ApiError(404, "التصنيف مش موجود");
  const latest = await latestMapping(tx, category.id);
  return { effectiveFrom: q.effectiveFrom, latestEffectiveFrom: latest ? day(latest.effectiveFrom) : null, impact: await mappingImpact(tx, entity.id, cafeId, category.id, q.effectiveFrom) };
}

export async function changeMapping(tx: Tx, actor: SessionUser, cafeId: string, input: z.infer<typeof mappingChangeInput>) {
  const entityId = await lockBooks(tx, cafeId);
  const category = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, cafeId } });
  if (!category) throw new ApiError(404, "التصنيف مش موجود");
  const latest = await latestMapping(tx, category.id);
  const latestDate = latest ? day(latest.effectiveFrom) : null;
  if (latestDate !== input.expectedLatestEffectiveFrom) throw new ApiError(409, "ربط التصنيف اتغيّر من حد تاني. حدّث الصفحة وراجع الربط الحالي");
  if (latestDate && input.effectiveFrom <= latestDate) throw new ApiError(400, "تاريخ الربط لازم يكون بعد آخر ربط محفوظ");
  const today = dateStrInTz(new Date());
  if (input.effectiveFrom < "2020-01-01" || input.effectiveFrom > addDays(today, 366)) throw new ApiError(400, "تاريخ الربط خارج المدى المقبول");
  const [closed] = await tx.$queryRaw<{ last: Date | null }[]>`SELECT max("endsOn") AS last FROM "AccountingPeriod" WHERE "entityId" = ${entityId} AND "status" = 'CLOSED'`;
  if (closed?.last && input.effectiveFrom <= day(closed.last)) throw new ApiError(400, `التاريخ جوه فترة مقفولة (لحد ${day(closed.last)}). اختار تاريخ بعدها`);

  let account: { id: string; code: string; name: string } | null = null;
  if (input.accountId) {
    const found = await tx.accountingAccount.findFirst({ where: { id: input.accountId, entityId, cafeId } });
    if (!found) throw new ApiError(404, "الحساب مش موجود");
    if (!found.isPostable || !found.isActive || found.type !== "EXPENSE") throw new ApiError(400, "لازم تختار حساب مصروفات نشط يقبل قيود");
    account = { id: found.id, code: found.code, name: found.name };
  }

  const impact = await mappingImpact(tx, entityId, cafeId, category.id, input.effectiveFrom);
  const changesAccount = (latest?.accountId ?? null) !== (account?.id ?? null);
  if (changesAccount && impact.postedCount > 0 && !input.acknowledgePostedNotReclassified) {
    throw new ApiError(409, `فيه ${impact.postedCount} مصروف مترحّل بالفعل في التاريخ ده أو بعده، ومش هيتصنف تاني. أكّد إنك فاهم ده`);
  }
  try {
    const row = await tx.expenseCategoryAccountMapping.create({ data: { cafeId, entityId, categoryId: category.id, accountId: account?.id ?? null, effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`), reason: input.reason, approvalRef: input.approvalRef, createdById: actor.id } });
    await auditInTransaction(tx, { cafeId, userId: actor.id, action: "EXPENSE_CATEGORY_MAPPING_CHANGED", entity: "ExpenseCategory", entityId: category.id, details: { categoryCode: category.code, from: latest?.account ? { id: latest.account.id, code: latest.account.code } : null, to: account ? { id: account.id, code: account.code } : null, effectiveFrom: input.effectiveFrom, reason: input.reason, approvalRef: input.approvalRef, impact, acknowledgedPostedNotReclassified: !!input.acknowledgePostedNotReclassified } });
    return { mapping: { id: row.id, categoryId: row.categoryId, accountId: row.accountId, effectiveFrom: day(row.effectiveFrom), reason: row.reason, approvalRef: row.approvalRef }, impact };
  } catch (error) { return guardError(error); }
}

/** One setup write: key and scope check, then the work under withIdempotency (required Idempotency-Key, stored result replayed). */
export async function setupWrite(request: NextRequest, operation: string, body: unknown, status: number, work: (tx: Tx, actor: SessionUser, cafeId: string) => Promise<unknown>) {
  const { session, cafeId } = await setupScope(request);
  return withIdempotency(request, requestScope({ ...session, cafeId }, `accounting-setup:${operation}`), body,
    async (tx) => NextResponse.json(await work(tx, session, cafeId), { status }),
    { scope: { cafeId }, authorize: async () => { await requireKey("accounting.setup"); } });
}
