"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "FULL" | "SELECTED";
type Schedule = "MANUAL_ONLY" | "DAILY_LAST_HANDOVER" | "WEEKLY";
type ConfigError = "CYCLE_POLICY_UNSUPPORTED" | "SELECTED_WITH_NO_ITEMS" | "WEEKLY_WITHOUT_WEEKDAY";
type HandoverConfig = { enabled: boolean; mode: Mode; selectedItemIds: string[]; periodic: { schedule: Schedule; weekday: number | null }; source: Record<"enabled" | "mode" | "schedule" | "weekday", "CAFE" | "BRANCH">; configError: { code: ConfigError; message: string } | null };
type InventoryItem = { id: string; name: string; isActive: boolean; archivedAt: string | null; branchId: string };
type Draft = Pick<HandoverConfig, "enabled" | "mode" | "selectedItemIds"> & { schedule: Schedule; weekday: number | null; modeExplicit: boolean };

const weekdays = [t.handoverConfig.weekdays.sunday, t.handoverConfig.weekdays.monday, t.handoverConfig.weekdays.tuesday, t.handoverConfig.weekdays.wednesday, t.handoverConfig.weekdays.thursday, t.handoverConfig.weekdays.friday, t.handoverConfig.weekdays.saturday];
const errorLabel: Record<ConfigError, string> = { CYCLE_POLICY_UNSUPPORTED: t.handoverConfig.errors.CYCLE_POLICY_UNSUPPORTED, SELECTED_WITH_NO_ITEMS: t.handoverConfig.errors.SELECTED_WITH_NO_ITEMS, WEEKLY_WITHOUT_WEEKDAY: t.handoverConfig.errors.WEEKLY_WITHOUT_WEEKDAY };
const draftFrom = (config: HandoverConfig): Draft => ({ enabled: config.enabled, mode: config.mode, selectedItemIds: config.selectedItemIds, schedule: config.periodic.schedule, weekday: config.periodic.weekday, modeExplicit: false });

