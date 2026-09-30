"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  HANDOVER_STATUS_LABEL,
  REVIEWABLE,
  TARGET_LABEL,
  type HandoverStatus,
} from "./handover-labels";

/** One row of `GET /api/handovers` — ids and counters, no quantities. */
export type HandoverRow = {
  id: string;
  branchId: string;
  status: HandoverStatus;
  target: string | null;
  outgoingShiftId: string;
  outgoingUserId: string;
  stockCountSessionId: string | null;
  requiredItemCount: number | null;
  submittedAt: string | null;
  createdAt: string;
};

export function HandoverList({
  handovers,
  selectedId,
  onSelect,
}: {
  handovers: HandoverRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (handovers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        مفيش عمليات تسليم بالفلاتر دي
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الحالة</TableHead>
            <TableHead>الوجهة</TableHead>
            <TableHead>أصناف مطلوبة</TableHead>
            <TableHead>اتسلّم</TableHead>
            <TableHead>اتعمل</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {handovers.map((h) => {
            // Only a handover under review can be opened; the detail endpoint
            // refuses the rest with 409, so they are shown without being made
            // to look clickable.
            const openable = REVIEWABLE.includes(h.status);
            return (
              <TableRow
                key={h.id}
                onClick={() => openable && onSelect(h.id)}
                className={`${openable ? "cursor-pointer" : "opacity-70"} ${
                  selectedId === h.id ? "bg-muted/60" : ""
                }`}
                data-testid="handover-row"
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {HANDOVER_STATUS_LABEL[h.status] ?? h.status}
                    {!openable && (
                      <Badge className="bg-muted text-muted-foreground hover:bg-muted">
                        للاطلاع
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {h.target ? (TARGET_LABEL[h.target] ?? h.target) : "—"}
                </TableCell>
                <TableCell className="tabular-nums">{h.requiredItemCount ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {h.submittedAt
                    ? new Date(h.submittedAt).toLocaleString("ar-EG", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(h.createdAt).toLocaleString("ar-EG", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
