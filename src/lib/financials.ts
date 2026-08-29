import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
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
  const defaults = {
    branchId,
    cafeId: branch.cafeId,
    taxEnabled: rate > 0,
    taxRate: rate,
    applyTaxTo: "ALL_ORDERS" as const,
  };
  // Create, and treat losing the race as success.
  //
  // This row is created lazily by whatever touches the branch first, and the
  // first thing to touch a new branch is often two orders at once — two tills
  // opening together, or one cashier double-tapping. Both find no row, both
  // insert, one wins, and the loser used to get a 500 for a sale that was
  // otherwise perfectly good.
  //
  // `upsert` does not fix it: Prisma compiles it to a SELECT followed by an
  // INSERT, which is the same race with more steps. The unique index is the
  // only thing that actually arbitrates, so the arbitration is what we listen
  // to — P2002 means somebody else created the row a microsecond ago, and
  // reading THEIR row is both correct and what the caller wanted.
  //
  // Deliberately not an update: this function returns a row, it does not
  // maintain one. Overwriting on conflict would let a late-arriving default
  // stamp over tax settings an owner had configured in between.
  try {
    return await db.branchFinancialSettings.create({ data: defaults });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return db.branchFinancialSettings.findUniqueOrThrow({ where: { branchId } });
    }
    throw e;
  }
}
