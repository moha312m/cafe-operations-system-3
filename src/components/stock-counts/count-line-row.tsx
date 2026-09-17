"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  DISPOSITION_LABEL,
  DISPUTED_DISPOSITIONS,
  OPEN_FOR_CAPTURE,
  TERMINAL_DISPOSITIONS,
  type CountStatus,
  type Disposition,
} from "./stock-count-labels";

/**
 * One line of a count session.
 *
 * The five variance fields are OPTIONAL on purpose. A blind count deletes
 * them from the payload for the person doing the counting — they are absent
 * keys, not nulls — so the counter cannot work backwards from the answer to
 * the number they were supposed to write down. Rendering `undefined` as a
 * dash keeps that blindness instead of quietly filling it in.
 */
export type CountLine = {
  id: string;
  inventoryItemId: string;
  unit: string;
  disposition: Disposition;
  countedQuantity: string | null;
  effectiveCountedQuantity: string | null;
  countedAt: string | null;
  inventoryItem: { id: string; name: string; category: string | null; unit: string };
  expectedQuantity?: string | null;
  varianceQuantity?: string | null;
  costImpact?: string | null;
  costImpactAvailable?: boolean;
};

export type LineAction = "capture" | "recount" | "accept-variance" | "correction";

export function CountLineRow({
  line,
  sessionStatus,
  blind,
  can,
  busy,
  onCapture,
  onAct,
}: {
  line: CountLine;
  sessionStatus: CountStatus;
  blind: boolean;
  can: (key: string) => boolean;
  busy: boolean;
  onCapture: (lineId: string, quantity: number) => void;
  onAct: (action: Exclude<LineAction, "capture">, line: CountLine) => void;
}) {
  const [draft, setDraft] = useState("");

  const captureOpen = OPEN_FOR_CAPTURE.includes(sessionStatus);
  const disputed = DISPUTED_DISPOSITIONS.includes(line.disposition);
  const terminal = TERMINAL_DISPOSITIONS.includes(line.disposition);

  return (
    <TableRow data-testid="count-line-row">
      <TableCell className="font-medium">{line.inventoryItem.name}</TableCell>
      <TableCell className="text-muted-foreground">{line.unit}</TableCell>
      <TableCell className="tabular-nums">{line.countedQuantity ?? "—"}</TableCell>
      <TableCell className="tabular-nums">
        {/* Absent under a blind count, and shown as absent. */}
        {blind ? "مخفي" : (line.expectedQuantity ?? "—")}
      </TableCell>
      <TableCell className="tabular-nums">
        {blind ? "مخفي" : (line.varianceQuantity ?? "—")}
      </TableCell>
      <TableCell>{DISPOSITION_LABEL[line.disposition] ?? line.disposition}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {captureOpen && !terminal && can("stock_count.submit") && (
            <>
              <Input
                className="h-8 w-24"
                inputMode="decimal"
                value={draft}
                placeholder="الكمية"
                onChange={(e) => setDraft(e.target.value)}
                aria-label={`الكمية المعدودة — ${line.inventoryItem.name}`}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || draft.trim() === ""}
                onClick={() => {
                  onCapture(line.id, Number(draft));
                  setDraft("");
                }}
                data-testid="count-line-capture"
              >
                تسجيل
              </Button>
            </>
          )}

          {disputed && can("stock_count.recount") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct("recount", line)}
              data-testid="count-line-recount"
            >
              إعادة عد
            </Button>
          )}

          {disputed && can("stock_count.confirm") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct("accept-variance", line)}
              data-testid="count-line-accept-variance"
            >
              اعتماد الفرق
            </Button>
          )}

          {line.countedQuantity !== null && can("stock_count.correct") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onAct("correction", line)}
              data-testid="count-line-correction"
            >
              تصحيح
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
