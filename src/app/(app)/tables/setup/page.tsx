"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { PageHeader, StatCard, EmptyState, LoadingState } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type CafeTable = {
  id: string; tableNumber: string; displayName: string | null; area: string | null;
  seatsCount: number | null; isActive: boolean; sortOrder: number; archivedAt: string | null;
};
type Summary = { total: number; active: number; inactive: number; occupied: number };
type Branch = { id: string; name: string };
type Form = {
  id?: string; tableNumber: string; displayName: string; area: string;
  seatsCount: string; sortOrder: string; isActive: boolean;
};
const EMPTY: Form = { tableNumber: "", displayName: "", area: "", seatsCount: "", sortOrder: "", isActive: true };

export default function TableSetupPage() {
  const { user, canKey, features } = useApp();
  const [tables, setTables] = useState<CafeTable[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [form, setForm] = useState<Form | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState({ from: "1", to: "15", namePrefix: "", area: "", seatsCount: "" });
  const [busy, setBusy] = useState(false);

  const canManage = canKey("tables.manage");
  const canCreate = canKey("tables.create");
  const canEdit = canKey("tables.edit");
  const canArchive = canKey("tables.archive");
  const canBulk = canKey("tables.bulk_create");
  const enabled = features?.enableTables ?? true;

  const load = useCallback(async () => {
    if (!branchId) { setTables([]); setSummary(null); return; }
    try {
      const data = await api<{ summary: Summary; tables: CafeTable[] }>(
        `/api/tables/config?branchId=${branchId}&includeArchived=1`
      );
      setTables(data.tables);
      setSummary(data.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الترابيزات");
    }
  }, [branchId]);

  useEffect(() => { if (canManage && enabled) load(); }, [canManage, enabled, load]);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches")
        .then((r) => { setBranches(r.branches); if (!branchId && r.branches[0]) setBranchId(r.branches[0].id); })
        .catch(() => {});
    }
  }, [user.branchId, branchId]);

  async function save() {
    if (!form) return;
    if (!form.tableNumber.trim()) return toast.error("رقم الترابيزة مطلوب");
    setBusy(true);
    try {
      const body = {
        branchId,
        tableNumber: form.tableNumber.trim(),
        displayName: form.displayName.trim() || undefined,
        area: form.area.trim() || undefined,
        seatsCount: form.seatsCount ? Number(form.seatsCount) : undefined,
        sortOrder: form.sortOrder ? Number(form.sortOrder) : undefined,
        isActive: form.isActive,
      };
      if (form.id) await api(`/api/tables/config/${form.id}`, { method: "PATCH", body });
      else await api("/api/tables/config", { method: "POST", body });
      toast.success("تم حفظ الترابيزة");
      setForm(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function bulkCreate() {
    if (!branchId) return toast.error("اختار الفرع");
    const from = Number(bulk.from), to = Number(bulk.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return toast.error("أرقام غير صحيحة");
    if (from > to) return toast.error("رقم البداية يجب أن يكون أقل من أو يساوي رقم النهاية");
    setBusy(true);
    try {
      const res = await api<{ created: number; skipped: number }>("/api/tables/config/bulk", {
        method: "POST",
        body: {
          branchId, from, to,
          namePrefix: bulk.namePrefix.trim() || undefined,
          area: bulk.area.trim() || undefined,
          seatsCount: bulk.seatsCount ? Number(bulk.seatsCount) : undefined,
        },
      });
      toast.success(
        res.skipped > 0
          ? `تم إنشاء ${res.created} ترابيزة · تم تجاهل ${res.skipped} لأنها موجودة بالفعل`
          : `تم إنشاء ${res.created} ترابيزة`
      );
      setBulkOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الإنشاء");
    } finally {
      setBusy(false);
    }
  }

  async function patch(t: CafeTable, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      await api(`/api/tables/config/${t.id}`, { method: "PATCH", body });
      toast.success(ok);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحديث");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <>
        <PageHeader title="إعداد الترابيزات" />
        <p className="text-muted-foreground">ميزة الترابيزات غير مفعلة لهذا الكافيه</p>
      </>
    );
  }
  if (!canManage) {
    return (
      <>
        <PageHeader title="إعداد الترابيزات" />
        <p className="text-destructive">ليس لديك صلاحية لإدارة الترابيزات</p>
      </>
    );
  }

  const bulkFrom = Number(bulk.from), bulkTo = Number(bulk.to);
  const bulkPreview = Number.isFinite(bulkFrom) && Number.isFinite(bulkTo) && bulkFrom <= bulkTo
    ? `سيتم إنشاء الترابيزات من ${bulkFrom} إلى ${bulkTo}` : null;

  return (
    <>
      <PageHeader title="إعداد الترابيزات" subtitle="إدارة ترابيزات كل فرع">
        <div className="flex flex-wrap items-center gap-2">
          {!user.branchId && branches.length > 0 && (
            <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
              <SelectTrigger className="w-44"><SelectValue>{branches.find((b) => b.id === branchId)?.name}</SelectValue></SelectTrigger>
              <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {canBulk && <Button variant="outline" onClick={() => setBulkOpen(true)}>إنشاء ترابيزات دفعة واحدة</Button>}
          {canCreate && <Button onClick={() => setForm({ ...EMPTY })}>+ إضافة ترابيزة</Button>}
        </div>
      </PageHeader>

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="إجمالي الترابيزات" value={summary.total} icon="🍽️" accent="blue" />
          <StatCard label="الترابيزات النشطة" value={summary.active} icon="✅" accent="emerald" />
          <StatCard label="الترابيزات الموقوفة" value={summary.inactive} icon="🚫" accent={summary.inactive > 0 ? "amber" : "slate"} />
          <StatCard label="المشغولة حاليًا" value={summary.occupied} icon="🔴" accent={summary.occupied > 0 ? "violet" : "slate"} />
        </div>
      )}

      <div className="mt-4">
        {tables === null ? (
          <LoadingState />
        ) : tables.length === 0 ? (
          <EmptyState message="لم يتم إنشاء ترابيزات لهذا الفرع بعد" icon="🍽️" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <Table>
              <TableHeader><TableRow>
                <TableHead>رقم الترابيزة</TableHead>
                <TableHead>الاسم</TableHead>
                <TableHead>المنطقة</TableHead>
                <TableHead className="text-center">عدد الكراسي</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead className="text-center">ترتيب الظهور</TableHead>
                <TableHead className="text-end">إجراءات</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {tables.map((t) => (
                  <TableRow key={t.id} className={t.archivedAt ? "opacity-50" : ""}>
                    <TableCell className="font-medium tabular-nums">{t.tableNumber}</TableCell>
                    <TableCell>{t.displayName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{t.area ?? "—"}</TableCell>
                    <TableCell className="text-center tabular-nums">{t.seatsCount ?? "—"}</TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        t.archivedAt ? "bg-foreground/8 text-muted-foreground"
                        : t.isActive ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : "bg-amber-500/12 text-amber-700 dark:text-amber-400"
                      }`}>
                        {t.archivedAt ? "مؤرشفة" : t.isActive ? "نشطة" : "موقوفة"}
                      </span>
                    </TableCell>
                    <TableCell className="text-center tabular-nums text-muted-foreground">{t.sortOrder}</TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        {!t.archivedAt && canEdit && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm({
                            id: t.id, tableNumber: t.tableNumber, displayName: t.displayName ?? "",
                            area: t.area ?? "", seatsCount: t.seatsCount != null ? String(t.seatsCount) : "",
                            sortOrder: String(t.sortOrder), isActive: t.isActive,
                          })}>تعديل</Button>
                        )}
                        {!t.archivedAt && canArchive && (
                          <Button size="sm" variant="ghost" disabled={busy}
                            onClick={() => patch(t, { isActive: !t.isActive }, t.isActive ? "تم إيقاف الترابيزة" : "تم تفعيل الترابيزة")}>
                            {t.isActive ? "إيقاف" : "تفعيل"}
                          </Button>
                        )}
                        {canArchive && (
                          <Button size="sm" variant="ghost" className={t.archivedAt ? "" : "text-destructive"} disabled={busy}
                            onClick={() => patch(t, { archived: !t.archivedAt }, t.archivedAt ? "تم استرجاع الترابيزة" : "تم أرشفة الترابيزة")}>
                            {t.archivedAt ? "استرجاع" : "أرشفة"}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={form !== null} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent className="max-w-md">
          {form && (
            <>
              <DialogHeader><DialogTitle>{form.id ? "تعديل ترابيزة" : "إضافة ترابيزة"}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>رقم الترابيزة</Label>
                    <Input dir="ltr" value={form.tableNumber} onChange={(e) => setForm({ ...form, tableNumber: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>ترتيب الظهور</Label>
                    <Input type="number" dir="ltr" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>اسم الترابيزة (اختياري)</Label>
                  <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>المنطقة</Label>
                    <Input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>عدد الكراسي</Label>
                    <Input type="number" dir="ltr" value={form.seatsCount} onChange={(e) => setForm({ ...form, seatsCount: e.target.value })} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                  نشطة
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setForm(null)} disabled={busy}>إلغاء</Button>
                <Button onClick={save} disabled={busy}>حفظ</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk create dialog */}
      <Dialog open={bulkOpen} onOpenChange={(o) => !o && !busy && setBulkOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>إنشاء ترابيزات دفعة واحدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>من رقم</Label>
                <Input type="number" dir="ltr" value={bulk.from} onChange={(e) => setBulk({ ...bulk, from: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>إلى رقم</Label>
                <Input type="number" dir="ltr" value={bulk.to} onChange={(e) => setBulk({ ...bulk, to: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>بادئة الاسم (اختياري)</Label>
              <Input placeholder="مثال: ترابيزة" value={bulk.namePrefix} onChange={(e) => setBulk({ ...bulk, namePrefix: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>المنطقة (اختياري)</Label>
                <Input value={bulk.area} onChange={(e) => setBulk({ ...bulk, area: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>عدد الكراسي (اختياري)</Label>
                <Input type="number" dir="ltr" value={bulk.seatsCount} onChange={(e) => setBulk({ ...bulk, seatsCount: e.target.value })} />
              </div>
            </div>
            {bulkPreview && <p className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-700 dark:text-blue-400">{bulkPreview}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={bulkCreate} disabled={busy}>إنشاء</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
