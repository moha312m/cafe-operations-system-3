import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
} from "@/lib/api";
import {
  startOpeningVerificationCount,
  verifyOpeningAgainstBoundary,
} from "@/lib/handover-boundary";

// The two acts that discharge a branch-custody opening gate: count the whole
// shelf, then verify the count and take the stock on.
//
// ── WHY ONE ROUTE WITH TWO ACTIONS ──
//
// The house pattern `/api/handovers` already uses, and for the same reason:
// both acts are about one subject — the branch custody being discharged — and
// splitting them across two paths would invite a caller to believe the second
// one can be reached without the first. The discriminated union is what makes
// each shape `.strict()` on its own terms.
//
// ── THE FIELDS THAT ARE DELIBERATELY ABSENT ──
//
// No item list, no `type`, no `scopeDerivation`. Opening-verification scope is
// the FULL active branch inventory, derived by the server through the same
// authoritative resolver every other count uses; a body that could narrow it
// would let the person being measured choose which shelves get looked at.
// `assertNoClientScope` makes the same refusal for an ordinary count start,
// and `.strict()` makes it here by name.
//
// No `accountabilityContext`. The generic stock-count route cannot produce a
// `BRANCH_OPENING_VERIFICATION` session and this one cannot produce any other
// kind: the context is a consequence of which endpoint was called and what
// state the branch was in, never a claim in a request body.
//
// No `idempotencyKey` on `verify`, and this is the one place its absence is
// load-bearing. The replay key is STRUCTURAL — the transferred branch period,
// its successor, and the LOCKED session naming it — and a caller-supplied key
// would give a SECOND answer to "is this the same verification?", one that a
// different count session could supply and be answered with the first one's
// result.
//
// No `verifierId` or `custodianId`. Who took the shelf comes from the
// authenticated session and from the gated shift's own cashier; a body that
// could name either would let one person sign another into custody.
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start_count"),
      shiftId: z.string().min(1, "لازم تحدد الوردية"),
      branchId: z.string().optional(),
      cafeId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      shiftId: z.string().min(1, "لازم تحدد الوردية"),
      countSessionId: z.string().min(1, "لازم تحدد الجرد الافتتاحي"),
      branchId: z.string().optional(),
      cafeId: z.string().optional(),
    })
    .strict(),
]);

// POST /api/custody/opening-verification
//
// ── THE TWO KEYS, AND WHY THEY DIFFER ──
//
// `start_count` starts a stock count, so it is guarded by
// `stock_count.start`. `verify` accepts evidence and takes custody of a room,
// which is what `handover.accept` already means — the arriving custodian
// taking on what was there. Both are in the cashier template already, because
// an arriving cashier is exactly who performs both acts.
//
// The permission catalog is NOT touched. Adding a key to serve one route is
// how a permission model stops meaning anything, and neither act here is a
// new kind of authority: it is counting, and it is accepting custody.
//
// `200` rather than `201` for `start_count`: a retry that reuses the count
// already open created nothing, and answering "created" to it would be false.
//
// Error mapping is entirely the shared `handleApiError`: 403 for the key or
// the feature, 400 for what the caller sent, 404 for a branch or session that
// is not theirs to see, and 409 for every gate refusal — no branch-held
// stock, a shift that is not waiting on an opening verification, two shifts
// that are, a drawer that is not open, a count that is not this custody's, an
// unconfirmed count, a count with shelves nobody reached, and a second count
// claiming a custody another one already verified.
export async function POST(request: NextRequest) {
  try {
    const body = actionSchema.parse(await request.json());

    if (body.action === "start_count") {
      const session = await requireKey("stock_count.start");
      await requireFeature(session, "inventoryEnabled");
      const cafeId = resolveCafeId(session, body.cafeId);
      const branchId = resolveBranchId(session, body.branchId);

      const started = await startOpeningVerificationCount({
        cafeId,
        branchId,
        shiftId: body.shiftId,
        actorId: session.id,
      });
      return NextResponse.json({
        countSession: {
          id: started.countSessionId,
          type: started.type,
          scopeItemIds: started.scopeItemIds,
          reused: started.reused,
        },
        branchCustodyPeriodId: started.branchCustodyPeriodId,
        shiftId: started.shiftId,
      });
    }

    const session = await requireKey("handover.accept");
    await requireFeature(session, "inventoryEnabled");
    const cafeId = resolveCafeId(session, body.cafeId);
    const branchId = resolveBranchId(session, body.branchId);

    const result = await verifyOpeningAgainstBoundary({
      cafeId,
      branchId,
      shiftId: body.shiftId,
      countSessionId: body.countSessionId,
      // The authenticated verifier, and the only place this value comes from.
      verifierId: session.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