export function HandoverConfigPanel({ branchId }: { branchId: string }) {
  const [confirmed, setConfirmed] = useState<HandoverConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!branchId) return;
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setConfirmed(null); setDraft(null); setItems([]); setQuery(""); setLoadError(null); setSaveError(null); setLoading(true);
    Promise.all([api<{ config: HandoverConfig }>(`/api/branches/${branchId}/handover-config`), api<{ items: InventoryItem[] }>(`/api/inventory?branchId=${branchId}`)])
      .then(([configResult, inventoryResult]) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setConfirmed(configResult.config); setDraft(draftFrom(configResult.config));
        setItems(inventoryResult.items.filter((item) => item.isActive && !item.archivedAt && item.branchId === branchId));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) setLoadError(error instanceof Error ? error.message : t.handoverConfig.loadFailure);
      }).finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [branchId]);

  const visibleItems = useMemo(() => items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const cycleNeedsExplicitMode = confirmed?.configError?.code === "CYCLE_POLICY_UNSUPPORTED" && !draft?.modeExplicit;
  const selectedEmpty = !!draft && draft.enabled && draft.mode === "SELECTED" && draft.selectedItemIds.length === 0;
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const toggleItem = (id: string) => setDraft((current) => !current ? current : { ...current, selectedItemIds: current.selectedItemIds.includes(id) ? current.selectedItemIds.filter((selected) => selected !== id) : [...current.selectedItemIds, id] });

  async function save() {
    if (!draft || selectedEmpty || (draft.enabled && cycleNeedsExplicitMode)) return;
    setSaving(true); setSaveError(null);
    try {
      const result = await api<{ config: HandoverConfig }>(`/api/branches/${branchId}/handover-config`, { method: "PATCH", body: { enabled: draft.enabled, mode: draft.mode, selectedItemIds: draft.selectedItemIds, schedule: draft.schedule, weekday: draft.schedule === "WEEKLY" ? draft.weekday : null } });
      setConfirmed(result.config); setDraft(draftFrom(result.config)); toast.success(t.handoverConfig.saveSuccess);
    } catch (error) { const text = error instanceof Error ? error.message : t.handoverConfig.saveFailure; setSaveError(text); toast.error(text); } finally { setSaving(false); }
  }

  if (!branchId) return null;
  if (loading) return <p className="text-sm text-muted-foreground">{t.handoverConfig.loading}</p>;
  if (loadError) return <p role="alert" className="text-sm text-destructive">{t.handoverConfig.loadFailure}: {loadError}</p>;
  if (!confirmed || !draft) return null;
  const inherited = (field: keyof HandoverConfig["source"]) => confirmed.source[field] === "CAFE" ? <span className="text-xs text-muted-foreground">{t.handoverConfig.usingCafeDefault}</span> : null;
  return <Card><CardHeader><CardTitle className="text-base">{t.handoverConfig.title}</CardTitle></CardHeader><CardContent className="space-y-4">
    {confirmed.configError && <p role="alert" className="rounded-lg border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">{errorLabel[confirmed.configError.code]}</p>}
    {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
    <label className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{t.handoverConfig.enabled} {inherited("enabled")}</span><input type="checkbox" checked={draft.enabled} disabled={saving || (draft.enabled && cycleNeedsExplicitMode)} onChange={(event) => change("enabled", event.target.checked)} /></label>
    {cycleNeedsExplicitMode && <p className="text-xs text-muted-foreground">{t.handoverConfig.chooseModeFirst}</p>}
    <div className="space-y-2"><Label>{t.handoverConfig.mode} {inherited("mode")}</Label><div className="flex gap-2">{(["FULL", "SELECTED"] as const).map((mode) => <Button key={mode} type="button" variant={draft.mode === mode ? "default" : "outline"} disabled={saving} onClick={() => setDraft({ ...draft, mode, modeExplicit: true })}>{t.handoverConfig.modeValues[mode]}</Button>)}</div></div>
    {draft.mode === "SELECTED" && <div className="space-y-2"><Label htmlFor="handover-ingredient-search">{t.handoverConfig.ingredients}</Label><Input id="handover-ingredient-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.handoverConfig.ingredientSearch} /><div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">{visibleItems.length ? visibleItems.map((item) => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.selectedItemIds.includes(item.id)} onChange={() => toggleItem(item.id)} disabled={saving} />{item.name}</label>) : <p className="text-sm text-muted-foreground">{t.handoverConfig.noIngredients}</p>}</div>{selectedEmpty && <p role="alert" className="text-sm text-destructive">{t.handoverConfig.selectedEmpty}</p>}</div>}
    <div className="space-y-2"><Label>{t.handoverConfig.schedule} {inherited("schedule")}</Label><select value={draft.schedule} disabled={saving} onChange={(event) => { const schedule = event.target.value as Schedule; setDraft({ ...draft, schedule, weekday: schedule === "WEEKLY" ? draft.weekday : null }); }} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">{(["MANUAL_ONLY", "DAILY_LAST_HANDOVER", "WEEKLY"] as const).map((schedule) => <option key={schedule} value={schedule}>{t.handoverConfig.scheduleValues[schedule]}</option>)}</select></div>
    {draft.schedule === "WEEKLY" && <div className="space-y-2"><Label>{t.handoverConfig.weekday} {inherited("weekday")}</Label><select value={draft.weekday ?? ""} disabled={saving} onChange={(event) => change("weekday", event.target.value === "" ? null : Number(event.target.value))} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="">{t.common.none}</option>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div>}
    <Button onClick={save} disabled={saving || selectedEmpty || (draft.enabled && cycleNeedsExplicitMode)}>{saving ? t.handoverConfig.saving : t.handoverConfig.save}</Button>
  </CardContent></Card>;
}
