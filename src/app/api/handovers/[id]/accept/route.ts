import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { acceptHandover } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// The handover is the one in the PATH, and the retry key is required.
//
// `.strict()` for the reason the sibling routes state: a body carrying
// `status`, `acceptedStockCountSessionId`, `resolvedTarget` or
// `varianceCaseIds` is refused BY NAME rather than quietly dropped. Every one
// of those is an answer the service computes from evidence, and a caller who
// could hand in their own would be dictating the record rather than asking
// for it to be written.
//
// `incomingUserId` is deliberately NOT a field. The column of that name
// records who took the shelf, and it comes from the authenticated session —
// accepting it from a body would let one cashier sign another's name to a
// custody transfer. It is refused by `.strict()` like any other unknown key.
//
// `incomingShiftId` IS accepted, and is a disambiguation rather than an
// instruction: the service finds the branch's single shift waiting on
// `AWAITING_CUSTODY_TRANSFER` by itself, and refuses when there is more than
// one. Naming it says which of them is taking over; the service still
// validates that the named shift is open, of this branch and actually waiting.
const acceptSchema = z
  .object({
    // The message is attached to the TYPE as well as to the length check, so
    // an absent key answers in the café's own language rather than with zod's
    // "expected string, received undefined".
    idempotencyKey: z
      .string({ error: "لازم تبعت مفتاح إعادة المحاولة" })
      .min(1, "لازم تبعت مفتاح إعادة المحاولة")
      .max(200),
    incomingShiftId: z.string().min(1).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// POST /api/handovers/:id/accept — the arriving custodian takes the room, the
// record, the shift and the till.
//
// Guarded by `handover.accept`, which is already in the permission catalog.
// The catalog is not touched here: adding a key to serve one route is how a
// permission model stops meaning anything.
//
// Error mapping is entirely the shared `handleApiError`: 403 for the key or
// the feature, 400 for what the caller sent (a missing key, an unknown field),
// 404 for a handover that is not theirs to see — existence-safe, so another
// café's id is indistinguishable from one that matches nothing — 403 for
// another branch's, and 409 for every gate refusal: a status that cannot be
// accepted, a `BRANCH_CUSTODY` target that belongs to a route this stage does
// not own, an unconfirmed or unbound count, a line of the current round that
// nobody signed for, an open dispute, a required item that was never counted,
// no arriving shift, or a freeze belonging to somebody else.
//
// No raw Prisma error reaches the client. The service converts the unique
// violations idempotency relies on into refusals of its own.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.accept");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;

    const body = acceptSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await acceptHandover({
      handoverId: id,
      incomingUserId: session.id,
      incomingShiftId: body.incomingShiftId,
      idempotencyKey: body.idempotencyKey,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
