"use client";

// The three manager acts that end a handover without the normal receiver:
//
//   cancel   «إنهاء التسليم لعهدة الفرع»   POST /api/handovers/:id/cancel
//   approve  «اعتماد التسليم كمدير»         POST /api/handovers/:id/approve
//   release  «فك العوائق المعلقة في الفرع»  POST /api/branches/:id/inventory-freeze/release
//
// Each one is an exception recorded in the manager's name, so each one asks
// for a HANDOVER reason code and a written note, and says plainly what it
// will and will not do. The server refuses all three without them, and
// refuses the outgoing custodian on their own handover — the screen hides the
// buttons from that person too, but the server is the rule.

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";

//   repair   «إصلاح عهدة الفرع»            POST /api/branches/:id/custody-repair
//            (a branch no shift can open on, with no handover to act on)

export type ManagerHandoverActionKind = "cancel" | "approve" | "release" | "repair";

/** One key per decision: a repeat after a lost response replays, never repeats. */
function newRequestKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const COPY: Record<ManagerHandoverActionKind, { title: string; explain: string; confirm: string; busy: string }> = {
  cancel: {
    title: "إنهاء التسليم لعهدة الفرع",
    explain: "التسليم هيتقفل من غير جرد مقبول: المخزون يتحوّل لعهدة الفرع كما هو بالدفاتر (غير متحقق منه)، شيفت المُسلّم يتقفل، وأول شيفت يفتح بعد كده لازم يجرد ويتحقق قبل البيع. الجرد اللي اتسجل بيفضل محفوظ للمراجعة ومحدش هيتحاسب على فرق ما اتشافش. الإجراء بيتسجل باسمك وبالسبب ده.",
    confirm: "إنهاء التسليم لعهدة الفرع",
    busy: "جارٍ الإنهاء…",
  },
  approve: {
    title: "اعتماد التسليم كمدير",
    explain: "الاعتماد بيستخدم جرد المُسلّم بعد ما يكون اتأكد: لو التسليم لسه مسودة بيتقدم باسمك، السطور المعدودة بتتوقّع باسمك من غير عدّ جديد، وبعدين: تسليم آخر اليوم بيتحفظ في عهدة الفرع، وتسليم شيفت لشيفت بيتسلم للشيفت المستلم المفتوح باستلام استثنائي. الأصناف المطلوبة اللي ماتعدتش بتتسجل كإعفاء بالسبب ده.",
    confirm: "اعتماد التسليم",
    busy: "جارٍ الاعتماد…",
  },
  release: {
    title: "فك العوائق المعلقة في الفرع",
    explain: "بيفك أي تجميد مخزون متعلق بتسليم خلص فعلاً، وبيُنهي كل تسليم لسه مسودة أو مرجوع لعهدة الفرع بالسبب ده (نفس «إنهاء التسليم لعهدة الفرع» لكل واحد). التسليمات المقدمة اللي مستنية مستلم مابتتلمسش.",
    confirm: "فك العوائق وإنهاء المسودات",
    busy: "جارٍ التنفيذ…",
  },
  repair: {
    title: "إصلاح عهدة الفرع",
    explain: "سجلات العهدة في الفرع ناقصة، فمحدش يقدر يفتح شيفت. الإصلاح بيخلي المخزون في عهدة الفرع كما هو بالدفاتر (من غير جرد ومن غير ما حد يتحاسب عليه)، ولو في شيفت مفتوح على الدرج بيفضل درجه ويستنى الجرد الافتتاحي قبل البيع. درج مالوش شيفت مفتوح بيتقفل بالمبلغ اللي اتعدّ عند قفل آخر شيفت. مفيش حاجة بتتمسح، والإجراء بيتسجل باسمك وبالسبب ده.",
    confirm: "إصلاح عهدة الفرع",
    busy: "جارٍ الإصلاح…",
  },
};

/** Who may see these buttons at all. The server checks again. */
export function useMayEndHandover(outgoingUserId?: string | null) {
  const { user, canKey } = useApp();
  const isOwner = user.role === "CAFE_OWNER" || user.role === "SUPER_ADMIN";
  const manager = isOwner || canKey("handover.exception") || canKey("handover.cancel");
  return manager && (!outgoingUserId || outgoingUserId !== user.id);
}

export function useMayApproveHandover(branchId: string | null | undefined, outgoingUserId?: string | null) {
  const { user, canKey } = useApp();
  const isOwner = user.role === "CAFE_OWNER" || user.role === "SUPER_ADMIN";
  const isBranchManager = user.role === "BRANCH_MANAGER" && !!branchId && user.branchId === branchId;
  return (isOwner || isBranchManager || canKey("handover.exception")) && (!outgoingUserId || outgoingUserId !== user.id);
}

export function ManagerHandoverActionDialog({ kind, open, handoverId, branchId, onClose, onDone }: {
  kind: ManagerHandoverActionKind;
  open: boolean;
  handoverId?: string | null;
  branchId?: string | null;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const copy = COPY[kind];
  const branchLevel = kind === "release" || kind === "repair";
  const ready = reasonCodeId.trim() !== "" && note.trim() !== "" && (branchLevel ? !!branchId : !!handoverId);

  async function run() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const body = kind === "repair"
        ? { reasonCodeId: reasonCodeId.trim(), note: note.trim(), idempotencyKey: requestKey }
        : { reasonCodeId: reasonCodeId.trim(), note: note.trim() };
      const url = kind === "release"
        ? `/api/branches/${encodeURIComponent(branchId!)}/inventory-freeze/release`
        : kind === "repair"
          ? `/api/branches/${encodeURIComponent(branchId!)}/custody-repair`
          : `/api/handovers/${encodeURIComponent(handoverId!)}/${kind}`;
      const res = await api<{ message?: string }>(url, { method: "POST", body });
      const message = res.message || "تم تنفيذ الإجراء";
      toast.success(message);
      setReasonCodeId("");
      setNote("");
      setRequestKey(newRequestKey());
      onClose();
      await onDone(message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تنفيذ الإجراء");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="rounded-lg border bg-muted/30 p-2.5 text-xs leading-relaxed">{copy.explain}</p>
          <ReasonCodeSelect domain="HANDOVER" value={reasonCodeId} onChange={setReasonCodeId} label="السبب" />
          <div className="space-y-1">
            <Label htmlFor={`manager-action-note-${kind}`}>اشرح اللي حصل</Label>
            <Textarea id={`manager-action-note-${kind}`} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="flex flex-wrap gap-2">
          <Button disabled={!ready || busy} onClick={() => void run()} data-testid={`manager-action-confirm-${kind}`}>
            {busy ? copy.busy : copy.confirm}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>رجوع</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
