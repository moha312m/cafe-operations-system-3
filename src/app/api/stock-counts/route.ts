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
  assertNoClientScope,
  assertSupportedCountType,
  listCountSessions,
  startCountSession,
} from "@/lib/stock-count";

const startSchema = z.object({
  type: z.enum(["FULL", "CRITICAL"], {
    message: "نوع الجرد لازم يكون CRITICAL أو FULL",
  }),
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  shiftId: z.string().nullish(),
});

// GET /api/stock-counts — the branch's counts, as a list with no targets in
// it. Whoever is about to count reads this, so the shape carries no quantity
// at all rather than relying on a redactor to remove one.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("stock_count.view");
    await requireFeature(session, "inventoryEnabled");

    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveBranchId(session, params.get("branchId"));
    const status = params.get("status");

    const sessions = await listCountSessions({
      cafeId,
      branchId,
      status: status ? (status as never) : undefined,
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/stock-counts — start one. The body says WHAT KIND of count, never
// which items: scope is derived from the owner's configuration, and a body
// that names items is refused rather than having the field dropped.
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("stock_count.start");
    await requireFeature(session, "inventoryEnabled");

    const raw: unknown = await request.json();
    // Before anything else is read from the body, so a caller that tried to
    // choose the scope learns that, rather than learning about their café.
    assertNoClientScope(raw);
    // Before the schema, so CYCLE comes back named rather than as "not one
    // of FULL, CRITICAL".
    assertSupportedCountType((raw as { type?: unknown } | null)?.type);
    const body = startSchema.parse(raw);

    const cafeId = resolveCafeId(session, body.cafeId);
    const branchId = resolveBranchId(session, body.branchId);

    const started = await startCountSession({
      cafeId,
      branchId,
      type: body.type,
      initiatedById: session.id,
      shiftId: body.shiftId ?? null,
    });

    return NextResponse.json(
      {
        session: {
          id: started.sessionId,
          branchId,
          type: body.type,
          status: started.status,
          scopeDerivation: started.derivation,
          custodyPeriodId: started.custodyPeriodId,
          lineCount: started.lineCount,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
