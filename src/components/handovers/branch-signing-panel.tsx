"use client";

// «حفظ في عهدة الفرع» — one press that finishes a BRANCH_CUSTODY handover.
//
// Nobody arrives on this path, so a manager with the exception key signs each counted line in the
// branch's name and then converts the handover to branch custody, both through `branch-custody-save`
// (the same acts the close's Done screen runs for a manager's own close). When the server asks for a
// manager's reason for an uncounted required item, the reason fields appear and the press is repeated
// with them.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";
import { ConfirmHandoverAction } from "./detail-frame";
import { pendingSignatureLineIds } from "./handover-journey";
import { convertedMessage, convertToBranchCustody, signPendingLines } from "./branch-custody-save";

type Line = { id: string; disposition: string; inventoryItem: { name: string } };
type Progress = { phase: "idle" | "running" | "stopped" | "done"; total: number; done: number; failed: { name: string; message: string }[] };

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

  /** Signs what is still unsigned; true only when nothing is left unsigned. */
  async function signAll(): Promise<boolean> {
    setProgress({ phase: "running", total: pendingIds.length, done: 0, failed: [] });
    const { total, done, failed } = await signPendingLines(handoverId, (p) => setProgress({ phase: "running", ...p }));
    setProgress({ phase: failed.length ? "stopped" : "done", total, done, failed });
    if (failed.length) toast.warning(`اتوقّع ${done} من ${total} سطر. فاضل ${failed.length} محتاج متابعة — اللي اتوقّع محفوظ، والعهدة لسه ما اتحوّلتش.`);
    return failed.length === 0;
  }

  async function convert() {
    setConverting(true);
    const res = await convertToBranchCustody(handoverId, { reasonCodeId: omissionReason, note: omissionNote });
    setConverting(false);
    if (res.ok) toast.success(convertedMessage(res));
    else if (res.omissionRequired) {
      setOmissionAsked(true);
      toast.warning("فيه صنف مطلوب ماتعدّش — اكتب سبب المدير والمبرر وبعدين اضغط الحفظ تاني.");
    } else toast.error(res.message);
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
