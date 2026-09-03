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
// Guarded by `handover.accept`, deliberately.
//
// A key named for this act — `handover.request_recount` — does not exist in
// the permission catalog at this stage; SH-23 is the stage that introduces
// it, and may then refine or replace this guard. Until it does, asking for a
// recount is an act of the party TAKING the custody, which is what
// `handover.accept` names, and guarding it with the SUBMIT key would have
// handed the decision to the person being measured. The catalog is not
// touched here: adding a key to serve one route is how a permission model
// stops meaning anything.
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
    const session = await requireKey("handover.accept");
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
