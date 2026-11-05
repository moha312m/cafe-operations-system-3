"use client";

// Signing a BRANCH_CUSTODY handover's counted lines in the branch's name.
//
// Nobody arrives on this path, so a manager with the exception key signs each counted line before
// «تحويل لعهدة الفرع» can complete. The signature is the existing per-line acknowledgement "signed for
// without counting": it keeps the counted quantities, is not an independent count, and carries the
// signing user's name and time. The batch is sequential, and the panel never trusts its own memory:
// before it starts, after a failure, and after a lost response it reloads the authoritative
// acknowledgements, so a batch that half-saved is shown as half-saved and continues from what is left.
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { ConfirmHandoverAction } from "./detail-frame";
import { pendingSignatureLineIds } from "./handover-journey";

type Line = { id: string; disposition: string; inventoryItem: { name: string } };
type Fresh = { count: { lines: Line[] } | null; workflow: { acknowledgements: { stockCountLineId: string }[] } };
type Progress = { phase: "idle" | "running" | "stopped" | "done"; total: number; done: number; failed: { name: string; message: string }[] };

const ALREADY_SIGNED = /متسجل استلامه قبل كده/;
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
  const pendingIds = pendingSignatureLineIds(lines, acknowledgements);
  const excluded = lines.filter((l) => l.disposition === "PENDING");
  const nameOf = (id: string) => lines.find((l) => l.id === id)?.inventoryItem.name ?? "سطر";
  const running = progress.phase === "running";

  /** The authoritative list of what still needs a signature, read from the server. */
  async function freshPending(): Promise<{ ids: string[]; names: Map<string, string> }> {
    const { handover } = await api<{ handover: Fresh }>(`/api/handovers/${handoverId}`);
    const fresh = handover.count?.lines ?? [];
    return { ids: pendingSignatureLineIds(fresh, handover.workflow.acknowledgements), names: new Map(fresh.map((l) => [l.id, l.inventoryItem.name])) };
  }

  async function run() {
    if (running) return;
    setConfirm(false);
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
    if (failed.length) toast.warning(`اتوقّع ${done} من ${total} سطر. فاضل ${failed.length} محتاج متابعة — اللي اتوقّع محفوظ.`);
    else toast.success(`اتوقّع ${done} سطر باسم الفرع`);
    await onChanged();
  }

  if (pendingIds.length === 0 && progress.phase !== "done" && progress.phase !== "stopped") {
    return (
      <section className="space-y-1 rounded-xl border p-3" data-testid="branch-custody-sign" aria-label="توقيع سطور الجرد لعهدة الفرع">
        <p className="font-medium">كل سطور الجرد المعدودة موقّعة باسم الفرع ✓</p>
        {signedAt && <p className="text-xs text-muted-foreground">آخر توقيع: {signedAt}</p>}
        {excluded.length > 0 && <p className="text-xs text-muted-foreground">{excluded.length} صنف غير معدود خارج التوقيع.</p>}
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border p-3" data-testid="branch-custody-sign" aria-label="توقيع سطور الجرد لعهدة الفرع">
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-100">
        <p className="font-semibold flex items-center gap-1.5 mb-1 text-blue-900 dark:text-blue-200">
          <span>💡</span>
          <span>كيف يتم توقيع السطور؟ (لا توجد خانة لكتابة توقيع أو نص)</span>
        </p>
        <p className="text-xs leading-relaxed text-blue-800 dark:text-blue-300">
          المقصود بـ «التوقيع» هنا ليس كتابة اسمك أو توقيع يدوي بالقلم، بل <strong>مجرد الضغط على الزر بالأسفل</strong> («اضغط هنا: تأكيد واعتماد السطور باسم الفرع»). عند الضغط عليه، يقوم النظام بتسجيل اعتماد السطور المعدودة إلكترونياً باسمك فوراً.
        </p>
      </div>
      <div>
        <p className="font-medium">تأكيد واعتماد سطور الجرد باسم الفرع</p>
        <p className="text-xs text-muted-foreground">مفيش موظف مستلم في عهدة الفرع (إغلاق مبيت)، فمسؤول بصلاحية الاستثناء بيعتمد السطور بالزر باسم الفرع. الإجراء مابيغيّرش الكميات المعدودة، ومش عدًّا مستقلًا.</p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">سطور هتتوقّع</dt><dd className="font-semibold tabular-nums" data-testid="branch-sign-eligible">{pendingIds.length}</dd></div>
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">خارج التوقيع (غير معدودة)</dt><dd className="font-semibold tabular-nums">{excluded.length}</dd></div>
        <div className="rounded-lg border bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">بتوقّع باسم</dt><dd className="font-semibold">{actorName}</dd></div>
      </dl>
      <ul className="list-disc space-y-0.5 pe-5 text-sm">{pendingIds.map((id) => <li key={id}>{nameOf(id)}</li>)}</ul>
      {excluded.length > 0 && <p className="text-xs text-muted-foreground">لن تُوقّع: {excluded.map((l) => l.inventoryItem.name).join("، ")} — لم تُعدّ في هذا الجرد.</p>}

      {progress.phase !== "idle" && (
        <div role="status" className="space-y-1 rounded-lg border bg-muted/30 p-2 text-sm" data-testid="branch-sign-progress">
          <p>{running ? "جارٍ التوقيع…" : progress.phase === "done" ? "تم." : "توقف قبل الانتهاء."} اتوقّع <b className="tabular-nums">{progress.done}</b> من <b className="tabular-nums">{progress.total}</b>{progress.failed.length > 0 && <>، وفاضل <b className="tabular-nums">{progress.failed.length}</b> محتاج متابعة</>}.</p>
          {progress.failed.map((f) => <p key={f.name} className="text-xs text-destructive">{f.name}: {f.message}</p>)}
          {progress.failed.length > 0 && <p className="text-xs text-muted-foreground">اللي اتوقّع محفوظ. اضغط «متابعة التوقيع» وهيبدأ من اللي لسه ما اتوقّعش بعد قراءة الحالة من الخادم.</p>}
        </div>
      )}

      <Button size="sm" disabled={running} onClick={() => setConfirm(true)} data-testid="branch-custody-sign-all" className="font-medium">
        {running ? "جارٍ الاعتماد والتوقيع…" : progress.phase === "stopped" ? "متابعة التوقيع" : "اضغط هنا: تأكيد واعتماد السطور باسم الفرع (زر إلكتروني)"}
      </Button>
      <ConfirmHandoverAction title="توقيع باسم الفرع" open={confirm} busy={running} onCancel={() => setConfirm(false)} onConfirm={() => void run()}>
        هتوقّع {pendingIds.length} سطر جرد باسم الفرع كمستخدم «{actorName}». التوقيع بيؤكد إنك راجعت السطور المعدودة بدون عدّ جديد، ومابيغيّرش الكميات. السطور غير المعدودة ({excluded.length}) خارج التوقيع. التوقيع بيتسجل بوقته واسمك.
      </ConfirmHandoverAction>
    </section>
  );
}
