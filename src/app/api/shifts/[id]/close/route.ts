import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { handleApiError, ApiError } from "@/lib/api";
import { closeShiftWithSettlement } from "@/lib/cash-close";
import { HandoverBlockedError } from "@/lib/handover";
import { resolvePermissions } from "@/lib/perms/effective";

type Params = { params: Promise<{ id: string }> };

// `reason` is the cash-variance explanation, and `cardReason` / `walletReason`
// are its equivalents on the two processor channels. Each is required by the
// service when ITS OWN variance is non-zero — the rules are stated once, in
// `cash-close` and `tender-settlement`, rather than duplicated into a
// conditional schema here.
//
// The three reasons are separate fields on purpose. A rejected card
// authorisation, a pending wallet transfer and a short drawer have different
// causes, and one shared "settlement reason" box would let a sentence about
// one stand as the explanation for another.
//
// `actualCardAmount` and `actualWalletAmount` are optional HERE and required
// by the service exactly when the channel took money this shift: a café that
// never accepted a card must not be made to type a figure for a terminal it
// does not own. `.min(0)` is deliberately NOT applied to them, unlike cash —
// a drawer cannot hold a negative amount, but a settlement net of refunds
// genuinely can be negative, and refusing that would make a real settlement
// unrecordable.
//
// `notes` stays what it always was: a free-text shift note that explains
// nothing in particular.
//
// The schema is deliberately narrow, and `.strict()` is what keeps it that
// way. Nothing accepts a tolerance, a bound, an acceptability verdict, an
// expected figure or a pre-computed variance — so a client cannot smuggle one
// in and have it stored beside figures the server produced, or move the target
// its settlement is measured against.
const closeSchema = z
  .object({
    actualCashAmount: z.number().min(0),
    reason: z.string().max(1000).optional(),
    actualCardAmount: z.number().optional(),
    cardReason: z.string().max(1000).optional(),
    actualWalletAmount: z.number().optional(),
    walletReason: z.string().max(1000).optional(),
    notes: z.string().max(1000).optional(),
    // Where the stock is going, when the branch's policy says it has to go
    // somewhere. Stated, never inferred — see `ShiftCloseArgs.handoverTarget`.
    handoverTarget: z.enum(["SHIFT_TO_SHIFT", "BRANCH_CUSTODY"]).optional(),
  })
  .strip();

// POST /api/shifts/[id]/close — reconcile & close. A cashier may close only
// their own shift; a manager/owner (shifts:read) may close any branch shift.
//
// Authorization and tenancy are settled HERE, before the money is touched.
// `closeShiftWithSettlement` then performs the whole close — the cash
// snapshot, every processor settlement, the variance cases those raise and all
// the audit rows — as ONE transaction, so a failure anywhere in it leaves the
// shift open rather than closed-without-evidence or closed-half-reconciled.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "Not authenticated");
    const { id } = await params;
    const data = closeSchema.parse(await request.json());

    const shift = await db.shift.findUnique({ where: { id } });
    if (!shift) throw new ApiError(404, "Shift not found");
    if (session.role !== "SUPER_ADMIN" && shift.cafeId !== session.cafeId) {
      throw new ApiError(403, "Not allowed");
    }
    if (session.branchId && shift.branchId !== session.branchId) {
      throw new ApiError(403, "Not allowed");
    }
    const isOwnShift = shift.cashierId === session.id;
    const canManage = hasPermission(session.role, "shifts:read");
    if (!isOwnShift && !canManage) {
      throw new ApiError(403, "مينفعش تقفل شيفت كاشير تاني");
    }
    // Re-checked under a row lock inside the transaction; refused here too so
    // an obviously-settled shift costs nothing to turn away. AWAITING_HANDOVER
    // is refused for the same reason CLOSED is: its money is already settled.
    if (shift.status !== "OPEN") {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    // The handover capabilities this actor holds, resolved once, here.
    //
    // The service cannot do this itself: whether a handover is required is
    // only settled inside its transaction, under the shift lock, and it has
    // no session to ask. So the route establishes what the actor MAY do and
    // the service demands whichever of those it turns out to need — which
    // keeps the refusal before any mutation on both paths.
    const { keys } = await resolvePermissions(session);
    const grants = {
      handoverSubmit: keys.has("handover.submit"),
      handoverException: keys.has("handover.exception"),
    };

    const result = await closeShiftWithSettlement({
      shiftId: id,
      actualCash: data.actualCashAmount,
      reason: data.reason,
      tenders: {
        CARD: { actual: data.actualCardAmount, reason: data.cardReason },
        WALLET: { actual: data.actualWalletAmount, reason: data.walletReason },
      },
      notes: data.notes,
      actorId: session.id,
      closedByManager: !isOwnShift,
      handoverTarget: data.handoverTarget,
      grants,
    });

    // Read back what was COMMITTED, rather than reporting what we intended to
    // write. The blind-count redaction does not apply: the shift is CLOSED now,
    // and revealing the target to the person who just counted it is the whole
    // point of doing so after the server has persisted the count (SHIFT-003).
    const closed = await db.shift.findUniqueOrThrow({
      where: { id },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
        // The settlements this close committed, so the closer sees what was
        // recorded against each channel rather than being told only that the
        // shift is shut.
        tenderReconciliations: {
          orderBy: { method: "asc" },
          select: {
            id: true,
            method: true,
            expectedAmount: true,
            actualAmount: true,
            varianceAmount: true,
            reasonNote: true,
            submittedAt: true,
          },
        },
      },
    });

    // The closer is told which of the two stages they completed. A shift in
    // AWAITING_HANDOVER is settled but not finished, and a response that
    // said only "closed" would send a custodian home believing they were
    // discharged of stock they are still answerable for.
    return NextResponse.json({
      shift: closed,
      handover: {
        required: result.handoverRequired,
        target: result.handoverTarget,
        handoverId: result.handoverId,
        freezeId: result.freezeId,
        requiredItemCount: result.requiredItemCount,
        configIssue: result.handoverConfigIssue,
      },
    });
  } catch (error) {
    // The one error that carries a payload. `handleApiError` is shared by
    // every route in the application and returns `{ error }` and nothing
    // else; widening it so this feature can attach a list would change the
    // error contract everywhere. So the blockers are serialised HERE,
    // beside the same `error` field every other refusal uses — a café that
    // is told one reason at a time learns to distrust the answer.
    if (error instanceof HandoverBlockedError) {
      return NextResponse.json(
        { error: error.message, blockers: error.blockers },
        { status: error.status }
      );
    }
    return handleApiError(error);
  }
}
