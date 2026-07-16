"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t, formatDate } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, Panel, StatCard, SubscriptionBadge, EmptyState, LoadingBlock } from "@/components/admin/ui";
import { SubscriptionDialog, type SubCafe } from "@/components/admin/subscription-dialog";

type Cafe = SubCafe & { slug: string; isActive: boolean };

export default function AdminSubscriptionsPage() {
  const [cafes, setCafes] = useState<Cafe[] | null>(null);
  const [editing, setEditing] = useState<SubCafe | null>(null);

  const load = useCallback(async () => {
    try {
      const { cafes } = await api<{ cafes: Cafe[] }>("/api/admin/cafes");
      setCafes(cafes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts = (status: string) => (cafes ?? []).filter((c) => c.subscriptionStatus === status).length;

  return (
    <>
      <PageHeader title={t.admin.nav.subscriptions} subtitle="باقات واشتراكات الكافيهات" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t.admin.subStatus.ACTIVE} value={counts("ACTIVE")} icon="✅" accent="emerald" />
        <StatCard label={t.admin.subStatus.TRIAL} value={counts("TRIAL")} icon="🧪" accent="indigo" />
        <StatCard label={t.admin.subStatus.EXPIRED} value={counts("EXPIRED")} icon="⏰" accent="amber" />
        <StatCard label={t.admin.subStatus.SUSPENDED} value={counts("SUSPENDED")} icon="⛔" accent="rose" />
      </div>

      <Panel className="mt-4">
        {cafes === null ? (
          <LoadingBlock label={t.admin.loading} />
        ) : cafes.length === 0 ? (
          <EmptyState message={t.admin.empty} icon="💳" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>الكافيه</TableHead>
                <TableHead>الباقة</TableHead>
                <TableHead>حالة الاشتراك</TableHead>
                <TableHead>ينتهي في</TableHead>
                <TableHead className="text-end">إجراءات</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {cafes.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>{c.planName}</TableCell>
                    <TableCell>
                      <SubscriptionBadge status={c.subscriptionStatus} label={t.admin.subStatus[c.subscriptionStatus as keyof typeof t.admin.subStatus] ?? c.subscriptionStatus} />
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{c.subscriptionEndsAt ? formatDate(c.subscriptionEndsAt) : "—"}</TableCell>
                    <TableCell className="text-end">
                      <Button size="sm" variant="outline" onClick={() => setEditing(c)}>تعديل الاشتراك</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <SubscriptionDialog cafe={editing} onOpenChange={(v) => !v && setEditing(null)} onDone={load} />
    </>
  );
}
