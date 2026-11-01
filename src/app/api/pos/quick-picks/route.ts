import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, resolveBranchId, handleApiError, ApiError } from "@/lib/api";
import { DEFAULT_TZ } from "@/lib/date-range";

const LOOKBACK_DAYS = 14;
const LIMIT = 8;
/** Fewer than this in the hour window and the whole lookback is used instead. */
const MIN_IN_WINDOW = 3;

// GET /api/pos/quick-picks?branchId= — what this branch sells most around
// this hour of the day (±1h, last 14 days), for one-tap buttons on the till.
// Read-only and informational: the till still prices and validates as usual.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:create");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveBranchId(session, params.get("branchId"));
    const branch = await db.branch.findFirst({ where: { id: branchId, cafeId }, select: { id: true } });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");

    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: DEFAULT_TZ }).format(new Date())
    );
    const hours = [(hour + 23) % 24, hour, (hour + 1) % 24];

    const ranked = (windowed: boolean) => db.$queryRaw<{ productId: string; quantity: bigint }[]>`
      SELECT oi."productId", SUM(oi."quantity")::bigint AS quantity
        FROM "OrderItem" oi
        JOIN "Order" o ON o."id" = oi."orderId"
       WHERE o."cafeId" = ${cafeId}
         AND o."branchId" = ${branchId}
         AND o."createdAt" >= ${since}
         AND o."status"::text NOT IN ('CANCELLED', 'REJECTED')
         AND oi."productId" IS NOT NULL
         AND oi."kitchenStatus"::text <> 'CANCELLED'
         AND (${!windowed} OR EXTRACT(HOUR FROM (o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${DEFAULT_TZ}))::int = ANY(${hours}))
       GROUP BY oi."productId"
       ORDER BY quantity DESC, oi."productId"
       LIMIT ${LIMIT}
    `;

    let rows = await ranked(true);
    let window: "HOUR" | "ALL_DAY" = "HOUR";
    if (rows.length < MIN_IN_WINDOW) {
      rows = await ranked(false);
      window = "ALL_DAY";
    }

    return NextResponse.json({
      window,
      hour,
      products: rows.map((r) => ({ productId: r.productId, quantity: Number(r.quantity) })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
