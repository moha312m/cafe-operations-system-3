// The two acts behind «حفظ في عهدة الفرع», shared by the handover screen's button and the close's
// Done screen (where a manager's own branch-custody close is saved without a second visit).
//
// Both acts are unchanged on the server and stay separate: the signature is the existing per-line
// acknowledgement "signed for without counting" (it keeps the counted quantities, is not an
// independent count, and carries the signing user's name and time), and the conversion is the
// existing `/to-branch-custody` call with its own retry key.
//
// The signing batch is sequential and never trusts a screen's memory: before it starts, after a
// failure, and after a lost response it reloads the authoritative acknowledgements, so a batch that
// half-saved is reported as half-saved and the next run continues from what is left.
import { api } from "@/lib/client";
import { handoverIntents } from "./handover-intent";
import { pendingSignatureLineIds } from "./handover-journey";

type Fresh = { count: { lines: { id: string; disposition: string; inventoryItem: { name: string } }[] } | null; workflow: { acknowledgements: { stockCountLineId: string }[] } };
export type SignResult = { total: number; done: number; failed: { name: string; message: string }[] };
export type ConvertResult =
  | { ok: true; alreadyAccepted: boolean; carried: number }
  | { ok: false; omissionRequired: boolean; message: string };

const ALREADY_SIGNED = /متسجل استلامه قبل كده/;
/** The server's refusal when a required item was not counted and no manager reason came with the conversion. */
const OMISSION_REASON_REQUIRED = /لازم سبب مدير/;

/** The authoritative list of what still needs a signature, read from the server. */
async function freshPending(handoverId: string): Promise<{ ids: string[]; names: Map<string, string> }> {
  const { handover } = await api<{ handover: Fresh }>(`/api/handovers/${handoverId}`);
  const fresh = handover.count?.lines ?? [];
  return { ids: pendingSignatureLineIds(fresh, handover.workflow.acknowledgements), names: new Map(fresh.map((l) => [l.id, l.inventoryItem.name])) };
}

/** Signs what is still unsigned; `failed` is empty only when nothing is left unsigned. */
export async function signPendingLines(handoverId: string, onProgress: (p: SignResult) => void = () => {}): Promise<SignResult> {
  const failed: SignResult["failed"] = [];
  let done = 0, total = 0;
  try {
    // Always start from what the server says is unsigned, not from what a screen last rendered.
    let { ids, names } = await freshPending(handoverId);
    total = ids.length;
    onProgress({ total, done, failed: [] });
    for (const id of ids) {
      const label = names.get(id) ?? "سطر";
      try {
        await api(`/api/handovers/${handoverId}/acknowledge`, { method: "POST", body: { stockCountLineId: id } });
        done++;
      } catch (e) {
        const message = e instanceof Error ? e.message : "تعذّر التوقيع";
        if (ALREADY_SIGNED.test(message)) { done++; }
        else {
          // The answer may have been lost after the server saved it: ask the server before calling it a failure.
          try {
            ({ ids, names } = await freshPending(handoverId));
            if (!ids.includes(id)) done++; else failed.push({ name: label, message });
          } catch { failed.push({ name: label, message: `${message} (تعذّر التأكد من حالة السطر)` }); }
        }
      }
      onProgress({ total, done, failed: [...failed] });
    }
  } catch (e) {
    failed.push({ name: "تحميل الحالة", message: e instanceof Error ? e.message : "تعذّر تحميل حالة التوقيعات" });
  }
  return { total, done, failed };
}

/** Converts to branch custody; the omission reason and note travel as a pair or not at all. */
export async function convertToBranchCustody(handoverId: string, omission?: { reasonCodeId: string; note: string }): Promise<ConvertResult> {
  const authorised = !!omission && omission.reasonCodeId.trim() !== "" && omission.note.trim() !== "";
  const intent = { omissionReasonCodeId: authorised ? omission!.reasonCodeId.trim() : undefined, omissionNote: authorised ? omission!.note.trim() : undefined };
  try {
    const res = await api<{ alreadyAccepted?: boolean; redecidedShiftIds?: string[] }>(`/api/handovers/${handoverId}/to-branch-custody`, {
      method: "POST",
      body: { idempotencyKey: handoverIntents.keyFor(handoverId, "branch", intent), ...intent },
    });
    handoverIntents.done(handoverId, "branch");
    return { ok: true, alreadyAccepted: !!res.alreadyAccepted, carried: res.redecidedShiftIds?.length ?? 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : "تعذّر الحفظ في عهدة الفرع";
    return { ok: false, omissionRequired: OMISSION_REASON_REQUIRED.test(message), message };
  }
}

/** The success wording both screens show. */
export function convertedMessage(res: { alreadyAccepted: boolean; carried: number }): string {
  return res.alreadyAccepted ? "العهدة كانت اتحفظت في عهدة الفرع قبل كده — نفس النتيجة بدون تكرار"
    : res.carried > 0 ? `اتحفظت العهدة في عهدة الفرع — ${res.carried} شيفت مستني انتقل للتحقق من العهدة الافتتاحية` : "اتحفظت العهدة في عهدة الفرع";
}
