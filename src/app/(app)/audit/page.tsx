"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t, formatDateTime } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
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

  const load = useCallback(async () => {
    try {
      const { logs } = await api<{ logs: Log[] }>("/api/audit");
      setLogs(logs);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل سجل الحركات");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">سجل الحركات</h1>
        <p className="text-sm text-muted-foreground">آخر ٢٠٠ حركة</p>
      </div>
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
          {logs.map((log) => (
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
                <Badge variant="outline">{log.action}</Badge>
              </TableCell>
              <TableCell className="max-w-md truncate text-sm text-muted-foreground">
                {log.details ? JSON.stringify(log.details) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
