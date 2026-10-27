"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { ROLE_LABELS } from "@/lib/permissions";
import type { Role, QrApprovalMode } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { QrApprovalSettingsDialog } from "@/components/qr-approval-settings-dialog";
import { QrOrderEditDialog } from "@/components/approvals/qr-order-edit-dialog";
import { OwnerActionQueue } from "@/components/approvals/owner-action-queue";
import { collectOrderPages, type OrderPage } from "@/lib/order-pages-client";

type OrderItem = {
  id: string; productName: string; variantName: string | null;
  unitPrice: number; quantity: number; lineTotal: number; notes: string | null;
};
type PendingOrder = {
  id: string; orderNumber: number; tableNumber: string | null;
  customerName: string | null; notes: string | null; total: number; createdAt: string;
  approvalMode: QrApprovalMode | null; assignedRole: Role | null; assignedUser: string | null;
  items: OrderItem[];
};

function assignedLabel(o: PendingOrder): string {
  if (o.assignedUser) return o.assignedUser;
  if (o.assignedRole) return ROLE_LABELS[o.assignedRole];
  return "أي موظف مصرّح له";
}

function waitLabel(createdAt: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000), 0);
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `منذ ${h}س${m ? ` ${m}د` : ""}`;
}

export default function ApprovalsPage() {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const [perms, setPerms] = useState({ canApprove: false, canReject: false, canEdit: false });
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<PendingOrder | null>(null);
  const [reason, setReason] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const canEditSettings = canKey("settings.edit_qr_approval");

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      type QueuePage = OrderPage<PendingOrder> & { canApprove: boolean; canReject: boolean; canEdit: boolean };
      const data = await api<QueuePage>(
        "/api/qr-orders/pending"
      );
      const complete = await collectOrderPages<PendingOrder>((cursor) => cursor
        ? api<QueuePage>(`/api/qr-orders/pending?cursor=${encodeURIComponent(cursor)}`)
        : Promise.resolve(data));
      if (version !== loadVersion.current) return;
      setOrders(complete.orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
      setPerms({ canApprove: data.canApprove, canReject: data.canReject, canEdit: data.canEdit });
      setLoadError(null);
    } catch (error) {
      if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : "تعذر تحديث قائمة الموافقات");
    }
  }, []);

  useEffect(() => {
    const versionRef = loadVersion;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await load();
      if (!stopped) timer = setTimeout(refresh, 20_000);
    };
    timer = setTimeout(refresh, 0);
    return () => { stopped = true; clearTimeout(timer); versionRef.current++; };
  }, [load]);

  async function approve(order: PendingOrder) {
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/approve`, { method: "POST" });
      toast.success("تم تأكيد الطلب وإرساله للتحضير");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التأكيد");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true);
    try {
      await api(`/api/orders/${rejecting.id}/reject`, { method: "POST", body: { reason } });
      toast.success("تم رفض الطلب");
      setRejecting(null); setReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الرفض");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <OwnerActionQueue />
      {loadError && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">تعذر تحديث القائمة؛ آخر بيانات مكتملة معروضة. {loadError}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold">طلبات المنيو في انتظار التأكيد</h1>
          <p className="text-sm text-muted-foreground">
            طلبات العملاء من منيو الـ QR — تحتاج تأكيد قبل ما تروح للتحضير
          </p>
        </div>
        <Badge variant={orders.length > 0 ? "destructive" : "secondary"} className="text-sm">{orders.length}</Badge>
        {canEditSettings && (
          <Button variant="outline" size="sm" className="ms-auto" onClick={() => setSettingsOpen(true)}>
            ⚙️ إعدادات تأكيد طلبات المنيو
          </Button>
        )}
      </div>

      {orders.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          <p className="text-3xl">📱</p>
          <p className="mt-2 text-sm">مفيش طلبات مستنية التأكيد دلوقتي.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-lg font-bold">#{order.orderNumber}</p>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge variant="outline">{t.orderStatus.PENDING_WAITER_APPROVAL}</Badge>
                  <span className="rounded-full bg-blue-500/12 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                    موجه إلى: {assignedLabel(order)}
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {order.tableNumber ? `ترابيزة ${order.tableNumber}` : "من غير ترابيزة"}
                {order.customerName && ` · ${order.customerName}`}
                {" · "}{formatTime(order.createdAt)} · {waitLabel(order.createdAt)}
              </p>
              <ul className="space-y-0.5 border-y py-2 text-sm">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium tabular-nums">{item.quantity}×</span>{" "}
                    {item.productName}
                    {item.variantName && <span className="text-muted-foreground"> ({item.variantName})</span>}
                    {item.notes && <span className="block ps-5 text-xs text-amber-700 dark:text-amber-400">📝 {item.notes}</span>}
                  </li>
                ))}
              </ul>
              {order.notes && <p className="text-xs text-muted-foreground">📝 {order.notes}</p>}
              <div className="flex items-center justify-between pt-1">
                <p className="font-bold tabular-nums">{money(order.total, currency)}</p>
                <div className="flex gap-1">
                  {perms.canApprove && (
                    <Button size="sm" disabled={busy} onClick={() => approve(order)}>تأكيد الطلب</Button>
                  )}
                  {perms.canEdit && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(order.id)}>تعديل الطلب</Button>
                  )}
                  {perms.canReject && (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy}
                      onClick={() => { setReason(""); setRejecting(order); }}>رفض</Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Reject dialog ── */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>رفض طلب رقم {rejecting?.orderNumber}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>سبب الرفض *</Label>
            <Textarea rows={2} placeholder="مثلاً: الترابيزة مش موجودة، طلب مكرر، صنف خلص…"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="destructive" disabled={busy || reason.trim().length < 2} onClick={reject}>
              {busy ? "جاري الرفض…" : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Full edit-before-approval dialog ── */}
      {editingId && (
        <QrOrderEditDialog
          orderId={editingId}
          canApprove={perms.canApprove}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load(); }}
        />
      )}

      {settingsOpen && (
        <QrApprovalSettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); load(); }} />
      )}
    </div>
  );
}
