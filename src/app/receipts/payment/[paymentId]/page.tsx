import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { resolvePermissions } from "@/lib/perms/effective";
import { audit } from "@/lib/audit";
import { PrintActions } from "@/components/receipts/print-actions";

export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = {
  CASH: "كاش", CARD: "فيزا", WALLET: "محفظة", MIXED: "مختلط",
};

function fmtMoney(v: number | string | { toString(): string }): string {
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${s} ج.م`;
}
function fmtDateTime(d: Date): string {
  return d.toLocaleString("ar-EG", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function sittingLabel(from: Date, to: Date): string {
  const mins = Math.max(Math.floor((to.getTime() - from.getTime()) / 60_000), 0);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `${m} دقيقة`;
  return `${h} ساعة${m ? ` و ${m} دقيقة` : ""}`;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// Simple centered message shell (no sidebar — this route prints).
function Message({ text }: { text: string }) {
  return (
    <main dir="rtl" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", fontFamily: "var(--font-cairo), sans-serif" }}>
      <p style={{ fontSize: 16, fontWeight: 600 }}>{text}</p>
    </main>
  );
}

type ReceiptItem = {
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  addOns: { addOnName: string }[];
  notes: string | null;
};

// Merge identical lines across the table's orders: same product, variant,
// unit price, add-ons and notes combine into one line with summed
// quantities — different pricing/add-ons/notes stay separate so the math
// is never wrong.
function mergeItems(items: ReceiptItem[]): ReceiptItem[] {
  const map = new Map<string, ReceiptItem>();
  for (const it of items) {
    const key = [
      it.productName, it.variantName ?? "", it.unitPrice,
      it.addOns.map((a) => a.addOnName).sort().join(","), it.notes ?? "",
    ].join("|");
    const prev = map.get(key);
    if (prev) {
      prev.quantity += it.quantity;
      prev.lineTotal = round2(prev.lineTotal + it.lineTotal);
    } else {
      map.set(key, { ...it, addOns: [...it.addOns] });
    }
  }
  return [...map.values()];
}

// إيصال دفع — printable customer receipt for one payment. READ-ONLY.
// Payments on a table session default to the UNIFIED table bill (one
// account, combined items, one totals block); ?scope=order forces the
// single-invoice view (explicit invoice collection, takeaway, delivery).
export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ print?: string; reprint?: string; scope?: string }>;
}) {
  const [{ paymentId }, sp] = await Promise.all([params, searchParams]);
  const session = await getSession();
  if (!session) return <Message text="سجّل دخولك الأول" />;

  const { keys } = await resolvePermissions(session);
  const isReprint = sp.reprint === "1";
  if (!keys.has(isReprint ? "receipts.reprint" : "receipts.print")) {
    return <Message text="ليس لديك صلاحية لطباعة الريسيت" />;
  }

  const payment = await db.payment.findFirst({
    // cafe scope = tenant isolation even with a leaked id
    where: { id: paymentId, cafeId: session.cafeId ?? "" },
    include: {
      cafe: { select: { name: true } },
      branch: { select: { name: true, address: true, phone: true } },
      receivedBy: { select: { name: true } },
      order: {
        include: {
          items: { include: { addOns: true } },
          customer: {
            select: { name: true, normalizedPhone: true, loyaltyPointsBalance: true },
          },
        },
      },
      tableSession: { select: { id: true, tableNumber: true, startedAt: true, status: true } },
    },
  });
  if (!payment) return <Message text="الإيصال غير موجود" />;
  if (session.branchId && payment.branchId && payment.branchId !== session.branchId) {
    return <Message text="الإيصال تبع فرع تاني" />;
  }

  const order = payment.order;
  // Table payments default to the unified table bill; ?scope=order forces
  // the single-invoice receipt (explicitly-collected invoice).
  const tableScope = !!payment.tableSessionId && sp.scope !== "order";

  // ── Unified table bill data ──
  let tableData: null | {
    tableNumber: string;
    startedAt: Date;
    subtotal: number;
    manualDiscount: number;
    loyaltyDiscount: number;
    service: number;
    tax: number;
    totalAmount: number;
    paidAmount: number;
    remainingAmount: number;
    operationAmount: number;
    previousPaid: number;
    loyaltyPointsRedeemed: number;
    loyaltyPointsEarned: number;
    customer: { name: string | null; normalizedPhone: string; loyaltyPointsBalance: number } | null;
    items: ReceiptItem[];
    internalOrders: { orderNumber: number; total: number }[];
  } = null;

  if (tableScope) {
    const ts = await db.tableSession.findFirst({
      where: { id: payment.tableSessionId!, cafeId: payment.cafeId },
      include: {
        orders: {
          where: { status: { notIn: ["CANCELLED", "REJECTED"] } },
          orderBy: { createdAt: "asc" },
          include: {
            items: { include: { addOns: true } },
            customer: { select: { name: true, normalizedPhone: true, loyaltyPointsBalance: true } },
          },
        },
      },
    });
    if (ts) {
      // "This operation" = sibling payment rows written by the same
      // collection transaction (same session/cashier, ±5s).
      const windowMs = 5_000;
      const siblings = await db.payment.aggregate({
        where: {
          tableSessionId: ts.id,
          cashierId: payment.cashierId,
          status: "PAID",
          createdAt: {
            gte: new Date(payment.createdAt.getTime() - windowMs),
            lte: new Date(payment.createdAt.getTime() + windowMs),
          },
        },
        _sum: { amount: true },
      });
      const operationAmount = Number(siblings._sum.amount ?? payment.amount);

      let subtotal = 0, manualDiscount = 0, loyaltyDiscount = 0, service = 0, tax = 0;
      let pointsRedeemed = 0, pointsEarned = 0;
      const allItems: ReceiptItem[] = [];
      let customer = order.customer;
      for (const o of ts.orders) {
        subtotal = round2(subtotal + Number(o.subtotal));
        loyaltyDiscount = round2(loyaltyDiscount + Number(o.loyaltyDiscountAmount));
        manualDiscount = round2(manualDiscount + Number(o.discountAmount) - Number(o.loyaltyDiscountAmount));
        service = round2(service + Number(o.serviceChargeAmount));
        tax = round2(tax + Number(o.taxAmount));
        pointsRedeemed += o.loyaltyPointsRedeemed;
        pointsEarned += o.loyaltyPointsEarned;
        if (!customer && o.customer) customer = o.customer;
        for (const it of o.items) {
          allItems.push({
            productName: it.productName,
            variantName: it.variantName,
            quantity: it.quantity,
            unitPrice: Number(it.unitPrice),
            lineTotal: Number(it.lineTotal),
            addOns: it.addOns,
            notes: it.notes,
          });
        }
      }

      tableData = {
        tableNumber: ts.tableNumber,
        startedAt: ts.startedAt,
        subtotal,
        manualDiscount: Math.max(manualDiscount, 0),
        loyaltyDiscount,
        service,
        tax,
        totalAmount: Number(ts.totalAmount),
        paidAmount: Number(ts.paidAmount),
        remainingAmount: Number(ts.remainingAmount),
        operationAmount,
        previousPaid: Math.max(round2(Number(ts.paidAmount) - operationAmount), 0),
        loyaltyPointsRedeemed: pointsRedeemed,
        loyaltyPointsEarned: pointsEarned,
        customer,
        items: mergeItems(allItems),
        internalOrders: ts.orders.map((o) => ({ orderNumber: o.orderNumber, total: Number(o.total) })),
      };
    }
  }

  // Audit trail: viewing always; printing/reprinting when deep-linked.
  await audit({
    cafeId: payment.cafeId, userId: session.id,
    action: sp.print === "1" ? (isReprint ? "RECEIPT_REPRINTED" : "RECEIPT_PRINTED") : "RECEIPT_VIEWED",
    entity: "Payment", entityId: payment.id,
    details: {
      paymentId: payment.id,
      orderId: payment.orderId,
      tableSessionId: payment.tableSessionId,
      branchId: payment.branchId,
    },
  });

  // ── Loyalty + status lines (mode-aware) ──
  const customer = tableData ? tableData.customer : order.customer;
  const loyaltyRedeemed = tableData ? tableData.loyaltyPointsRedeemed : order.loyaltyPointsRedeemed;
  const loyaltyEarned = tableData ? tableData.loyaltyPointsEarned : order.loyaltyPointsEarned;
  const loyaltyDiscountValue = tableData ? tableData.loyaltyDiscount : Number(order.loyaltyDiscountAmount);
  const showLoyalty = !!customer && (loyaltyRedeemed > 0 || loyaltyEarned > 0 || customer.loyaltyPointsBalance > 0);

  const orderRemaining = Number(order.remainingAmount);
  const remaining = tableData ? tableData.remainingAmount : orderRemaining;
  const settledLine = tableData
    ? tableData.remainingAmount <= 0.001
      ? "تم سداد الحساب بالكامل ✅"
      : `متبقي على الترابيزة: ${fmtMoney(tableData.remainingAmount)}`
    : orderRemaining <= 0.001
      ? "مدفوع بالكامل ✅"
      : `مدفوع جزئيًا — المتبقي: ${fmtMoney(orderRemaining)}`;

  const singleItems: ReceiptItem[] = order.items.map((it) => ({
    productName: it.productName,
    variantName: it.variantName,
    quantity: it.quantity,
    unitPrice: Number(it.unitPrice),
    lineTotal: Number(it.lineTotal),
    addOns: it.addOns,
    notes: it.notes,
  }));

  const dashed = { borderTop: "1px dashed #999", margin: "8px 0" } as const;
  const row = { display: "flex", justifyContent: "space-between", gap: 8 } as const;

  return (
    <main dir="rtl" style={{ background: "#f4f4f5", minHeight: "100dvh", padding: "16px 8px", fontFamily: "var(--font-cairo), sans-serif" }}>
      {/* Print CSS: 80mm paper, hide screen chrome. */}
      <style>{`
        @media print {
          body { margin: 0; background: #fff !important; }
          main { background: #fff !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .receipt {
            width: 80mm !important;
            max-width: 80mm !important;
            direction: rtl;
            box-shadow: none !important;
            border: 0 !important;
            margin: 0 !important;
          }
        }
        @page { size: 80mm auto; margin: 2mm; }
      `}</style>

      <PrintActions autoPrint={sp.print === "1"} />

      <div
        className="receipt"
        style={{
          width: "80mm", maxWidth: "100%", margin: "0 auto", background: "#fff",
          border: "1px solid #e4e4e7", borderRadius: 8, padding: "12px 10px",
          fontSize: 12, lineHeight: 1.7, color: "#111",
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22 }}>☕</div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{payment.cafe.name}</div>
          {payment.branch && <div style={{ fontWeight: 600 }}>{payment.branch.name}</div>}
          {payment.branch?.address && <div style={{ color: "#555", fontSize: 11 }}>{payment.branch.address}</div>}
          {payment.branch?.phone && <div style={{ color: "#555", fontSize: 11 }} dir="ltr">{payment.branch.phone}</div>}
          <div style={{ fontWeight: 700, marginTop: 4 }}>
            {tableData ? `— حساب الترابيزة رقم ${tableData.tableNumber} —` : "— إيصال دفع —"}
          </div>
          <div style={{ color: "#555", fontSize: 11 }}>{fmtDateTime(new Date())}</div>
        </div>

        <div style={dashed} />

        {/* Main info */}
        <div style={row}><span>رقم الريسيت</span><b dir="ltr">{payment.id.slice(-8).toUpperCase()}</b></div>
        {!tableData && <div style={row}><span>رقم الطلب</span><b>#{order.orderNumber}</b></div>}
        {!tableData && order.tableNumber && (
          <div style={row}><span>رقم الترابيزة</span><b>{order.tableNumber}</b></div>
        )}
        <div style={row}><span>الكاشير</span><b>{payment.receivedBy.name}</b></div>
        {customer?.name && <div style={row}><span>العميل</span><b>{customer.name}</b></div>}
        {customer?.normalizedPhone && (
          <div style={row}><span>رقم الموبايل</span><b dir="ltr">{customer.normalizedPhone}</b></div>
        )}
        {tableData && (
          <>
            <div style={row}><span>بداية الجلسة</span><b>{fmtDateTime(tableData.startedAt)}</b></div>
            <div style={row}><span>مدة الجلوس</span><b>{sittingLabel(tableData.startedAt, new Date())}</b></div>
          </>
        )}

        <div style={dashed} />

        {/* ── Items: ONE unified list (no per-invoice headers) ── */}
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          {tableData ? "أصناف الترابيزة" : "الأصناف"}
        </div>
        {(tableData ? tableData.items : singleItems).map((it, i) => (
          <div key={i}>
            <div style={row}>
              <span style={{ minWidth: 0 }}>
                {it.quantity}× {it.productName}
                {it.variantName ? ` (${it.variantName})` : ""}
                {it.quantity > 1 && (
                  <span style={{ color: "#777", fontSize: 10 }}> ({fmtMoney(it.unitPrice)})</span>
                )}
              </span>
              <span style={{ whiteSpace: "nowrap" }}>{fmtMoney(it.lineTotal)}</span>
            </div>
            {it.addOns.length > 0 && (
              <div style={{ color: "#555", fontSize: 11, paddingInlineStart: 12 }}>
                + {it.addOns.map((a) => a.addOnName).join("، ")}
              </div>
            )}
            {it.notes && (
              <div style={{ color: "#555", fontSize: 11, paddingInlineStart: 12 }}>📝 {it.notes}</div>
            )}
          </div>
        ))}
        {tableData && (
          <div style={{ color: "#777", fontSize: 10, marginTop: 2 }}>
            يشمل هذا الحساب كل طلبات الترابيزة
          </div>
        )}

        <div style={dashed} />

        {/* ── ONE totals section ── */}
        {tableData ? (
          <>
            <div style={row}><span>إجمالي الحساب</span><span>{fmtMoney(tableData.subtotal)}</span></div>
            {tableData.manualDiscount > 0.001 && (
              <div style={row}><span>الخصم</span><span>−{fmtMoney(tableData.manualDiscount)}</span></div>
            )}
            {tableData.loyaltyDiscount > 0.001 && (
              <div style={row}><span>خصم نقاط الولاء</span><span>−{fmtMoney(tableData.loyaltyDiscount)}</span></div>
            )}
            {tableData.service > 0.001 && (
              <div style={row}><span>السيرفيس</span><span>{fmtMoney(tableData.service)}</span></div>
            )}
            {tableData.tax > 0.001 && (
              <div style={row}><span>الضريبة</span><span>{fmtMoney(tableData.tax)}</span></div>
            )}
            <div style={{ ...row, fontWeight: 800, fontSize: 14 }}>
              <span>إجمالي المستحق</span><span>{fmtMoney(tableData.totalAmount)}</span>
            </div>
            {tableData.previousPaid > 0.001 && (
              <div style={row}><span>المدفوع سابقًا</span><span>{fmtMoney(tableData.previousPaid)}</span></div>
            )}
            <div style={row}><span>المدفوع في هذه العملية</span><b>{fmtMoney(tableData.operationAmount)}</b></div>
            <div style={row}><span>إجمالي المدفوع</span><span>{fmtMoney(tableData.paidAmount)}</span></div>
            <div style={{ ...row, fontWeight: 700 }}>
              <span>المتبقي</span><span>{fmtMoney(tableData.remainingAmount)}</span>
            </div>
          </>
        ) : (
          <>
            <div style={row}><span>الإجمالي قبل الخصم</span><span>{fmtMoney(order.subtotal)}</span></div>
            {Number(order.discountAmount) - Number(order.loyaltyDiscountAmount) > 0.001 && (
              <div style={row}><span>الخصم</span><span>−{fmtMoney(Number(order.discountAmount) - Number(order.loyaltyDiscountAmount))}</span></div>
            )}
            {Number(order.loyaltyDiscountAmount) > 0 && (
              <div style={row}><span>خصم نقاط الولاء</span><span>−{fmtMoney(order.loyaltyDiscountAmount)}</span></div>
            )}
            {Number(order.serviceChargeAmount) > 0 && (
              <div style={row}><span>السيرفيس</span><span>{fmtMoney(order.serviceChargeAmount)}</span></div>
            )}
            {Number(order.taxAmount) > 0 && (
              <div style={row}><span>الضريبة</span><span>{fmtMoney(order.taxAmount)}</span></div>
            )}
            <div style={{ ...row, fontWeight: 800, fontSize: 14 }}>
              <span>الإجمالي النهائي</span><span>{fmtMoney(order.total)}</span>
            </div>
            <div style={row}><span>المدفوع</span><span>{fmtMoney(order.paidAmount)}</span></div>
            {orderRemaining > 0.001 && (
              <div style={{ ...row, fontWeight: 700 }}><span>المتبقي</span><span>{fmtMoney(orderRemaining)}</span></div>
            )}
          </>
        )}

        <div style={dashed} />

        {/* Payment */}
        <div style={row}><span>طريقة الدفع</span><b>{METHOD_LABEL[payment.method] ?? payment.method}</b></div>
        <div style={row}><span>رقم عملية الدفع</span><b dir="ltr">{payment.id.slice(-8).toUpperCase()}</b></div>
        <div style={row}><span>وقت الدفع</span><b>{fmtDateTime(payment.paidAt)}</b></div>
        <div style={{ textAlign: "center", fontWeight: 700, marginTop: 4, color: remaining <= 0.001 ? "#047857" : "#b45309" }}>
          {settledLine}
        </div>

        {/* Loyalty */}
        {showLoyalty && (
          <>
            <div style={dashed} />
            <div style={{ fontWeight: 700, marginBottom: 2 }}>⭐ نقاط الولاء</div>
            {loyaltyRedeemed > 0 && (
              <>
                <div style={row}><span>نقاط مستخدمة</span><span>{loyaltyRedeemed}</span></div>
                <div style={row}><span>خصم نقاط الولاء</span><span>{fmtMoney(loyaltyDiscountValue)}</span></div>
              </>
            )}
            {loyaltyEarned > 0 && (
              <div style={row}><span>نقاط مكتسبة من الطلب</span><span>+{loyaltyEarned}</span></div>
            )}
            <div style={row}>
              <span>رصيد النقاط الحالي</span>
              <b>{customer!.loyaltyPointsBalance} نقطة</b>
            </div>
          </>
        )}

        <div style={dashed} />

        {/* Footer */}
        <div style={{ textAlign: "center", fontWeight: 700 }}>شكرًا لزيارتكم 🌟</div>
        <div style={{ textAlign: "center", color: "#555", fontSize: 11 }}>نتمنى رؤيتكم مرة أخرى</div>
      </div>

      {/* Internal order breakdown — screen only, never printed. */}
      {tableData && tableData.internalOrders.length > 1 && (
        <div
          className="no-print"
          style={{
            width: "80mm", maxWidth: "100%", margin: "12px auto 0", background: "#fff",
            border: "1px dashed #d4d4d8", borderRadius: 8, padding: "8px 10px",
            fontSize: 11, color: "#555",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>تفاصيل الطلبات الداخلية (لا تُطبع)</div>
          {tableData.internalOrders.map((o) => (
            <div key={o.orderNumber} style={row}>
              <span>طلب #{o.orderNumber}</span>
              <span>{fmtMoney(o.total)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
