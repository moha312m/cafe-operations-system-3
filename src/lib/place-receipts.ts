import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";

type Client = Prisma.TransactionClient | typeof db;
type SnapshotAsset = { id: string; name: string; area: string | null; checkpoints: Array<{ id: string; label: string; required: boolean; critical: boolean }> };

export async function createPlaceReceipt(args: { cafeId: string; branchId: string; shiftId: string; assignedUserId: string; actorId: string }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "Branch" WHERE "id"=$1 FOR NO KEY UPDATE', args.branchId);
    const shift = await tx.shift.findFirst({ where: { id: args.shiftId, cafeId: args.cafeId, branchId: args.branchId }, select: { id: true } });
    if (!shift) throw new ApiError(404, "Shift was not found in this branch");
    const assigned = await tx.user.findFirst({ where: { id: args.assignedUserId, cafeId: args.cafeId, branchId: args.branchId, isActive: true, archivedAt: null }, select: { id: true } });
    if (!assigned) throw new ApiError(400, "Assign an active inspector from this branch");
    const settings = await tx.branchOpeningSettings.findUnique({ where: { branchId: args.branchId }, select: { placeAcceptanceRequired: true, placeInspectorId: true } });
    if (settings?.placeAcceptanceRequired && settings.placeInspectorId !== args.assignedUserId) throw new ApiError(400, "Assign the branch's configured place inspector");
    const assets = await tx.placeAsset.findMany({ where: { cafeId: args.cafeId, branchId: args.branchId, isActive: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, area: true, checkpoints: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, label: true, required: true, critical: true } } } });
    const snapshot = assets as SnapshotAsset[];
    return tx.shiftPlaceReceipt.create({ data: { cafeId: args.cafeId, branchId: args.branchId, incomingShiftId: args.shiftId, assignedUserId: args.assignedUserId, createdById: args.actorId, snapshot: snapshot as Prisma.InputJsonValue }, select: { id: true, status: true, snapshot: true, assignedUser: { select: { id: true, name: true } } } });
  });
}

export async function getPlaceReceipt(client: Client, receiptId: string, cafeId: string) {
  const receipt = await client.shiftPlaceReceipt.findFirst({ where: { id: receiptId, cafeId }, include: { assignedUser: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, acceptedBy: { select: { id: true, name: true } }, overriddenBy: { select: { id: true, name: true } }, observations: { include: { actor: { select: { id: true, name: true } }, asset: { select: { id: true, name: true } }, checkpoint: { select: { id: true, label: true } }, incident: true, photos: { select: { id: true, mime: true } } }, orderBy: { createdAt: "asc" } }, incidents: { select: { id: true, status: true, assetId: true } }, events: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } } } });
  if (!receipt) throw new ApiError(404, "Place receipt not found");
  return receipt;
}

export async function recordPlaceObservation(args: { receiptId: string; cafeId: string; assetId: string; checkpointId: string; side: "OUTGOING" | "INCOMING"; condition: "OK" | "NOTE" | "FAULT" | "NOT_CHECKED"; note?: string; actorId: string }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "ShiftPlaceReceipt" WHERE "id"=$1 FOR UPDATE', args.receiptId);
    const receipt = await tx.shiftPlaceReceipt.findFirst({ where: { id: args.receiptId, cafeId: args.cafeId }, select: { id: true, branchId: true, status: true, assignedUserId: true, snapshot: true } });
    if (!receipt) throw new ApiError(404, "Place receipt not found");
    if (receipt.status !== "PENDING") throw new ApiError(409, "Accepted place evidence is locked");
    if (args.side === "INCOMING" && receipt.assignedUserId !== args.actorId) throw new ApiError(403, "Only the named inspector may record the incoming condition");
    const snapshot = receipt.snapshot as unknown as SnapshotAsset[];
    const asset = snapshot.find((item) => item.id === args.assetId);
    if (!asset || !asset.checkpoints.some((item) => item.id === args.checkpointId)) throw new ApiError(400, "The asset/checkpoint is outside this receipt snapshot");
    const observation = await tx.placeObservation.create({ data: { receiptId: receipt.id, assetId: args.assetId, checkpointId: args.checkpointId, side: args.side, condition: args.condition, note: args.note?.trim() || null, actorId: args.actorId } });
    let incidentId: string | null = null;
    if (args.condition === "FAULT") {
      const incident = await tx.placeIncident.create({ data: { cafeId: args.cafeId, branchId: receipt.branchId, receiptId: receipt.id, observationId: observation.id, assetId: args.assetId, reportedById: args.actorId } });
      incidentId = incident.id;
    }
    await tx.placeReceiptEvent.create({ data: { receiptId: receipt.id, actorId: args.actorId, action: "OBSERVED", note: args.condition + (args.note?.trim() ? ": " + args.note.trim() : "") } });
    await auditInTransaction(tx, { cafeId: args.cafeId, userId: args.actorId, action: "PLACE_CONDITION_RECORDED", entity: "ShiftPlaceReceipt", entityId: receipt.id, details: { observationId: observation.id, assetId: args.assetId, checkpointId: args.checkpointId, side: args.side, condition: args.condition, incidentId } });
    return { observationId: observation.id, incidentId };
  });
}

