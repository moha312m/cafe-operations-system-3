// The instant a physical count is measured against.
//
// Capture is deliberately not a special case. It takes the identical
// FOR UPDATE lock that every stock mutation takes (src/lib/ledger.ts), which
// is what makes the result trustworthy:
//
//   A concurrent mutator must hold that same lock to assign version N+1. So
//   at capture time, every version at or below the captured one is committed
//   AND reflected in the `currentStock` read under the same lock. There is
//   no window in which a row is numbered-but-invisible.
//
// That is exactly the property a global sequence cannot provide. `nextval()`
// assigns at INSERT and is non-transactional, so a slow transaction can hold
// a LOW number and commit AFTER a capture has already read past it — leaving
// a movement that is simultaneously below the cursor and absent from the
// captured balance. Such a movement is excluded from the rebase replay and
// missing from the expected figure at the same time: silently lost, and read
// later as somebody's shortage.
//
// A movement posted between capture and confirmation is therefore neither an
// error nor silently absorbed. It is assigned a version above the captured
// one, excluded from that line's expected figure, and replayed onto the
// rebase so `currentStock` ends correct.

import type { Prisma } from "@prisma/client";
import { round3 } from "@/lib/costing";
import { lockItemForUpdate } from "@/lib/ledger";

export type CountPoint = {
  inventoryItemId: string;
  /** Balance at the instant the lock was held. */
  expectedQuantity: number;
  /** Everything at or below is committed; nothing above has been assigned. */
  itemVersion: bigint;
  capturedAt: Date;
  /**
   * The rule this point was captured under, stored alongside it so a count
   * read months later states its own basis instead of leaving a reader to
   * infer it from whatever the code says by then.
   */
  basis: "LOCKED_ITEM_VERSION";
};

/**
 * Capture a count point inside the caller's transaction.
 *
 * MUST be called within an interactive transaction, and the caller should
 * keep that transaction open across the write that stores the result: the
 * lock is what makes the balance and the version describe the same instant,
 * and it is released at commit.
 */
export async function captureCountPoint(
  tx: Prisma.TransactionClient,
  inventoryItemId: string
): Promise<CountPoint> {
  const locked = await lockItemForUpdate(tx, inventoryItemId);

  return {
    inventoryItemId,
    expectedQuantity: round3(locked.currentStock),
    itemVersion: locked.ledgerVersion,
    capturedAt: new Date(),
    basis: "LOCKED_ITEM_VERSION",
  };
}
