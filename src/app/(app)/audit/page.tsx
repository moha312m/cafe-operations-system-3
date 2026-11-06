"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t, formatDateTime } from "@/lib/i18n";
import { auditActionLabel } from "@/lib/audit-action-labels";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Log = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { name: string; email: string; role: string } | null;
};

export default function AuditPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const range = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });

  // `cursor` continues after the oldest row shown; without it the list starts over from the newest.
  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoading(true);
    try {
      const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}) });
      const res = await api<{ logs: Log[]; hasMore: boolean }>(`/api/audit?${query}`);
      setLogs((current) => cursor ? [...current, ...res.logs] : res.logs);
      setHasMore(res.hasMore);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل سجل الحركات");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const needle = search.trim();
  const shown = needle
    ? logs.filter((log) => [log.user?.name ?? "", auditActionLabel(log.action), log.action].some((text) => text.includes(needle)))
    : logs;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">سجل الحركات</h1>
        <p className="text-sm text-muted-foreground">الأحدث أولًا · ظاهر {logs.length} حركة{hasMore ? " — فيه أقدم" : ""}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3" data-testid="audit-filters">
        <label className="space-y-1 text-sm">من يوم<Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" /></label>
        <label className="space-y-1 text-sm">لحد يوم<Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" /></label>
        <label className="space-y-1 text-sm">بحث بالمستخدم أو الحركة<Input value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" /></label>
        <a href={`/api/audit?${new URLSearchParams({ ...Object.fromEntries(range), format: "csv" })}`} download className={buttonVariants({ variant: "outline" })} data-testid="audit-export">تصدير CSV</a>
      </div>
      {needle && <p className="text-xs text-muted-foreground">البحث في الحركات الظاهرة بس ({shown.length} من {logs.length}).</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الوقت</TableHead>
            <TableHead>المستخدم</TableHead>
            <TableHead>الحركة</TableHead>
            <TableHead>التفاصيل</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {formatDateTime(log.createdAt)}
              </TableCell>
              <TableCell>
                {log.user ? (
                  <span>
                    {log.user.name}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({t.roles[log.user.role as keyof typeof t.roles] ?? log.user.role})
                    </span>
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline" title={log.action}>{auditActionLabel(log.action)}</Badge>
              </TableCell>
              <TableCell className="max-w-md text-sm text-muted-foreground">
                {log.details ? (
                  <details>
                    <summary className="cursor-pointer">عرض</summary>
                    <pre dir="ltr" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(log.details, null, 2)}</pre>
                  </details>
                ) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {hasMore && <Button variant="outline" disabled={loading} onClick={() => void load(logs[logs.length - 1]?.id)} data-testid="audit-more">{loading ? "جاري التحميل…" : "عرض حركات أقدم"}</Button>}
    </div>
  );
}
