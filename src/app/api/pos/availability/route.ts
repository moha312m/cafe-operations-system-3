import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { db } from "@/lib/db";
import { branchAvailability } from "@/lib/stock-availability";
import { getInventoryEnforcementMode } from "@/lib/inventory-policy";

// The POS availability board: how many more of each configuration this branch
// can actually make.
//
// ── One request, not one per card ──
//
// A café has dozens of products and most of them have sizes. Asking per card
// is not a slower version of the right design; it is a different one that
// falls over at the counter, and it gets worse exactly as a menu grows. So the
// whole board comes back at once: the branch's free quantities sent once, and
// each configuration carrying only its per-unit draw against them. That is
// also precisely what the browser needs to recompute the cart on every tap
// without another round trip.
//
// ── Read-only, and deliberately unaudited ──
//
// Nothing here writes, locks or reserves. A cashier idling on the POS screen
// generates a steady trickle of these, and an audit row per read would bury
// the events that actually matter — a blocked sale, an override, a deduction —
// under thousands of "somebody looked". The persisted commitments an order
// creates are the business evidence; looking at them is not an event.
//
// ── And deliberately uncached ──
//
// Availability changes on a sale, a delivery, a cancellation, a handover and a
// recipe edit. Anything cached as menu data would serve a number that was true
// when the shift opened.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:create");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    // Throws for a branch-pinned caller naming somebody else's branch.
    const branchId = resolveBranchId(session, params.get("branchId"));

    // And for a café-wide caller naming a branch outside their café: the
    // permission says "may take orders", not "may take orders anywhere".
    const branch = await db.branch.findFirst({
      where: { id: branchId, cafeId },
      select: { id: true },
    });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");

    // The café's persisted policy, read from the café the caller is
    // authenticated into. It does not change any number below — the count is
    // physical either way — but the POS needs it to word a zero correctly: a
    // branch that may sell into a negative balance still has nothing on the
    // shelf, and saying so is the difference between an informed override and
    // a surprise.
    const mode = await getInventoryEnforcementMode(cafeId);

    const availability = await branchAvailability({ cafeId, branchId, mode });
    return NextResponse.json({ availability });
  } catch (error) {
    return handleApiError(error);
  }
}
