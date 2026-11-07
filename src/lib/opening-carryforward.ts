// What the next shift at a branch will open with, shown BEFORE it opens.
//
// The open dialog pre-fills its opening cash from this and says where it came
// from, so the cashier sees the drawer custody they are taking on (opening +
// net cash sales is what they will owe at close). The figure shown is the one
// `ensureCustodyForShift` will actually apply; this never decides anything.
//
//   PENDING_HANDOVER  a direct handover is waiting for its receiver: accept it,
//                     do not open around it
//   OVERNIGHT_SAFE    night storage is waiting to be claimed and counted; its
//                     amount stays blind unless the viewer may see reports
//   CASH_DISPOSITION  the previous shift left this much in the drawer
//   NONE              nothing is carried; the cashier states the opening

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { money } from "@/lib/money";

export type CarryforwardSource = "CASH_DISPOSITION" | "OVERNIGHT_SAFE" | "PENDING_HANDOVER" | "NONE";

export type OpeningCarryforward = {
  expectedOpeningCash: string | null;
  source: CarryforwardSource;
  previousShiftNumber: number | null;
  previousCashierName: string | null;
  pendingDirectHandoverId: string | null;
};

type Client = Prisma.TransactionClient | typeof db;

/** Pure: the precedence between the three ways a drawer reaches the next shift. */
export function pickCarryforward(input: {
  previous: { shiftNumber: number; cashierName: string; status: string; retainedAmount: string | null; consumedByOtherShift: boolean } | null;
  pendingHandover: { id: string; retainedAmount: string | null } | null;
  overnight: { amount: string } | null;
  canSeeBlindAmounts: boolean;
}): OpeningCarryforward {
  const prev = {
    previousShiftNumber: input.previous?.shiftNumber ?? null,
    previousCashierName: input.previous?.cashierName ?? null,
  };
  if (input.pendingHandover) {
    return { ...prev, source: "PENDING_HANDOVER", expectedOpeningCash: input.pendingHandover.retainedAmount, pendingDirectHandoverId: input.pendingHandover.id };
  }
  if (input.overnight) {
    return { ...prev, source: "OVERNIGHT_SAFE", expectedOpeningCash: input.canSeeBlindAmounts ? input.overnight.amount : null, pendingDirectHandoverId: null };
  }
  if (input.previous && input.previous.status === "CLOSED" && input.previous.retainedAmount !== null && !input.previous.consumedByOtherShift) {
    return { ...prev, source: "CASH_DISPOSITION", expectedOpeningCash: input.previous.retainedAmount, pendingDirectHandoverId: null };
  }
  return { ...prev, source: "NONE", expectedOpeningCash: null, pendingDirectHandoverId: null };
}

export async function openingCarryforward(client: Client, args: { cafeId: string; branchId: string; canSeeBlindAmounts: boolean }): Promise<OpeningCarryforward> {
  const [previous, pending, storage] = await Promise.all([
    client.shift.findFirst({
      where: { cafeId: args.cafeId, branchId: args.branchId },
      orderBy: { shiftNumber: "desc" },
      select: {
        shiftNumber: true, status: true, cashier: { select: { name: true } },
        cashDisposition: { select: { retainedAmount: true, handover: { select: { incomingShiftId: true } } } },
      },
    }),
    client.handoverSession.findFirst({
      where: { cafeId: args.cafeId, branchId: args.branchId, target: "SHIFT_TO_SHIFT", status: "OUTGOING_SUBMITTED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, outgoingShift: { select: { cashDisposition: { select: { retainedAmount: true } } } } },
    }),
    client.cashStorage.findFirst({
      where: { cafeId: args.cafeId, branchId: args.branchId, OR: [{ receipt: { is: null } }, { receipt: { is: { acceptedAt: null } } }] },
      orderBy: [{ declaredAt: "desc" }, { id: "desc" }],
      select: { id: true, leftInDrawer: true },
    }),
  ]);
  const movements = storage
    ? await client.cashStorageMovement.aggregate({ where: { storageId: storage.id }, _sum: { amount: true } })
    : null;
  const retained = (value: { toString(): string } | null | undefined) => (value == null ? null : money(value.toString()).toFixed(2));
  return pickCarryforward({
    previous: previous ? {
      shiftNumber: previous.shiftNumber,
      cashierName: previous.cashier.name,
      status: previous.status,
      retainedAmount: retained(previous.cashDisposition?.retainedAmount),
      consumedByOtherShift: !!previous.cashDisposition?.handover?.incomingShiftId,
    } : null,
    pendingHandover: pending ? { id: pending.id, retainedAmount: retained(pending.outgoingShift.cashDisposition?.retainedAmount) } : null,
    overnight: storage ? { amount: money(storage.leftInDrawer.toString()).plus(movements?._sum.amount?.toString() ?? 0).toFixed(2) } : null,
    canSeeBlindAmounts: args.canSeeBlindAmounts,
  });
}
