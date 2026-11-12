import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError, requireActiveSession } from "@/lib/api";

// In-app notifications for the signed-in user only. Reading marks delivery;
// "read" is the person's own acknowledgement.

// GET /api/notifications?unread=1 — newest first.
export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    const unreadOnly = request.nextUrl.searchParams.get("unread") === "1";
    const where = { recipientId: session.id, ...(unreadOnly ? { readAt: null } : {}) };
    const [rows, unread] = await Promise.all([
      db.notification.findMany({
        where, orderBy: { createdAt: "desc" }, take: 100,
        select: { id: true, kind: true, title: true, body: true, handoverId: true, comparisonId: true, payload: true, createdAt: true, readAt: true, deliveredAt: true, branch: { select: { name: true } } },
      }),
      db.notification.count({ where: { recipientId: session.id, readAt: null } }),
    ]);
    const undelivered = rows.filter((r) => !r.deliveredAt).map((r) => r.id);
    if (undelivered.length) {
      await db.notification.updateMany({ where: { id: { in: undelivered }, recipientId: session.id, deliveredAt: null }, data: { deliveredAt: new Date(), deliveryAttempts: { increment: 1 } } });
    }
    return NextResponse.json({ unread, notifications: rows.map((r) => ({ ...r, branchName: r.branch?.name ?? null, branch: undefined })) });
  } catch (error) {
    return handleApiError(error);
  }
}

const readSchema = z.union([
  z.object({ action: z.literal("read"), ids: z.array(z.string().min(1)).min(1).max(200) }).strict(),
  z.object({ action: z.literal("read_all") }).strict(),
]);

// POST /api/notifications — mark the caller's own notifications read. Idempotent by nature.
export async function POST(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    const body = readSchema.parse(await request.json());
    const where = { recipientId: session.id, readAt: null, ...(body.action === "read" ? { id: { in: body.ids } } : {}) };
    const updated = await db.notification.updateMany({ where, data: { readAt: new Date() } });
    return NextResponse.json({ marked: updated.count });
  } catch (error) {
    return handleApiError(error);
  }
}
