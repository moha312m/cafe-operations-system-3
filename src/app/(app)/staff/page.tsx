"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { MANAGEABLE_ROLES, ROLE_LABELS } from "@/lib/permissions";
import { PermissionEditor } from "@/components/staff/permission-editor";
import type { Role } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type StaffUser = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  archivedAt: string | null;
  lastLoginAt: string | null;
  branchId: string | null;
  branch: { name: string } | null;
  effectiveBranchId: string | null;
  temporaryBranchId: string | null;
  temporaryBranchUntil: string | null;
  temporaryBranch: { name: string } | null;
  temporaryBranchStatus: "PENDING" | "ACTIVE" | "EXPIRED_FINISHING" | "CANCELLED_FINISHING" | null;
  cafeRoleId: string | null;
  cafeRole: { id: string; name: string; isActive: boolean } | null;
};
type Branch = { id: string; name: string; isActive?: boolean };
type RoleOption = { id: string; name: string; isSystemDefault: boolean };

const TEMPORARY_STATUS = {
  PENDING: "بانتظار تسليم الوردية والعهدة الحالية",
  ACTIVE: "تعيين مؤقت نشط",
  EXPIRED_FINISHING: "انتهى الموعد — بانتظار تسليم الوردية والعهدة",
  CANCELLED_FINISHING: "ملغي — بانتظار تسليم الوردية والعهدة",
};

const STATUS = {
  ACTIVE: { label: "نشط", variant: "secondary" as const },
  INACTIVE: { label: "موقوف", variant: "destructive" as const },
  ARCHIVED: { label: "مؤرشف", variant: "outline" as const },
};

function statusOf(u: StaffUser): keyof typeof STATUS {
  if (u.archivedAt) return "ARCHIVED";
  return u.isActive ? "ACTIVE" : "INACTIVE";
}

const EMPTY_FORM = {
  name: "",
  email: "",
  phone: "",
  password: "",
  confirm: "",
  role: "CASHIER" as Role,
  branchId: "",
  cafeRoleId: "",
};

