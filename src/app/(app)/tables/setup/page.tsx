"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { PageHeader, StatCard, EmptyState, LoadingState } from "@/components/cafe/ui";
import { cn } from "@/lib/utils";
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

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "ALL", label: "الكل" },
  { key: "ACTIVE", label: "النشطة" },
  { key: "INACTIVE", label: "الموقوفة" },
  { key: "ARCHIVED", label: "المؤرشفة" },
];

// Visual state → accent classes. Occupied wins over active (blue), then
// archived (muted), inactive (amber), active (green).
type Visual = "occupied" | "active" | "inactive" | "archived";
function visualOf(t: CafeTable, occupied: boolean): Visual {
  if (t.archivedAt) return "archived";
  if (t.isActive && occupied) return "occupied";
  if (t.isActive) return "active";
  return "inactive";
}
const VISUAL: Record<Visual, { card: string; badge: string; label: string; ring: string }> = {
  active:   { card: "border-emerald-500/40", badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", label: "نشطة", ring: "text-emerald-600 dark:text-emerald-400" },
  occupied: { card: "border-blue-500/50", badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400", label: "مشغولة الآن", ring: "text-blue-600 dark:text-blue-400" },
  inactive: { card: "border-amber-500/40", badge: "bg-amber-500/12 text-amber-700 dark:text-amber-400", label: "موقوفة", ring: "text-amber-600 dark:text-amber-400" },
  archived: { card: "border-border opacity-60", badge: "bg-foreground/8 text-muted-foreground", label: "مؤرشفة", ring: "text-muted-foreground" },
};

export default function TableSetupPage() {
  const { user, canKey, features } = useApp();
  const [tables, setTables] = useState<CafeTable[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [occupied, setOccupied] = useState<Set<string>>(new Set());
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [view, setView] = useState<"grid" | "list">("grid");
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
      const data = await api<{ summary: Summary; tables: CafeTable[]; occupiedNumbers: string[] }>(
        `/api/tables/config?branchId=${branchId}&includeArchived=1`
      );
      setTables(data.tables);
      setSummary(data.summary);
      setOccupied(new Set(data.occupiedNumbers ?? []));
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

  const filtered = useMemo(() => {
    if (!tables) return [];
    const needle = q.trim().toLowerCase();
    return tables.filter((t) => {
      if (filter === "ACTIVE" && !(t.isActive && !t.archivedAt)) return false;
      if (filter === "INACTIVE" && !(!t.isActive && !t.archivedAt)) return false;
      if (filter === "ARCHIVED" && !t.archivedAt) return false;
      if (needle && !`${t.tableNumber} ${t.displayName ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [tables, q, filter]);

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

  function editForm(t: CafeTable): Form {
    return {
      id: t.id, tableNumber: t.tableNumber, displayName: t.displayName ?? "",
      area: t.area ?? "", seatsCount: t.seatsCount != null ? String(t.seatsCount) : "",
      sortOrder: String(t.sortOrder), isActive: t.isActive,
    };
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

  const emptyBranch = tables !== null && tables.length === 0;

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

      {/* Toolbar: search + status chips + view toggle */}
      {!emptyBranch && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Input placeholder="ابحث برقم أو اسم الترابيزة…" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex rounded-xl border border-border bg-card p-0.5 text-sm">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={cn("rounded-lg px-3 py-1.5 font-medium transition-colors",
                  filter === f.key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="ms-auto flex rounded-xl border border-border bg-card p-0.5 text-sm">
            <button onClick={() => setView("grid")}
              className={cn("rounded-lg px-3 py-1.5 font-medium transition-colors", view === "grid" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
              ▦ عرض كمربعات
            </button>
            <button onClick={() => setView("list")}
              className={cn("rounded-lg px-3 py-1.5 font-medium transition-colors", view === "list" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
              ☰ عرض كجدول
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        {tables === null ? (
          <LoadingState />
        ) : emptyBranch ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
            <p className="text-4xl">🍽️</p>
            <p className="mt-3 text-sm font-medium text-muted-foreground">لا توجد ترابيزات مضافة لهذا الفرع بعد</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {canCreate && <Button onClick={() => setForm({ ...EMPTY })}>+ إضافة ترابيزة</Button>}
              {canBulk && <Button variant="outline" onClick={() => setBulkOpen(true)}>إنشاء ترابيزات دفعة واحدة</Button>}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState message="لا توجد ترابيزات مطابقة للبحث" icon="🔍" />
        ) : view === "grid" ? (
          // ── Card grid ──
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {filtered.map((t) => {
              const v = visualOf(t, occupied.has(t.tableNumber));
              const meta = VISUAL[v];
              return (
                <div key={t.id}
                  className={cn("group flex flex-col rounded-2xl border-2 bg-card p-4 shadow-sm transition-all hover:shadow-md", meta.card)}>
                  <div className="flex items-start justify-between gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.badge)}>{meta.label}</span>
                    <span className="text-[11px] text-muted-foreground">#{t.sortOrder}</span>
                  </div>

                  <div className="flex flex-col items-center py-3 text-center">
                    <span className="text-3xl leading-none">🍽️</span>
                    <span className={cn("mt-1.5 font-heading text-2xl font-bold tabular-nums text-foreground")}>ترابيزة {t.tableNumber}</span>
                    <span className="mt-0.5 text-xs text-muted-foreground">{t.displayName || "بدون اسم"}</span>
                  </div>

                  <div className="flex items-center justify-center gap-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                    <span>📍 {t.area || "بدون منطقة"}</span>
                    <span>🪑 {t.seatsCount != null ? `${t.seatsCount} كراسي` : "—"}</span>
                  </div>

                  {(canEdit || canArchive) && (
                    <div className="mt-3 flex flex-wrap justify-center gap-1">
                      {!t.archivedAt && canEdit && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setForm(editForm(t))}>تعديل</Button>
                      )}
                      {!t.archivedAt && canArchive && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy}
                          onClick={() => patch(t, { isActive: !t.isActive }, t.isActive ? "تم إيقاف الترابيزة" : "تم تفعيل الترابيزة")}>
                          {t.isActive ? "إيقاف" : "تفعيل"}
                        </Button>
                      )}
                      {canArchive && (
                        <Button size="sm" variant="ghost" className={cn("h-7 px-2 text-xs", !t.archivedAt && "text-destructive")} disabled={busy}
                          onClick={() => patch(t, { archived: !t.archivedAt }, t.archivedAt ? "تم استرجاع الترابيزة" : "تم أرشفة الترابيزة")}>
                          {t.archivedAt ? "استرجاع" : "أرشفة"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // ── List (table) view ──
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
                {filtered.map((t) => {
                  const meta = VISUAL[visualOf(t, occupied.has(t.tableNumber))];
                  return (
                    <TableRow key={t.id} className={t.archivedAt ? "opacity-50" : ""}>
                      <TableCell className="font-medium tabular-nums">{t.tableNumber}</TableCell>
                      <TableCell>{t.displayName ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{t.area ?? "—"}</TableCell>
                      <TableCell className="text-center tabular-nums">{t.seatsCount ?? "—"}</TableCell>
                      <TableCell><span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", meta.badge)}>{meta.label}</span></TableCell>
                      <TableCell className="text-center tabular-nums text-muted-foreground">{t.sortOrder}</TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-1">
                          {!t.archivedAt && canEdit && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(editForm(t))}>تعديل</Button>
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
                  );
                })}
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
