// Purchase-only arithmetic, shared by the browser preview and API writers.
// 60 significant digits cover the bounded decimal products and sums and keep
// division error far below the smallest possible weighted-average rounding gap.
// Never change the shared Decimal constructor's global precision or rounding.
import { Decimal, type Numeric } from "./money";

const PurchaseDecimal = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_CEIL });
const MAX_MONEY = "9999999999.99"; // Decimal(12,2)
const MAX_QUANTITY = "999999999.999"; // Decimal(12,3)

export class PurchaseArithmeticError extends Error {
  constructor(message: string) { super(message); this.name = "PurchaseArithmeticError"; }
}

function numeric(value: unknown, label: string): Decimal {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PurchaseArithmeticError(label + " يجب أن تكون رقمًا محدودًا");
  }
  return new PurchaseDecimal(value.toString());
}
function bounded(value: Decimal, max: string, label: string): Decimal {
  if (!value.isFinite() || value.abs().gt(max)) {
    throw new PurchaseArithmeticError(label + " خارج النطاق المسموح");
  }
  return value;
}
const asNumber = (value: Decimal) => value.isZero() ? 0 : value.toNumber();

export function purchaseQuantity(value: unknown): number {
  const quantity = numeric(value, "الكمية");
  if (quantity.lte(0)) throw new PurchaseArithmeticError("الكمية يجب أن تكون أكبر من صفر");
  const stored = quantity.toDecimalPlaces(3);
  if (stored.isZero()) throw new PurchaseArithmeticError("الكمية أصغر من دقة التخزين (0.001)");
  return asNumber(bounded(stored, MAX_QUANTITY, "الكمية"));
}

export function purchaseUnitCost(value: unknown): number {
  const cost = numeric(value, "تكلفة الوحدة");
  if (cost.lt(0)) throw new PurchaseArithmeticError("تكلفة الوحدة لا يمكن أن تكون سالبة");
  if (cost.decimalPlaces() > 2) throw new PurchaseArithmeticError("تكلفة الوحدة يجب ألا تتجاوز منزلتين عشريتين");
  return asNumber(bounded(cost, MAX_MONEY, "تكلفة الوحدة"));
}

export function purchaseAmount(value: unknown): number {
  const amount = numeric(value, "القيمة المالية");
  if (amount.lt(0)) throw new PurchaseArithmeticError("القيمة المالية لا يمكن أن تكون سالبة");
  return asNumber(bounded(amount.toDecimalPlaces(2), MAX_MONEY, "القيمة المالية"));
}

export function purchaseLine(quantity: unknown, unitCost: unknown) {
  const storedQuantity = purchaseQuantity(quantity);
  const storedCost = purchaseUnitCost(unitCost);
  const total = new PurchaseDecimal(storedQuantity).times(storedCost).toDecimalPlaces(2);
  return { quantity: storedQuantity, unitCost: storedCost, totalCost: asNumber(bounded(total, MAX_MONEY, "إجمالي الصنف")) };
}

export function purchaseSubtotal(lines: readonly { totalCost: number }[]): number {
  const sum = lines.reduce<Decimal>((total, line) => total.plus(line.totalCost), new PurchaseDecimal(0));
  return asNumber(bounded(sum, MAX_MONEY, "مجموع الأصناف"));
}

// Creation clamps the normalized initial payment to the invoice total.
// Editing preserves already recorded payments, even if the new total is lower.
export function purchaseTotals(subtotal: number, discount: number, tax: number, paid = 0, clampPaid = false) {
  const storedSubtotal = purchaseAmount(subtotal);
  const storedDiscount = purchaseAmount(discount);
  const storedTax = purchaseAmount(tax);
  const total = new PurchaseDecimal(storedSubtotal).minus(storedDiscount).plus(storedTax);
  if (total.lt(0)) throw new PurchaseArithmeticError("الخصم أكبر من قيمة الفاتورة");
  bounded(total, MAX_MONEY, "إجمالي الفاتورة");
  let payment = new PurchaseDecimal(purchaseAmount(paid));
  if (clampPaid && payment.gt(total)) payment = total;
  const remaining = total.minus(payment);
  return {
    subtotal: storedSubtotal, discount: storedDiscount, tax: storedTax,
    total: asNumber(total), paid: asNumber(payment), remaining: remaining.lt(0) ? 0 : asNumber(remaining),
  };
}

export function purchaseWeightedAverage(oldStock: Numeric, oldCost: Numeric, newQty: Numeric, newCost: Numeric): number {
  const stock = new PurchaseDecimal(oldStock.toString());
  const quantity = new PurchaseDecimal(newQty.toString());
  const cost = new PurchaseDecimal(newCost.toString());
  const combined = stock.plus(quantity);
  // Retain the combined-quantity fallback and signed negative-stock formula.
  const average = combined.lte(0) ? cost : stock.times(oldCost.toString()).plus(quantity.times(cost)).dividedBy(combined);
  return asNumber(bounded(average.toDecimalPlaces(2), MAX_MONEY, "متوسط تكلفة الوحدة"));
}

