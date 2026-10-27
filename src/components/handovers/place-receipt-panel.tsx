"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type SnapshotItem = { id: string; name: string; area: string | null; checkpoints: Array<{ id: string; label: string; required: boolean; critical: boolean }> };
type ReceiptRow = { id: string; status: string; assignedUser: { id: string; name: string }; incomingShift: { shiftNumber: number; openedAt: string }; snapshot: SnapshotItem[] };
type Detail = ReceiptRow & { observations: Array<{ id: string; assetId: string; checkpointId: string; side: string; condition: string; note: string | null; incident: { id: string; status: string } | null; photos: Array<{ id: string }> }>; incidents: Array<{ id: string; status: string; assetId: string }> };
const conditions = [{ value: "OK", label: "سليم" }, { value: "NOTE", label: "ملاحظة" }, { value: "FAULT", label: "عطل" }, { value: "NOT_CHECKED", label: "لم يتم الفحص" }];

export function PlaceReceiptPanel({ branchId }: { branchId: string }) {
  const { user, canKey } = useApp();
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [override, setOverride] = useState("");
  const [repair, setRepair] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!branchId || !canKey("handover.view")) return;
    setError("");
    try {
      const result = await api<{ receipts: ReceiptRow[] }>("/api/place-receipts?branchId=" + encodeURIComponent(branchId));
      setRows(result.receipts);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحميل استلام المكان"); }
  }, [branchId, canKey]);

  async function openReceipt(id: string) {
    const result = await api<{ receipt: Detail }>("/api/place-receipts/" + id);
    setDetail(result.receipt);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  if (!canKey("handover.view")) return null;

  async function observe(item: SnapshotItem, checkpointId: string) {
    if (!detail) return;
    const key = item.id + ":" + checkpointId;
    setBusy(true);
    try {
      const result = await api<{ observationId: string; incidentId: string | null }>("/api/place-receipts/" + detail.id, { method: "PATCH", body: {
        action: "OBSERVE", assetId: item.id, checkpointId, side: "INCOMING", condition: selection[key] ?? "OK", note: notes[key] ?? "",
      } });
      if (selection[key] === "FAULT") {
        const file = (document.getElementById("place-evidence-" + key) as HTMLInputElement | null)?.files?.[0];
        if (file) { const form = new FormData(); form.set("file", file); form.set("observationId", result.observationId); const response = await fetch("/api/place-photos", { method: "POST", body: form }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error ?? "تعذر رفع صورة العطل"); }
      }
      await openReceipt(detail.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تسجيل حالة الجهاز"); }
    finally { setBusy(false); }
  }

  async function accept() {
    if (!detail) return;
    setBusy(true);
    try {
      const body: { action: "ACCEPT"; idempotencyKey: string; overrideReason?: string } = { action: "ACCEPT", idempotencyKey: crypto.randomUUID() };
      if (override.trim()) body.overrideReason = override.trim();
      await api("/api/place-receipts/" + detail.id, { method: "PATCH", body });
      setOverride(""); await load(); await openReceipt(detail.id); toast.success("تم تسجيل استلام المكان");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر اعتماد الاستلام"); }
    finally { setBusy(false); }
  }

  async function resolveIncident(incidentId: string) {
    setBusy(true);
    try { await api("/api/place-incidents/" + incidentId + "/resolve", { method: "POST", body: { repairNote: repair[incidentId] ?? "" } }); if (detail) await openReceipt(detail.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تسجيل إصلاح العطل"); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-xl border p-4" data-testid="place-receipt-panel">
    <header className="flex items-center justify-between gap-2"><h2 className="font-semibold">استلام المكان والأجهزة</h2><Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>تحديث</Button></header>
    <p className="text-xs text-muted-foreground">الموظف المعيّن يسجل حالة كل جهاز. قبول الكاش أو الخامات منفصل عن اعتماد المكان.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!rows.length && <p className="text-sm text-muted-foreground">لا توجد استلامات مكان في هذا الفرع.</p>}
    {rows.length > 0 && <div className="space-y-2">{rows.map((row) => <button key={row.id} type="button" className="w-full rounded border p-2 text-start text-sm hover:bg-muted" onClick={() => { void openReceipt(row.id); }}>
      شيفت #{row.incomingShift.shiftNumber} · {row.assignedUser.name} · {row.status === "PENDING" ? "ينتظر الفحص" : row.status === "ACCEPTED" ? "تم الاستلام" : "اعتماد استثنائي"}
    </button>)}</div>}
    {detail && <div className="space-y-4 border-t pt-3">
      <p className="text-sm">مسؤول الفحص: <strong>{detail.assignedUser.name}</strong> · الحالة: {detail.status}</p>
      {detail.snapshot.map((asset) => <article key={asset.id} className="space-y-2 rounded-lg border p-3">
        <h3 className="font-medium">{asset.name}{asset.area ? " · " + asset.area : ""}</h3>
        {asset.checkpoints.map((checkpoint) => {
          const key = asset.id + ":" + checkpoint.id;
          const recorded = detail.observations.find((item) => item.assetId === asset.id && item.checkpointId === checkpoint.id && item.side === "INCOMING");
          return <div key={checkpoint.id} className="space-y-2 border-t py-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">{checkpoint.label}{checkpoint.required ? " · مطلوب" : ""}</span>{recorded && <span className="text-xs">{conditions.find((item) => item.value === recorded.condition)?.label ?? recorded.condition}</span>}</div>
            {detail.status === "PENDING" && detail.assignedUser.id === user.id && <>
              <select aria-label={"حالة " + checkpoint.label} className="h-9 w-full rounded border bg-background px-3 text-sm" value={selection[key] ?? "OK"} onChange={(e) => setSelection({ ...selection, [key]: e.target.value })}>{conditions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              <Textarea aria-label={"ملاحظة " + checkpoint.label} maxLength={1000} placeholder="اكتب ملاحظة عند الحاجة" value={notes[key] ?? ""} onChange={(e) => setNotes({ ...notes, [key]: e.target.value })} />
              {selection[key] === "FAULT" && <Label className="text-xs">صورة العطل (اختياري)<input id={"place-evidence-" + key} type="file" accept="image/jpeg,image/png,image/webp" className="mt-1 block w-full" /></Label>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void observe(asset, checkpoint.id)}>حفظ حالة الفحص</Button>
            </>}
            {recorded?.photos.map((photo) => <Image key={photo.id} src={"/api/place-photos/" + photo.id} alt={"صورة عطل " + checkpoint.label} width={96} height={96} unoptimized className="size-24 rounded border object-cover" />)}
          </div>;
        })}
      </article>)}
      {detail.status === "PENDING" && detail.assignedUser.id === user.id && <div className="space-y-2">
        <Button disabled={busy} onClick={() => void accept()}>تأكيد استلام المكان</Button>
      </div>}
      {detail.status === "PENDING" && user.role === "CAFE_OWNER" && canKey("handover.exception") && <div className="space-y-2 rounded border border-amber-500/40 p-3">
        <Label htmlFor="place-override">سبب اعتماد الاستثناء عند نقص الفحص أو وجود عطل</Label><Textarea id="place-override" value={override} maxLength={500} onChange={(e) => setOverride(e.target.value)} />
        <Button variant="outline" disabled={busy || override.trim().length < 5} onClick={() => void accept()}>اعتماد استثنائي مع تسجيل السبب</Button>
      </div>}
      {user.role === "CAFE_OWNER" && detail.incidents.filter((incident) => incident.status === "OPEN").map((incident) => <div key={incident.id} className="space-y-2 rounded border p-3">
        <Label htmlFor={"repair-" + incident.id}>تسجيل إصلاح العطل (من غير تغيير بلاغ العطل الأصلي)</Label><Textarea id={"repair-" + incident.id} value={repair[incident.id] ?? ""} onChange={(e) => setRepair({ ...repair, [incident.id]: e.target.value })} />
        <Button size="sm" variant="outline" disabled={busy || (repair[incident.id] ?? "").trim().length < 3} onClick={() => void resolveIncident(incident.id)}>تسجيل الإصلاح</Button>
      </div>)}
    </div>}
  </section>;
}
