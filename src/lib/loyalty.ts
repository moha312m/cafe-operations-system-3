import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api";
import {
  computeEarnedPoints,
  type LoyaltyCalcSettings,
} from "@/lib/loyalty-calc";
import type { LoyaltySettings, Prisma } from "@prisma/client";

// Lazily returns the cafe's loyalty settings, creating the defaults row
// (disabled program, 10 EGP = 1 point, 1 point = 1 EGP) the first time.
export async function getLoyaltySettings(cafeId: string): Promise<LoyaltySettings> {
  const existing = await db.loyaltySettings.findUnique({ where: { cafeId } });
  if (existing) return existing;
  try {
    return await db.loyaltySettings.create({ data: { cafeId } });
  } catch {
    // Unique race: another request created it first.
    return (await db.loyaltySettings.findUnique({ where: { cafeId } }))!;
  }
}

// In-memory defaults mirroring the schema defaults — used when the loyalty
// tables are unreachable (e.g. migration not applied yet in production).
function loyaltyDefaults(cafeId: string): LoyaltySettings {
  const now = new Date();
  return {
    id: "loyalty-defaults",
    cafeId,
    enabled: false,
    earnPointsPerAmount: 1,
    earnAmountStep: 10 as unknown as LoyaltySettings["earnAmountStep"],
    pointValueAmount: 1 as unknown as LoyaltySettings["pointValueAmount"],
    minPointsToRedeem: 50,
    maxRedeemPercentageOfOrder: 50,
    pointsExpireDays: null,
    earnOnPaidOrdersOnly: true,
    customerPhoneRequiredForQr: true,
    createdAt: now,
    updatedAt: now,
  };
}

// Never-throwing variant for PUBLIC pages and order-flow enhancers: any DB
// failure degrades to "loyalty disabled" instead of crashing the request.
export async function getLoyaltySettingsSafe(cafeId: string): Promise<LoyaltySettings> {
  try {
    return await getLoyaltySettings(cafeId);
  } catch (e) {
    console.error("loyalty settings unavailable — falling back to disabled", e);
    return loyaltyDefaults(cafeId);
  }
}

// Plain-number view for the pure calc helpers and client payloads.
export function loyaltyCalcSettings(s: LoyaltySettings): LoyaltyCalcSettings {
  return {
    enabled: s.enabled,
    earnPointsPerAmount: s.earnPointsPerAmount,
    earnAmountStep: Number(s.earnAmountStep),
    pointValueAmount: Number(s.pointValueAmount),
    minPointsToRedeem: s.minPointsToRedeem,
    maxRedeemPercentageOfOrder: s.maxRedeemPercentageOfOrder,
    earnOnPaidOrdersOnly: s.earnOnPaidOrdersOnly,
  };
}

// Awards earn-points for an order exactly once. Safe to call after every
// payment event — it no-ops unless the order is eligible right now:
// linked customer, loyalty enabled, not cancelled, and (when
// earnOnPaidOrdersOnly) fully paid. The atomic updateMany claim on
// loyaltyPointsAwardedAt is the double-earn guard.
//
// Never throws: awarding points is an enhancement — a loyalty-layer
// failure must never fail the payment/order that triggered it.
export async function maybeAwardLoyaltyPoints(orderId: string): Promise<number | null> {
  try {
    return await awardLoyaltyPointsInner(orderId);
  } catch (e) {
    console.error("loyalty award skipped", e);
    return null;
  }
}

async function awardLoyaltyPointsInner(orderId: string): Promise<number | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, cafeId: true, customerId: true, orderNumber: true,
      status: true, paymentStatus: true, total: true, loyaltyPointsAwardedAt: true,
    },
  });
  if (!order?.customerId || order.loyaltyPointsAwardedAt) return null;
  if (order.status === "CANCELLED" || order.status === "REJECTED") return null;

  const settings = await getLoyaltySettings(order.cafeId);
  if (!settings.enabled) return null;
  if (settings.earnOnPaidOrdersOnly && order.paymentStatus !== "PAID") return null;

  const points = computeEarnedPoints(Number(order.total), loyaltyCalcSettings(settings));

  const claimed = await db.order.updateMany({
    where: { id: order.id, loyaltyPointsAwardedAt: null },
    data: { loyaltyPointsAwardedAt: new Date(), loyaltyPointsEarned: points },
  });
  if (claimed.count === 0) return null; // another request won the race
  if (points <= 0) return 0;

  await db.$transaction([
    db.loyaltyTransaction.create({
      data: {
        cafeId: order.cafeId,
        customerId: order.customerId,
        orderId: order.id,
        type: "EARN",
        points,
        amountValue: order.total,
        note: `كسب نقاط — طلب #${order.orderNumber}`,
      },
    }),
    db.customer.update({
      where: { id: order.customerId },
      data: {
        loyaltyPointsBalance: { increment: points },
        lifetimePointsEarned: { increment: points },
      },
    }),
  ]);
  await audit({
    cafeId: order.cafeId,
    action: "LOYALTY_POINTS_EARNED",
    entity: "Customer",
    entityId: order.customerId,
    details: {
      customerId: order.customerId, orderId: order.id, orderNumber: order.orderNumber,
      newValue: { points, orderTotal: Number(order.total) },
    },
  });
  return points;
}

