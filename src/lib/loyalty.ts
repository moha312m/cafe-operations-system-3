import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  computeEarnedPoints,
  type LoyaltyCalcSettings,
} from "@/lib/loyalty-calc";
import type { LoyaltySettings } from "@prisma/client";

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

// Deducts redeemed points at order creation (already validated by the
// caller) and writes the REDEEM ledger row.
export async function recordRedemption({
  cafeId, customerId, orderId, orderNumber, points, amountValue, userId,
}: {
  cafeId: string; customerId: string; orderId: string; orderNumber: number;
  points: number; amountValue: number; userId: string | null;
}) {
  await db.$transaction([
    db.loyaltyTransaction.create({
      data: {
        cafeId, customerId, orderId,
        type: "REDEEM",
        points: -points,
        amountValue,
        note: `استخدام نقاط — طلب #${orderNumber}`,
        createdByUserId: userId,
      },
    }),
    db.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPointsBalance: { decrement: points },
        lifetimePointsRedeemed: { increment: points },
      },
    }),
  ]);
  await audit({
    cafeId, userId,
    action: "LOYALTY_POINTS_REDEEMED",
    entity: "Customer",
    entityId: customerId,
    details: { customerId, orderId, orderNumber, newValue: { points, amountValue } },
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
