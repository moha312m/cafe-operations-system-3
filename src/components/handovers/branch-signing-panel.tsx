"use client";

// «حفظ في عهدة الفرع» — one press that finishes a BRANCH_CUSTODY handover.
//
// Nobody arrives on this path, so a manager with the exception key signs each counted line in the
// branch's name and then converts the handover to branch custody. Both acts are unchanged and stay
// separate on the server: the signature is the existing per-line acknowledgement "signed for without
// counting" (it keeps the counted quantities, is not an independent count, and carries the signing
// user's name and time), and the conversion is the existing `/to-branch-custody` call with its own
// retry key. The screen only runs them one after the other under a single confirmation.
//
// The signing batch is sequential and never trusts this screen's memory: before it starts, after a
// failure, and after a lost response it reloads the authoritative acknowledgements, so a batch that
// half-saved is shown as half-saved, nothing is converted, and the next press continues from what is
// left. When the server asks for a manager's reason for an uncounted required item, the reason
// fields appear and the press is repeated with them.
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";
import { ConfirmHandoverAction } from "./detail-frame";
import { handoverIntents } from "./handover-intent";
import { pendingSignatureLineIds } from "./handover-journey";

type Line = { id: string; disposition: string; inventoryItem: { name: string } };
type Fresh = { count: { lines: Line[] } | null; workflow: { acknowledgements: { stockCountLineId: string }[] } };
type Progress = { phase: "idle" | "running" | "stopped" | "done"; total: number; done: number; failed: { name: string; message: string }[] };

const ALREADY_SIGNED = /متسجل استلامه قبل كده/;
/** The server's refusal when a required item was not counted and no manager reason came with the conversion. */
const OMISSION_REASON_REQUIRED = /لازم سبب مدير/;
const EMPTY: Progress = { phase: "idle", total: 0, done: 0, failed: [] };

