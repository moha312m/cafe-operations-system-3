import { round3 } from '@/lib/costing';

// Never infer a comparison from a missing quantity, a tolerance verdict, or money.
// The latest physical observation owns both its quantity and its ledger cursor.
export type MatchingLineEvidence = {
  countedQuantity: unknown; expectedQuantity: unknown; itemVersion: bigint | null;
  countedAt: Date | null; counterId: string | null; expectedBasis: string | null;
  disposition: string;
  recounts: { countedQuantity: unknown; expectedQuantity: unknown; varianceQuantity: unknown;
    itemVersion: bigint; countedAt: Date; counterId: string; resolved: boolean }[];
  corrections: { newCountedQuantity: unknown }[];
};
/** Judged dispositions a complete outgoing declaration may carry (HND-UX-004). */
const DECLARABLE = ['WITHIN_TOLERANCE','OUTSIDE_TOLERANCE','RECOUNT_REQUIRED','RESOLVED_WITHIN_TOLERANCE','VARIANCE_CONFIRMED','VARIANCE_RECORDED'];

/**
 * The current physical observation of one line, or null when it is not valid
 * evidence (missing, stale ledger cursor, unresolved recount, malformed).
 * The difference is observed minus expected at three decimals.
 */
export function handoverLineObservation(line: MatchingLineEvidence, currentVersion: bigint): { difference: number } | null {
  if (!DECLARABLE.includes(line.disposition)) return null;
  const recount = line.recounts[0];
  if (recount && !recount.resolved) return null;
  if (!recount && line.countedQuantity == null) return null;
  const quantity = recount ? recount.countedQuantity : line.corrections[0] ? line.corrections[0].newCountedQuantity : line.countedQuantity;
  const expected = recount ? recount.expectedQuantity : line.expectedQuantity;
  const version = recount ? recount.itemVersion : line.itemVersion;
  const countedAt = recount ? recount.countedAt : line.countedAt;
  const counterId = recount ? recount.counterId : line.counterId;
  if (quantity == null || expected == null || !Number.isFinite(Number(quantity)) ||
      !Number.isFinite(Number(expected)) || Number(quantity) < 0 || version === null ||
      version !== currentVersion || !countedAt || !Number.isFinite(countedAt.getTime()) ||
      !counterId || (!recount && line.expectedBasis !== 'LOCKED_ITEM_VERSION')) return null;
  const difference = round3(round3(Number(quantity)) - round3(Number(expected)));
  if (recount && (recount.varianceQuantity == null || !Number.isFinite(Number(recount.varianceQuantity)) ||
      round3(Number(recount.varianceQuantity)) !== difference)) return null;
  return { difference };
}

export function matchingHandoverLine(line: MatchingLineEvidence, currentVersion: bigint): boolean {
  if (!['WITHIN_TOLERANCE','RESOLVED_WITHIN_TOLERANCE','VARIANCE_CONFIRMED'].includes(line.disposition)) return false;
  return handoverLineObservation(line, currentVersion)?.difference === 0;
}
