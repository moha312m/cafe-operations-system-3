"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { newIdempotencyKey } from "./handover-labels";

type Action = "recount" | "override" | "branch";

/**
 * The decisions a handover under review can end with.
 *
 * Four acts, four different powers, and they are deliberately not one
 * button with a dropdown: accepting custody, sending the count back,
 * waving it through as a manager, and parking it on the branch are answers
 * to different questions, and each is drawn only for the key it costs.
 *
 * Since SH-23 asking for a recount costs `handover.request_recount` rather
 * than borrowing `handover.accept` — so an account may hold the power to
 * sign for stock without holding the power to reject the count, and this
 * bar shows exactly that.
 */
export function HandoverActionBar({
  handoverId,
  onDone,
}: {
  handoverId: string;
  onDone: () => void;
}) {
  const { canKey } = useApp();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Action | null>(null);
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"MANAGER_ADJUSTMENT" | "NO_INCOMING">(
    "MANAGER_ADJUSTMENT"
  );

  function start(action: Action) {
    setReasonCodeId("");
    setNote("");
    setOpen(action);
  }

  async function accept() {
    setBusy(true);
    try {
      const res = await api<{ alreadyAccepted: boolean }>(
        `/api/handovers/${handoverId}/accept`,
        // The retry key is what makes a repeated press safe: the same key on
        // an already-completed handover answers 200, a different one is
        // refused as a second acceptance.
        { method: "POST", body: { idempotencyKey: newIdempotencyKey() } }
      );
      toast.success(res.alreadyAccepted ? "التسليم كان مستلم قبل كده" : "تم استلام العهدة");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر الاستلام");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!open) return;
    setBusy(true);
    try {
      if (open === "recount") {
        const res = await api<{ disputedLineIds: string[] }>(
          `/api/handovers/${handoverId}/request-recount`,
          {
            method: "POST",
            body: { reasonCodeId: reasonCodeId.trim(), note: note.trim() || undefined },
          }
        );
        toast.success(`اترفض الجرد — سطور معترض عليها: ${res.disputedLineIds.length}`);
      } else if (open === "override") {
        await api(`/api/handovers/${handoverId}/override-accept`, {
          method: "POST",
          body: {
            idempotencyKey: newIdempotencyKey(),
            reasonCodeId: reasonCodeId.trim(),
            // Required by the service, and refused when blank after trimming.
            note: note.trim(),
            kind,
          },
        });
        toast.success("اتعمل استلام استثنائي");
      } else {
        // The two omission fields authorise leaving a required item
        // uncounted, and they are only valid TOGETHER: a reason without its
        // note is refused by name. So they travel as a pair or not at all —
        // sending half of one would turn a typo into a refusal the person
        // would have to decode.
        const omissionReason = reasonCodeId.trim();
        const omissionNote = note.trim();
        const authorised = omissionReason !== "" && omissionNote !== "";
        await api(`/api/handovers/${handoverId}/to-branch-custody`, {
          method: "POST",
          body: {
            idempotencyKey: newIdempotencyKey(),
            omissionReasonCodeId: authorised ? omissionReason : undefined,
            omissionNote: authorised ? omissionNote : undefined,
          },
        });
        toast.success("اتحولت العهدة للفرع");
      }
      setOpen(null);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تنفيذ الإجراء");
    } finally {
      setBusy(false);
    }
  }

  const needsReason = open === "recount" || open === "override";

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canKey("handover.accept") && (
          <Button size="sm" disabled={busy} onClick={accept} data-testid="handover-accept">
            استلام العهدة
          </Button>
        )}
        {canKey("handover.request_recount") && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => start("recount")}
            data-testid="handover-request-recount"
          >
            طلب إعادة الجرد
          </Button>
        )}
        {canKey("handover.exception") && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => start("override")}
              data-testid="handover-override-accept"
            >
              استلام استثنائي
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => start("branch")}
              data-testid="handover-to-branch-custody"
            >
              تحويل لعهدة الفرع
            </Button>
          </>
        )}
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => !o && !busy && setOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {open === "recount"
                ? "طلب إعادة الجرد"
                : open === "override"
                  ? "استلام استثنائي"
                  : "تحويل لعهدة الفرع"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {open === "override" && (
              <div className="space-y-2">
                <Label>نوع الاستثناء</Label>
                <div className="flex gap-2">
                  {(["MANAGER_ADJUSTMENT", "NO_INCOMING"] as const).map((k) => (
                    <Button
                      key={k}
                      type="button"
                      size="sm"
                      variant={kind === k ? "default" : "outline"}
                      onClick={() => setKind(k)}
                    >
                      {k === "MANAGER_ADJUSTMENT" ? "تسوية مدير" : "مفيش مستلم"}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label>
                {open === "branch"
                  ? "معرّف سبب الإعفاء (اختياري)"
                  : "معرّف السبب (reasonCodeId)"}
              </Label>
              <Input
                value={reasonCodeId}
                onChange={(e) => setReasonCodeId(e.target.value)}
                placeholder="reasonCodeId"
              />
            </div>
            <div className="space-y-2">
              <Label>ملاحظة{open === "override" ? "" : " (اختياري)"}</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button
              className="w-full"
              disabled={
                busy ||
                (needsReason && reasonCodeId.trim() === "") ||
                (open === "override" && note.trim() === "") ||
                // Half an omission authorisation is not a smaller
                // authorisation. Rather than quietly dropping whichever
                // field was filled in, the pair has to be completed or
                // cleared before this will send anything.
                (open === "branch" &&
                  (reasonCodeId.trim() === "") !== (note.trim() === ""))
              }
              onClick={run}
              data-testid="handover-action-confirm"
            >
              تنفيذ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