export function BranchSigningPanel({ handoverId, lines, acknowledgements, signedAt, actorName, onChanged }: {
  handoverId: string;
  lines: Line[];
  acknowledgements: { stockCountLineId: string }[];
  /** Latest signing time recorded for this round, when any line is already signed. */
  signedAt: string | null;
  actorName: string;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<Progress>(EMPTY);
  const [converting, setConverting] = useState(false);
  const [omissionAsked, setOmissionAsked] = useState(false);
  const [omissionReason, setOmissionReason] = useState("");
  const [omissionNote, setOmissionNote] = useState("");
  const pendingIds = pendingSignatureLineIds(lines, acknowledgements);
  const excluded = lines.filter((l) => l.disposition === "PENDING");
  const nameOf = (id: string) => lines.find((l) => l.id === id)?.inventoryItem.name ?? "سطر";
  const running = progress.phase === "running" || converting;
  // Half an omission authorisation is not a smaller one: both fields, or neither.
  const omissionHalf = (omissionReason.trim() === "") !== (omissionNote.trim() === "");
  const omissionMissing = omissionAsked && (omissionReason.trim() === "" || omissionNote.trim() === "");

  /** The authoritative list of what still needs a signature, read from the server. */
  async function freshPending(): Promise<{ ids: string[]; names: Map<string, string> }> {
    const { handover } = await api<{ handover: Fresh }>(`/api/handovers/${handoverId}`);
    const fresh = handover.count?.lines ?? [];
    return { ids: pendingSignatureLineIds(fresh, handover.workflow.acknowledgements), names: new Map(fresh.map((l) => [l.id, l.inventoryItem.name])) };
  }

  /** Signs what is still unsigned; true only when nothing is left unsigned. */
  async function signAll(): Promise<boolean> {
    setProgress({ phase: "running", total: pendingIds.length, done: 0, failed: [] });
    const failed: Progress["failed"] = [];
    let done = 0, total = pendingIds.length;
    try {
      // Always start from what the server says is unsigned, not from what this screen last rendered.
      let { ids, names } = await freshPending();
      total = ids.length;
      setProgress({ phase: "running", total, done: 0, failed: [] });
      for (const id of ids) {
        const label = names.get(id) ?? nameOf(id);
        try {
          await api(`/api/handovers/${handoverId}/acknowledge`, { method: "POST", body: { stockCountLineId: id } });
          done++;
        } catch (e) {
          const message = e instanceof Error ? e.message : "تعذّر التوقيع";
          if (ALREADY_SIGNED.test(message)) { done++; }
          else {
            // The answer may have been lost after the server saved it: ask the server before calling it a failure.
            try {
              ({ ids, names } = await freshPending());
              if (!ids.includes(id)) done++; else failed.push({ name: label, message });
            } catch { failed.push({ name: label, message: `${message} (تعذّر التأكد من حالة السطر)` }); }
          }
        }
        setProgress({ phase: "running", total, done, failed: [...failed] });
      }
    } catch (e) {
      failed.push({ name: "تحميل الحالة", message: e instanceof Error ? e.message : "تعذّر تحميل حالة التوقيعات" });
    }
    setProgress({ phase: failed.length ? "stopped" : "done", total, done, failed });
    if (failed.length) toast.warning(`اتوقّع ${done} من ${total} سطر. فاضل ${failed.length} محتاج متابعة — اللي اتوقّع محفوظ، والعهدة لسه ما اتحوّلتش.`);
    return failed.length === 0;
  }

  async function convert() {
    const authorised = omissionReason.trim() !== "" && omissionNote.trim() !== "";
    const intent = { omissionReasonCodeId: authorised ? omissionReason.trim() : undefined, omissionNote: authorised ? omissionNote.trim() : undefined };
    setConverting(true);
    try {
      const res = await api<{ alreadyAccepted?: boolean; redecidedShiftIds?: string[] }>(`/api/handovers/${handoverId}/to-branch-custody`, {
        method: "POST",
        body: { idempotencyKey: handoverIntents.keyFor(handoverId, "branch", intent), ...intent },
      });
      handoverIntents.done(handoverId, "branch");
      const carried = res.redecidedShiftIds?.length ?? 0;
      toast.success(res.alreadyAccepted ? "العهدة كانت اتحفظت في عهدة الفرع قبل كده — نفس النتيجة بدون تكرار"
        : carried > 0 ? `اتحفظت العهدة في عهدة الفرع — ${carried} شيفت مستني انتقل للتحقق من العهدة الافتتاحية` : "اتحفظت العهدة في عهدة الفرع");
    } catch (e) {
      const message = e instanceof Error ? e.message : "تعذّر الحفظ في عهدة الفرع";
      if (OMISSION_REASON_REQUIRED.test(message)) {
        setOmissionAsked(true);
        toast.warning("فيه صنف مطلوب ماتعدّش — اكتب سبب المدير والمبرر وبعدين اضغط الحفظ تاني.");
      } else toast.error(message);
    } finally {
      setConverting(false);
    }
  }

  async function run() {
    if (running) return;
    setConfirm(false);
    const signed = pendingIds.length === 0 ? true : await signAll();
    if (signed) await convert();
    await onChanged();
  }

  return (
    <section className="space-y-3 rounded-xl border p-3" data-testid="branch-custody-sign" aria-label="حفظ العهدة في عهدة الفرع">
      <div>
        <p className="font-medium">حفظ العهدة في عهدة الفرع</p>
        <p className="text-xs text-muted-foreground">مفيش موظف مستلم (إغلاق مبيت). زر واحد بيعتمد سطور الجرد المعدودة باسم الفرع باسمك ووقتك، وبعدها بيحوّل العهدة لعهدة الفرع. مابيغيّرش الكميات، ومش عدًّا مستقلًا — جرد الصبح هو اللي بيتحقق منها.</p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">سطور هتتوقّع</dt><dd className="font-semibold tabular-nums" data-testid="branch-sign-eligible">{pendingIds.length}</dd></div>
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">خارج التوقيع (غير معدودة)</dt><dd className="font-semibold tabular-nums">{excluded.length}</dd></div>
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">بتوقّع باسم</dt><dd className="font-semibold">{actorName}</dd></div>
      </dl>
      {pendingIds.length > 0
        ? <ul className="list-disc space-y-0.5 pe-5 text-sm">{pendingIds.map((id) => <li key={id}>{nameOf(id)}</li>)}</ul>
        : <p className="text-sm">كل سطور الجرد المعدودة موقّعة باسم الفرع ✓{signedAt ? <span className="text-xs text-muted-foreground"> · آخر توقيع: {signedAt}</span> : null}</p>}
      {excluded.length > 0 && <p className="text-xs text-muted-foreground">لن تُوقّع: {excluded.map((l) => l.inventoryItem.name).join("، ")} — لم تُعدّ في هذا الجرد.</p>}

      {progress.phase !== "idle" && (
        <div role="status" className="space-y-1 rounded-lg border bg-muted/30 p-2 text-sm" data-testid="branch-sign-progress">
          <p>{progress.phase === "running" ? "جارٍ التوقيع…" : progress.phase === "done" ? "التوقيع تم." : "توقف قبل الانتهاء."} اتوقّع <b className="tabular-nums">{progress.done}</b> من <b className="tabular-nums">{progress.total}</b>{progress.failed.length > 0 && <>، وفاضل <b className="tabular-nums">{progress.failed.length}</b> محتاج متابعة</>}.</p>
          {progress.failed.map((f) => <p key={f.name} className="text-xs text-destructive">{f.name}: {f.message}</p>)}
          {progress.failed.length > 0 && <p className="text-xs text-muted-foreground">اللي اتوقّع محفوظ والعهدة ما اتحوّلتش. اضغط «متابعة الحفظ» وهيكمّل من اللي لسه ما اتوقّعش بعد قراءة الحالة من الخادم.</p>}
        </div>
      )}

      {omissionAsked && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3" data-testid="branch-omission-fields">
          <p className="text-xs font-medium">فيه صنف مطلوب ماتعدّش. الحفظ في عهدة الفرع محتاج سبب مدير ومبرر مكتوب، وبيتسجلوا باسمك.</p>
          <ReasonCodeSelect domain="HANDOVER" value={omissionReason} onChange={setOmissionReason} label="سبب إعفاء صنف من الجرد" />
          <Label htmlFor="branch-omission-note">المبرر</Label>
          <Textarea id="branch-omission-note" rows={2} maxLength={1000} value={omissionNote} onChange={(e) => setOmissionNote(e.target.value)} />
        </div>
      )}

      <Button disabled={running || omissionMissing || omissionHalf} onClick={() => setConfirm(true)} data-testid="branch-custody-sign-all" className="min-h-11 font-medium">
        {running ? "جارٍ الحفظ…" : progress.phase === "stopped" ? "متابعة الحفظ" : "حفظ في عهدة الفرع"}
      </Button>
      <ConfirmHandoverAction title="حفظ في عهدة الفرع" open={confirm} busy={running} onCancel={() => setConfirm(false)} onConfirm={() => void run()}>
        {pendingIds.length > 0 ? `هتوقّع ${pendingIds.length} سطر جرد باسم الفرع كمستخدم «${actorName}»، وبعدها العهدة هتتحوّل لعهدة الفرع. ` : `هتتحوّل العهدة لعهدة الفرع باسمك «${actorName}». `}
        التوقيع بيؤكد إنك راجعت السطور المعدودة بدون عدّ جديد، ومابيغيّرش الكميات. السطور غير المعدودة ({excluded.length}) خارج التوقيع. كل توقيع بيتسجل بوقته واسمك.
      </ConfirmHandoverAction>
    </section>
  );
}
