"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { MODULES, keysForModule } from "@/lib/perms/catalog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type RoleOption = { id: string; name: string; isSystemDefault: boolean };
type OverrideState = "role" | "allow" | "deny";

// Per-user permission editor: assign a role and add explicit allow/deny
// overrides that win over the role. Overrides default to "من الدور".
export function PermissionEditor({
  userId,
  userName,
  roleOptions,
  onClose,
  onSaved,
}: {
  userId: string;
  userName: string;
  roleOptions: RoleOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cafeRoleId, setCafeRoleId] = useState<string | null>(null);
  const [roleKeys, setRoleKeys] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{
        user: { cafeRoleId: string | null };
        roleKeys: string[];
        overrides: { permissionKey: string; allowed: boolean }[];
      }>(`/api/users/${userId}/permissions`);
      setCafeRoleId(data.user.cafeRoleId);
      setRoleKeys(new Set(data.roleKeys));
      setOverrides(Object.fromEntries(data.overrides.map((o) => [o.permissionKey, o.allowed])));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const stateOf = (key: string): OverrideState =>
    key in overrides ? (overrides[key] ? "allow" : "deny") : "role";

  const cycle = (key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      const s = key in prev ? (prev[key] ? "allow" : "deny") : "role";
      if (s === "role") next[key] = true; // → allow
      else if (s === "allow") next[key] = false; // → deny
      else delete next[key]; // deny → back to role default
      return next;
    });
  };

  async function save() {
    setBusy(true);
    try {
      await api(`/api/users/${userId}/permissions`, {
        method: "PUT",
        body: {
          cafeRoleId,
          overrides: Object.entries(overrides).map(([key, allowed]) => ({ key, allowed })),
        },
      });
      toast.success("تم حفظ الصلاحيات");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  const badge = (key: string) => {
    const s = stateOf(key);
    const effective = s === "allow" ? true : s === "deny" ? false : roleKeys.has(key);
    if (s === "allow") return { label: "مسموح مخصص", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
    if (s === "deny") return { label: "ممنوع مخصص", cls: "bg-red-500/12 text-red-700 dark:text-red-400" };
    return {
      label: effective ? "من الدور" : "غير مسموح",
      cls: effective ? "bg-blue-500/12 text-blue-700 dark:text-blue-400" : "bg-foreground/8 text-muted-foreground",
    };
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>صلاحيات مخصصة — {userName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">جاري التحميل…</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">الدور / مجموعة الصلاحيات</label>
              <select
                value={cafeRoleId ?? ""}
                onChange={(e) => setCafeRoleId(e.target.value || null)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">— بدون دور (الافتراضي) —</option>
                {roleOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                اضغط على أي صلاحية للتبديل: من الدور ← مسموح مخصص ← ممنوع مخصص.
              </p>
            </div>

            <div className="space-y-2">
              {MODULES.map((mod) => {
                const keys = keysForModule(mod.code).filter((k) => k.key !== "platform.manage");
                if (keys.length === 0) return null;
                return (
                  <div key={mod.code} className="rounded-xl border border-border p-3">
                    <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <span>{mod.icon}</span>{mod.label}
                    </p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {keys.map((k) => {
                        const b = badge(k.key);
                        return (
                          <button key={k.key} onClick={() => cycle(k.key)}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-start text-sm hover:bg-accent">
                            <span className="flex items-center gap-1.5">
                              {k.label}
                              {k.sensitive && <span className="rounded bg-red-500/10 px-1 py-0.5 text-[10px] text-red-600 dark:text-red-400">حساسة</span>}
                            </span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${b.cls}`}>{b.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button onClick={save} disabled={busy || loading}>حفظ الصلاحيات</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
