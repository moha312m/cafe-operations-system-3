"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export type SubCafe = {
  id: string; name: string; planName: string;
  subscriptionStatus: string; subscriptionEndsAt: string | null;
};

// Edit a cafe's subscription (plan, status, end date). Placeholder billing:
// no payment processing, just DB-backed state the owner controls.
export function SubscriptionDialog({
  cafe,
  onOpenChange,
  onDone,
}: {
  cafe: SubCafe | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState("");
  const [statusVal, setStatusVal] = useState("TRIAL");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cafe) {
      setPlan(cafe.planName);
      setStatusVal(cafe.subscriptionStatus);
      setEndsAt(cafe.subscriptionEndsAt ? cafe.subscriptionEndsAt.slice(0, 10) : "");
    }
  }, [cafe]);

  function extend30() {
    const base = endsAt ? new Date(endsAt) : new Date();
    base.setDate(base.getDate() + 30);
    setEndsAt(base.toISOString().slice(0, 10));
    setStatusVal("ACTIVE");
  }

  async function save() {
    if (!cafe) return;
    setBusy(true);
    try {
      await api(`/api/admin/cafes/${cafe.id}`, {
        method: "PATCH",
        body: {
          planName: plan.trim() || "تجريبي",
          subscriptionStatus: statusVal,
          subscriptionEndsAt: endsAt ? new Date(endsAt).toISOString() : null,
        },
      });
      toast.success("تم تحديث الاشتراك");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحديث الاشتراك");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!cafe} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>اشتراك — {cafe?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>الباقة</Label>
            <Input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="تجريبي / أساسي / مميز" />
          </div>
          <div className="space-y-2">
            <Label>حالة الاشتراك</Label>
            <select value={statusVal} onChange={(e) => setStatusVal(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
              {(["TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED"] as const).map((s) => (
                <option key={s} value={s}>{t.admin.subStatus[s]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>تاريخ انتهاء الاشتراك</Label>
            <div className="flex gap-2">
              <Input type="date" dir="ltr" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              <Button type="button" variant="outline" size="sm" onClick={extend30}>+ ٣٠ يوم</Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>{busy ? "جاري الحفظ…" : t.common.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