export async function acceptPlaceReceipt(args: { receiptId: string; cafeId: string; actorId: string; idempotencyKey: string; overrideReason?: string }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "ShiftPlaceReceipt" WHERE "id"=$1 FOR UPDATE', args.receiptId);
    const receipt = await tx.shiftPlaceReceipt.findFirst({ where: { id: args.receiptId, cafeId: args.cafeId }, include: { observations: { select: { checkpointId: true, side: true, condition: true } } } });
    if (!receipt) throw new ApiError(404, "Place receipt not found");
    if (receipt.status !== "PENDING") return { alreadyAccepted: true };
    const snapshot = receipt.snapshot as unknown as SnapshotAsset[];
    const required = snapshot.flatMap((asset) => asset.checkpoints.filter((checkpoint) => checkpoint.required).map((checkpoint) => ({ ...checkpoint, assetId: asset.id })));
    const incomplete = required.some((checkpoint) => !receipt.observations.some((observation) => observation.checkpointId === checkpoint.id && observation.side === "INCOMING" && observation.condition !== "NOT_CHECKED"));
    const faulty = required.some((checkpoint) => receipt.observations.some((observation) => observation.checkpointId === checkpoint.id && observation.side === "INCOMING" && observation.condition === "FAULT"));
    if ((incomplete || faulty) && !args.overrideReason) throw new ApiError(400, incomplete ? "Complete every required place check before acceptance" : "Required equipment fault needs an authorized override");
    if (args.overrideReason && args.overrideReason.trim().length < 5) throw new ApiError(400, "Override reason must explain the operational decision");
    const status = args.overrideReason ? "OVERRIDDEN" : "ACCEPTED";
    await tx.shiftPlaceReceipt.update({ where: { id: receipt.id }, data: { status, acceptedById: args.actorId, acceptedAt: new Date(), ...(args.overrideReason ? { overriddenById: args.actorId, overrideReason: args.overrideReason.trim() } : {}) } });
    const duplicate = await tx.placeReceiptEvent.findFirst({ where: { receiptId: receipt.id, action: status, idempotencyKey: args.idempotencyKey }, select: { id: true } });
    if (!duplicate) await tx.placeReceiptEvent.create({ data: { receiptId: receipt.id, actorId: args.actorId, action: status, idempotencyKey: args.idempotencyKey, note: args.overrideReason?.trim() ?? null } });
    await auditInTransaction(tx, { cafeId: args.cafeId, userId: args.actorId, action: "PLACE_RECEIPT_" + status, entity: "ShiftPlaceReceipt", entityId: receipt.id, details: { overrideReason: args.overrideReason?.trim() ?? null } });
    return { alreadyAccepted: false };
  });
}

export async function resolvePlaceIncident(args: { incidentId: string; cafeId: string; actorId: string; repairNote: string }) {
  return db.$transaction(async (tx) => {
    const incident = await tx.placeIncident.findFirst({ where: { id: args.incidentId, cafeId: args.cafeId }, select: { id: true, status: true, assetId: true } });
    if (!incident) throw new ApiError(404, "Place incident not found");
    if (incident.status === "RESOLVED") return;
    await tx.placeIncident.update({ where: { id: incident.id }, data: { status: "RESOLVED", resolvedById: args.actorId, resolvedAt: new Date(), repairNote: args.repairNote.trim() } });
    await auditInTransaction(tx, { cafeId: args.cafeId, userId: args.actorId, action: "PLACE_INCIDENT_RESOLVED", entity: "PlaceIncident", entityId: incident.id, details: { repairNote: args.repairNote.trim(), assetId: incident.assetId } });
  });
}
