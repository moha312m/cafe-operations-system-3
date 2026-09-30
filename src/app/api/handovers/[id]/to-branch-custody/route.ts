import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { acceptToBranchCustody } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// The handover is the one in the PATH; the manager is the one in the SESSION.
//
// `.strict()` for the reason every sibling handover route states: a body
// carrying `status`, `resolvedTarget`, `incomingStockCustodyId` or
// `acceptedStockCountSessionId` is refused BY NAME rather than quietly
// dropped. Each of those is an answer the service derives from evidence, and
// a caller who could hand in their own would be dictating the record rather
// than asking for it to be written.
//
// ── THE FIELDS THAT ARE DELIBERATELY ABSENT ──
//
// `managerId` is not a field and must never become one. It is the whole
// authority this endpoint records, and a body that could name it would let
// any holder of `handover.exception` sign a different manager's name to the
// end of somebody's stock custody. It comes from `session.id`.
//
// `target` and `resolvedTarget` are not fields. The target is immutable and
// SH-14 wrote it at close; this route ACCEPTS a handover that already says
// `BRANCH_CUSTODY` and refuses one that does not. A body that could state it
// would turn "where the stock is going" into a decision taken after the count
// rather than before it — which is exactly what the immutable column exists
// to prevent.
//
// `incomingUserId` and `incomingShiftId` are not fields, and their absence is
// the point of this endpoint rather than an omission from it. Branch custody
// means NOBODY receives the stock. A body that could name a recipient would
// let this route construct the one state the whole target exists to avoid: a
// person recorded as holding a shelf they never took.
//
// `cafeId` is present because `resolveCafeId` requires it for SUPER_ADMIN
// sessions, which carry no `cafeId` of their own — the same optional field
// every sibling handover route already carries.
const toBranchCustodySchema = z
  .object({
    // The message is attached to the TYPE as well as the length check, so an
    // absent key answers in the café's own language rather than with zod's
    // "expected string, received undefined".
    idempotencyKey: z
      .string({ error: "لازم تبعت مفتاح إعادة المحاولة" })
      .min(1, "لازم تبعت مفتاح إعادة المحاولة")
      .max(200),
    // Both optional, and only meaningful together: they authorise finishing
    // over a required item nobody counted. The service owns the pairing rule
    // and the trim, so a body of spaces is refused by the same rule for an
    // HTTP caller and a direct one.
    omissionReasonCodeId: z.string().min(1).optional(),
    omissionNote: z.string().max(2000).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// POST /api/handovers/:id/to-branch-custody — a manager ends employee custody
// of the shelf, and the branch itself holds it until somebody verifies it.
//
// Guarded by `handover.exception`, already in the permission catalog and
// deliberately absent from the cashier template: ending employee stock
// custody is a manager act, and the same key already guards choosing
// `BRANCH_CUSTODY` at close. The catalog is not touched here — adding a key
// to serve one route is how a permission model stops meaning anything.
//
// Error mapping is entirely the shared `handleApiError`: 403 for the key or
// the feature, 400 for what the caller sent — a missing retry key, half an
// omission authorisation, a foreign or retired reason code, an unknown field
// — 404 for a handover that is not theirs to see, which is existence-safe so
// another café's id is indistinguishable from one that matches nothing, 403
// for another branch's, and 409 for every gate refusal: a status that cannot
// be accepted, a `SHIFT_TO_SHIFT` target that belongs to the ordinary accept
// route, an unconfirmed or unbound count, an unsigned line of the current
// round, an open dispute, an outgoing drawer the close left open, a required
// item nobody counted and nobody authorised, an OPEN shift already waiting
// for a custody transfer, a freeze belonging to somebody else, and a retry
// key that claims a second acceptance of one handover.
//
// No raw Prisma error reaches the client.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.exception");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;

    const body = toBranchCustodySchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await acceptToBranchCustody({
      handoverId: id,
      // The authenticated manager, and the only place this value comes from.
      managerId: session.id,
      idempotencyKey: body.idempotencyKey,
      omissionReasonCodeId: body.omissionReasonCodeId,
      omissionNote: body.omissionNote,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
