"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { MANAGEABLE_ROLES, ROLE_LABELS } from "@/lib/permissions";
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
};
type Branch = { id: string; name: string };

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
};

export default function StaffPage() {
  const { user } = useApp();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);

  // filters
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [branchFilter, setBranchFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", role: "" as Role, branchId: "" });
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
    });
    setEditing(u);
  }

  async function saveEdit() {
    if (!editing) return;
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
              <TableHead>الفرع</TableHead>
              <TableHead>الحالة</TableHead>
              <TableHead>آخر دخول</TableHead>
              <TableHead className="text-end">إجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
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
                    <TableCell>{u.branch?.name ?? "كل الفروع"}</TableCell>
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
          </div>
          <DialogFooter>
            <Button onClick={saveEdit} disabled={busy || !editForm.name}>
              {busy ? "جاري الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
