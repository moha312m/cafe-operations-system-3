"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import {
  MODULES, PERMISSION_KEYS, keysForModule, MODULE_MAP,
  type ModuleCode,
} from "@/lib/perms/catalog";
import { PageHeader, Panel, EmptyState, LoadingState } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type RoleRow = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isSystemDefault: boolean;
  isActive: boolean;
  userCount: number;
  permissionKeys: string[];
  modules: ModuleCode[];
};

type Editing = {
  id?: string;
  name: string;
  code: string;
  description: string;
  isActive: boolean;
  keys: Set<string>;
  isSystemDefault: boolean;
};

const EMPTY: Editing = {
  name: "", code: "", description: "", isActive: true, keys: new Set(), isSystemDefault: false,
};

export default function RolesPermissionsPage() {
  const { features, canKey } = useApp();
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = canKey("users.manage_permissions");

  const load = useCallback(async () => {
    try {
      const { roles } = await api<{ roles: RoleRow[] }>("/api/roles");
      setRoles(roles);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الأدوار");
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // A module is locked when its feature flag is off for this cafe.
  const isModuleLocked = (code: ModuleCode) => {
    const f = MODULE_MAP[code].feature;
    return !!(f && features && (features as Record<string, unknown>)[f] === false);
  };

  function openNew() {
    setEditing({ ...EMPTY, keys: new Set() });
  }

  async function openEdit(id: string) {
    try {
      const { role } = await api<{ role: RoleRow }>(`/api/roles/${id}`);
      setEditing({
        id: role.id,
        name: role.name,
        code: role.code,
        description: role.description ?? "",
        isActive: role.isActive,
        isSystemDefault: role.isSystemDefault,
        keys: new Set(role.permissionKeys),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    }
  }

  async function save() {
    if (!editing) return;
    if (editing.name.trim().length < 2) return toast.error("اسم الدور مطلوب");
    setBusy(true);
    try {
      const body = {
        name: editing.name.trim(),
        description: editing.description.trim(),
        isActive: editing.isActive,
        permissionKeys: [...editing.keys],
      };
      if (editing.id) {
        await api(`/api/roles/${editing.id}`, { method: "PATCH", body });
      } else {
        await api("/api/roles", {
          method: "POST",
          body: { ...body, code: editing.code.trim() || undefined },
        });
      }
      toast.success("تم حفظ الدور");
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(r: RoleRow) {
    try {
      await api(`/api/roles/${r.id}`, { method: "PATCH", body: { isActive: !r.isActive } });
      toast.success(r.isActive ? "تم تعطيل الدور" : "تم تفعيل الدور");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحديث");
    }
  }

  async function duplicate(r: RoleRow) {
    try {
      await api(`/api/roles/${r.id}/duplicate`, { method: "POST" });
      toast.success("تم نسخ الدور");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل النسخ");
    }
  }

  async function remove(r: RoleRow) {
    if (!confirm(`حذف/أرشفة الدور "${r.name}"؟`)) return;
    try {
      const res = await api<{ archived?: boolean; deleted?: boolean }>(`/api/roles/${r.id}`, { method: "DELETE" });
      toast.success(res.deleted ? "تم حذف الدور" : "تم أرشفة الدور");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحذف");
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="الأدوار والصلاحيات" />
        <p className="text-destructive">ليس لديك صلاحية للوصول لهذه الصفحة</p>
      </>
    );
  }

  const filtered = (roles ?? []).filter((r) => {
    if (filter === "ACTIVE" && !r.isActive) return false;
    if (filter === "INACTIVE" && r.isActive) return false;
    if (q && !`${r.name} ${r.code}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <PageHeader
        title="الأدوار والصلاحيات"
        subtitle="إدارة الأدوار وتحديد الموديولات المسموحة لكل دور"
      >
        <Button onClick={openNew}>+ إضافة دور جديد</Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input placeholder="ابحث باسم أو كود الدور…" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex rounded-xl border border-border bg-card p-0.5 text-sm">
          {([["ALL", "الكل"], ["ACTIVE", "نشط"], ["INACTIVE", "موقوف"]] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`rounded-lg px-3 py-1.5 font-medium ${filter === k ? "bg-foreground text-background" : "text-muted-foreground"}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {roles === null ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState message="لا يوجد أدوار" icon="🛡️" />
      ) : (
        <div className="grid gap-3">
          {filtered.map((r) => (
            <Panel key={r.id} bodyClassName="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-heading text-base font-bold text-foreground">{r.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{r.code}</code>
                  {r.isSystemDefault && (
                    <span className="rounded-full bg-blue-500/12 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">افتراضي</span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.isActive ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-foreground/8 text-muted-foreground"}`}>
                    {r.isActive ? "نشط" : "موقوف"}
                  </span>
                  <span className="text-xs text-muted-foreground">· {r.userCount} مستخدم</span>
                </div>
                {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.modules.map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground/80">
                      <span>{MODULE_MAP[m].icon}</span>{MODULE_MAP[m].label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => openEdit(r.id)}>تعديل</Button>
                <Button size="sm" variant="ghost" onClick={() => duplicate(r)}>نسخ</Button>
                <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>{r.isActive ? "تعطيل" : "تفعيل"}</Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(r)}>حذف</Button>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {/* Add/Edit role modal */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle>{editing.id ? "تعديل الدور" : "إضافة دور جديد"}</DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>اسم الدور</Label>
                    <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>كود الدور</Label>
                    <Input dir="ltr" placeholder="اختياري — يُنشأ تلقائيًا" disabled={!!editing.id}
                      value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>الوصف</Label>
                  <Textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
                  الحالة: نشط
                </label>

                <div className="flex items-center justify-between">
                  <h3 className="font-heading text-sm font-semibold">الصلاحيات حسب الموديول</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => {
                      const all = new Set<string>();
                      for (const p of PERMISSION_KEYS) {
                        if (p.key !== "platform.manage" && !isModuleLocked(p.module)) all.add(p.key);
                      }
                      setEditing({ ...editing, keys: all });
                    }}>تحديد الكل</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing({ ...editing, keys: new Set() })}>إلغاء تحديد الكل</Button>
                  </div>
                </div>

                <div className="space-y-2">
                  {MODULES.map((mod) => {
                    const keys = keysForModule(mod.code).filter((k) => k.key !== "platform.manage");
                    if (keys.length === 0) return null;
                    const locked = isModuleLocked(mod.code);
                    const modAll = keys.every((k) => editing.keys.has(k.key));
                    return (
                      <div key={mod.code} className={`rounded-xl border border-border p-3 ${locked ? "opacity-60" : ""}`}>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <span>{mod.icon}</span>{mod.label}
                            {locked && <span className="rounded bg-amber-500/12 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">🔒 غير مفعّلة في الباقة</span>}
                          </span>
                          {!locked && (
                            <button className="text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                const next = new Set(editing.keys);
                                if (modAll) keys.forEach((k) => next.delete(k.key));
                                else keys.forEach((k) => next.add(k.key));
                                setEditing({ ...editing, keys: next });
                              }}>
                              {modAll ? "إلغاء الكل" : "تحديد الكل"}
                            </button>
                          )}
                        </div>
                        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                          {keys.map((k) => (
                            <label key={k.key} className={`flex items-center gap-2 text-sm ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                              <input
                                type="checkbox"
                                disabled={locked}
                                checked={editing.keys.has(k.key)}
                                onChange={(e) => {
                                  const next = new Set(editing.keys);
                                  if (e.target.checked) next.add(k.key); else next.delete(k.key);
                                  setEditing({ ...editing, keys: next });
                                }}
                              />
                              <span>{k.label}</span>
                              {k.sensitive && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-600 dark:text-red-400">صلاحية حساسة</span>}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>إلغاء</Button>
                <Button onClick={save} disabled={busy}>حفظ الدور</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
