"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Checkpoint = { id: string; label: string; required: boolean; critical: boolean };
type Asset = { id: string; name: string; area: string | null; isActive: boolean; checkpoints: Checkpoint[]; photos: Array<{ id: string }> };
type Settings = { placeAcceptanceRequired: boolean; placeInspectorId: string | null };
type Employee = { id: string; name: string; effectiveBranchId?: string; branchId: string | null };

export function PlaceChecklistCard({ branchId }: { branchId: string }) {
  const { user, canKey } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [checkpoints, setCheckpoints] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!branchId) return;
    setError("");
    try {
      const [assetResult, settingResult, employeeResult] = await Promise.all([
        api<{ assets: Asset[] }>("/api/place-assets?branchId=" + encodeURIComponent(branchId)),
        api<{ settings: Settings }>("/api/branches/" + branchId + "/opening-settings"),
        api<{ users: Employee[] }>("/api/users?branchId=" + encodeURIComponent(branchId) + "&status=ACTIVE"),
      ]);
      setAssets(assetResult.assets);
      setSettings(settingResult.settings);
      setEmployees(employeeResult.users.filter((item) => item.id !== user.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تحميل قائمة فحص المكان");
    }
  }, [branchId, user.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  if (user.role !== "CAFE_OWNER" || !canKey("settings.edit")) return null;

  async function saveSettings() {
    if (!settings || !branchId) return;
    setBusy(true);
    try {
      const result = await api<{ settings: Settings }>("/api/branches/" + branchId + "/opening-settings", {
        method: "PATCH",
        body: { placeAcceptanceRequired: settings.placeAcceptanceRequired, placeInspectorId: settings.placeInspectorId },
      });
      setSettings(result.settings);
      toast.success("تم حفظ إعدادات استلام المكان");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر حفظ إعدادات المكان");
    } finally { setBusy(false); }
  }

  async function addAsset() {
    const labels = checkpoints.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!branchId || !name.trim() || labels.length === 0) return;
    setBusy(true);
    try {
      await api("/api/place-assets", { method: "POST", body: {
        branchId, name: name.trim(), area: area.trim(),
        checkpoints: labels.map((label) => ({ label, required: true, critical: false })),
      } });
      setName(""); setArea(""); setCheckpoints(""); await load();
      toast.success("تمت إضافة بند الفحص");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذرت إضافة بند الفحص");
    } finally { setBusy(false); }
  }

  async function uploadReference(assetId: string, file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData(); form.set("file", file); form.set("assetId", assetId);
      const response = await fetch("/api/place-photos", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "تعذر رفع الصورة");
      await load(); toast.success("تم حفظ الصورة بصورة خاصة");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر رفع الصورة"); }
    finally { setBusy(false); }
  }

  async function retireAsset(asset: Asset) {
    setBusy(true);
    try {
      await api("/api/place-assets/" + asset.id, { method: "PATCH", body: { isActive: !asset.isActive } });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحديث البند"); }
    finally { setBusy(false); }
  }

  return <Card data-testid="place-checklist-card">
    <CardHeader><CardTitle className="text-base">فحص المكان والأجهزة عند استلام الشيفت</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">أضف الأجهزة ونقاط فحصها. كل صورة مرجعية محفوظة بصورة خاصة، وسجل كل شيفت يحتفظ بنسخة من القائمة وقت فتحه.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {settings && <div className="space-y-3 rounded-lg border p-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.placeAcceptanceRequired} disabled={busy} onChange={(e) => setSettings({ ...settings, placeAcceptanceRequired: e.target.checked })} />إلزام فحص المكان قبل تشغيل الشيفت</label>
        <div className="space-y-1"><Label htmlFor="place-inspector">الموظف المسؤول بالاسم</Label>
          <select id="place-inspector" aria-label="الموظف المسؤول عن فحص المكان" className="h-9 w-full rounded-lg border bg-background px-3 text-sm" value={settings.placeInspectorId ?? ""} disabled={busy} onChange={(e) => setSettings({ ...settings, placeInspectorId: e.target.value || null })}>
            <option value="">اختر الموظف المسؤول</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </div>
        <Button size="sm" disabled={busy} onClick={saveSettings}>حفظ إعدادات الفحص</Button>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="place-asset-name">اسم الجهاز أو المنطقة</Label><Input id="place-asset-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="ماكينة الإسبريسو" /></div>
        <div className="space-y-1"><Label htmlFor="place-asset-area">المكان داخل الفرع</Label><Input id="place-asset-area" value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} placeholder="البار" /></div>
        <div className="space-y-1 sm:col-span-2"><Label htmlFor="place-checkpoints">نقاط الفحص، كل نقطة في سطر</Label><textarea id="place-checkpoints" className="min-h-24 w-full rounded-lg border bg-background p-3 text-sm" value={checkpoints} onChange={(e) => setCheckpoints(e.target.value)} placeholder={"ضغط الاستخلاص\nحالة المطحنة\nنظافة محطة العمل"} /></div>
        <Button className="sm:col-span-2" disabled={busy || !name.trim() || !checkpoints.trim()} onClick={addAsset}>إضافة الجهاز ونقاط فحصه</Button>
      </div>
      <div className="space-y-3">
        {assets.map((asset) => <article key={asset.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>{asset.name}</strong><span className="text-xs text-muted-foreground">{asset.area || "من غير تحديد مكان"}</span></div>
          <ul className="list-inside list-disc text-sm">{asset.checkpoints.map((item) => <li key={item.id}>{item.label}{item.required ? " · مطلوب" : " · اختياري"}</li>)}</ul>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm underline">رفع صورة مرجعية<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !asset.isActive} onChange={(e) => void uploadReference(asset.id, e.target.files?.[0])} /></label>
            <span className="text-xs text-muted-foreground">{asset.photos.length} صورة</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void retireAsset(asset)}>{asset.isActive ? "إيقاف البند" : "إعادة تفعيله"}</Button>
          </div>
          <div className="flex flex-wrap gap-2">{asset.photos.map((photo) => <Image key={photo.id} src={"/api/place-photos/" + photo.id} alt={"صورة مرجعية " + asset.name} width={80} height={80} unoptimized className="size-20 rounded border object-cover" />)}</div>
        </article>)}
        {!assets.length && <p className="text-sm text-muted-foreground">لم تتم إضافة أجهزة أو نقاط فحص لهذا الفرع.</p>}
      </div>
    </CardContent>
  </Card>;
}
