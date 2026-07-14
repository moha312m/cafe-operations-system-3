"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { TableQrLinks, publicMenuUrl } from "@/components/table-qr-links";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Branch = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  menuSlug: string | null;
  publicMenuEnabled: boolean;
};

export default function BranchesPage() {
  const { cafe } = useApp();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  // إعدادات منيو العميل dialog
  const [settingsFor, setSettingsFor] = useState<Branch | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);

  // روابط QR للترابيزات dialog
  const [qrFor, setQrFor] = useState<Branch | null>(null);

  const load = useCallback(async () => {
    try {
      const { branches } = await api<{ branches: Branch[] }>("/api/branches");
      setBranches(branches);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الفروع");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/branches", {
        method: "POST",
        body: { name, address: address || undefined, phone: phone || undefined },
      });
      toast.success("اتضاف الفرع");
      setName("");
      setAddress("");
      setPhone("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل إضافة الفرع");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(branch: Branch) {
    setBusy(true);
    try {
      await api(`/api/branches/${branch.id}`, {
        method: "PATCH",
        body: { isActive: !branch.isActive },
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل تحديث الفرع");
    } finally {
      setBusy(false);
    }
  }

  async function saveMenuSettings() {
    if (!settingsFor) return;
    setBusy(true);
    try {
      await api(`/api/branches/${settingsFor.id}`, {
        method: "PATCH",
        body: {
          publicMenuEnabled: enabledDraft,
          menuSlug: slugDraft.trim() || null,
        },
      });
      toast.success("اتحفظت إعدادات المنيو");
      setSettingsFor(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل حفظ الإعدادات");
    } finally {
      setBusy(false);
    }
  }

  const cafeSlug = cafe?.slug ?? "";

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">الفروع</h1>

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <Input
          placeholder="اسم الفرع"
          className="w-48"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          placeholder="العنوان"
          className="w-64"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Input
          placeholder="التليفون"
          className="w-40"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Button type="submit" disabled={busy}>
          ضيف فرع
        </Button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الاسم</TableHead>
            <TableHead>العنوان</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead>منيو QR</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-medium">{b.name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {b.address ?? "—"}
              </TableCell>
              <TableCell>
                <Badge variant={b.isActive ? "secondary" : "outline"}>
                  {b.isActive ? "شغّال" : "مقفول"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={b.publicMenuEnabled ? "secondary" : "destructive"}>
                  {b.publicMenuEnabled ? "مفعّل" : "متوقف"}
                </Badge>
                {b.menuSlug && (
                  <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                    /menu/{cafeSlug}/{b.menuSlug}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-end [&>button]:ms-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    window.open(publicMenuUrl(cafeSlug, b), "_blank")
                  }
                >
                  فتح المنيو
                </Button>
                <Button size="sm" variant="outline" onClick={() => setQrFor(b)}>
                  روابط QR للترابيزات
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSlugDraft(b.menuSlug ?? "");
                    setEnabledDraft(b.publicMenuEnabled);
                    setSettingsFor(b);
                  }}
                >
                  إعدادات منيو العميل
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => toggle(b)}
                >
                  {b.isActive ? "قفل الفرع" : "افتح تاني"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* ── إعدادات منيو العميل ─────────────────────────────────── */}
      <Dialog open={settingsFor !== null} onOpenChange={(o) => !o && setSettingsFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>إعدادات منيو العميل — {settingsFor?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={enabledDraft}
                onChange={(e) => setEnabledDraft(e.target.checked)}
              />
              تفعيل منيو QR
            </label>
            {!enabledDraft && (
              <p className="text-xs text-muted-foreground">
                لما يكون متوقف، العملاء هيشوفوا &quot;المنيو غير متاح حاليًا&quot;.
              </p>
            )}
            <div className="space-y-2">
              <Label>اسم الرابط (بالإنجليزي)</Label>
              <Input
                dir="ltr"
                placeholder="tagamoa"
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value.toLowerCase())}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">رابط المنيو</Label>
              <p className="break-all rounded-md bg-muted px-2 py-1.5 text-xs" dir="ltr">
                {settingsFor &&
                  publicMenuUrl(cafeSlug, {
                    id: settingsFor.id,
                    menuSlug: slugDraft.trim() || null,
                  })}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={saveMenuSettings} disabled={busy}>
              {busy ? "جاري الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── روابط QR للترابيزات ─────────────────────────────────── */}
      <Dialog open={qrFor !== null} onOpenChange={(o) => !o && setQrFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>روابط QR للترابيزات — {qrFor?.name}</DialogTitle>
          </DialogHeader>
          {/* key resets the QR preview state when switching branches */}
          {qrFor && <TableQrLinks key={qrFor.id} cafeSlug={cafeSlug} branch={qrFor} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
