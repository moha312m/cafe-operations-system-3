"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// Secure password-reset modal for the platform owner. Sends the new
// password to `endpoint` (PATCH). Never displays or echoes existing
// passwords — write-only.
export function PasswordResetDialog({
  open,
  onOpenChange,
  endpoint,
  subjectName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  endpoint: string | null;
  subjectName: string;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const pr = t.admin.passwordReset;

  const error =
    pw.length === 0
      ? pr.required
      : pw.length < 8
        ? pr.tooShort
        : confirm !== pw
          ? pr.mismatch
          : null;

  function reset() {
    setPw("");
    setConfirm("");
  }

  async function submit() {
    if (error || !endpoint) return;
    setBusy(true);
    try {
      await api(endpoint, { method: "PATCH", body: { password: pw } });
      toast.success(pr.success);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تغيير كلمة المرور");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{pr.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{subjectName}</p>
          <div className="space-y-2">
            <Label>{pr.newPassword}</Label>
            <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{pr.confirmPassword}</Label>
            <Input type="password" dir="ltr" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {pw.length > 0 && error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !!error}>
            {busy ? "جاري الحفظ…" : t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
