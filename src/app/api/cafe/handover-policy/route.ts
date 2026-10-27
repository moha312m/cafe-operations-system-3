import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireKey, handleApiError, ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { DEFAULT_STALE_ORDER_ALERT_HOURS, MAX_STALE_ORDER_ALERT_HOURS } from "@/lib/open-orders";
import { MAX_STALE_ORDER_ALERT_MINUTES, resolveStaleOrderAlertMinutes } from "@/lib/stale-order-alert";

// What a handover close does with orders still open in the branch, and when
// an order sitting unserved or unpaid is flagged as forgotten.
//
// Scoped to the caller's own café: the cafeId is taken from the session and
// never from the request, so one tenant cannot address another's policy.
function cafeIdOf(session: { role: string; cafeId: string | null }) {
  if (!session.cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
  return session.cafeId;
}

export async function GET() {
  try {
    // Anyone who can open a till may READ it — the close dialog uses it to
    // explain what will happen to open orders. Changing it is the owner's.
    const session = await requirePermission("orders:create");
    const cafeId = cafeIdOf(session);
    const settings = await db.cafeSettings.findUnique({
      where: { cafeId },
      select: { carryOpenOrdersOnHandover: true, staleOrderAlertHours: true, staleOrderAlertMinutes: true },
    });
    return NextResponse.json({
      carryOpenOrdersOnHandover: settings?.carryOpenOrdersOnHandover ?? false,
      staleOrderAlertHours: settings?.staleOrderAlertHours ?? DEFAULT_STALE_ORDER_ALERT_HOURS,
      staleOrderAlertMinutes: resolveStaleOrderAlertMinutes(settings),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z
  .object({
    carryOpenOrdersOnHandover: z.boolean({ message: "القيمة لازم تكون تشغيل أو إيقاف" }).optional(),
    staleOrderAlertMinutes: z
      .number({ message: "عدد الدقائق لازم يكون رقم" })
      .int("عدد الدقائق لازم يكون رقم صحيح")
      .min(0, `عدد الدقائق من 0 لـ ${MAX_STALE_ORDER_ALERT_MINUTES}`)
      .max(MAX_STALE_ORDER_ALERT_MINUTES, `عدد الدقائق من 0 لـ ${MAX_STALE_ORDER_ALERT_MINUTES}`)
      .optional(),
    staleOrderAlertHours: z
      .number({ message: "عدد الساعات لازم يكون رقم" })
      .int("عدد الساعات لازم يكون رقم صحيح")
      .min(0, `عدد الساعات من 0 لـ ${MAX_STALE_ORDER_ALERT_HOURS}`)
      .max(MAX_STALE_ORDER_ALERT_HOURS, `عدد الساعات من 0 لـ ${MAX_STALE_ORDER_ALERT_HOURS}`)
      .optional(),
  })
  .strict()
  .refine((v) => v.staleOrderAlertMinutes === undefined || v.staleOrderAlertHours === undefined, {
    message: "ابعت وقت التنبيه بالدقائق أو بالساعات، مش الاتنين",
  })
  .refine((v) => v.carryOpenOrdersOnHandover !== undefined || v.staleOrderAlertHours !== undefined || v.staleOrderAlertMinutes !== undefined, {
    message: "مفيش تغيير متبعت",
  });

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireKey("settings.edit");
    const cafeId = cafeIdOf(session);
    const { carryOpenOrdersOnHandover, staleOrderAlertHours, staleOrderAlertMinutes } = patchSchema.parse(await request.json());
    const minutes = staleOrderAlertMinutes ?? (staleOrderAlertHours !== undefined ? staleOrderAlertHours * 60 : undefined);

    const updated = await db.$transaction(async (tx) => {
      const prev = await tx.cafeSettings.findUnique({
        where: { cafeId },
        select: { carryOpenOrdersOnHandover: true, staleOrderAlertHours: true, staleOrderAlertMinutes: true },
      });
      const data = {
        ...(carryOpenOrdersOnHandover !== undefined ? { carryOpenOrdersOnHandover } : {}),
        ...(staleOrderAlertHours !== undefined ? { staleOrderAlertHours } : {}),
        ...(minutes !== undefined ? { staleOrderAlertMinutes: minutes } : {}),
      };
      const next = await tx.cafeSettings.upsert({
        where: { cafeId },
        create: { cafeId, ...data },
        update: data,
      });
      if (carryOpenOrdersOnHandover !== undefined) {
        await auditInTransaction(tx, {
          cafeId,
          userId: session.id,
          action: "HANDOVER_CARRY_OPEN_ORDERS_CHANGED",
          entity: "CafeSettings",
          entityId: next.id,
          details: {
            byName: session.name,
            scope: "CAFE",
            oldValue: prev?.carryOpenOrdersOnHandover ?? null,
            newValue: next.carryOpenOrdersOnHandover,
          },
        });
      }
      if (staleOrderAlertHours !== undefined) {
        await auditInTransaction(tx, {
          cafeId,
          userId: session.id,
          action: "STALE_ORDER_ALERT_HOURS_CHANGED",
          entity: "CafeSettings",
          entityId: next.id,
          details: {
            byName: session.name,
            scope: "CAFE",
            oldValue: prev?.staleOrderAlertHours ?? null,
            newValue: next.staleOrderAlertHours,
          },
        });
      }
      if (staleOrderAlertMinutes !== undefined) {
        await auditInTransaction(tx, {
          cafeId, userId: session.id, action: "STALE_ORDER_ALERT_MINUTES_CHANGED",
          entity: "CafeSettings", entityId: next.id,
          details: { byName: session.name, scope: "CAFE", unit: "MINUTES", oldValue: resolveStaleOrderAlertMinutes(prev), newValue: resolveStaleOrderAlertMinutes(next) },
        });
      }
      return next;
    });

    return NextResponse.json({
      carryOpenOrdersOnHandover: updated.carryOpenOrdersOnHandover,
      staleOrderAlertHours: updated.staleOrderAlertHours,
      staleOrderAlertMinutes: resolveStaleOrderAlertMinutes(updated),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
