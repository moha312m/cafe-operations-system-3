"use client";

import { type CountEntry, validCountQuantity } from "./count-entry-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { TONE_SIDE, TONE_SURFACE, type Tone } from "@/components/ui/tone";
import { UNIT_LABEL } from "@/lib/inventory";
import { DISPOSITION_LABEL, DISPUTED_DISPOSITIONS, OPEN_FOR_CAPTURE, TERMINAL_DISPOSITIONS, type CountStatus, type Disposition } from "./stock-count-labels";

/** Optional target fields stay absent in blind responses. */
export type CountLine = {
  id: string;
  inventoryItemId: string;
  unit: string;
  disposition: Disposition;
  countedQuantity: string | null;
  effectiveCountedQuantity: string | null;
  countedAt: string | null;
  inventoryItem: { id: string; name: string; category: string | null; unit: string; isCritical?: boolean };
  expectedQuantity?: string | null;
  varianceQuantity?: string | null;
  reasonCodeId?: string | null;
  costImpact?: string | null;
  costImpactAvailable?: boolean;
};
export type LineAction = "capture" | "recount" | "accept-variance" | "correction" | "reason";

export function CountLineRow({ line, sessionStatus, blind, handover = false, can, busy, entry, onDraft, onSave, onAct }: {
  line: CountLine;
  sessionStatus: CountStatus;
  blind: boolean;
  handover?: boolean;
  can: (key: string) => boolean;
  busy: boolean;
  entry: CountEntry;
  onDraft: (lineId: string, value: string) => void;
  onSave: (lineId: string) => void;
  onAct: (action: Exclude<LineAction, "capture">, line: CountLine) => void;
}) {
  const captureOpen = OPEN_FOR_CAPTURE.includes(sessionStatus);
  const disputed = DISPUTED_DISPOSITIONS.includes(line.disposition);
  const terminal = TERMINAL_DISPOSITIONS.includes(line.disposition);
  const compact = handover && ["DRAFT", "IN_PROGRESS"].includes(sessionStatus);
  // Row colour: sage = counted above zero, caramel = an explicit zero, tide = still waiting.
  const draftValue = entry.value.trim();
  const tone: Tone = compact
    ? (entry.status === "empty" || draftValue === "" ? "tide" : Number(draftValue) === 0 ? "caramel" : "sage")
    : (line.countedQuantity === null ? "tide" : Number(line.countedQuantity) === 0 ? "caramel" : "sage");
  const nameCell = `${TONE_SIDE[tone]} ${TONE_SURFACE[tone]}`;
  const savingLabel = { empty: "لم تُعدّ", dirty: "غير محفوظ", saving: "جارٍ الحفظ…", saved: "محفوظ", failed: "فشل الحفظ" }[entry.status];
  const quantityInput = <Input
    className="h-9 w-28 tabular-nums"
    inputMode="decimal"
    dir="ltr"
    value={entry.value}
    placeholder="الكمية"
    disabled={busy}
    aria-invalid={entry.status === "failed"}
    aria-label={`الكمية المعدودة — ${line.inventoryItem.name}`}
    onChange={(e) => onDraft(line.id, e.target.value)}
    onBlur={() => { if (handover && entry.status !== "saved" && entry.status !== "empty") onSave(line.id); }}
    onKeyDown={(e) => {
      if (handover && e.key === "Enter") {
        e.preventDefault(); onSave(line.id);
        const inputs = Array.from(e.currentTarget.closest("table")?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]') ?? []);
        inputs[inputs.indexOf(e.currentTarget) + 1]?.focus();
      }
    }}
  />;
  const savingStatus = <div className="max-w-56 space-y-1 whitespace-normal" aria-live="polite">
    <span className={entry.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{savingLabel}</span>
    {entry.value.trim() === "0" && entry.status !== "empty" && <span className={`ms-1 rounded border px-1.5 py-0.5 text-xs font-medium ${TONE_SURFACE.caramel}`}>صفر فعلي — نفد</span>}
    {entry.error && <p role="alert" className="text-xs text-destructive">{entry.error}</p>}
    {entry.status === "failed" && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(line.id)}>{entry.conflict ? "تحديث الدليل للمراجعة" : "إعادة الحفظ"}</Button>}
  </div>;
  // Below the sm breakpoint each item becomes a stacked card (name, unit, controls, status): beside a wide
  // controls column the name scrolled out of view while its quantity was being typed.
  if (compact) return <TableRow data-testid="count-line-row" className="max-sm:block max-sm:border-b max-sm:py-2">
    <TableCell className={`min-w-36 max-w-56 whitespace-normal font-medium [overflow-wrap:anywhere] max-sm:block max-sm:max-w-none ${nameCell}`}>{line.inventoryItem.name}</TableCell>
    <TableCell className="text-muted-foreground max-sm:block max-sm:pb-0">{UNIT_LABEL[line.unit as keyof typeof UNIT_LABEL] ?? line.unit}</TableCell>
    <TableCell className="max-sm:block">{can("stock_count.submit") ? <div className="flex flex-wrap items-center gap-1.5">{quantityInput}<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { const cur = Number(entry.value); const next = Number.isFinite(cur) && entry.value.trim() !== "" ? Math.max(0, Math.round((cur - 1) * 1000) / 1000) : 0; onDraft(line.id, String(next)); if (handover) onSave(line.id); }} data-testid="count-line-dec" aria-label={`إنقاص ${line.inventoryItem.name}`}>-1</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { const cur = Number(entry.value); const next = Number.isFinite(cur) && entry.value.trim() !== "" ? Math.round((cur + 1) * 1000) / 1000 : 1; onDraft(line.id, String(next)); if (handover) onSave(line.id); }} data-testid="count-line-inc" aria-label={`زيادة ${line.inventoryItem.name}`}>+1</Button><Button type="button" size="sm" variant={entry.value.trim() === "0" ? "default" : "outline"} disabled={busy} onClick={() => { onDraft(line.id, "0"); if (handover) onSave(line.id); }} data-testid="count-line-zero">0 (صفر فعلي)</Button></div> : (line.countedQuantity ?? "—")}</TableCell>
    <TableCell className="max-sm:block">{savingStatus}</TableCell>
  </TableRow>;

  return <TableRow data-testid="count-line-row">
    <TableCell className={`min-w-36 whitespace-normal font-medium [overflow-wrap:anywhere] ${nameCell}`}>{line.inventoryItem.name}</TableCell>
    <TableCell className="text-muted-foreground">{UNIT_LABEL[line.unit as keyof typeof UNIT_LABEL] ?? line.unit}</TableCell>
    <TableCell className="tabular-nums">{line.countedQuantity ?? "—"}</TableCell>
    <TableCell className="tabular-nums">{blind ? "مخفي" : (line.expectedQuantity ?? "—")}</TableCell>
    <TableCell className="tabular-nums">{blind ? "مخفي" : (line.varianceQuantity ?? "—")}</TableCell>
    <TableCell>{DISPOSITION_LABEL[line.disposition] ?? line.disposition}</TableCell>
    <TableCell><div className="flex flex-wrap items-center justify-end gap-2">
      {captureOpen && !terminal && can("stock_count.submit") && <>
        {quantityInput}
        <Button size="sm" variant="outline" disabled={busy || entry.status === "saving" || !validCountQuantity(entry.value)} onClick={() => onSave(line.id)} data-testid="count-line-capture">تسجيل</Button>
        {savingStatus}
      </>}
      {disputed && can("stock_count.recount") && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("recount", line)} data-testid="count-line-recount">إعادة عد</Button>}
      {disputed && can("stock_count.confirm") && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("accept-variance", line)} data-testid="count-line-accept-variance">اعتماد الفرق</Button>}
      {handover && ["SUBMITTED", "RECOUNT_REQUIRED", "CONFIRMED"].includes(sessionStatus) && !blind && !line.reasonCodeId && line.varianceQuantity != null && Number(line.varianceQuantity) !== 0 && can("stock_count.confirm") && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("reason", line)}>تسجيل سبب الفرق</Button>}
      {line.countedQuantity !== null && can("stock_count.correct") && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct("correction", line)} data-testid="count-line-correction">تصحيح</Button>}
    </div></TableCell>
  </TableRow>;
}
