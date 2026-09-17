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
  COUNT_STATUS_LABEL,
  COUNT_TYPE_LABEL,
  type CountStatus,
  type CountType,
} from "./stock-count-labels";

/** One row of `GET /api/stock-counts` — ids and counters only, no figures. */
export type CountSessionRow = {
  id: string;
  branchId: string;
  type: CountType;
  status: CountStatus;
  mode: "BLIND" | "OPEN";
  startedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  lineCount: number;
};

export function StockCountList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: CountSessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        مفيش جلسات جرد بالفلاتر دي
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>النوع</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead>الأصناف</TableHead>
            <TableHead>اتفتح</TableHead>
            <TableHead>اتسلّم</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`cursor-pointer ${selectedId === s.id ? "bg-muted/60" : ""}`}
              data-testid="stock-count-row"
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  {COUNT_TYPE_LABEL[s.type] ?? s.type}
                  {s.mode === "BLIND" && (
                    <Badge className="bg-slate-200 text-slate-800 hover:bg-slate-200">
                      أعمى
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>{COUNT_STATUS_LABEL[s.status] ?? s.status}</TableCell>
              <TableCell className="tabular-nums">{s.lineCount}</TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(s.createdAt).toLocaleString("ar-EG", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {s.submittedAt
                  ? new Date(s.submittedAt).toLocaleString("ar-EG", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
