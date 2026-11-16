import { PrintActions } from "@/components/receipts/print-actions";
import { ApiError, requirePermission, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { protectedTransaction } from "@/lib/protected-transaction";
import { hasPickupTicket, pickupSettled } from "@/lib/register-pickup";
import { scopedLockPredicate } from "@/lib/transaction-locks";

export const dynamic = "force-dynamic";

export default async function PickupTicket({ params, searchParams }: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ print?: string; reprint?: string }>;
}) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  const requestedReprint = query.reprint === "1";
  const forbidden = "ليس لديك صلاحية لطباعة تذكرة الاستلام";
  let order;
  try {
    const session = await requirePermission("orders:read");
    const { keys } = await resolvePermissions(session);
    const canPrintPaid = keys.has("receipts.print");
    const canReprint = keys.has("receipts.reprint");
    if (requestedReprint ? !canReprint : !canPrintPaid && !keys.has("receipts.print_pickup")) {
      throw new ApiError(403, forbidden);
    }
    const scope = resolveReadScope(session);
    order = await protectedTransaction(async (tx) => {
      // Serialize ticket issuance with other prints and with order payment.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT o."id" FROM "Order" o
        WHERE o."id" = ${orderId} AND ${scopedLockPredicate(tx, "o")} FOR UPDATE OF o
      `;
      if (!locked) return null;
      const ticket = await tx.order.findUniqueOrThrow({
        where: { id: locked.id },
        select: {
          id: true, cafeId: true, branchId: true, orderNumber: true, createdAt: true,
          branch: { select: { name: true } }, status: true, source: true,
          type: true, approvalStatus: true, tableSessionId: true, tableNumber: true,
          paymentStatus: true, remainingAmount: true,
        },
      });
      if (!requestedReprint && !canPrintPaid && ticket.paymentStatus === "PAID") {
        throw new ApiError(403, "صلاحية تذكرة الاستلام للطلبات غير المدفوعة فقط — لطباعة الإيصال المدفوع يلزم receipts.print");
      }
      if (!hasPickupTicket(ticket)) return null;
      const priorPrint = !requestedReprint && await tx.auditLog.findFirst({
        where: {
          cafeId: ticket.cafeId, entity: "Order", entityId: ticket.id,
          createdAt: { gte: ticket.createdAt },
          action: { in: ["PICKUP_TICKET_PRINTED", "PICKUP_TICKET_REPRINTED"] },
        },
        select: { id: true },
      });
      const isReprint = requestedReprint || !!priorPrint;
      if (isReprint && !canReprint) throw new ApiError(403, forbidden);
      await auditInTransaction(tx, {
        cafeId: ticket.cafeId, userId: session.id,
        action: isReprint ? "PICKUP_TICKET_REPRINTED" : "PICKUP_TICKET_PRINTED",
        entity: "Order", entityId: ticket.id,
        details: {
          orderId: ticket.id, orderNumber: ticket.orderNumber,
          branchId: ticket.branchId, paymentStatus: ticket.paymentStatus,
        },
      });
      return ticket;
    }, scope);
  } catch (e) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) return <main dir="rtl" className="p-8 text-center">{e.message}</main>;
    throw e;
  }
  if (!order) return <main dir="rtl" className="p-8 text-center">تذكرة الاستلام غير متاحة لهذا الطلب.</main>;
  const label = order.status === "SERVED" ? "تم تسليم الطلب"
    : order.paymentStatus === "PAID" && pickupSettled({ ...order, remainingAmount: order.remainingAmount.toString() }) ? "مدفوع"
    : order.remainingAmount.isZero() ? "لا يوجد مبلغ مستحق" : "في انتظار التحصيل";
  return <main dir="rtl" className="mx-auto max-w-[80mm] px-4 py-5 text-center">
    <style>{`@media print { @page { size: 80mm auto; margin: 3mm; } .no-print { display: none !important; } body { background: white !important; color: black !important; } }`}</style>
    <p className="text-lg font-bold">{order.branch.name}</p>
    <h1 className="mt-3 text-xl font-semibold">رقم الاستلام</h1>
    <p className="text-5xl font-bold tabular-nums"><bdi>#{order.orderNumber}</bdi></p>
    <p className="mt-3 font-semibold">{label}</p>
    <p className="mt-2 text-sm">تذكرة استلام الطلب · ليست إيصال دفع</p>
    <PrintActions autoPrint={query.print === "1"} printLabel="طباعة تذكرة الاستلام" />
  </main>;
}
