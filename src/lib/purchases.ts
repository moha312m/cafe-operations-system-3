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

export const FUNDING_SOURCES = ["DRAWER", "SAFE", "BANK"] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const FUNDING_LABEL: Record<FundingSource, string> = {
  DRAWER: "من درج الكاشير",
  SAFE: "من الخزنة",
  BANK: "من البنك / كارت / محفظة",
};

// Cash sources pay in cash and a bank source never does — the same rule the
// PurchasePayment_funding_check constraint enforces, stated here so the API
// can refuse with a readable message instead of a constraint error.
// What the screen offers: one choice that fixes both the source and the
// method, so an impossible pair (bank cash, drawer card) can't be picked.
export const PAYMENT_CHOICES = [
  { key: "DRAWER_CASH", fundingSource: "DRAWER", method: "CASH", label: "كاش من درج الكاشير" },
  { key: "SAFE_CASH", fundingSource: "SAFE", method: "CASH", label: "كاش من الخزنة" },
  { key: "BANK_TRANSFER", fundingSource: "BANK", method: "BANK_TRANSFER", label: "تحويل بنكي" },
  { key: "BANK_CARD", fundingSource: "BANK", method: "CARD", label: "فيزا الكافيه" },
  { key: "BANK_WALLET", fundingSource: "BANK", method: "WALLET", label: "محفظة الكافيه" },
] as const satisfies readonly { key: string; fundingSource: FundingSource; method: PurchasePaymentMethod; label: string }[];
export type PaymentChoice = (typeof PAYMENT_CHOICES)[number];

export function fundingMethodError(funding: FundingSource, method: PurchasePaymentMethod): string | null {
  if (funding === "BANK") return method === "CASH" ? "الدفع من البنك مايكونش كاش — اختار تحويل أو كارت أو محفظة" : null;
  return method === "CASH" ? null : "الدفع من الدرج أو الخزنة لازم يكون كاش";
}

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
