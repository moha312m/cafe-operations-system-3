"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/admin/ui";
import {
  FEATURE_FLAGS,
  FEATURE_LABELS,
  WORKFLOW_SWITCHES,
  SWITCH_LABELS,
  WORKFLOW_MODE_LABELS,
  QR_ROUTING_LABELS,
  type CafeFeatures,
} from "@/lib/cafe-settings";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
      <span className="text-sm text-slate-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-slate-300"}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-0.5" : "start-[22px]"}`}
        />
      </button>
    </label>
  );
}

export function CafeSettingsTab({
  cafeId,
  initial,
  onSaved,
}: {
  cafeId: string;
  initial: CafeFeatures;
  onSaved: () => void;
}) {
  const [s, setS] = useState<CafeFeatures>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CafeFeatures>(k: K, v: CafeFeatures[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      const { settings } = await api<{ settings: CafeFeatures }>(
        `/api/admin/cafes/${cafeId}/settings`,
        { method: "PATCH", body: s }
      );
      setS(settings);
      toast.success("تم حفظ الإعدادات");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      const { settings } = await api<{ settings: CafeFeatures }>(
        `/api/admin/cafes/${cafeId}/settings`,
        { method: "DELETE" }
      );
      setS(settings);
      toast.success("تم استرجاع الإعدادات الافتراضية");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الاسترجاع");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* A) Feature toggles */}
        <Panel title="مميزات الكافيه" className="lg:col-span-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {FEATURE_FLAGS.map((f) => (
              <Toggle key={f} label={FEATURE_LABELS[f]} checked={s[f]} onChange={(v) => set(f, v)} />
            ))}
          </div>
        </Panel>

        {/* B) Workflow mode */}
        <Panel title="طريقة التشغيل">
          <select
            value={s.workflowMode}
            onChange={(e) => set("workflowMode", e.target.value as CafeFeatures["workflowMode"])}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
          >
            {Object.entries(WORKFLOW_MODE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </Panel>

        {/* C) QR routing */}
        <Panel title="مسار طلبات QR">
          <select
            value={s.qrOrderRoutingMode}
            onChange={(e) => set("qrOrderRoutingMode", e.target.value as CafeFeatures["qrOrderRoutingMode"])}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
          >
            {Object.entries(QR_ROUTING_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </Panel>

        {/* D) Extra switches */}
        <Panel title="إعدادات إضافية" className="lg:col-span-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {WORKFLOW_SWITCHES.map((w) => (
              <Toggle key={w} label={SWITCH_LABELS[w]} checked={s[w]} onChange={(v) => set(w, v)} />
            ))}
          </div>
        </Panel>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy}>حفظ الإعدادات</Button>
        <Button variant="outline" onClick={reset} disabled={busy}>استرجاع الإعدادات الافتراضية</Button>
      </div>
    </div>
  );
}
