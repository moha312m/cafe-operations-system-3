// ── Purchases helpers ────────────────────────────────────────────────
import type {
  PurchaseInvoiceStatus,
  PurchasePaymentStatus,
  PurchasePaymentMethod,
} from "@prisma/client";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const INVOICE_STATUS_LABEL: Record<PurchaseInvoiceStatus, string> = {
  DRAFT: "مسودة",
  CONFIRMED: "مؤكدة",
  CANCELLED: "ملغية",
};

export const PAYMENT_STATUS_LABEL: Record<PurchasePaymentStatus, string> = {
  UNPAID: "غير مدفوعة",
  PARTIAL: "مدفوعة جزئيًا",
  PAID: "مدفوعة بالكامل",
};

export const PURCHASE_METHOD_LABEL: Record<PurchasePaymentMethod, string> = {
  CASH: "كاش",
  CARD: "فيزا",
  WALLET: "محفظة",
  BANK_TRANSFER: "تحويل بنكي",
};

// Weighted-average cost per unit after adding a purchase:
//   (oldStock*oldCost + newQty*newCost) / (oldStock + newQty)
// Falls back to the new cost when there's no prior stock.
export function weightedAverageCost(
  oldStock: number,
  oldCost: number,
  newQty: number,
  newCost: number
): number {
  const totalQty = oldStock + newQty;
  if (totalQty <= 0) return round2(newCost);
  return round2((oldStock * oldCost + newQty * newCost) / totalQty);
}

// Derive an invoice's payment status from its totals.
export function paymentStatusFor(total: number, paid: number): PurchasePaymentStatus {
  if (paid <= 0.001) return "UNPAID";
  if (paid >= total - 0.001) return "PAID";
  return "PARTIAL";
}
