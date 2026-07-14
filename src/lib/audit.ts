import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

// Fire-and-forget audit trail. Failures are logged but never block the
// action being audited.
export async function audit(entry: {
  cafeId?: string | null;
  userId?: string | null;
  action: string; // "order.create", "auth.login", ...
  entity: string;
  entityId?: string | null;
  details?: Prisma.InputJsonValue;
}) {
  try {
    await db.auditLog.create({
      data: {
        cafeId: entry.cafeId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        details: entry.details,
      },
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}
