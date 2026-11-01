"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Mode = "OWNER_REQUEST" | "OWNER_PASSCODE" | "EITHER";
type Settings = { owner: { id: string; name: string }; refundMode: Mode; cancelMode: Mode; itemVoidMode: Mode; passcodeConfigured: boolean };
const modes: { value: Mode; label: string }[] = [
  { value: "OWNER_REQUEST", label: "موافقة من شاشة المالك" },
  { value: "OWNER_PASSCODE", label: "باسكود المالك" },
  { value: "EITHER", label: "موافقة أو باسكود" },
];

export function OwnerActionSettingsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [password, setPassword] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setSettings(await api<Settings>("/api/cafe/owner-action-settings")); }
    catch { setSettings(null); }
  }
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, []);
  if (!settings) return null;

  async function saveModes() {
    const current = settings;
    if (!current) return;
    if (!password) return toast.error("اكتب كلمة مرور حساب المالك للتأكيد");
    setBusy(true);
    try {
      const updated = await api<Settings>("/api/cafe/owner-action-settings", {
        method: "PATCH", body: { refundMode: current.refundMode, cancelMode: current.cancelMode, itemVoidMode: current.itemVoidMode, currentPassword: password },
      });
      setSettings(updated); setPassword(""); toast.success("تم حفظ إعدادات الموافقات");
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ الإعدادات"); }
    finally { setBusy(false); }
  }

  async function savePasscode() {
    const current = settings;
    if (!current) return;
    if (!password || !/^\d{6,12}$/.test(passcode)) return toast.error("الباسكود من ٦ إلى ١٢ رقمًا، مع كلمة مرور المالك");
    setBusy(true);
    try {
      await api("/api/cafe/owner-action-settings", { method: "POST", body: { currentPassword: password, passcode } });
      setSettings({ ...current, passcodeConfigured: true }); setPasscode(""); setPassword("");
      toast.success("تم ضبط باسكود المالك");
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر ضبط الباسكود"); }
    finally { setBusy(false); }
  }

  const field = (key: "refundMode" | "cancelMode" | "itemVoidMode", label: string) => (
    <div className="space-y-1.5" key={key}>
      <Label>{label}</Label>
      <select value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value as Mode })} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
        {modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select>
    </div>
  );

  return <Card>
    <CardHeader><CardTitle className="text-base">موافقات المالك على إلغاء الأصناف والطلبات والاسترداد</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">المالك المحدد: {settings.owner.name}. لا ينفذ الإلغاء أو الاسترداد قبل الاعتماد.</p>
      {field("cancelMode", "إلغاء الطلب أو حذف صنف")}
      {field("itemVoidMode", "حذف صنف محفوظ من الطلب")}
      {field("refundMode", "استرداد المبلغ")}
      <div className="space-y-1.5"><Label>كلمة مرور المالك لتأكيد التغيير</Label><Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
      <Button disabled={busy || !password} onClick={saveModes}>حفظ طرق الموافقة</Button>
      <div className="space-y-2 rounded-lg border p-3">
        <p className="text-sm font-medium">باسكود المالك: {settings.passcodeConfigured ? "مضبوط" : "غير مضبوط"}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input inputMode="numeric" autoComplete="off" type="password" maxLength={12} placeholder="باسكود من ٦–١٢ رقمًا" value={passcode} onChange={(event) => setPasscode(event.target.value)} />
          <Button variant="outline" disabled={busy || !password || !/^\d{6,12}$/.test(passcode)} onClick={savePasscode}>{settings.passcodeConfigured ? "تغيير الباسكود" : "ضبط الباسكود"}</Button>
        </div>
        <p className="text-xs text-muted-foreground">تغيير الباسكود يلغي الموافقات السابقة التي تمت بباسكود.</p>
      </div>
    </CardContent>
  </Card>;
}
