import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";
import { configureOwnerPasscode } from "@/lib/owner-passcode";

const mode = z.enum(["OWNER_REQUEST", "OWNER_PASSCODE", "EITHER"]);
const patchSchema = z.object({
  ownerId: z.string().min(1).optional(),
  refundMode: mode.optional(),
  cancelMode: mode.optional(),
  itemVoidMode: mode.optional(),
  currentPassword: z.string().min(1),
}).strict().refine((value) => value.ownerId !== undefined || value.refundMode !== undefined || value.cancelMode !== undefined || value.itemVoidMode !== undefined, { message: "No settings were provided" });
const passcodeSchema = z.object({ currentPassword: z.string().min(1), passcode: z.string().regex(/^\d{6,12}$/) }).strict();

async function actorForSettings() {
  const actor = await requireKey("settings.edit");
  if (!actor.cafeId || actor.role !== "CAFE_OWNER") throw new ApiError(403, "Cafe owner required");
  return actor;
}

export async function GET() {
  try {
    const actor = await actorForSettings();
    const settings = await db.ownerActionSettings.findUnique({
      where: { cafeId: actor.cafeId! },
      include: { owner: { select: { id: true, name: true } } },
    });
    const owner = settings?.owner ?? { id: actor.id, name: actor.name };
    const passcode = await db.ownerPasscode.findUnique({
      where: { cafeId: actor.cafeId! }, select: { ownerId: true },
    });
    return NextResponse.json({
      owner,
      refundMode: settings?.refundMode ?? "OWNER_REQUEST",
      cancelMode: settings?.cancelMode ?? "OWNER_REQUEST",
      itemVoidMode: settings?.itemVoidMode ?? "OWNER_REQUEST",
      passcodeConfigured: passcode?.ownerId === owner.id,
    });
  } catch (error) { return handleApiError(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await actorForSettings();
    const input = patchSchema.parse(await request.json());
    const currentUser = await db.user.findFirst({
      where: { id: actor.id, cafeId: actor.cafeId!, role: "CAFE_OWNER", isActive: true, archivedAt: null },
      select: { passwordHash: true },
    });
    const { verifyPassword } = await import("@/lib/auth");
    if (!currentUser || !(await verifyPassword(input.currentPassword, currentUser.passwordHash))) {
      throw new ApiError(401, "Current password is incorrect");
    }

    const previous = await db.ownerActionSettings.findUnique({ where: { cafeId: actor.cafeId! } });
    const ownerId = input.ownerId ?? previous?.ownerId ?? actor.id;
    const selected = await db.user.findFirst({
      where: { id: ownerId, cafeId: actor.cafeId!, role: "CAFE_OWNER", isActive: true, archivedAt: null },
      select: { id: true, name: true },
    });
    if (!selected) throw new ApiError(400, "Choose an active cafe owner");

    const next = await db.$transaction(async (tx) => {
      const configuredPasscode = await tx.ownerPasscode.findUnique({ where: { cafeId: actor.cafeId! }, select: { ownerId: true } });
      const nextRefund = input.refundMode ?? previous?.refundMode ?? "OWNER_REQUEST";
      const nextCancel = input.cancelMode ?? previous?.cancelMode ?? "OWNER_REQUEST";
      const nextItemVoid = input.itemVoidMode ?? previous?.itemVoidMode ?? "OWNER_REQUEST";
      if ([nextRefund, nextCancel, nextItemVoid].some((value) => value !== "OWNER_REQUEST") && configuredPasscode?.ownerId !== selected.id) {
        throw new ApiError(409, "The selected owner must configure a passcode before enabling passcode authorization");
      }
      const updated = await tx.ownerActionSettings.upsert({
        where: { cafeId: actor.cafeId! },
        create: { cafeId: actor.cafeId!, ownerId: selected.id, refundMode: nextRefund, cancelMode: nextCancel, itemVoidMode: nextItemVoid },
        update: { ownerId: selected.id, refundMode: nextRefund, cancelMode: nextCancel, itemVoidMode: nextItemVoid, version: { increment: 1 } },
      });
      await auditInTransaction(tx, { cafeId: actor.cafeId!, userId: actor.id, action: "OWNER_ACTION_SETTINGS_CHANGED", entity: "OwnerActionSettings", entityId: updated.id, details: {
        oldOwnerId: previous?.ownerId ?? null, ownerId: selected.id,
        refundMode: updated.refundMode, cancelMode: updated.cancelMode, itemVoidMode: updated.itemVoidMode, version: updated.version,
      } });
      return updated;
    });
    return NextResponse.json({
      owner: selected, refundMode: next.refundMode, cancelMode: next.cancelMode, itemVoidMode: next.itemVoidMode,
      passcodeConfigured: (await db.ownerPasscode.findUnique({ where: { cafeId: actor.cafeId! }, select: { ownerId: true } }))?.ownerId === selected.id,
    });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await actorForSettings();
    const input = passcodeSchema.parse(await request.json());
    const result = await configureOwnerPasscode({ actor, ...input });
    return NextResponse.json({ passcodeConfigured: result.configured });
  } catch (error) { return handleApiError(error); }
}