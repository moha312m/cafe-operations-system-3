import type { ShiftCustodyGate } from "@prisma/client";
import { db } from "@/lib/db";
import { openingReceiptAccepted, placeReceiptRequired } from "@/lib/opening-readiness";

type ShiftOpener = { id: string; name: string };

export async function shiftOpeners(cafeId: string, shiftIds: string[]) {
  const openers = new Map<string, ShiftOpener | null>();
  if (shiftIds.length === 0) return openers;
  const events = await db.auditLog.findMany({
    where: { cafeId, entity: "Shift", action: "SHIFT_OPENED", entityId: { in: shiftIds } },
    select: { entityId: true, user: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const event of events) {
    if (event.entityId && !openers.has(event.entityId)) openers.set(event.entityId, event.user);
  }
  return openers;
}

export type ShiftOpeningRequirement = "CUSTODY_TRANSFER" | "OPENING_VERIFICATION" | "CASH_RECEIPT" | "PLACE_RECEIPT";

export function shiftOpeningRequirements(
  shift: {
    openedAt: Date;
    custodyGateReason: ShiftCustodyGate | null;
    openingCashReceipt?: { status: string } | null;
    placeReceipt?: { status: string } | null;
  },
  settings: { placeAcceptanceRequired: boolean; updatedAt: Date } | null | undefined,
) {
  const waitingFor: ShiftOpeningRequirement[] = [];
  if (shift.custodyGateReason === "AWAITING_CUSTODY_TRANSFER") waitingFor.push("CUSTODY_TRANSFER");
  if (shift.custodyGateReason === "AWAITING_OPENING_VERIFICATION") waitingFor.push("OPENING_VERIFICATION");
  if (shift.openingCashReceipt && !openingReceiptAccepted(shift.openingCashReceipt.status)) waitingFor.push("CASH_RECEIPT");
  if (placeReceiptRequired(shift.openedAt, settings) && !openingReceiptAccepted(shift.placeReceipt?.status)) waitingFor.push("PLACE_RECEIPT");
  return waitingFor;
}
