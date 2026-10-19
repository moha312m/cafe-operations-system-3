import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireActiveSession, requireKey, requireFeature, resolveCafeId, handleApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
const domain = z.enum(["STOCK", "CASH", "TENDER", "HANDOVER"]);
const createSchema = z.object({ domain, code: z.string().trim().min(1).max(80).optional(), label: z.string().trim().min(1).max(200), cafeId: z.string().optional() }).strict();
export async function GET(request: NextRequest) {
 try {
  const session = await requireActiveSession();
  await requireFeature(session, "inventoryEnabled");
  const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
  const selectedDomain = domain.parse(request.nextUrl.searchParams.get("domain"));
  const reasons = await db.reasonCode.findMany({ where: { cafeId, domain: selectedDomain, isActive: true }, select: { id: true, code: true, label: true, domain: true }, orderBy: { label: "asc" } });
  return NextResponse.json({ reasons });
 } catch (error) { return handleApiError(error); }
}
export async function POST(request: NextRequest) {
 try {
  const session = await requireKey("stock_count.configure");
  await requireFeature(session, "inventoryEnabled");
  const body = createSchema.parse(await request.json());
  const cafeId = resolveCafeId(session, body.cafeId);
  const reason = await db.$transaction(async tx => {
   const created = await tx.reasonCode.create({ data: { cafeId, domain: body.domain, code: body.code ?? `OWNER_${randomUUID()}`, label: body.label }, select: { id: true, code: true, label: true, domain: true } });
   await auditInTransaction(tx, { cafeId, userId: session.id, action: "REASON_CODE_CREATED", entity: "ReasonCode", entityId: created.id, details: { domain: created.domain, label: created.label } });
   return created;
  });
  return NextResponse.json({ reason }, { status: 201 });
 } catch (error) { return handleApiError(error); }
}
