import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

/** Separate evidence gates; accepting equipment cannot accept cash or stock. */
export async function assertOpeningReady(client: Prisma.TransactionClient | typeof db, args: { shiftId: string; scope: "CASH" | "OPERATIONS" }): Promise<void> {
  const shift = await client.shift.findUnique({ where: { id: args.shiftId }, select: { status: true, branchId: true, openedAt: true, custodyGateReason: true, openingCashReceipt: { select: { status: true } } } });
  if (!shift || shift.status !== "OPEN") throw new ApiError(400, "An open shift is required");
  if (shift.custodyGateReason) throw new ApiError(400, "Shift is awaiting custody: " + shift.custodyGateReason);
  if (shift.openingCashReceipt && !["ACCEPTED", "OVERRIDDEN"].includes(shift.openingCashReceipt.status)) throw new ApiError(400, "Count and confirm the opening drawer cash before operating this shift");
  if (args.scope === "OPERATIONS") {
    const settings = await client.branchOpeningSettings.findUnique({ where: { branchId: shift.branchId }, select: { placeAcceptanceRequired: true, updatedAt: true } });
    if (settings?.placeAcceptanceRequired && shift.openedAt >= settings.updatedAt) {
      const receipt = await client.shiftPlaceReceipt.findUnique({ where: { incomingShiftId: args.shiftId }, select: { status: true } });
      if (!receipt || !["ACCEPTED", "OVERRIDDEN"].includes(receipt.status)) throw new ApiError(400, "Complete and accept the place/equipment check before operating this shift");
    }
  }
}

/** Preserve legacy deferred-serving semantics while enforcing new receipt gates. */
export async function assertOpeningReceiptEvidence(client: Prisma.TransactionClient | typeof db, shiftId: string): Promise<void> {
  const receipt = await client.openingCashReceipt.findUnique({ where: { incomingShiftId: shiftId }, select: { status: true } });
  if (receipt && !["ACCEPTED", "OVERRIDDEN"].includes(receipt.status)) throw new ApiError(400, "Count and confirm the opening drawer cash before operating this shift");
}
