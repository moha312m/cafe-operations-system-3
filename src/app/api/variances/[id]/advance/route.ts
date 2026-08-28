import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { advanceVarianceCase } from "@/lib/variance-case";
import { mayAssignResponsibility } from "@/lib/variance-confidence";

type Params = { params: Promise<{ id: string }> };

const STATUSES = [
  "OPEN",
  "UNDER_INVESTIGATION",
  "RESPONSIBILITY_ASSIGNED",
  "APPROVED",
  "RESOLVED",
  "WAIVED",
] as const;

const advanceSchema = z.object({
  to: z.enum(STATUSES, { message: "حالة غير معروفة" }),
  note: z.string().max(1000).optional(),
  assignedResponsibilityUserId: z.string().optional(),
});

/** The two moves that END a case. */
const CLOSING: readonly string[] = ["RESOLVED", "WAIVED"];

/**
 * Which key a move costs.
 *
 * Looking into a case and closing one are different powers on purpose: the
 * person doing the reviewing should not also be the one deciding the review
 * is over. An unrecognised target falls to the investigate key so that an
 * unauthorised caller is refused before a malformed body is diagnosed for
 * them.
 */
function keyFor(to: unknown): string {
  return CLOSING.includes(String(to)) ? "variance.resolve" : "variance.investigate";
}

// POST /api/variances/:id/advance — move one case along, or refuse.
//
// Three refusals live here rather than in `advanceVarianceCase`, because they
// are about the CALLER and the request, not about the case's own state
// machine, which the service already owns:
//
//   • the key the target status costs;
//   • closing without a stated reason — a case that ends with no note is one
//     nobody can review afterwards;
//   • assigning responsibility from evidence below VERIFIED, refused with the
//     confidence named so the reader knows what would have to change. The
//     service keeps its own copy of that guard, which is deliberate: this one
//     produces the better message, that one makes the rule impossible to walk
//     around by calling the service directly.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const raw: unknown = await request.json();
    const session = await requireKey(keyFor((raw as { to?: unknown } | null)?.to));
    await requireFeature(session, "shiftManagementEnabled");

    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const body = advanceSchema.parse(raw);

    const found = await db.varianceCase.findUnique({
      where: { id },
      select: { id: true, cafeId: true, branchId: true, status: true, confidence: true },
    });
    // 404 rather than 403 across a café boundary: a tenant learns nothing
    // about another tenant's records, including that they exist.
    if (!found || found.cafeId !== cafeId) {
      throw new ApiError(404, "حالة الفرق غير موجودة");
    }
    if (session.branchId && found.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }

    if (CLOSING.includes(body.to) && !body.note?.trim()) {
      throw new ApiError(400, "لازم تكتب سبب إقفال الحالة");
    }

    if (body.to === "RESPONSIBILITY_ASSIGNED" && !mayAssignResponsibility(found.confidence)) {
      throw new ApiError(
        403,
        `مينفعش تحدد مسؤولية على فرق تقديره ${found.confidence} — لازم الأدلة تكون VERIFIED`
      );
    }

    if (body.assignedResponsibilityUserId) {
      const person = await db.user.findUnique({
        where: { id: body.assignedResponsibilityUserId },
        select: { cafeId: true },
      });
      if (!person || person.cafeId !== cafeId) {
        throw new ApiError(400, "الموظف مش تابع للكافيه");
      }
    }

    const result = await advanceVarianceCase({
      caseId: id,
      to: body.to,
      actorId: session.id,
      note: body.note?.trim() || undefined,
      assignedResponsibilityUserId: body.assignedResponsibilityUserId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
