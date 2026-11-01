// Prisma's browser Decimal export keeps shared preview helpers browser-safe.
// Monetary decisions remain Decimal; conversion to numbers is presentation.
import { Decimal } from "@prisma/client/runtime/index-browser";
export { Decimal };
export type Numeric = number | string | { toString(): string };
export function decimal(value: Numeric): Decimal {
  const result = new Decimal(value.toString());
  if (!result.isFinite()) throw new RangeError("Invalid monetary value");
  return result;
}
export function money(value: Numeric): Decimal {
  return decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
export function sumMoney(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((sum, value) => sum.plus(decimal(value)), decimal(0));
}
export function moneyMin(...values: Numeric[]): Decimal { return Decimal.min(...values.map(decimal)); }
export function moneyMax(...values: Numeric[]): Decimal { return Decimal.max(...values.map(decimal)); }
export function validCurrencyInput(value: unknown): boolean {
  if (typeof value !== "number" && typeof value !== "string") return false;
  try { const d = decimal(value); return d.decimalPlaces() <= 2 && d.abs().lte("99999999.99"); } catch { return false; }
}
