import { db } from "@/lib/db";
import type { BranchFinancialSettings, Prisma } from "@prisma/client";
import { decimal } from "@/lib/money";
// pure calc re-exported below

export { computeCharges } from "@/lib/charges";
export { computeChargesExact } from "@/lib/charges";
export type { ChargeResult } from "@/lib/charges";
export type FinancialSettings = BranchFinancialSettings;

// Lazily returns a branch's tax/service settings, creating a defaults row
// (seeded from the cafe's tax rate) the first time.
export async function getBranchFinancialSettings(
  branchId: string,
  client: Prisma.TransactionClient | typeof db = db
): Promise<BranchFinancialSettings> {
  const existing = await client.branchFinancialSettings.findUnique({ where: { branchId } });
  if (existing) return existing;
  const branch = await client.branch.findUnique({
    where: { id: branchId },
    include: { cafe: { select: { taxRate: true } } },
  });
  if (!branch) throw new Error("Branch not found");
  const rate = decimal(branch.cafe.taxRate);
  return client.branchFinancialSettings.upsert({
    where: { branchId }, update: { branchId },
    create: {
      branchId,
      cafeId: branch.cafeId,
      taxEnabled: rate.gt(0),
      taxRate: rate,
      applyTaxTo: "ALL_ORDERS",
    },
  });
}
