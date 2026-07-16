"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// Confirm suspending a cafe. Suspension is reversible and never deletes
// data — it flips isActive off and records an optional reason.
export function SuspendDialog({
  cafe,
  onOpenChange,
  onDone,
}: {
  cafe: { id: string; name: string } | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function suspend() {
    if (!cafe) return;
    setBusy(true);
    try {
      await api(`/api/admin/cafes/${cafe.id}`, {
        method: "PATCH",
        body: { isActive: false, suspendedReason: reason.trim() || null },
      });
      toast.success("تم إيقاف الكافيه");
      setReason("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الإيقاف");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!cafe} onOpenChange={(v) => { if (!v) setReason(""); onOpenChange(v); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>إيقاف الكافيه</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            هيتم إيقاف <span className="font-semibold text-foreground">{cafe?.name}</span> — الموظفين مش هيقدروا
            يسجّلوا دخول ومنيو العميل هيتقفل. البيانات كلها بتفضل محفوظة ويمكن التفعيل تاني في أي وقت.
          </p>
          <div className="space-y-2">
            <Label>سبب الإيقاف (اختياري)</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: عدم سداد الاشتراك" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={suspend} disabled={busy}>
            {busy ? "جاري الإيقاف…" : "تأكيد الإيقاف"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
