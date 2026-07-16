"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

const empty = {
  name: "", slug: "", currency: "EGP", taxRate: "0",
  ownerName: "", ownerEmail: "", ownerPassword: "", mainBranchName: "الفرع الرئيسي",
};

// Onboard a new tenant: creates the cafe, its first owner, and a main
// branch in one call (POST /api/cafes).
export function CreateCafeDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(empty);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function create() {
    setBusy(true);
    try {
      await api("/api/cafes", { method: "POST", body: { ...form, taxRate: Number(form.taxRate) } });
      toast.success("تم إنشاء الكافيه مع حساب المالك والفرع الرئيسي");
      setOpen(false);
      setForm(empty);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل إضافة الكافيه");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>+ كافيه جديد</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>إضافة كافيه جديد</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>اسم الكافيه</Label>
              <Input value={form.name} onChange={set("name")} />
            </div>
            <div className="space-y-2">
              <Label>المعرّف (بالإنجليزي)</Label>
              <Input dir="ltr" placeholder="my-cafe" value={form.slug} onChange={set("slug")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>العملة</Label>
              <Input dir="ltr" value={form.currency} onChange={set("currency")} />
            </div>
            <div className="space-y-2">
              <Label>نسبة الضريبة ٪</Label>
              <Input type="number" min="0" step="0.01" value={form.taxRate} onChange={set("taxRate")} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>اسم الفرع الرئيسي</Label>
            <Input value={form.mainBranchName} onChange={set("mainBranchName")} />
          </div>
          <div className="space-y-2">
            <Label>اسم المالك</Label>
            <Input value={form.ownerName} onChange={set("ownerName")} />
          </div>
          <div className="space-y-2">
            <Label>إيميل المالك</Label>
            <Input type="email" dir="ltr" value={form.ownerEmail} onChange={set("ownerEmail")} />
          </div>
          <div className="space-y-2">
            <Label>باسورد المالك (٨ حروف على الأقل)</Label>
            <Input type="password" dir="ltr" value={form.ownerPassword} onChange={set("ownerPassword")} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={create}
            disabled={busy || !form.name || !form.slug || !form.ownerName || !form.ownerEmail || form.ownerPassword.length < 8}
          >
            {busy ? "جاري الإضافة…" : "إضافة الكافيه"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
