// Stock handover v2 — the pure comparison (no database, no clock).
// See src/lib/stock-handover-v2.ts for the rules this implements.
import type { InventoryUnit, StockComparisonReliability } from "@prisma/client";
import { ApiError } from "@/lib/api";

// ─────────────────────────── exact arithmetic ───────────────────────────

/** A 3-decimal quantity as integer thousandths. Rejects anything not exactly representable. */
export function toMilli(value: unknown): bigint {
  const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new ApiError(400, "الكمية لازم تكون رقم بحد أقصى ٣ أرقام عشرية");
  const [, sign, whole, frac = ""] = match;
  const milli = BigInt(whole) * BigInt(1000) + BigInt((frac + "000").slice(0, 3));
  return sign === "-" ? -milli : milli;
}

/** Integer thousandths back to a fixed 3-decimal string. */
export function fromMilli(value: bigint): string {
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const text = `${abs / BigInt(1000)}.${String(abs % BigInt(1000)).padStart(3, "0")}`;
  return negative && abs !== BigInt(0) ? `-${text}` : text;
}

// ─────────────────────────── the pure comparison ───────────────────────────

export type CountObservation = {
  quantityMilli: bigint;
  unit: InventoryUnit;
  countedAt: Date;
  /** null for a legacy line written without a cursor. */
  itemVersion: bigint | null;
  counterId: string | null;
};

export type LedgerMovement = { itemVersion: bigint; quantityMilli: bigint; createdAt: Date };

export type ComparisonLabel = "NO_DIFFERENCE" | "EXPLAINED_BY_MOVEMENTS" | "UNEXPLAINED" | "UNAVAILABLE";

export type ItemComparison = {
  reliability: StockComparisonReliability;
  label: ComparisonLabel;
  /** Arabic, for the report: why a figure is provisional or unavailable. */
  note: string | null;
  rawMilli: bigint | null;
  netMilli: bigint | null;
  expectedMilli: bigint | null;
  adjustedMilli: bigint | null;
  movementCount: number;
};

export const MISSING_OUTGOING = "المُسلِّم ماعدّش الصنف ده";
export const MISSING_INCOMING = "المُستلِم ماعدّش الصنف ده";
export const UNIT_MISMATCH = "وحدة العدّ مختلفة بين الجردين — الفرق مش محسوب";
export const NO_CURSOR = "مؤقت: أحد الجردين من غير مؤشر دفتر، فالحركات محسوبة بالوقت";

/**
 * Compare one item. Pure: the same inputs always give the same answer, and a
 * missing count is never treated as zero.
 */
export function compareItem(
  outgoing: CountObservation | null,
  incoming: CountObservation | null,
  movements: LedgerMovement[],
): ItemComparison {
  const unavailable = (note: string): ItemComparison => ({
    reliability: "UNAVAILABLE", label: "UNAVAILABLE", note,
    rawMilli: null, netMilli: null, expectedMilli: null, adjustedMilli: null, movementCount: 0,
  });
  if (!outgoing) return unavailable(MISSING_OUTGOING);
  if (!incoming) return unavailable(MISSING_INCOMING);
  if (outgoing.unit !== incoming.unit) return unavailable(UNIT_MISMATCH);

  let reliability: StockComparisonReliability = "CONFIRMED";
  let note: string | null = null;
  let inWindow: LedgerMovement[];
  let sign: bigint;
  if (outgoing.itemVersion !== null && incoming.itemVersion !== null) {
    const forward = incoming.itemVersion >= outgoing.itemVersion;
    const lo = forward ? outgoing.itemVersion : incoming.itemVersion;
    const hi = forward ? incoming.itemVersion : outgoing.itemVersion;
    inWindow = movements.filter((m) => m.itemVersion > lo && m.itemVersion <= hi);
    sign = forward ? BigInt(1) : -BigInt(1);
  } else {
    // Labelled, never silent: a legacy line has no cursor, so the window falls
    // back to wall-clock time and the result is provisional.
    reliability = "PROVISIONAL";
    note = NO_CURSOR;
    const forward = incoming.countedAt.getTime() >= outgoing.countedAt.getTime();
    const lo = forward ? outgoing.countedAt : incoming.countedAt;
    const hi = forward ? incoming.countedAt : outgoing.countedAt;
    inWindow = movements.filter((m) => m.createdAt.getTime() > lo.getTime() && m.createdAt.getTime() <= hi.getTime());
    sign = forward ? BigInt(1) : -BigInt(1);
  }
  const net = sign * inWindow.reduce((sum, m) => sum + m.quantityMilli, BigInt(0));
  const raw = incoming.quantityMilli - outgoing.quantityMilli;
  const expected = outgoing.quantityMilli + net;
  const adjusted = incoming.quantityMilli - expected;
  const label: ComparisonLabel = adjusted !== BigInt(0) ? "UNEXPLAINED" : raw !== BigInt(0) ? "EXPLAINED_BY_MOVEMENTS" : "NO_DIFFERENCE";
  return { reliability, label, note, rawMilli: raw, netMilli: net, expectedMilli: expected, adjustedMilli: adjusted, movementCount: inWindow.length };
}

/** The labels as the owner reads them. */
export const LABEL_AR: Record<ComparisonLabel, string> = {
  NO_DIFFERENCE: "مطابق",
  EXPLAINED_BY_MOVEMENTS: "فرق مفسَّر بحركات مسجلة",
  UNEXPLAINED: "فرق غير مفسَّر — مطلوب مراجعة",
  UNAVAILABLE: "المقارنة غير متاحة",
};

