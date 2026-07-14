import type { InventoryTransactionType, InventoryUnit } from "@prisma/client";

// Stock status derivation (spec §3):
//   currentStock <= 0            → نفد (out)
//   currentStock <= minimumStock → منخفض (low)
//   otherwise                    → متوفر (ok)
export type StockStatus = "out" | "low" | "ok";

export function stockStatus(current: number, minimum: number): StockStatus {
  if (current <= 0) return "out";
  if (current <= minimum) return "low";
  return "ok";
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  ok: "متوفر",
  low: "منخفض",
  out: "نفد",
};

export const UNIT_LABEL: Record<InventoryUnit, string> = {
  GRAM: "جرام",
  KG: "كيلو",
  ML: "مل",
  LITER: "لتر",
  PIECE: "قطعة",
  BOX: "علبة",
  BAG: "كيس",
};

export const TXN_LABEL: Record<InventoryTransactionType, string> = {
  PURCHASE: "إضافة مخزون",
  USAGE: "استخدام",
  WASTE: "هالك",
  ADJUSTMENT: "تسوية",
  TRANSFER_IN: "تحويل داخل",
  TRANSFER_OUT: "تحويل خارج",
  RETURN: "مرتجع",
};

// Which audit action a movement writes.
export const TXN_AUDIT_ACTION: Record<InventoryTransactionType, string> = {
  PURCHASE: "INVENTORY_STOCK_ADDED",
  RETURN: "INVENTORY_STOCK_ADDED",
  USAGE: "INVENTORY_STOCK_USED",
  WASTE: "INVENTORY_WASTE_RECORDED",
  ADJUSTMENT: "INVENTORY_ADJUSTED",
  TRANSFER_IN: "INVENTORY_TRANSFERRED",
  TRANSFER_OUT: "INVENTORY_TRANSFERRED",
};

// Sign a raw (positive) quantity gets depending on the movement type.
// ADJUSTMENT keeps the caller's sign (can be ±). Everything else is fixed.
export function signedDelta(
  type: InventoryTransactionType,
  quantity: number
): number {
  switch (type) {
    case "PURCHASE":
    case "RETURN":
    case "TRANSFER_IN":
      return Math.abs(quantity);
    case "USAGE":
    case "WASTE":
    case "TRANSFER_OUT":
      return -Math.abs(quantity);
    case "ADJUSTMENT":
      return quantity; // signed by the user
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
