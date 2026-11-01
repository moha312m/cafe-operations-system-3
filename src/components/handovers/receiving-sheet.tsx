"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { UNIT_LABEL } from "@/lib/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TONE_SIDE, TONE_SURFACE, type Tone } from "@/components/ui/tone";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";
import { newIdempotencyKey } from "./handover-labels";
import { receivingDecisions, receivingRequestKey, reviewPriority, type ReceivingDraft } from "./receiving-model";

type ReceivingLine = { id: string; unit: string; disposition: string; inventoryItem: { name: string; category?: string | null; isCritical?: boolean }; varianceQuantity?: string | null };
const emptyDraft = (): ReceivingDraft => ({ quantity: "", withoutCount: false, reason: "", note: "", refuse: false });

export function ReceivingSheet({ handoverId, countSessionId, countVersion, lines, acknowledgements, onSaved }: {
  handoverId: string; countSessionId: string; countVersion:string; lines: ReceivingLine[];
  acknowledgements: { stockCountLineId: string; decision: string }[];
  onSaved: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, ReceivingDraft>>({});
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<string>("all");
  const sheetRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const request = useRef<{ fingerprint: string; key: string } | null>(null);
  const acknowledged = new Set(acknowledgements.map(row => row.stockCountLineId));
  const unreviewed = lines.filter(line => !acknowledged.has(line.id) && line.disposition !== "PENDING");
  const missing = lines.filter(line => line.disposition === "PENDING");
  const decisions = receivingDecisions(unreviewed.map(line => line.id), drafts);
  const visible = [...unreviewed].sort((a, b) => reviewPriority(a) - reviewPriority(b)).filter(line => {
    if (!line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
    if (filterTab === "undecided") return receivingDecisions([line.id], drafts) === null;
    if (filterTab === "critical") return !!line.inventoryItem.isCritical;
    return true;
  });

  function update(id: string, change: Partial<ReceivingDraft>) {
    if (inFlight.current) return;
    setDrafts(previous => ({ ...previous, [id]: { ...(previous[id] ?? emptyDraft()), ...change } }));
    setSaved(false);
  }

  async function confirm() {
    if (inFlight.current || !decisions || !decisions.length) return;
    inFlight.current = true;
    setBusy(true); setError("");
    request.current = receivingRequestKey(countSessionId+":"+countVersion, decisions, request.current, newIdempotencyKey);
    try {
      await api(`/api/handovers/${handoverId}/acknowledge`, { method: "POST", body: { countSessionId, countVersion, lines: decisions, idempotencyKey: request.current.key } });
      setSaved(true);
      await onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "تعذّر حفظ الاستلام — البيانات المكتوبة محفوظة، راجع السبب وأعد المحاولة");
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  if (!unreviewed.length) return null;
  return <section ref={sheetRef} className="space-y-3 rounded-xl border p-3" aria-label="ورقة استلام المخزون" data-testid="handover-receiving-sheet">
    <h3 className="font-semibold">ورقة استلام المخزون</h3>
    <p className="text-xs text-muted-foreground">اكتب الكمية اللي عدّيتها، وهي اللي هتستلمها؛ لو مختلفة الفرق بيتسجل. أو استلم دون عدّ مستقل (بدون كمية).</p>
    {missing.length > 0 && <p role="alert" className={`rounded-lg border p-2 ${TONE_SURFACE.caramel}`}>أصناف لم تُعدّ: {missing.map(line => line.inventoryItem.name).join("، ")}. لا يمكن توقيعها كأصناف معدودة؛ يلزم استكمالها أو مراجعة المسؤول وفق ضوابط التسليم.</p>}
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted p-1" data-testid="receiving-filter-tabs">
      <Button type="button" size="sm" variant={filterTab === "all" ? "default" : "outline"} disabled={busy} onClick={() => setFilterTab("all")}>الكل ({unreviewed.length})</Button>
      <Button type="button" size="sm" variant={filterTab === "undecided" ? "default" : "outline"} disabled={busy} onClick={() => setFilterTab("undecided")}>لم يُسجل بعد ({unreviewed.filter(l => receivingDecisions([l.id], drafts) === null).length})</Button>
      <Button type="button" size="sm" variant={filterTab === "critical" ? "default" : "outline"} disabled={busy} onClick={() => setFilterTab("critical")}>الأصناف الحرجة ({unreviewed.filter(l => l.inventoryItem.isCritical).length})</Button>
      <Button type="button" size="sm" variant="secondary" className="ms-auto" disabled={busy} data-testid="receiving-next-undecided" onClick={() => {
        setFilterTab("all");
        setSearch("");
        setTimeout(() => {
          const inputs = Array.from(sheetRef.current?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]') ?? []);
          const nextInput = inputs.find(inp => !inp.disabled && inp.value.trim() === "");
          (nextInput ?? inputs[0])?.focus();
        }, 0);
      }}>الصنف التالي</Button>
    </div>
    <label className="block text-sm">بحث أصناف الاستلام<Input value={search} aria-label="بحث ورقة الاستلام" onChange={event => setSearch(event.target.value)} disabled={busy} /></label>
    <div className="space-y-2">
      {visible.map(line => {
        const draft = drafts[line.id] ?? emptyDraft();
        const changed = line.varianceQuantity != null && Number(line.varianceQuantity) !== 0;
        // sage = counted, tide = taken without an independent count, caramel = not decided yet.
        const tone: Tone = draft.withoutCount ? "tide" : draft.quantity.trim() !== "" && receivingDecisions([line.id], drafts) !== null ? "sage" : "caramel";
        return <div key={line.id} className={`space-y-2 rounded-lg border p-3 ${TONE_SURFACE[tone]} ${TONE_SIDE[tone]}`} data-testid="receiving-sheet-line">
          <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)]">
            <div className="font-medium [overflow-wrap:anywhere]">{line.inventoryItem.name}<span className="ms-2 text-xs text-muted-foreground">{UNIT_LABEL[line.unit as keyof typeof UNIT_LABEL] ?? line.unit}</span>{changed && <p className="text-xs text-clay-ink">فيه فرق مسجّل في جرد المُسلِّم</p>}</div>
            <div className="space-y-1.5"><label className="text-xs">الكمية الفعلية<Input inputMode="decimal" value={draft.quantity} disabled={busy || draft.withoutCount} aria-label={`عد الاستلام — ${line.inventoryItem.name}`} onChange={event => update(line.id, { quantity: event.target.value, withoutCount: false })} /></label><div className="flex flex-wrap items-center gap-1"><Button type="button" size="sm" variant="outline" disabled={busy || draft.withoutCount} data-testid="receiving-line-dec" onClick={() => { const cur = Number(draft.quantity); const next = Number.isFinite(cur) && draft.quantity.trim() !== "" ? Math.max(0, Math.round((cur - 1) * 1000) / 1000) : 0; update(line.id, { quantity: String(next), withoutCount: false }); }}>-1</Button><Button type="button" size="sm" variant="outline" disabled={busy || draft.withoutCount} data-testid="receiving-line-inc" onClick={() => { const cur = Number(draft.quantity); const next = Number.isFinite(cur) && draft.quantity.trim() !== "" ? Math.round((cur + 1) * 1000) / 1000 : 1; update(line.id, { quantity: String(next), withoutCount: false }); }}>+1</Button><Button type="button" size="sm" variant={draft.quantity.trim() === "0" && !draft.withoutCount ? "default" : "outline"} disabled={busy} data-testid="receiving-line-zero" onClick={() => update(line.id, { quantity: "0", withoutCount: false })}>0 (صفر فعلي)</Button></div>{draft.quantity.trim() === "0" && !draft.withoutCount && <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${TONE_SURFACE.caramel}`}>صفر فعلي — نفد</span>}</div>
            <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.withoutCount} disabled={busy || draft.quantity.trim() !== ""} onChange={event => update(line.id, { withoutCount: event.target.checked })} />أستلم دون عدّ مستقل (بدون كمية)</label>
          </div>
          <details open={error || draft.refuse ? true : undefined}>
            <summary className="cursor-pointer text-xs text-muted-foreground">رفض استلام الصنف</summary>
            <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" checked={!!draft.refuse} disabled={busy} data-testid="receiving-line-refuse" onChange={event => update(line.id, { refuse: event.target.checked })} />أرفض استلام الصنف ده (اعتراض يوقف التسليم لحد إعادة الجرد)</label>
            {draft.refuse && <fieldset disabled={busy} className="mt-2 grid gap-2 sm:grid-cols-2"><ReasonCodeSelect domain="HANDOVER" value={draft.reason} onChange={reason => update(line.id, { reason })} label={`سبب الرفض — ${line.inventoryItem.name}`} /><Textarea disabled={busy} value={draft.note} aria-label={`ملاحظة الرفض — ${line.inventoryItem.name}`} maxLength={500} onChange={event => update(line.id, { note: event.target.value })} /></fieldset>}
          </details>
        </div>;
      })}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error} · لم تُمسح إدخالاتك. راجع أسباب الاختلاف ثم أعد المحاولة؛ إذا تغيّر الجرد، حدّث الحالة.</p>}
    {saved && <p role="status" className="text-sm">تم حفظ قرارات الاستلام؛ لم يكتمل نقل العهدة بعد.</p>}
    <div className="surface-espresso sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3" data-testid="receiving-summary-bar">
      <p className="text-xs">قرارات مكتملة: {unreviewed.filter(line => receivingDecisions([line.id], drafts) !== null).length} / {unreviewed.length} · نسخة الجرد: <span dir="ltr">{countSessionId}</span></p>
      <Button className="bg-card text-sage-ink hover:bg-card/90" disabled={busy || saved || !decisions || !decisions.length} onClick={() => void confirm()} data-testid="handover-receiving-confirm">{busy ? "جاري حفظ الاستلام…" : "أؤكد قرارات الاستلام لكل الأصناف أعلاه"}</Button>
    </div>
  </section>;
}
