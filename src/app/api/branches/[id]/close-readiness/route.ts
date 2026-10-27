import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requirePermission, resolveCafeId } from "@/lib/api";
import { handoverStartBlockers } from "@/lib/handover-blockers";
import { resolveBranchHandoverConfigReadOnly } from "@/lib/handover-config";

type Params = { params: Promise<{ id: string }> };

// GET /api/branches/:id/close-readiness — what would stand in the way of a shift close at this branch, WITHOUT closing anything.
//
// Genuinely read-only: a single READ ONLY transaction made of the same reads the close itself performs (`resolveBranchHandoverConfigReadOnly`,
// `handoverStartBlockers`). It never submits, simulates or probes a close, takes no lock, and writes nothing. The close route remains the only
// authority: this is advice for the person at the till, and the server re-decides on the actual close.
//
// Scope is the same as the sibling `handover-config` read: the caller must be allowed to operate shifts, the branch must belong to the caller's
// cafe, and a branch-pinned user cannot read a sibling branch. Only counts, short references and item NAMES/UNITS are returned — never stock
// quantities, so blind counts stay blind.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const session = await requirePermission("shifts:operate");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const branch = await db.branch.findUnique({ where: { id }, select: { cafeId: true } });
    if (!branch) throw new ApiError(404, "Branch not found");
    if (branch.cafeId !== cafeId) throw new ApiError(403, "Branch is outside this cafe");
    if (session.branchId && session.branchId !== id) throw new ApiError(403, "Branch-pinned user cannot access a sibling branch");

    const readiness = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const config = await resolveBranchHandoverConfigReadOnly(tx, cafeId, id);
      const blockers = config.enabled ? await handoverStartBlockers(tx, { cafeId, branchId: id }) : [];
      const settings = await tx.cafeSettings.findUnique({ where: { cafeId }, select: { carryOpenOrdersOnHandover: true } });
      const requiredItems = config.enabled && config.mode === "SELECTED"
        ? await tx.inventoryItem.findMany({
          where: { cafeId, branchId: id, archivedAt: null, isActive: true, isCritical: true },
          select: { id: true, name: true, unit: true }, orderBy: { name: "asc" },
        })
        : [];
      // Exact destinations for the two count blockers, resolved HERE, inside the same scoped read-only transaction. Active-count blockers already carry
      // session ids; correction blockers carry CORRECTION ids, which the count screen cannot open, so they are mapped to the session that owns them.
      // Both queries are filtered by cafe and branch, so an id can only be named if it belongs to this branch. Status and type only — no quantities.
      const activeCountIds = blockers.find((b) => b.code === "FOREIGN_ACTIVE_COUNT")?.ids ?? [];
      const correctionIds = blockers.find((b) => b.code === "PENDING_CORRECTIONS")?.ids ?? [];
      const scope = { cafeId, branchId: id };
      const [activeSessions, correctionRows] = await Promise.all([
        activeCountIds.length ? tx.stockCountSession.findMany({ where: { ...scope, id: { in: activeCountIds } }, select: { id: true, status: true, type: true } }) : Promise.resolve([]),
        correctionIds.length ? tx.stockCountCorrection.findMany({ where: { id: { in: correctionIds }, status: "PENDING_APPROVAL", line: { session: scope } }, select: { id: true, line: { select: { session: { select: { id: true, status: true, type: true } } } } } }) : Promise.resolve([]),
      ]);
      const sessions = new Map<string, { id: string; status: string; type: string; pendingCorrections: number }>();
      for (const s of activeSessions) sessions.set(s.id, { id: s.id, status: s.status, type: s.type, pendingCorrections: 0 });
      for (const c of correctionRows) {
        const s = c.line.session;
        const entry = sessions.get(s.id) ?? { id: s.id, status: s.status, type: s.type, pendingCorrections: 0 };
        entry.pendingCorrections += 1;
        sessions.set(s.id, entry);
      }
      return {
        checkedAt: new Date().toISOString(),
        enabled: config.enabled,
        mode: config.mode,
        configError: config.configError,
        carryOpenOrders: settings?.carryOpenOrdersOnHandover === true,
        blockers,
        requiredItems,
        records: { countSessions: [...sessions.values()] },
      };
    });
    return NextResponse.json({ readiness });
  } catch (error) {
    return handleApiError(error);
  }
}