export default function StaffPage() {
  const { user, canKey } = useApp();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [permTarget, setPermTarget] = useState<StaffUser | null>(null);
  const [busy, setBusy] = useState(false);
  const canManagePerms = canKey("users.manage_permissions");

  // filters
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [branchFilter, setBranchFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", role: "" as Role, branchId: "", cafeRoleId: "" });
  const [temporaryTarget, setTemporaryTarget] = useState<StaffUser | null>(null);
  const [temporaryForm, setTemporaryForm] = useState({ branchId: "", until: "" });
  const [pwTarget, setPwTarget] = useState<StaffUser | null>(null);
  const [pw, setPw] = useState({ password: "", confirm: "" });

  const creatableRoles = MANAGEABLE_ROLES[user.role];

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (roleFilter !== "ALL") params.set("role", roleFilter);
    if (branchFilter !== "ALL") params.set("branchId", branchFilter);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    try {
      const { users } = await api<{ users: StaffUser[] }>(`/api/users?${params}`);
      setUsers(users);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الموظفين");
    }
  }, [q, roleFilter, branchFilter, statusFilter]);

  useEffect(() => {
    const timer = setTimeout(load, 250); // debounce search typing
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    api<{ branches: Branch[] }>("/api/branches")
      .then((r) => setBranches(r.branches))
      .catch(() => {});
    api<{ roles: RoleOption[] }>("/api/roles/options")
      .then((r) => setRoleOptions(r.roles))
      .catch(() => {});
  }, []);

  const canManage = (u: StaffUser) =>
    u.id !== user.id && MANAGEABLE_ROLES[user.role].includes(u.role);

  // ── actions ──
  async function create() {
    if (form.password !== form.confirm) {
      toast.error("تأكيد كلمة المرور غير مطابق");
      return;
    }
    setBusy(true);
    try {
      await api("/api/users", {
        method: "POST",
        body: {
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          password: form.password,
          role: form.role,
          branchId:
            form.role === "CAFE_OWNER" ? null : form.branchId || user.branchId,
          cafeRoleId: form.cafeRoleId || null,
        },
      });
      toast.success("تم إضافة الموظف بنجاح");
      setAddOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل إضافة الموظف");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(u: StaffUser) {
    setEditForm({
      name: u.name,
      phone: u.phone ?? "",
      role: u.role,
      branchId: u.branchId ?? "",
      cafeRoleId: u.cafeRoleId ?? "",
    });
    setEditing(u);
  }

  async function saveEdit() {
    if (!editing) return;
    if (editForm.role !== "CAFE_OWNER" && !editForm.branchId && !user.branchId) {
      toast.error("الفرع مطلوب");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/users/${editing.id}`, {
        method: "PATCH",
        body: {
          name: editForm.name,
          phone: editForm.phone || null,
          ...(editForm.role !== editing.role ? { role: editForm.role } : {}),
          ...(editForm.branchId !== (editing.branchId ?? "")
            ? { branchId: editForm.branchId || null }
            : {}),
          ...(editForm.cafeRoleId !== (editing.cafeRoleId ?? "")
            ? { cafeRoleId: editForm.cafeRoleId || null }
            : {}),
        },
      });
      toast.success("تم تعديل بيانات الموظف");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التعديل");
    } finally {
      setBusy(false);
    }
  }

  function openTemporary(u: StaffUser) {
    const end = u.temporaryBranchUntil ? new Date(u.temporaryBranchUntil) : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const local = new Date(end.getTime() - end.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 16);
    setTemporaryForm({ branchId: u.temporaryBranchId ?? "", until: local });
    setTemporaryTarget(u);
  }

  async function saveTemporary(cancel = false) {
    if (!temporaryTarget) return;
    const end = new Date(temporaryForm.until);
    if (!cancel && (!temporaryForm.branchId || !Number.isFinite(end.getTime()) || end <= new Date())) {
      toast.error("اختار الفرع المؤقت وتاريخ انتهاء في المستقبل");
      return;
    }
    setBusy(true);
    try {
      await api("/api/users/" + temporaryTarget.id, { method: "PATCH",
        body: cancel ? { temporaryBranchId: null } : {
          temporaryBranchId: temporaryForm.branchId, temporaryBranchUntil: end.toISOString(),
        },
      });
      toast.success(cancel ? "تم إلغاء التعيين المؤقت؛ العودة بعد تسليم أي وردية وعهدة مفتوحة" : "تم حفظ التعيين المؤقت");
      setTemporaryTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تعديل التعيين المؤقت");
    } finally { setBusy(false); }
  }

  async function changePassword() {
    if (!pwTarget) return;
    if (pw.password !== pw.confirm) {
      toast.error("تأكيد كلمة المرور غير مطابق");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/users/${pwTarget.id}`, {
        method: "PATCH",
        body: { password: pw.password },
      });
      toast.success("تم تغيير كلمة المرور بنجاح");
      setPwTarget(null);
      setPw({ password: "", confirm: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تغيير كلمة المرور");
    } finally {
      setBusy(false);
    }
  }

  async function patch(u: StaffUser, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      await api(`/api/users/${u.id}`, { method: "PATCH", body });
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تنفيذ الإجراء");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">الموظفين</h1>
        <Button onClick={() => setAddOpen(true)}>إضافة موظف جديد</Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="ابحث عن موظف..."
          className="w-56"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v ?? "ALL")}>
          <SelectTrigger className="w-36">
            <SelectValue>
              {roleFilter === "ALL" ? "كل الأدوار" : ROLE_LABELS[roleFilter as Role]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">كل الأدوار</SelectItem>
            {creatableRoles.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!user.branchId && (
          <Select value={branchFilter} onValueChange={(v) => setBranchFilter(v ?? "ALL")}>
            <SelectTrigger className="w-40">
              <SelectValue>
                {branchFilter === "ALL"
                  ? "كل الفروع"
                  : branches.find((b) => b.id === branchFilter)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">كل الفروع</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "ALL")}>
          <SelectTrigger className="w-36">
            <SelectValue>
              {statusFilter === "ALL"
                ? "كل الحالات"
                : STATUS[statusFilter as keyof typeof STATUS].label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">كل الحالات</SelectItem>
            <SelectItem value="ACTIVE">نشط</SelectItem>
            <SelectItem value="INACTIVE">موقوف</SelectItem>
            <SelectItem value="ARCHIVED">مؤرشف</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>الاسم</TableHead>
              <TableHead>البريد الإلكتروني</TableHead>
              <TableHead>رقم الموبايل</TableHead>
              <TableHead>الدور</TableHead>
              <TableHead>مجموعة الصلاحيات</TableHead>
              <TableHead>الفرع</TableHead>
              <TableHead>الحالة</TableHead>
              <TableHead>آخر دخول</TableHead>
              <TableHead className="text-end">إجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  مفيش موظفين
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => {
                const st = statusOf(u);
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell dir="ltr" className="text-end">{u.email}</TableCell>
                    <TableCell dir="ltr" className="text-end">{u.phone ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                    </TableCell>
                    <TableCell>
                      {u.cafeRole ? (
                        <span className="rounded-md bg-violet-500/12 px-2 py-0.5 text-xs text-violet-700 dark:text-violet-400">
                          {u.cafeRole.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">افتراضي</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{u.branch?.name ?? "كل الفروع"}</div>
                      {u.temporaryBranchStatus && (
                        <div className="mt-1 space-y-1 text-xs">
                          <Badge variant="outline">{TEMPORARY_STATUS[u.temporaryBranchStatus]}</Badge>
                          <div>الفرع المؤقت: {u.temporaryBranch?.name ?? "—"}</div>
                          {u.temporaryBranchUntil && <div className="text-muted-foreground">حتى {new Date(u.temporaryBranchUntil).toLocaleString("ar-EG")}</div>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS[st].variant}>{STATUS[st].label}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {u.lastLoginAt ? formatTime(u.lastLoginAt) : "—"}
                    </TableCell>
                    <TableCell>
                      {canManage(u) && (
                        <div className="flex justify-end gap-1">
                          {st !== "ARCHIVED" && (
                            <>
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => openEdit(u)}>
                                تعديل
                              </Button>
                              {user.role === "CAFE_OWNER" && u.branchId && u.role !== "CAFE_OWNER" && u.role !== "SUPER_ADMIN" && (
                                <Button size="sm" variant="ghost" disabled={busy || !u.isActive} onClick={() => openTemporary(u)}>
                                  تعيين مؤقت
                                </Button>
                              )}
                              {canManagePerms && (
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPermTarget(u)}>
                                  صلاحيات مخصصة
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => {
                                  setPw({ password: "", confirm: "" });
                                  setPwTarget(u);
                                }}
                              >
                                تغيير كلمة المرور
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    u.isActive &&
                                    !confirm("هل أنت متأكد من إيقاف هذا الحساب؟")
                                  )
                                    return;
                                  patch(
                                    u,
                                    { isActive: !u.isActive },
                                    u.isActive ? "تم إيقاف الحساب" : "تم تفعيل الحساب"
                                  );
                                }}
                              >
                                {u.isActive ? "إيقاف الحساب" : "تفعيل الحساب"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => {
                                  if (!confirm("هل أنت متأكد من أرشفة هذا الموظف؟")) return;
                                  patch(u, { archived: true }, "تم أرشفة الموظف");
                                }}
                              >
                                أرشفة
                              </Button>
                            </>
                          )}
                          {st === "ARCHIVED" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                patch(u, { archived: false, isActive: true }, "تم استرجاع الموظف")
                              }
                            >
                              استرجاع
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={(o) => !busy && setAddOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة موظف جديد</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>الاسم</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>البريد الإلكتروني</Label>
                <Input
                  type="email"
                  dir="ltr"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>رقم الموبايل</Label>
                <Input
                  dir="ltr"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>كلمة المرور</Label>
                <Input
                  type="password"
                  dir="ltr"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>تأكيد كلمة المرور</Label>
                <Input
                  type="password"
                  dir="ltr"
                  value={form.confirm}
                  onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                />
              </div>
            </div>
            {form.password.length > 0 && form.password.length < 8 && (
              <p className="text-xs text-destructive">كلمة المرور يجب أن تكون 8 أحرف على الأقل</p>
            )}
            {form.confirm.length > 0 && form.confirm !== form.password && (
              <p className="text-xs text-destructive">تأكيد كلمة المرور غير مطابق</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>الدور</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })}>
                  <SelectTrigger>
                    <SelectValue>{ROLE_LABELS[form.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {creatableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.role !== "CAFE_OWNER" && !user.branchId && (
                <div className="space-y-2">
                  <Label>الفرع</Label>
                  <Select
                    value={form.branchId}
                    onValueChange={(v) => setForm({ ...form, branchId: v ?? "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختار">
                        {branches.find((b) => b.id === form.branchId)?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>الدور / مجموعة الصلاحيات</Label>
              <select
                value={form.cafeRoleId}
                onChange={(e) => setForm({ ...form, cafeRoleId: e.target.value })}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">— بدون دور (الافتراضي حسب النوع) —</option>
                {roleOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={create}
              disabled={
                busy ||
                !form.name ||
                !form.email ||
                form.password.length < 8 ||
                form.password !== form.confirm ||
                (form.role !== "CAFE_OWNER" && !user.branchId && !form.branchId)
              }
            >
              {busy ? "جاري الإضافة…" : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(o) => !busy && !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تعديل بيانات الموظف</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>الاسم</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>رقم الموبايل</Label>
              <Input
                dir="ltr"
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>الدور</Label>
                <Select
                  value={editForm.role}
                  onValueChange={(v) => setEditForm({ ...editForm, role: v as Role })}
                >
                  <SelectTrigger>
                    <SelectValue>{ROLE_LABELS[editForm.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {creatableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!user.branchId && (
                <div className="space-y-2">
                  <Label>الفرع</Label>
                  <Select
                    value={editForm.branchId}
                    onValueChange={(v) => setEditForm({ ...editForm, branchId: v ?? "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختار">
                        {branches.find((b) => b.id === editForm.branchId)?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>الدور / مجموعة الصلاحيات</Label>
              <select
                value={editForm.cafeRoleId}
                onChange={(e) => setEditForm({ ...editForm, cafeRoleId: e.target.value })}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">— بدون دور (الافتراضي حسب النوع) —</option>
                {roleOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={saveEdit} disabled={busy || !editForm.name ||
              (editForm.role !== "CAFE_OWNER" && !user.branchId && !editForm.branchId)}>
              {busy ? "جاري الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={temporaryTarget !== null} onOpenChange={(o) => !busy && !o && setTemporaryTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>تعيين مؤقت — {temporaryTarget?.name}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            الفرع الأساسي: {temporaryTarget?.branch?.name}. يبدأ التعيين بعد تسليم الوردية والعهدة الحالية، وتتم العودة تلقائياً بعد الموعد وتسليم أي وردية وعهدة مفتوحة في الفرع المؤقت.
          </p>
          {temporaryTarget?.temporaryBranchStatus && <Badge variant="outline">{TEMPORARY_STATUS[temporaryTarget.temporaryBranchStatus]}</Badge>}
          <div className="space-y-2">
            <Label htmlFor="temporary-branch">الفرع المؤقت</Label>
            <Select value={temporaryForm.branchId} onValueChange={(value) => setTemporaryForm({ ...temporaryForm, branchId: value ?? "" })}>
              <SelectTrigger id="temporary-branch"><SelectValue>{branches.find((b) => b.id === temporaryForm.branchId)?.name}</SelectValue></SelectTrigger>
              <SelectContent>
                {branches.filter((b) => b.id !== temporaryTarget?.branchId && b.isActive !== false).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Label htmlFor="temporary-until">تاريخ ووقت الانتهاء</Label>
            <Input id="temporary-until" type="datetime-local" dir="ltr" value={temporaryForm.until} onChange={(e) => setTemporaryForm({ ...temporaryForm, until: e.target.value })} />
          </div>
          <DialogFooter>
            {temporaryTarget?.temporaryBranchId && temporaryTarget.temporaryBranchStatus !== "CANCELLED_FINISHING" && <Button variant="destructive" disabled={busy} onClick={() => saveTemporary(true)}>إلغاء التعيين المؤقت</Button>}
            <Button disabled={busy || !temporaryForm.branchId || !temporaryForm.until} onClick={() => saveTemporary()}>حفظ التعيين المؤقت</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {permTarget && (
        <PermissionEditor
          userId={permTarget.id}
          userName={permTarget.name}
          roleOptions={roleOptions}
          onClose={() => setPermTarget(null)}
          onSaved={() => { setPermTarget(null); load(); }}
        />
      )}

      {/* Password dialog */}
      <Dialog open={pwTarget !== null} onOpenChange={(o) => !busy && !o && setPwTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>تغيير كلمة المرور — {pwTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>كلمة المرور الجديدة</Label>
              <Input
                type="password"
                dir="ltr"
                value={pw.password}
                onChange={(e) => setPw({ ...pw, password: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>تأكيد كلمة المرور</Label>
              <Input
                type="password"
                dir="ltr"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
              />
            </div>
            {pw.confirm.length > 0 && pw.confirm !== pw.password && (
              <p className="text-xs text-destructive">تأكيد كلمة المرور غير مطابق</p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={changePassword}
              disabled={busy || pw.password.length < 8 || pw.password !== pw.confirm}
            >
              {busy ? "جاري الحفظ…" : "تغيير كلمة المرور"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
