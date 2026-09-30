import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { overrideAcceptHandover } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// The handover is the one in the PATH; the manager is the one in the SESSION.
//
// `.strict()` for the reason every sibling handover route states: a body
// carrying `status`, `exceptionById`, `missingItemIds`, `resolvedTarget` or
// `openingExceptionId` is refused BY NAME rather than quietly dropped. All of
// those are answers the service derives from evidence, and a caller who could
// hand in their own would be dictating the record rather than asking for it.
//
// ── THE FIELDS THAT ARE DELIBERATELY ABSENT ──
//
// `managerId` is not a field and must never become one. It is the whole
// authority this endpoint records, and a body that could name it would let any
// holder of `handover.exception` sign a different manager's name to an
// override. It comes from `session.id`.
//
// `incomingShiftId` is not a field either, and this is where this route
// diverges from its `accept` sibling on purpose. There the arriving custodian
// is the caller, so naming which of two waiting shifts is theirs is a
// disambiguation they are entitled to make. Here the caller is a manager who
// is not taking custody, and letting them point the transfer at a shift would
// be letting them choose who answers for the shelf. The service resolves the
// branch's single shift waiting on `AWAITING_CUSTODY_TRANSFER` and refuses
// when there is more than one, which is the honest answer to an ambiguity.
//
// `incomingUserId` IS accepted, and it is an assertion rather than an
// instruction: the service reads the recipient from the resolved shift's own
// cashier and refuses when a supplied value disagrees. A manager may state who
// they believe is taking over and be told they are wrong; they may not name
// somebody into custody.
//
// `cafeId` is present because `resolveCafeId` requires it for SUPER_ADMIN
// sessions, which carry no `cafeId` of their own — the same optional field the
// `accept`, `acknowledge` and `request-recount` siblings already carry. For
// every ordinary session it is ignored in favour of the session's own café.
const overrideAcceptSchema = z
  .object({
    // The message is attached to the TYPE as well as the length check, so an
    // absent key answers in the café's own language rather than with zod's
    // "expected string, received undefined".
    idempotencyKey: z
      .string({ error: "لازم تبعت مفتاح إعادة المحاولة" })
      .min(1, "لازم تبعت مفتاح إعادة المحاولة")
      .max(200),
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب الاستثناء" })
      .min(1, "لازم تحدد سبب الاستثناء"),
    // Length only. The service owns the trim and the blank refusal, so a body
    // of spaces is refused by the same rule for an HTTP caller and a direct
    // one — there is no door into this service with a weaker check on it.
    note: z
      .string({ error: "لازم تكتب سبب الاستثناء بالتفصيل" })
      .max(2000),
    // The two kinds this stage owns. `NO_INCOMING` classifies WHY the manager
    // is overriding; it does not mean "finish with nobody arriving". An
    // arriving shift and a USER recipient are still required, and a genuinely
    // absent recipient is SH-22's branch custody, reached through its own
    // route.
    kind: z.enum(["MANAGER_ADJUSTMENT", "NO_INCOMING"], {
      error: "نوع الاستثناء مش مظبوط",
    }),
    incomingUserId: z.string().min(1).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// POST /api/handovers/:id/override-accept — a manager finishes a handover the
// count did not finish, and the record says exactly what was skipped.
//
// Guarded by `handover.exception`, already in the permission catalog and
// deliberately absent from the cashier template: it rides `shifts:read`, so a
// cashier who can see the handover still cannot override it. The catalog is
// not touched here — adding a key to serve one route is how a permission model
// stops meaning anything.
//
// Error mapping is entirely the shared `handleApiError`: 403 for the key or
// the feature, 400 for what the caller sent — a missing retry key, a missing
// or foreign or retired reason code, a whitespace-only note, an unknown field
// — 404 for a handover that is not theirs to see, which is existence-safe so
// another café's id is indistinguishable from one that matches nothing, 403
// for another branch's, and 409 for every gate refusal: a status that cannot
// be accepted, a `BRANCH_CUSTODY` target that belongs to SH-22, an unconfirmed
// or unbound count, an unsigned line of the current round, an open dispute, no
// arriving shift or two of them, a named recipient who is not the arriving
// shift's cashier, a freeze belonging to somebody else, and a retry key that
// claims a second acceptance of one handover.
//
// No raw Prisma error reaches the client.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.exception");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;

    const body = overrideAcceptSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await overrideAcceptHandover({
      handoverId: id,
      // The authenticated manager, and the only place this value comes from.
      managerId: session.id,
      incomingUserId: body.incomingUserId,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      kind: body.kind,
      idempotencyKey: body.idempotencyKey,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
