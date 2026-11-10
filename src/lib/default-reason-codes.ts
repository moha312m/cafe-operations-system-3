import type { Prisma, ReasonDomain } from "@prisma/client";
import { db } from "@/lib/db";

export const DEFAULT_REASON_CODES: Record<ReasonDomain, Array<{ code: string; label: string }>> = {
  HANDOVER: [
    { code: "SYS_HANDOVER_MISCOUNT", label: "خطأ أو شك في العد (Something wrong in counting)" },
    { code: "SYS_HANDOVER_VARIANCE", label: "فارق كمية غير مبرر (Unexplained variance)" },
    { code: "SYS_HANDOVER_DAMAGED", label: "أصناف تالفة أو غير صالحة (Damaged or spoiled stock)" },
    { code: "SYS_HANDOVER_MISSING", label: "بضاعة ناقصة أو لم تُستلم (Missing or unreceived items)" },
    { code: "SYS_HANDOVER_OTHER", label: "سبب آخر مع توضيح بالملاحظة (Other - note provided)" },
  ],
  STOCK: [
    { code: "SYS_STOCK_MISCOUNT", label: "خطأ في العد اليدوي (Manual counting error)" },
    { code: "SYS_STOCK_WASTE", label: "هالك أو تلف تشغيلي (Operational waste / damage)" },
    { code: "SYS_STOCK_SHORTAGE", label: "عجز غير مبرر بالكمية (Unexplained shortage)" },
    { code: "SYS_STOCK_EXPIRATION", label: "انتهاء صلاحية (Expired items)" },
    { code: "SYS_STOCK_OTHER", label: "سبب آخر مع توضيح بالملاحظة (Other - note provided)" },
  ],
  CASH: [
    { code: "SYS_CASH_MISCOUNT", label: "خطأ في عد النقدية أو الفكة (Cash counting / change error)" },
    { code: "SYS_CASH_PETTY_UNRECORDED", label: "مصروف نثري لم يُسجل بالدرج (Unrecorded petty cash)" },
    { code: "SYS_CASH_TENDER_MISMATCH", label: "فارق تحصيل فيزا أو محفظة (Card / Wallet mismatch)" },
    { code: "SYS_CASH_OTHER", label: "سبب آخر مع توضيح بالملاحظة (Other - note provided)" },
  ],
  TENDER: [
    { code: "SYS_TENDER_BANK_FEE", label: "خصم عمولة بنكية (Bank settlement fee)" },
    { code: "SYS_TENDER_NETWORK_ERROR", label: "خطأ شبكة بماكينة الدفع (POS network discrepancy)" },
    { code: "SYS_TENDER_OTHER", label: "سبب آخر مع توضيح بالملاحظة (Other - note provided)" },
  ],
};

export async function ensureDefaultReasonCodes(
  client: Prisma.TransactionClient | typeof db,
  cafeId: string,
  domain: ReasonDomain
): Promise<Array<{ id: string; code: string; label: string; domain: ReasonDomain }>> {
  const existing = await client.reasonCode.findMany({
    where: { cafeId, domain, isActive: true },
    select: { id: true, code: true, label: true, domain: true },
    orderBy: { label: "asc" },
  });

  if (existing.length > 0) {
    return existing;
  }

  const defaults = DEFAULT_REASON_CODES[domain] ?? [];
  if (defaults.length === 0) return [];

  // Seed defaults atomically for this cafe
  for (const item of defaults) {
    await client.reasonCode.upsert({
      where: {
        cafeId_domain_code: {
          cafeId,
          domain,
          code: item.code,
        },
      },
      create: {
        cafeId,
        domain,
        code: item.code,
        label: item.label,
        isActive: true,
      },
      update: {
        isActive: true,
        label: item.label,
      },
    });
  }

  return client.reasonCode.findMany({
    where: { cafeId, domain, isActive: true },
    select: { id: true, code: true, label: true, domain: true },
    orderBy: { label: "asc" },
  });
}

export async function seedAllDefaultReasonCodesForCafe(
  client: Prisma.TransactionClient | typeof db,
  cafeId: string
): Promise<number> {
  const domains: ReasonDomain[] = ["HANDOVER", "STOCK", "CASH", "TENDER"];
  let totalCount = 0;
  for (const domain of domains) {
    const reasons = await ensureDefaultReasonCodes(client, cafeId, domain);
    totalCount += reasons.length;
  }
  return totalCount;
}

