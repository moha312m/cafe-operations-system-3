import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { requestRecount } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// The handover is the one in the PATH, and the reason is required.
//
// `.strict()` for the reason the sibling `POST /api/handovers` states in its
// own comment: a body carrying `status`, `disputedLineIds` or `handoverId` is
// refused BY NAME rather than quietly dropped. The answer is the service's to
// compute, and a caller who could hand in their own `disputedLineIds` would
// be telling the outgoing hand which lines to re-examine.
const recountSchema = z
  .object({
    // The message is attached to the TYPE as well as to the length check, so
    // an absent `reasonCodeId` answers in the café's own language rather than
    // with zod's "expected string, received undefined". Missing and empty are
    // the same mistake to the person making it, and the service's own gate
    // (`assertHandoverReason`) already treats them the same way.
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب إعادة الجرد" })
      .min(1, "لازم تحدد سبب إعادة الجرد"),
    note: z.string().max(500).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// POST /api/handovers/:id/request-recount — the arriving custodian says the
// count does not match, and sends it back.
//
// Guarded by `handover.request_recount`, the act's own key since SH-23.
//
// Until SH-23 this route borrowed `handover.accept` — the closest existing
// name for an act of the party TAKING the custody — because a key serving a
// single route was not worth a catalog entry on its own. SH-23 named the act:
// asking for a recount is a decision about the evidence, distinct from
// accepting it, and now grantable (or revocable) on its own. The key rides
// the `handover:participate` bridge and the participating role templates, so
// every role that could send a count back before the split still can.
// Guarding with the SUBMIT key would have handed the decision to the person
// being measured, and still would.
//
// `incomingUserId` is the AUDIT ACTOR only. The `HandoverSession` column of
// the same name is not written by this stage — somebody who asked for a
// recount has not taken the shelf, and the handover-level incoming party is
// recorded when custody actually moves.
//
// Error mapping is entirely the shared `handleApiError`: 403 for the key or
// the feature, 400 for what the caller sent (missing or unknown field, a
// reason that is missing, wrong-domain, another café's, or stopped), 404 for
// a handover that is not theirs to see, 403 for another branch's, 409 for a
// status that cannot be sent back or a handover with no bound count.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.request_recount");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;

    const body = recountSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await requestRecount({
      handoverId: id,
      incomingUserId: session.id,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
