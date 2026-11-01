import { money, type Numeric } from "@/lib/money";
import { protectedTransaction } from "@/lib/protected-transaction";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";
import { normalizeEgyptianPhone } from "@/lib/phone";
import type { Customer, Prisma } from "@prisma/client";

const round2 = money;

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
}, client?: Prisma.TransactionClient): Promise<Customer | null> {
  if (client) return findOrCreateCustomerInner(args, client);
  try {
    return await protectedTransaction((tx) => findOrCreateCustomerInner(args, tx), { cafeId: args.cafeId });
  } catch (e) {
    console.error("customer link skipped", e);
    return null;
  }
}

async function findOrCreateCustomerInner(args: { cafeId: string; phone: string; name?: string | null }, tx: Prisma.TransactionClient): Promise<Customer | null> {
  const normalizedPhone = normalizeEgyptianPhone(args.phone);
  if (!normalizedPhone) return null;
  const where = { cafeId_normalizedPhone: { cafeId: args.cafeId, normalizedPhone } };
  const existing = await tx.customer.findUnique({ where });
  const customer = await tx.customer.upsert({
    where, update: { normalizedPhone }, create: {
      cafeId: args.cafeId, phone: args.phone.trim(), normalizedPhone, name: args.name?.trim() || null,
    }
  });
  if (!existing) await auditInTransaction(tx, {
    cafeId: args.cafeId, action: "CUSTOMER_CREATED", entity: "Customer", entityId: customer.id,
    details: { customerId: customer.id, newValue: { phone: normalizedPhone, name: customer.name } }
  });
  if (!customer.name && args.name?.trim()) {
    const updated = await tx.customer.update({ where: { id: customer.id }, data: { name: args.name.trim() } });
    await auditInTransaction(tx, {
      cafeId: args.cafeId, action: "CUSTOMER_UPDATED", entity: "Customer", entityId: customer.id,
      details: { customerId: customer.id, oldValue: { name: null }, newValue: { name: updated.name } }
    });
    return updated;
  }
  return customer;
}

// Bump the denormalised order stats after an order is linked. Never throws.
export async function recordCustomerOrder(customerId: string, orderTotal: Numeric, client?: Prisma.TransactionClient) {
  const work = () => (client ?? db).customer.update({
    where: { id: customerId },
    data: {
      totalOrders: { increment: 1 },
      totalSpent: { increment: round2(orderTotal) },
      lastOrderAt: new Date(),
    },
  });
  if (client) { await work(); return; }
  try { await work(); } catch (e) { console.error("customer stats update skipped", e); }
}

// Roll the stats back when a linked order is cancelled. Never throws.
export async function unrecordCustomerOrder(customerId: string, orderTotal: Numeric, client?: Prisma.TransactionClient) {
  const work = () => (client ?? db).customer.update({
    where: { id: customerId },
    data: {
      totalOrders: { decrement: 1 },
      totalSpent: { decrement: round2(orderTotal) },
    },
  });
  if (client) { await work(); return; }
  try { await work(); } catch (e) { console.error("customer stats rollback skipped", e); }
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
