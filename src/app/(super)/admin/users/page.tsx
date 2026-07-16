"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t, formatDateTime } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, Panel, StatusPill, EmptyState, LoadingBlock } from "@/components/admin/ui";
import { PasswordResetDialog } from "@/components/admin/password-reset-dialog";

type User = {
  id: string; name: string; email: string; phone: string | null; role: string;
  isActive: boolean; archivedAt: string | null; lastLoginAt: string | null;
  cafe: { id: string; name: string } | null;
  branch: { name: string } | null;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [pwTarget, setPwTarget] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (role) qs.set("role", role);
      if (status) qs.set("status", status);
      const { users } = await api<{ users: User[] }>(`/api/admin/users?${qs.toString()}`);
      setUsers(users);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل المستخدمين");
    }
  }, [q, role, status]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  async function setActive(u: User, isActive: boolean) {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { isActive } });
      toast.success(isActive ? "تم تفعيل الحساب" : "تم إيقاف الحساب");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحديث");
    }
  }

  async function archive(u: User) {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { archived: true } });
      toast.success("تمت أرشفة المستخدم");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الأرشفة");
    }
  }

  return (
    <>
      <PageHeader title={t.admin.nav.users} subtitle="كل المستخدمين عبر كل الكافيهات" />

      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input placeholder="ابحث بالاسم أو الإيميل أو الموبايل…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
            <option value="">كل الأدوار</option>
            {(["CAFE_OWNER", "BRANCH_MANAGER", "CASHIER", "WAITER", "BARISTA", "INVENTORY_MANAGER"] as const).map((r) => (
              <option key={r} value={r}>{t.roles[r]}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
            <option value="">كل الحالات</option>
            <option value="ACTIVE">مفعّل</option>
            <option value="INACTIVE">موقوف</option>
            <option value="ARCHIVED">مؤرشف</option>
          </select>
        </div>

        {users === null ? (
          <LoadingBlock label={t.admin.loading} />
        ) : users.length === 0 ? (
          <EmptyState message={t.admin.empty} icon="👥" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>الاسم</TableHead>
                <TableHead>الإيميل</TableHead>
                <TableHead>الموبايل</TableHead>
                <TableHead>الدور</TableHead>
                <TableHead>الكافيه</TableHead>
                <TableHead>الفرع</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>آخر دخول</TableHead>
                <TableHead className="text-end">إجراءات</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {users.map((u) => {
                  const archived = !!u.archivedAt;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell dir="ltr" className="text-start text-xs text-slate-500">{u.email}</TableCell>
                      <TableCell dir="ltr" className="text-start text-xs text-slate-500">{u.phone ?? "—"}</TableCell>
                      <TableCell>{t.roles[u.role as keyof typeof t.roles] ?? u.role}</TableCell>
                      <TableCell className="text-slate-600">{u.cafe?.name ?? "—"}</TableCell>
                      <TableCell className="text-slate-500">{u.branch?.name ?? "—"}</TableCell>
                      <TableCell>
                        <StatusPill active={u.isActive && !archived} labels={{ on: t.common.active, off: archived ? "مؤرشف" : t.common.disabled }} />
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setPwTarget({ id: u.id, name: u.name })}>
                            {t.admin.actions.resetPassword}
                          </Button>
                          {!archived && (u.isActive ? (
                            <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setActive(u, false)}>إيقاف</Button>
                          ) : (
                            <Button size="sm" variant="ghost" className="text-emerald-600" onClick={() => setActive(u, true)}>تفعيل</Button>
                          ))}
                          {!archived && (
                            <Button size="sm" variant="ghost" className="text-slate-500" onClick={() => archive(u)}>أرشفة</Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <PasswordResetDialog
        open={!!pwTarget}
        onOpenChange={(v) => !v && setPwTarget(null)}
        endpoint={pwTarget ? `/api/admin/users/${pwTarget.id}` : null}
        subjectName={pwTarget?.name ?? ""}
      />
    </>
  );
}
