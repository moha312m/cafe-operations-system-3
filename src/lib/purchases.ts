// ── Purchases helpers ────────────────────────────────────────────────
import type {
  InventoryUnit,
  PurchaseInvoiceStatus,
  PurchasePaymentStatus,
  PurchasePaymentMethod,
} from "@prisma/client";

import { purchaseWeightedAverage } from "./purchase-arithmetic";
import type { Numeric } from "./money";

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
  oldStock: Numeric,
  oldCost: Numeric,
  newQty: Numeric,
  newCost: Numeric
): number {
  return purchaseWeightedAverage(oldStock, oldCost, newQty, newCost);
}

// Derive an invoice's payment status from its totals.
export function paymentStatusFor(total: number, paid: number): PurchasePaymentStatus {
  if (paid <= 0.001) return "UNPAID";
  if (paid >= total - 0.001) return "PAID";
  return "PARTIAL";
}

export type PickerItem = { id: string; name: string; unit: InventoryUnit };

// Which item a draft line shows that the ordinary picker does not offer.
// The ordinary list leaves out archived items, but a draft keeps the item it
// was written with: that one stays visible and selected for its own line only,
// so saving unrelated edits neither drops it nor forces a substitute. Other
// lines, and other items, still choose from the ordinary list.
export function retainedLineItem(available: readonly PickerItem[], selectedId: string, retained: Readonly<Record<string, PickerItem>>): PickerItem | null {
  if (!selectedId || available.some((item) => item.id === selectedId)) return null;
  return retained[selectedId] ?? null;
}
