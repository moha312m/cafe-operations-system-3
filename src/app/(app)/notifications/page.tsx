"use client";
// «التنبيهات» — the signed-in person's own in-app notifications.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";

type Note = { id: string; kind: string; title: string; body: string; handoverId: string | null; createdAt: string; readAt: string | null; branchName: string | null };

export default function NotificationsPage() {
  const [rows, setRows] = useState<Note[] | null>(null);
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    try {
      const data = await api<{ unread: number; notifications: Note[] }>("/api/notifications");
      setRows(data.notifications); setUnread(data.unread);
    } catch (error) { toast.error((error as Error).message); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mark = async (body: Record<string, unknown>) => {
    try { await api("/api/notifications", { method: "POST", body }); await load(); }
    catch (error) { toast.error((error as Error).message); }
  };

  return (
    <div dir="rtl" className="mx-auto max-w-2xl space-y-3 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">التنبيهات {unread > 0 && <span className="text-base text-red-700">({unread})</span>}</h1>
        {unread > 0 && <Button variant="outline" onClick={() => void mark({ action: "read_all" })}>علّم الكل مقروء</Button>}
      </header>
      {rows === null ? <p className="text-sm text-muted-foreground">بيحمّل…</p> : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">مفيش تنبيهات.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((n) => (
            <li key={n.id} className={`rounded-xl border p-3 ${n.readAt ? "bg-card" : "border-primary/40 bg-primary/5"}`}>
              <p className="font-semibold">{n.title}</p>
              <p className="text-sm text-muted-foreground">{n.body}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{new Date(n.createdAt).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" })}</span>
                {n.handoverId && <Link className="text-primary underline" href={`/reports/stock-handovers?handoverId=${n.handoverId}`}>افتح التقرير</Link>}
                {!n.readAt && <button type="button" className="text-primary underline" onClick={() => void mark({ action: "read", ids: [n.id] })}>علّم مقروء</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
