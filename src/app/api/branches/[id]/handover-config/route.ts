import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireKey, resolveCafeId } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { resolveBranchHandoverConfig, updateBranchHandoverConfig } from "@/lib/handover-config";

type Params = { params: Promise<{ id: string }> };
const patchSchema = z.object({ enabled: z.boolean().optional(), mode: z.enum(["FULL", "SELECTED"]).optional(), selectedItemIds: z.array(z.string().min(1)).max(2000).optional(), schedule: z.enum(["MANUAL_ONLY", "DAILY_LAST_HANDOVER", "WEEKLY"]).nullable().optional(), weekday: z.number().int().min(0).max(6).nullable().optional() }).strict();

async function authorize(branchId: string, cafeId: string, edit: boolean) {
  const session = edit ? await requireKey("stock_count.configure") : await getSession();
  if (!session) throw new ApiError(401, "Sign in first");
  const branch = await db.branch.findUnique({ where: { id: branchId }, select: { cafeId: true } });
  if (!branch) throw new ApiError(404, "Branch not found");
  if (branch.cafeId !== cafeId) throw new ApiError(403, "Branch is outside this cafe");
  if (session.branchId && session.branchId !== branchId) throw new ApiError(403, "Branch-pinned user cannot access a sibling branch");
  return session;
}

export async function GET(request: NextRequest, { params }: Params) {
  try { const { id } = await params; const session = await getSession(); if (!session) throw new ApiError(401, "Sign in first"); const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId")); await authorize(id, cafeId, false); return NextResponse.json({ config: await resolveBranchHandoverConfig(cafeId, id) }); } catch (error) { return handleApiError(error); }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try { const { id } = await params; const session = await requireKey("stock_count.configure"); const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId")); await authorize(id, cafeId, true); const patch = patchSchema.parse(await request.json()); return NextResponse.json({ config: await updateBranchHandoverConfig({ cafeId, branchId: id, actorId: session.id, patch }) }); } catch (error) { return handleApiError(error); }
}
