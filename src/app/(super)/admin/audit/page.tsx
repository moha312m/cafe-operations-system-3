"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t, formatDateTime } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, Panel, EmptyState, LoadingBlock } from "@/components/admin/ui";

type Log = {
  id: string; action: string; entity: string; entityId: string | null;
  createdAt: string; cafe: { name: string } | null; user: { name: string; role: string } | null;
};

export default function AdminAuditPage() {
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [cafes, setCafes] = useState<{ id: string; name: string }[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [cafeId, setCafeId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (cafeId) qs.set("cafeId", cafeId);
      if (action) qs.set("action", action);
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const res = await api<{ logs: Log[]; cafes: { id: string; name: string }[]; actions: string[] }>(
        `/api/admin/audit?${qs.toString()}`
      );
      setLogs(res.logs);
      setCafes(res.cafes);
      setActions(res.actions);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل السجل");
    }
  }, [cafeId, action, from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title={t.admin.nav.audit} subtitle="سجل الحركات عبر كل الكافيهات" />

      <Panel>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">الكافيه</Label>
            <select value={cafeId} onChange={(e) => setCafeId(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
              <option value="">كل الكافيهات</option>
              {cafes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">نوع الحركة</Label>
            <select value={action} onChange={(e) => setAction(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
              <option value="">كل الحركات</option>
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        {logs === null ? (
          <LoadingBlock label={t.admin.loading} />
        ) : logs.length === 0 ? (
          <EmptyState message={t.admin.empty} icon="🕓" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>المستخدم</TableHead>
                <TableHead>الكافيه</TableHead>
                <TableHead>نوع الحركة</TableHead>
                <TableHead>الكيان</TableHead>
                <TableHead>الوقت</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">
                      {l.user?.name ?? "—"}
                      {l.user && <span className="block text-xs text-slate-400">{t.roles[l.user.role as keyof typeof t.roles] ?? l.user.role}</span>}
                    </TableCell>
                    <TableCell className="text-slate-600">{l.cafe?.name ?? "المنصة"}</TableCell>
                    <TableCell><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{l.action}</span></TableCell>
                    <TableCell className="text-slate-500">{l.entity}</TableCell>
                    <TableCell className="text-xs text-slate-500">{formatDateTime(l.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </>
  );
}