// Takes the points an order was placed with, and writes the REDEEM ledger
// row that accounts for them.
//
// Two things changed in R-POS-02B1. The deduction used to be unconditional —
// the caller had validated the balance on an ordinary read moments earlier,
// and nothing stopped a second order spending the same points in between, so
// `loyaltyPointsBalance` went negative and the column has no CHECK to catch
// it. And it used to run in a transaction of its own, AFTER the order had
// already been committed with its discount applied, so there was no way to
// refuse a redemption without leaving a discounted order that had paid for
// itself with points nobody had.
//
// Both are fixed by the same move: the claim is a single conditional update,
// and it runs inside the ORDER's transaction. If the points are gone, the
// claim matches no row, this throws, and the order rolls back with it.
export async function recordRedemptionInTx(
  tx: Prisma.TransactionClient,
  {
    cafeId, customerId, orderId, orderNumber, points, amountValue, userId,
  }: {
    cafeId: string; customerId: string; orderId: string; orderNumber: number;
    points: number; amountValue: number; userId: string | null;
  }
): Promise<{ oldBalance: number; newBalance: number }> {
  const claimed = await tx.customer.updateMany({
    where: { id: customerId, loyaltyPointsBalance: { gte: points } },
    data: {
      loyaltyPointsBalance: { decrement: points },
      lifetimePointsRedeemed: { increment: points },
    },
  });
  if (claimed.count === 0) throw new ApiError(400, "لا يوجد رصيد نقاط كافي");

  await tx.loyaltyTransaction.create({
    data: {
      cafeId, customerId, orderId,
      type: "REDEEM",
      points: -points,
      amountValue,
      note: `استخدام نقاط — طلب #${orderNumber}`,
      createdByUserId: userId,
    },
  });

  // Read back rather than trusting the balance the caller saw before the
  // claim: under contention the row that was actually decremented may not be
  // the one that was read, and the audit should record what happened.
  const after = await tx.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { loyaltyPointsBalance: true },
  });
  return { oldBalance: after.loyaltyPointsBalance + points, newBalance: after.loyaltyPointsBalance };
}

/** The audit row for a redemption, written once its transaction has committed. */
export async function auditRedemption({
  cafeId, customerId, orderId, orderNumber, points, amountValue, userId, oldBalance, newBalance,
}: {
  cafeId: string; customerId: string; orderId: string; orderNumber: number;
  points: number; amountValue: number; userId: string | null;
  oldBalance: number; newBalance: number;
}) {
  await audit({
    cafeId, userId,
    action: "LOYALTY_POINTS_REDEEMED",
    entity: "Customer",
    entityId: customerId,
    details: {
      customerId, orderId, orderNumber,
      points, amountValue,
      oldValue: { balance: oldBalance },
      newValue: { balance: newBalance },
    },
  });
}

// On order cancellation: take back earned points and refund redeemed
// points, once (guarded by an existing CANCELLED_REVERSAL row).
// Never throws — a loyalty failure must not block the cancellation.
export async function reverseOrderLoyalty(orderId: string, userId: string | null) {
  try {
    await reverseOrderLoyaltyInner(orderId, userId);
  } catch (e) {
    console.error("loyalty reversal skipped", e);
  }
}

async function reverseOrderLoyaltyInner(orderId: string, userId: string | null) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, cafeId: true, customerId: true, orderNumber: true,
      loyaltyPointsEarned: true, loyaltyPointsRedeemed: true, loyaltyPointsAwardedAt: true,
    },
  });
  if (!order?.customerId) return;
  const earned = order.loyaltyPointsAwardedAt ? order.loyaltyPointsEarned : 0;
  const redeemed = order.loyaltyPointsRedeemed;
  if (earned <= 0 && redeemed <= 0) return;

  const already = await db.loyaltyTransaction.findFirst({
    where: { orderId: order.id, type: "CANCELLED_REVERSAL" },
    select: { id: true },
  });
  if (already) return;

  const delta = redeemed - earned; // refund redeemed, claw back earned
  await db.$transaction([
    db.loyaltyTransaction.create({
      data: {
        cafeId: order.cafeId,
        customerId: order.customerId,
        orderId: order.id,
        type: "CANCELLED_REVERSAL",
        points: delta,
        note: `إلغاء نقاط — طلب #${order.orderNumber}`,
        createdByUserId: userId,
      },
    }),
    db.customer.update({
      where: { id: order.customerId },
      data: {
        loyaltyPointsBalance: { increment: delta },
        lifetimePointsEarned: earned > 0 ? { decrement: earned } : undefined,
        lifetimePointsRedeemed: redeemed > 0 ? { decrement: redeemed } : undefined,
      },
    }),
  ]);
  await audit({
    cafeId: order.cafeId, userId,
    action: "LOYALTY_POINTS_REVERSED",
    entity: "Customer",
    entityId: order.customerId,
    details: {
      customerId: order.customerId, orderId: order.id, orderNumber: order.orderNumber,
      oldValue: { earned, redeemed }, newValue: { balanceDelta: delta },
    },
  });
}
