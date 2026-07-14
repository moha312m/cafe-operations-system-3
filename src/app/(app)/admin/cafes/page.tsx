"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Cafe = {
  id: string;
  name: string;
  slug: string;
  currency: string;
  isActive: boolean;
  createdAt: string;
  _count: { branches: number; users: number; orders: number };
};

const emptyForm = {
  name: "",
  slug: "",
  currency: "USD",
  taxRate: "0",
  ownerName: "",
  ownerEmail: "",
  ownerPassword: "",
  mainBranchName: "الفرع الرئيسي",
};

export default function CafesAdminPage() {
  const [cafes, setCafes] = useState<Cafe[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const { cafes } = await api<{ cafes: Cafe[] }>("/api/cafes");
      setCafes(cafes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الكافيهات");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      await api("/api/cafes", {
        method: "POST",
        body: { ...form, taxRate: Number(form.taxRate) },
      });
      toast.success("اتضاف الكافيه مع حساب المالك والفرع الرئيسي");
      setOpen(false);
      setForm(emptyForm);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل إضافة الكافيه");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(cafe: Cafe) {
    setBusy(true);
    try {
      await api(`/api/cafes/${cafe.id}`, {
        method: "PATCH",
        body: { isActive: !cafe.isActive },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحديث الكافيه");
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">الكافيهات</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>ضيف كافيه جديد</DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>إضافة كافيه جديد</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>اسم الكافيه</Label>
                  <Input value={form.name} onChange={set("name")} />
                </div>
                <div className="space-y-2">
                  <Label>المعرّف (بالإنجليزي)</Label>
                  <Input placeholder="my-cafe" value={form.slug} onChange={set("slug")} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>العملة (ISO)</Label>
                  <Input value={form.currency} onChange={set("currency")} />
                </div>
                <div className="space-y-2">
                  <Label>نسبة الضريبة ٪</Label>
                  <Input type="number" min="0" step="0.01" value={form.taxRate} onChange={set("taxRate")} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>اسم الفرع الرئيسي</Label>
                <Input value={form.mainBranchName} onChange={set("mainBranchName")} />
              </div>
              <div className="space-y-2">
                <Label>اسم المالك</Label>
                <Input value={form.ownerName} onChange={set("ownerName")} />
              </div>
              <div className="space-y-2">
                <Label>إيميل المالك</Label>
                <Input type="email" value={form.ownerEmail} onChange={set("ownerEmail")} />
              </div>
              <div className="space-y-2">
                <Label>باسورد المالك (٨ حروف على الأقل)</Label>
                <Input type="password" value={form.ownerPassword} onChange={set("ownerPassword")} />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={create}
                disabled={
                  busy ||
                  !form.name ||
                  !form.slug ||
                  !form.ownerName ||
                  !form.ownerEmail ||
                  form.ownerPassword.length < 8
                }
              >
                {busy ? "جاري الإضافة…" : "إضافة الكافيه"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الاسم</TableHead>
            <TableHead>المعرّف</TableHead>
            <TableHead className="text-end">الفروع</TableHead>
            <TableHead className="text-end">المستخدمين</TableHead>
            <TableHead className="text-end">الطلبات</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {cafes.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell className="text-muted-foreground">{c.slug}</TableCell>
              <TableCell className="text-end tabular-nums">{c._count.branches}</TableCell>
              <TableCell className="text-end tabular-nums">{c._count.users}</TableCell>
              <TableCell className="text-end tabular-nums">{c._count.orders}</TableCell>
              <TableCell>
                <Badge variant={c.isActive ? "secondary" : "destructive"}>
                  {c.isActive ? "شغّال" : "موقوف"}
                </Badge>
              </TableCell>
              <TableCell className="text-end">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => toggleActive(c)}>
                  {c.isActive ? "إيقاف" : "تفعيل"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
