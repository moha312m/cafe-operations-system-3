"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Branch = { id: string; name: string };
type FinSettings = {
  taxEnabled: boolean;
  taxRate: number | string;
  applyTaxTo: "ALL_ORDERS" | "DINE_IN_ONLY" | "TAKEAWAY_ONLY" | "DELIVERY_ONLY";
  serviceChargeEnabled: boolean;
  serviceChargeType: "PERCENTAGE" | "FIXED";
  serviceChargeRate: number | string;
  serviceChargeFixedAmount: number | string;
  applyServiceTo: "ALL_ORDERS" | "DINE_IN_ONLY" | "TAKEAWAY_ONLY" | "DELIVERY_ONLY";
};

const SCOPES = ["ALL_ORDERS", "DINE_IN_ONLY", "TAKEAWAY_ONLY", "DELIVERY_ONLY"] as const;

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      <button
        type="button" role="switch" aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-0.5" : "start-[22px]"}`} />
      </button>
    </label>
  );
}

export default function SettingsPage() {
  const { user } = useApp();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [s, setS] = useState<FinSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ branches: Branch[] }>("/api/branches")
      .then((r) => {
        setBranches(r.branches);
        if (!user.branchId && r.branches[0]) setBranchId((b) => b || r.branches[0].id);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "فشل التحميل"));
  }, [user.branchId]);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const { settings } = await api<{ settings: FinSettings }>(`/api/branches/${branchId}/financial-settings`);
      setS(settings);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الإعدادات");
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof FinSettings>(k: K, v: FinSettings[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      await api(`/api/branches/${branchId}/financial-settings`, {
        method: "PATCH",
        body: {
          taxEnabled: s.taxEnabled,
          taxRate: Number(s.taxRate) || 0,
          applyTaxTo: s.applyTaxTo,
          serviceChargeEnabled: s.serviceChargeEnabled,
          serviceChargeType: s.serviceChargeType,
          serviceChargeRate: Number(s.serviceChargeRate) || 0,
          serviceChargeFixedAmount: Number(s.serviceChargeFixedAmount) || 0,
          applyServiceTo: s.applyServiceTo,
        },
      });
      toast.success(t.finance.saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t.finance.settingsTitle}</h1>
        {/* Owner picks a branch; managers are pinned to theirs. */}
        {!user.branchId && branches.length > 1 && (
          <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
            <SelectTrigger className="w-48">
              <SelectValue>{branches.find((b) => b.id === branchId)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {!s ? (
        <p className="text-sm text-muted-foreground">{t.common.loading}</p>
      ) : (
        <>
          {/* Tax */}
          <Card>
            <CardHeader><CardTitle className="text-base">{t.finance.tax}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Toggle label={t.finance.taxEnabled} checked={s.taxEnabled} onChange={(v) => set("taxEnabled", v)} />
              {s.taxEnabled && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t.finance.taxRate} (٪)</Label>
                    <Input type="number" min="0" max="100" step="0.01" dir="ltr" value={String(s.taxRate)} onChange={(e) => set("taxRate", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t.finance.applyTaxTo}</Label>
                    <select value={s.applyTaxTo} onChange={(e) => set("applyTaxTo", e.target.value as FinSettings["applyTaxTo"])} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                      {SCOPES.map((sc) => <option key={sc} value={sc}>{t.finance.scope[sc]}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Service */}
          <Card>
            <CardHeader><CardTitle className="text-base">{t.finance.service}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Toggle label={t.finance.serviceEnabled} checked={s.serviceChargeEnabled} onChange={(v) => set("serviceChargeEnabled", v)} />
              {s.serviceChargeEnabled && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{t.finance.serviceType}</Label>
                    <select value={s.serviceChargeType} onChange={(e) => set("serviceChargeType", e.target.value as FinSettings["serviceChargeType"])} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                      <option value="PERCENTAGE">{t.finance.percentage}</option>
                      <option value="FIXED">{t.finance.fixed}</option>
                    </select>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {s.serviceChargeType === "PERCENTAGE" ? (
                      <div className="space-y-1.5">
                        <Label>{t.finance.serviceRate} (٪)</Label>
                        <Input type="number" min="0" max="100" step="0.01" dir="ltr" value={String(s.serviceChargeRate)} onChange={(e) => set("serviceChargeRate", e.target.value)} />
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label>{t.finance.serviceFixed} (ج.م)</Label>
                        <Input type="number" min="0" step="0.01" dir="ltr" value={String(s.serviceChargeFixedAmount)} onChange={(e) => set("serviceChargeFixedAmount", e.target.value)} />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label>{t.finance.applyServiceTo}</Label>
                      <select value={s.applyServiceTo} onChange={(e) => set("applyServiceTo", e.target.value as FinSettings["applyServiceTo"])} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
                        {SCOPES.map((sc) => <option key={sc} value={sc}>{t.finance.scope[sc]}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Button onClick={save} disabled={busy}>{t.finance.save}</Button>
        </>
      )}
    </div>
  );
}
