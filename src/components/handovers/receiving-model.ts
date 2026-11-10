// HND-UX-003: a counted quantity is what the receiver accepts, even when it
// differs from what was handed over. `refuse` is the separate, explicit
// refusal and is the only thing that sends a reason.
export type ReceivingDraft = { quantity: string; withoutCount: boolean; reason: string; note: string; refuse?: boolean };
export type ReceivingDecision = { stockCountLineId: string; incomingCountedQuantity: number | null; disputeReasonCodeId?: string; disputeNote?: string; refuse?: true };

// Blank is undecided. Only an explicit checkbox makes a null observation.
export function receivingDecisions(ids: string[], drafts: Record<string, ReceivingDraft>): ReceivingDecision[] | null {
  const result: ReceivingDecision[] = [];
  for (const id of ids) {
    const draft = drafts[id];
    if (!draft) return null;
    const quantity = Number(draft.quantity);
    if (!draft.withoutCount && (draft.quantity.trim() === '' || !Number.isFinite(quantity) || quantity < 0)) return null;
    // A refusal must say why; without a reason it is not a decision yet.
    if (draft.refuse && !draft.reason.trim()) return null;
    result.push({ stockCountLineId: id, incomingCountedQuantity: draft.withoutCount ? null : quantity,
      ...(draft.refuse ? { refuse: true as const, disputeReasonCodeId: draft.reason.trim() } : {}),
      ...(draft.refuse && draft.note.trim() ? { disputeNote: draft.note.trim() } : {}),
    });
  }
  return result;
}

export function receivingRequestKey(countSessionId: string, lines: ReceivingDecision[], previous: { fingerprint: string; key: string } | null, createKey: () => string) {
  const fingerprint = JSON.stringify({ countSessionId, lines });
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: createKey() };
}

export function reviewPriority(line: { disposition: string; varianceQuantity?: string | null }) {
  if (line.disposition === 'PENDING') return 0;
  if (['OUTSIDE_TOLERANCE', 'RECOUNT_REQUIRED', 'RECOUNT_DISPUTED', 'VARIANCE_CONFIRMED'].includes(line.disposition) || (line.varianceQuantity != null && Number(line.varianceQuantity) !== 0)) return 1;
  return 2;
}

export type ReceivingAck = {
  stockCountLineId: string; decision: string;
  incomingCountedQuantity?: string | null; handedOverQuantity?: string | null; varianceQuantity?: string | null;
};

const trimmed = (value: string) => String(Number(value));
/** A signed difference: a real minus sign, an explicit plus, and a plain zero. */
export function signedQuantity(value: string | null | undefined): string {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return n > 0 ? `+${trimmed(value)}` : n < 0 ? `−${trimmed(value).slice(1)}` : "0";
}

/**
 * Two different comparisons live on one line, and they are never mixed:
 *   outgoing  — the outgoing count against the expected stock (`line.varianceQuantity`);
 *   receiving — the receiver's own count against what was handed over (the stored acknowledgement).
 * An acknowledgement with no independent count (null) has no receiving count and no receiving
 * difference; it is not a zero and not a match.
 */
export function receivingRowDisplay(line: { countedQuantity?: string | null; effectiveCountedQuantity?: string | null; varianceQuantity?: string | null }, ack: ReceivingAck | undefined, disclosed: boolean) {
  const activeCount = line.effectiveCountedQuantity ?? line.countedQuantity;
  const outgoingCount = disclosed ? (activeCount != null ? trimmed(activeCount) : "—") : "مخفي";
  const outgoingDifference = disclosed ? signedQuantity(line.varianceQuantity) : "مخفي";
  if (!ack) return { outgoingCount, outgoingDifference, state: "pending" as const, incomingCount: "—", handedOver: "—", receivingDifference: "—" };
  const none = ack.incomingCountedQuantity == null;
  const handedOver = ack.handedOverQuantity != null ? trimmed(ack.handedOverQuantity) : "—";
  const stored = ack.varianceQuantity != null ? ack.varianceQuantity
    : !none && ack.handedOverQuantity != null ? String(Math.round((Number(ack.incomingCountedQuantity) - Number(ack.handedOverQuantity)) * 1000) / 1000) : null;
  return {
    outgoingCount, outgoingDifference,
    state: ack.decision === "DISPUTED" ? ("disputed" as const) : ("accepted" as const),
    incomingCount: none ? "بدون عدّ مستقل" : trimmed(String(ack.incomingCountedQuantity)),
    handedOver,
    receivingDifference: none ? "—" : signedQuantity(stored),
  };
}
