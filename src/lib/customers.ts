import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizeEgyptianPhone } from "@/lib/phone";
import type { Customer } from "@prisma/client";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Finds (or creates) the cafe-scoped customer profile for a phone number.
// Returns null when the phone doesn't normalize — callers treat that as
// "no customer link" rather than an error, except where phone is required.
// Never throws: profile linking is an enhancement — a customers-layer
// failure (e.g. table missing before the migration runs) must never fail
// the order being placed.
export async function findOrCreateCustomerByPhone(args: {
  cafeId: string;
  phone: string;
  name?: string | null;
}): Promise<Customer | null> {
  try {
    return await findOrCreateCustomerInner(args);
  } catch (e) {
    console.error("customer link skipped", e);
    return null;
  }
}

async function findOrCreateCustomerInner({
  cafeId,
  phone,
  name,
}: {
  cafeId: string;
  phone: string;
  name?: string | null;
}): Promise<Customer | null> {
  const normalizedPhone = normalizeEgyptianPhone(phone);
  if (!normalizedPhone) return null;

  const existing = await db.customer.findUnique({
    where: { cafeId_normalizedPhone: { cafeId, normalizedPhone } },
  });
  if (existing) {
    // Fill in the name if we never had one.
    if (!existing.name && name?.trim()) {
      const updated = await db.customer.update({
        where: { id: existing.id },
        data: { name: name.trim() },
      });
      await audit({
        cafeId,
        action: "CUSTOMER_UPDATED",
        entity: "Customer",
        entityId: existing.id,
        details: { customerId: existing.id, oldValue: { name: null }, newValue: { name: name.trim() } },
      });
      return updated;
    }
    return existing;
  }

  // Unique constraint races (two simultaneous orders) fall back to a read.
  try {
    const created = await db.customer.create({
      data: {
        cafeId,
        phone: phone.trim(),
        normalizedPhone,
        name: name?.trim() || null,
      },
    });
    await audit({
      cafeId,
      action: "CUSTOMER_CREATED",
      entity: "Customer",
      entityId: created.id,
      details: { customerId: created.id, newValue: { phone: normalizedPhone, name: created.name } },
    });
    return created;
  } catch {
    return db.customer.findUnique({
      where: { cafeId_normalizedPhone: { cafeId, normalizedPhone } },
    });
  }
}

// Bump the denormalised order stats after an order is linked. Never throws.
export async function recordCustomerOrder(customerId: string, orderTotal: number) {
  try {
    await db.customer.update({
      where: { id: customerId },
      data: {
        totalOrders: { increment: 1 },
        totalSpent: { increment: round2(orderTotal) },
        lastOrderAt: new Date(),
      },
    });
  } catch (e) {
    console.error("customer stats update skipped", e);
  }
}

// Roll the stats back when a linked order is cancelled. Never throws.
export async function unrecordCustomerOrder(customerId: string, orderTotal: number) {
  try {
    await db.customer.update({
      where: { id: customerId },
      data: {
        totalOrders: { decrement: 1 },
        totalSpent: { decrement: round2(orderTotal) },
      },
    });
  } catch (e) {
    console.error("customer stats rollback skipped", e);
  }
}

// JSON-safe customer payload (Decimals → numbers, canonical phone).
export function serializeCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    phone: c.normalizedPhone,
    email: c.email,
    notes: c.notes,
    totalOrders: c.totalOrders,
    totalSpent: Number(c.totalSpent),
    lastOrderAt: c.lastOrderAt,
    loyaltyPointsBalance: c.loyaltyPointsBalance,
    lifetimePointsEarned: c.lifetimePointsEarned,
    lifetimePointsRedeemed: c.lifetimePointsRedeemed,
    isActive: c.isActive,
    createdAt: c.createdAt,
  };
}
