import { db } from "@/lib/db";
import type { BranchFinancialSettings } from "@prisma/client";
// pure calc re-exported below

export { computeCharges } from "@/lib/charges";
export type { ChargeResult } from "@/lib/charges";
export type FinancialSettings = BranchFinancialSettings;

// Lazily returns a branch's tax/service settings, creating a defaults row
// (seeded from the cafe's tax rate) the first time.
export async function getBranchFinancialSettings(
  branchId: string
): Promise<BranchFinancialSettings> {
  const existing = await db.branchFinancialSettings.findUnique({ where: { branchId } });
  if (existing) return existing;
  const branch = await db.branch.findUnique({
    where: { id: branchId },
    include: { cafe: { select: { taxRate: true } } },
  });
  if (!branch) throw new Error("Branch not found");
  const rate = Number(branch.cafe.taxRate) || 0;
  return db.branchFinancialSettings.create({
    data: {
      branchId,
      cafeId: branch.cafeId,
      taxEnabled: rate > 0,
      taxRate: rate,
      applyTaxTo: "ALL_ORDERS",
    },
  });
}
