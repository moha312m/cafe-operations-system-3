// ── Default chart of accounts ────────────────────────────────────────
// A starting chart for one café company (D3), to be reviewed by the
// accountant before anything is posted for real. Posting rules refer to
// accounts by systemKey, never by code, so the accountant may renumber or
// rename freely. No tax rate lives here: the sales-tax account only holds
// what each bill recorded.
import type { AccountType, BalanceSide, Prisma } from "@prisma/client";

type ChartAccount = { code: string; name: string; type: AccountType; normalBalance?: BalanceSide; systemKey?: string; parent?: string; header?: boolean };

const NORMAL: Record<AccountType, BalanceSide> = { ASSET: "DEBIT", EXPENSE: "DEBIT", LIABILITY: "CREDIT", EQUITY: "CREDIT", REVENUE: "CREDIT" };

export const DEFAULT_CHART: readonly ChartAccount[] = [
  { code: "1000", name: "الأصول", type: "ASSET", header: true },
  { code: "1110", name: "نقدية درج الكاشير", type: "ASSET", systemKey: "CASH_DRAWER", parent: "1000" },
  { code: "1120", name: "نقدية الخزنة", type: "ASSET", systemKey: "CASH_SAFE", parent: "1000" },
  { code: "1130", name: "البنك", type: "ASSET", systemKey: "BANK", parent: "1000" },
  { code: "1140", name: "مقاصة مدفوعات الفيزا", type: "ASSET", systemKey: "CARD_CLEARING", parent: "1000" },
  { code: "1150", name: "مقاصة مدفوعات المحافظ", type: "ASSET", systemKey: "WALLET_CLEARING", parent: "1000" },
  { code: "1160", name: "مبالغ مستحقة من العملاء", type: "ASSET", systemKey: "CUSTOMER_RECEIVABLE", parent: "1000" },
  { code: "1170", name: "ضريبة على المشتريات", type: "ASSET", systemKey: "PURCHASE_TAX", parent: "1000" },
  { code: "1200", name: "المخزون", type: "ASSET", systemKey: "INVENTORY", parent: "1000" },
  { code: "1210", name: "مخزون محوّل بين الفروع", type: "ASSET", systemKey: "INVENTORY_IN_TRANSIT", parent: "1000" },
  { code: "1300", name: "دفعات مقدمة للموردين", type: "ASSET", systemKey: "SUPPLIER_ADVANCES", parent: "1000" },
  { code: "2000", name: "الخصوم", type: "LIABILITY", header: true },
  { code: "2100", name: "الموردين", type: "LIABILITY", systemKey: "ACCOUNTS_PAYABLE", parent: "2000" },
  { code: "2110", name: "بضاعة مستلمة لم تُفوتر", type: "LIABILITY", systemKey: "GOODS_RECEIVED_NOT_INVOICED", parent: "2000" },
  { code: "2200", name: "ضريبة مبيعات مستحقة", type: "LIABILITY", systemKey: "SALES_TAX_PAYABLE", parent: "2000" },
  { code: "2300", name: "مبالغ مستحقة للعملاء", type: "LIABILITY", systemKey: "CUSTOMER_CREDIT", parent: "2000" },
  { code: "3000", name: "حقوق الملكية", type: "EQUITY", header: true },
  { code: "3100", name: "رأس المال", type: "EQUITY", systemKey: "OWNER_CAPITAL", parent: "3000" },
  { code: "3200", name: "أرصدة افتتاحية", type: "EQUITY", systemKey: "OPENING_BALANCE", parent: "3000" },
  { code: "3300", name: "أرباح محتجزة", type: "EQUITY", systemKey: "RETAINED_EARNINGS", parent: "3000" },
  { code: "4000", name: "الإيرادات", type: "REVENUE", header: true },
  { code: "4100", name: "المبيعات", type: "REVENUE", systemKey: "SALES", parent: "4000" },
  { code: "4200", name: "إيراد الخدمة", type: "REVENUE", systemKey: "SERVICE_REVENUE", parent: "4000" },
  { code: "4300", name: "خصومات المبيعات", type: "REVENUE", normalBalance: "DEBIT", systemKey: "SALES_DISCOUNTS", parent: "4000" },
  { code: "4400", name: "مرتجعات المبيعات", type: "REVENUE", normalBalance: "DEBIT", systemKey: "SALES_RETURNS", parent: "4000" },
  { code: "5000", name: "التكاليف والمصروفات", type: "EXPENSE", header: true },
  { code: "5100", name: "تكلفة المبيعات", type: "EXPENSE", systemKey: "COST_OF_SALES", parent: "5000" },
  { code: "5110", name: "خصومات المشتريات", type: "EXPENSE", normalBalance: "CREDIT", systemKey: "PURCHASE_DISCOUNTS", parent: "5000" },
  { code: "5200", name: "هالك وفروقات مخزون", type: "EXPENSE", systemKey: "INVENTORY_LOSS", parent: "5000" },
  { code: "5300", name: "فروقات الكاش", type: "EXPENSE", systemKey: "CASH_OVER_SHORT", parent: "5000" },
  { code: "5900", name: "مصروفات تشغيل أخرى", type: "EXPENSE", systemKey: "OTHER_OPERATING_EXPENSE", parent: "5000" },
];

/**
 * The café's books, created with the default chart on first use. Idempotent,
 * and adds any default account a newer chart introduced to existing books
 * (matched by code, so an accountant's renames are kept).
 */
export async function ensureAccountingEntity(tx: Prisma.TransactionClient, cafeId: string) {
  let entity = await tx.accountingEntity.findUnique({ where: { cafeId } });
  if (!entity) {
    const cafe = await tx.cafe.findUniqueOrThrow({ where: { id: cafeId }, select: { name: true, currency: true } });
    entity = await tx.accountingEntity.create({ data: { cafeId, name: cafe.name, currency: cafe.currency } });
  }
  // Serialise backfills so two first uses cannot both add the same account.
  await tx.$queryRaw`SELECT "id" FROM "AccountingEntity" WHERE "id" = ${entity.id} FOR UPDATE`;
  const present = await tx.accountingAccount.findMany({ where: { entityId: entity.id }, select: { id: true, code: true } });
  const ids = new Map(present.map((a) => [a.code, a.id]));
  for (const a of DEFAULT_CHART) {
    if (ids.has(a.code)) continue;
    const created = await tx.accountingAccount.create({ data: {
      cafeId, entityId: entity.id, code: a.code, name: a.name, type: a.type,
      normalBalance: a.normalBalance ?? NORMAL[a.type], systemKey: a.systemKey ?? null,
      isPostable: !a.header, parentId: a.parent ? ids.get(a.parent)! : null,
    } });
    ids.set(a.code, created.id);
  }
  return entity;
}
