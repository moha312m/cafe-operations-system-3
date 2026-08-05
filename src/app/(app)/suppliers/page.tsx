"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { PageHeader, Panel, EmptyState, LoadingState } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type Supplier = {
  id: string; name: string; phone: string | null; email: string | null;
  address: string | null; notes: string | null; isActive: boolean;
  _count: { invoices: number };
};

type Form = { id?: string; name: string; phone: string; email: string; address: string; notes: string };
const EMPTY: Form = { name: "", phone: "", email: "", address: "", notes: "" };

export default function SuppliersPage() {
  const { canKey } = useApp();
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  const canView = canKey("suppliers.view");
  const canCreate = canKey("suppliers.create");
  const canEdit = canKey("suppliers.edit");
  const canToggle = canKey("suppliers.deactivate");

  const load = useCallback(async () => {
    try {
      const { suppliers } = await api<{ suppliers: Supplier[] }>(
        `/api/suppliers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`
      );
      setSuppliers(suppliers);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الموردين");
    }
  }, [q]);

  useEffect(() => {
    if (!canView) return;
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [canView, load]);

  async function save() {
    if (!form) return;
    if (form.name.trim().length < 2) return toast.error("اسم المورد مطلوب");
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        address: form.address.trim() || undefined,
        notes: form.notes.trim() || undefined,
      };
      if (form.id) await api(`/api/suppliers/${form.id}`, { method: "PATCH", body });
      else await api("/api/suppliers", { method: "POST", body });
      toast.success("تم حفظ المورد");
      setForm(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: Supplier) {
    try {
      await api(`/api/suppliers/${s.id}`, { method: "PATCH", body: { isActive: !s.isActive } });
      toast.success(s.isActive ? "تم إيقاف المورد" : "تم تفعيل المورد");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحديث");
    }
  }

  if (!canView) {
    return (
      <>
        <PageHeader title="الموردين" />
        <p className="text-destructive">ليس لديك صلاحية للوصول لهذه الصفحة</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="الموردين" subtitle="إدارة موردين الخامات">
        {canCreate && <Button onClick={() => setForm({ ...EMPTY })}>+ إضافة مورد</Button>}
      </PageHeader>

      <div className="mb-4">
        <Input placeholder="ابحث باسم أو رقم المورد…" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {suppliers === null ? (
        <LoadingState />
      ) : suppliers.length === 0 ? (
        <EmptyState message="لا يوجد موردين حتى الآن" icon="🚚" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {suppliers.map((s) => (
            <Panel key={s.id} bodyClassName="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <span className="font-heading text-base font-bold text-foreground">{s.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.isActive ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-foreground/8 text-muted-foreground"}`}>
                  {s.isActive ? "نشط" : "موقوف"}
                </span>
              </div>
              <div className="space-y-0.5 text-sm text-muted-foreground">
                {s.phone && <p dir="ltr" className="text-end">{s.phone}</p>}
                {s.email && <p dir="ltr" className="text-end">{s.email}</p>}
                {s.address && <p>{s.address}</p>}
                <p className="text-xs">{s._count.invoices} فاتورة شراء</p>
              </div>
              <div className="flex gap-1.5 pt-1">
                {canEdit && (
                  <Button size="sm" variant="outline" onClick={() => setForm({
                    id: s.id, name: s.name, phone: s.phone ?? "", email: s.email ?? "",
                    address: s.address ?? "", notes: s.notes ?? "",
                  })}>تعديل</Button>
                )}
                {canToggle && (
                  <Button size="sm" variant="ghost" onClick={() => toggle(s)}>
                    {s.isActive ? "إيقاف" : "تفعيل"}
                  </Button>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <Dialog open={form !== null} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent className="max-w-md">
          {form && (
            <>
              <DialogHeader>
                <DialogTitle>{form.id ? "تعديل مورد" : "إضافة مورد"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>اسم المورد</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>رقم الموبايل</Label>
                    <Input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>البريد الإلكتروني</Label>
                    <Input dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>العنوان</Label>
                  <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>ملاحظات</Label>
                  <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setForm(null)} disabled={busy}>إلغاء</Button>
                <Button onClick={save} disabled={busy}>حفظ</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
