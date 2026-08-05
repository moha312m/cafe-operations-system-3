"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { APPROVAL_MODE_LABEL } from "@/lib/qr-approval";
import { ROLE_LABELS } from "@/lib/permissions";
import type { QrApprovalMode, Role } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type Branch = { id: string; name: string };
type UserOpt = { id: string; name: string; role: Role };
type Settings = {
  enabled: boolean;
  approvalMode: QrApprovalMode;
  targetRole: Role | null;
  targetUserId: string | null;
  allowApproverToEditOrder: boolean;
  allowApproverToRejectOrder: boolean;
  sendToKitchenAfterApproval: boolean;
};

const MODES: QrApprovalMode[] = [
  "AUTO_CONFIRM", "ANY_AUTHORIZED_USER", "WAITER_APPROVAL", "CASHIER_DIRECT",
  "MANAGER_APPROVAL", "KITCHEN_DIRECT", "ROLE_BASED", "SPECIFIC_USER",
];
const ROLE_OPTS: Role[] = ["BRANCH_MANAGER", "WAITER", "CASHIER", "BARISTA", "INVENTORY_MANAGER"];

const DEFAULTS: Settings = {
  enabled: true, approvalMode: "ANY_AUTHORIZED_USER", targetRole: null, targetUserId: null,
  allowApproverToEditOrder: true, allowApproverToRejectOrder: true, sendToKitchenAfterApproval: true,
};

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-muted-foreground/30"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-0.5" : "start-[22px]"}`} />
      </button>
    </label>
  );
}

// إعدادات تأكيد طلبات المنيو — branch-level QR approval routing editor.
export function QrApprovalSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useApp();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [s, setS] = useState<Settings | null>(null);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [locks, setLocks] = useState({ waiterApprovalEnabled: true, kitchenScreenEnabled: true });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches")
        .then((r) => { setBranches(r.branches); if (!branchId && r.branches[0]) setBranchId(r.branches[0].id); })
        .catch(() => {});
    }
  }, [user.branchId, branchId]);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await api<{ settings: Settings; users: UserOpt[]; locks: typeof locks }>(
        `/api/qr-approval-settings?branchId=${branchId}`
      );
      setS(data.settings); setUsers(data.users); setLocks(data.locks);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const modeLocked = (m: QrApprovalMode) =>
    (m === "WAITER_APPROVAL" && !locks.waiterApprovalEnabled) ||
    (m === "KITCHEN_DIRECT" && !locks.kitchenScreenEnabled);

  async function save() {
    if (!s) return;
    if (s.approvalMode === "ROLE_BASED" && !s.targetRole) return toast.error("اختار الدور المسؤول");
    if (s.approvalMode === "SPECIFIC_USER" && !s.targetUserId) return toast.error("اختار الموظف المسؤول");
    setBusy(true);
    try {
      await api("/api/qr-approval-settings", {
        method: "PUT",
        body: {
          branchId,
          enabled: s.enabled,
          approvalMode: s.approvalMode,
          targetRole: s.targetRole,
          targetUserId: s.targetUserId,
          allowApproverToEditOrder: s.allowApproverToEditOrder,
          allowApproverToRejectOrder: s.allowApproverToRejectOrder,
          sendToKitchenAfterApproval: s.sendToKitchenAfterApproval,
        },
      });
      toast.success("تم حفظ الإعدادات");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => (p ? { ...p, [k]: v } : p));

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-md overflow-y-auto">
        <DialogHeader><DialogTitle>إعدادات تأكيد طلبات المنيو</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          حدد مين يستقبل طلبات العملاء القادمة من منيو QR قبل دخولها مرحلة التحضير.
        </p>

        {!user.branchId && branches.length > 0 && (
          <div className="space-y-1.5">
            <Label>الفرع</Label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}

        {!s ? (
          <p className="text-sm text-muted-foreground">جاري التحميل…</p>
        ) : (
          <div className="space-y-4">
            <Toggle label="تفعيل تأكيد طلبات QR" checked={s.enabled} onChange={(v) => set("enabled", v)} />

            <div className="space-y-1.5">
              <Label>مين يأكد طلبات المنيو؟</Label>
              <select value={s.approvalMode} onChange={(e) => set("approvalMode", e.target.value as QrApprovalMode)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                {MODES.map((m) => (
                  <option key={m} value={m} disabled={modeLocked(m)}>
                    {APPROVAL_MODE_LABEL[m]}{modeLocked(m) ? " (غير مفعلة)" : ""}
                  </option>
                ))}
              </select>
            </div>

            {s.approvalMode === "ROLE_BASED" && (
              <div className="space-y-1.5">
                <Label>الدور المسؤول</Label>
                <select value={s.targetRole ?? ""} onChange={(e) => set("targetRole", (e.target.value || null) as Role | null)}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">اختار الدور</option>
                  {ROLE_OPTS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
            )}

            {s.approvalMode === "SPECIFIC_USER" && (
              <div className="space-y-1.5">
                <Label>الموظف المسؤول</Label>
                <select value={s.targetUserId ?? ""} onChange={(e) => set("targetUserId", e.target.value || null)}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">اختار الموظف</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name} · {ROLE_LABELS[u.role]}</option>)}
                </select>
              </div>
            )}

            <div className="space-y-2.5 border-t pt-3">
              <Toggle label="السماح بتعديل الطلب قبل التأكيد" checked={s.allowApproverToEditOrder} onChange={(v) => set("allowApproverToEditOrder", v)} />
              <Toggle label="السماح برفض الطلب" checked={s.allowApproverToRejectOrder} onChange={(v) => set("allowApproverToRejectOrder", v)} />
              <Toggle label="إرسال الطلب للبار بعد التأكيد" checked={s.sendToKitchenAfterApproval} onChange={(v) => set("sendToKitchenAfterApproval", v)} />
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setS({ ...DEFAULTS })} disabled={busy || !s}>استرجاع الافتراضي</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button onClick={save} disabled={busy || !s}>حفظ الإعدادات</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
