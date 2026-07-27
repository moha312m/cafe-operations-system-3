import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError } from "@/lib/api";
import { sessionDisplayStatus } from "@/lib/table-sessions";

// GET /api/tables — open table sessions (+ today's closed) for the table
// board. ?branchId= for owners; pinned staff are locked to their branch.
// ?tableNumber= checks one table (POS uses it for the "open bill" hint).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("tables.view");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const tableNumber = params.get("tableNumber")?.trim();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [open, closedToday] = await Promise.all([
      db.tableSession.findMany({
        where: {
          cafeId,
          ...(branchId ? { branchId } : {}),
          ...(tableNumber ? { tableNumber } : {}),
          status: "OPEN",
        },
        orderBy: { startedAt: "asc" },
        include: {
          branch: { select: { name: true } },
          orders: {
            select: { id: true, status: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      tableNumber
        ? []
        : db.tableSession.findMany({
            where: {
              cafeId,
              ...(branchId ? { branchId } : {}),
              status: "CLOSED",
              closedAt: { gte: startOfToday },
            },
            orderBy: { closedAt: "desc" },
            take: 12,
            include: { branch: { select: { name: true } } },
          }),
    ]);

    return NextResponse.json({
      sessions: open.map((s) => ({
        id: s.id,
        tableNumber: s.tableNumber,
        branch: s.branch.name,
        status: s.status,
        displayStatus: sessionDisplayStatus(s),
        startedAt: s.startedAt,
        totalAmount: Number(s.totalAmount),
        paidAmount: Number(s.paidAmount),
        remainingAmount: Number(s.remainingAmount),
        customerName: s.customerName,
        // Pending-approval orders count as activity but not billing.
        orderCount: s.orders.filter((o) => o.status !== "REJECTED" && o.status !== "CANCELLED").length,
        lastOrderAt: s.orders[0]?.createdAt ?? null,
      })),
      closedToday: closedToday.map((s) => ({
        id: s.id,
        tableNumber: s.tableNumber,
        branch: s.branch.name,
        startedAt: s.startedAt,
        closedAt: s.closedAt,
        totalAmount: Number(s.totalAmount),
        paidAmount: Number(s.paidAmount),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