export function purchaseStockAfter(stock: number, quantity: number): number {
  return asNumber(bounded(new PurchaseDecimal(stock).plus(quantity).toDecimalPlaces(3), MAX_QUANTITY, "رصيد المخزون"));
}

function requiredFormNumber(text: string, label: string, zeroAllowed = true): number {
  if (text.trim() === "") {
    throw new PurchaseArithmeticError("أدخل " + label + (zeroAllowed ? " صراحةً؛ الصفر قيمة مسموحة للتكلفة" : ""));
  }
  return Number(text);
}
export const purchaseQuantityFromForm = (text: string) => purchaseQuantity(requiredFormNumber(text, "الكمية", false));
export const purchaseUnitCostFromForm = (text: string) => purchaseUnitCost(requiredFormNumber(text, "تكلفة الوحدة"));
export function purchaseLineFromForm(quantity: string, unitCost: string) {
  return purchaseLine(requiredFormNumber(quantity, "الكمية"), requiredFormNumber(unitCost, "تكلفة الوحدة"));
}
export function purchaseAmountFromForm(text: string): number {
  return purchaseAmount(text.trim() === "" ? 0 : Number(text));
}

export type PurchaseFormLine = { inventoryItemId: string; quantity: string; unitCost: string };
export type PurchaseFormPayment =
  | { mode: "UNPAID" | "PAID" | "PARTIAL"; amount: string } // creating: the initial payment
  | { recorded: number }; // editing: payments already recorded stay as they are
export type PurchaseFormSummary = { subtotal: number; discount: number; tax: number; total: number; paid: number; remaining: number };

const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

// The one function the purchase form previews with. It reuses the writers'
// own parsers and totals, so a preview error or figure is the stored one.
// Each message is attributed to the field it belongs to, for inline display.
export function purchaseFormPreview(input: { lines: readonly PurchaseFormLine[]; discount: string; tax: string; payment: PurchaseFormPayment }) {
  const lines = input.lines.map((line) => {
    const errors: { item?: string; quantity?: string; unitCost?: string; line?: string } = {};
    if (!line.inventoryItemId) errors.item = "اختار الخامة لكل صنف أو احذف السطر الفارغ";
    let quantity: number | null = null;
    let unitCost: number | null = null;
    try { quantity = purchaseQuantityFromForm(line.quantity); } catch (error) { errors.quantity = messageOf(error, "الكمية غير صحيحة"); }
    try { unitCost = purchaseUnitCostFromForm(line.unitCost); } catch (error) { errors.unitCost = messageOf(error, "تكلفة الوحدة غير صحيحة"); }
    let totalCost: number | null = null;
    if (quantity !== null && unitCost !== null) {
      try { totalCost = purchaseLine(quantity, unitCost).totalCost; } catch (error) { errors.line = messageOf(error, "إجمالي الصنف غير صحيح"); }
    }
    return { totalCost: errors.item || errors.line ? null : totalCost, errors };
  });

  const errors: { discount?: string; tax?: string; payment?: string; summary?: string } = {};
  let discount = 0;
  let tax = 0;
  try { discount = purchaseAmountFromForm(input.discount); } catch (error) { errors.discount = messageOf(error, "الخصم غير صحيح"); }
  try { tax = purchaseAmountFromForm(input.tax); } catch (error) { errors.tax = messageOf(error, "الضريبة غير صحيحة"); }

  let summary: PurchaseFormSummary | null = null;
  let paymentAmount = 0; // what a create request sends as the initial payment
  let clamped = false;
  const linesValid = lines.length > 0 && lines.every((line) => line.totalCost !== null && Object.keys(line.errors).length === 0);
  if (lines.length === 0) errors.summary = "أضف صنف واحد على الأقل";
  if (linesValid && !errors.discount && !errors.tax) {
    try {
      const subtotal = purchaseSubtotal(lines.map((line) => ({ totalCost: line.totalCost as number })));
      if ("recorded" in input.payment) {
        summary = purchaseTotals(subtotal, discount, tax, input.payment.recorded);
      } else {
        const base = purchaseTotals(subtotal, discount, tax);
        let wanted = 0;
        if (input.payment.mode === "PAID") wanted = base.total;
        else if (input.payment.mode === "PARTIAL") {
          try { wanted = purchaseAmountFromForm(input.payment.amount); } catch (error) { errors.payment = messageOf(error, "مبلغ الدفعة غير صحيح"); }
        }
        if (input.payment.mode !== "UNPAID" && !errors.payment && wanted <= 0) errors.payment = "مبلغ الدفعة غير صحيح";
        summary = purchaseTotals(subtotal, discount, tax, errors.payment ? 0 : wanted, true);
        paymentAmount = summary.paid;
        clamped = !errors.payment && input.payment.mode === "PARTIAL" && wanted > base.total;
      }
    } catch (error) {
      const message = messageOf(error, "قيم الفاتورة غير صحيحة");
      if (message.includes("الخصم")) errors.discount = message; else errors.summary = message;
    }
  }
  const valid = summary !== null && !errors.discount && !errors.tax && !errors.payment && !errors.summary && linesValid;
  return { lines, errors, summary, paymentAmount, clamped, valid };
}
