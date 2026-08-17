"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type CustomerRow = {
  id: string;
  name: string | null;
  phone: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: string | null;
  loyaltyPointsBalance: number;
  isActive: boolean;
};

type Stats = {
  totalCount: number;
  newToday: number;
  repeatCount: number;
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  currentPointsBalance: number;
  avgSpend: number;
  topSpenders: { id: string; name: string | null; normalizedPhone: string; totalSpent: number; totalOrders: number; loyaltyPointsBalance: number }[];
};

type Details = {
  customer: CustomerRow & { notes: string | null; lifetimePointsEarned: number; lifetimePointsRedeemed: number };
  orders: { id: string; orderNumber: number; type: string; status: string; paymentStatus: string; total: number; loyaltyPointsEarned: number; loyaltyPointsRedeemed: number; createdAt: string }[];
  transactions: { id: string; type: string; points: number; amountValue: number | null; note: string | null; orderNumber: number | null; createdBy: string | null; createdAt: string }[];
};

const TXN_LABEL: Record<string, string> = {
  EARN: "كسب نقاط",
  REDEEM: "استخدام نقاط",
  ADJUSTMENT_ADD: "تعديل يدوي (+)",
  ADJUSTMENT_SUBTRACT: "تعديل يدوي (−)",
  EXPIRED: "انتهاء صلاحية",
  CANCELLED_REVERSAL: "إلغاء نقاط",
};

function dateLabel(v: string | null) {
  return v ? new Date(v).toLocaleDateString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}

export default function CustomersPage() {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const canEdit = canKey("customers.edit");
  const canAdjust = canKey("customers.adjust_points");

  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [denied, setDenied] = useState(false);

  const [details, setDetails] = useState<Details | null>(null);
  const [adjusting, setAdjusting] = useState<CustomerRow | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [busy, setBusy] = useState(false);
  // تعديل — edit name/notes dialog.
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{ customers: CustomerRow[]; stats: Stats }>(
        `/api/customers${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`
      );
      setRows(r.customers);
      setStats(r.stats);
    } catch {
      setDenied(true);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  async function openDetails(id: string) {
    try {
      setDetails(await api<Details>(`/api/customers/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    }
  }

  async function toggleActive(c: CustomerRow) {
    try {
      await api(`/api/customers/${c.id}`, { method: "PATCH", body: { isActive: !c.isActive } });
      toast.success(c.isActive ? "تم تعطيل العميل" : "تم تفعيل العميل");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التعديل");
    }
  }

  async function submitEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/customers/${editing.id}`, {
        method: "PATCH",
        body: { name: editName.trim(), notes: editNotes.trim() },
      });
      toast.success("تم حفظ بيانات العميل");
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function submitAdjust() {
    if (!adjusting) return;
    const delta = Math.trunc(Number(adjustDelta) || 0);
    if (!delta) return toast.error("اكتب عدد نقاط غير صفري");
    setBusy(true);
    try {
      await api(`/api/customers/${adjusting.id}/points`, {
        method: "POST",
        body: { delta, note: adjustNote.trim() || undefined },
      });
      toast.success("تم تعديل النقاط");
      setAdjusting(null); setAdjustDelta(""); setAdjustNote("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التعديل");
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
        ليس لديك صلاحية للوصول لبيانات العملاء
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">العملاء وبرنامج الولاء</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canKey("loyalty.settings_edit") && (
            <Button variant="outline" size="sm" onClick={() => (window.location.href = "/settings")}>
              ⚙️ إعدادات برنامج الولاء
            </Button>
          )}
          <Input
            placeholder="ابحث بالاسم أو رقم الموبايل…"
            className="w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Metrics */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["إجمالي العملاء", String(stats.totalCount)],
            ["عملاء جدد اليوم", String(stats.newToday)],
            ["عملاء متكررين", String(stats.repeatCount)],
            ["إجمالي النقاط الحالية", String(stats.currentPointsBalance)],
            ["نقاط مستخدمة", String(stats.totalPointsRedeemed)],
            ["أفضل عميل", stats.topSpenders[0]?.name ?? stats.topSpenders[0]?.normalizedPhone ?? "—"],
          ].map(([label, value]) => (
            <Card key={label}>
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-bold tabular-nums">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Top customers */}
      {stats && stats.topSpenders.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <p className="mb-2 text-sm font-semibold">🏆 أفضل العملاء (بالإنفاق)</p>
            <div className="flex flex-wrap gap-2">
              {stats.topSpenders.map((c, i) => (
                <button key={c.id} onClick={() => openDetails(c.id)}
                  className="rounded-full border bg-muted/40 px-3 py-1.5 text-xs hover:bg-accent">
                  {i + 1}. {c.name ?? c.normalizedPhone} — <b className="tabular-nums">{money(c.totalSpent, currency)}</b>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* List */}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">جاري التحميل…</p>
      ) : rows.length === 0 ? (
        <div className="space-y-1 rounded-xl border bg-card p-8 text-center">
          <p className="text-sm font-medium">لا يوجد عملاء حتى الآن</p>
          <p className="text-xs text-muted-foreground">
            سيتم إضافة العملاء تلقائيًا عند تسجيل رقم الموبايل في POS أو QR
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-start">الاسم</th>
                <th className="p-3 text-start">رقم الموبايل</th>
                <th className="p-3 text-start">رصيد النقاط</th>
                <th className="p-3 text-start">إجمالي الطلبات</th>
                <th className="p-3 text-start">إجمالي الإنفاق</th>
                <th className="p-3 text-start">آخر زيارة</th>
                <th className="p-3 text-start">الحالة</th>
                <th className="p-3 text-start">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="p-3 font-medium">{c.name ?? "—"}</td>
                  <td className="p-3 tabular-nums" dir="ltr">{c.phone}</td>
                  <td className="p-3 tabular-nums font-semibold">{c.loyaltyPointsBalance}</td>
                  <td className="p-3 tabular-nums">{c.totalOrders}</td>
                  <td className="p-3 tabular-nums">{money(c.totalSpent, currency)}</td>
                  <td className="p-3 text-xs">{dateLabel(c.lastOrderAt)}</td>
                  <td className="p-3">
                    <Badge variant={c.isActive ? "secondary" : "destructive"}>
                      {c.isActive ? "نشط" : "معطّل"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => openDetails(c.id)}>
                        عرض التفاصيل
                      </Button>
                      {canEdit && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => {
                          setEditing(c); setEditName(c.name ?? ""); setEditNotes("");
                        }}>
                          تعديل
                        </Button>
                      )}
                      {canAdjust && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAdjusting(c)}>
                          تعديل النقاط
                        </Button>
                      )}
                      {canEdit && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => toggleActive(c)}>
                          {c.isActive ? "تعطيل" : "تفعيل"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Details dialog */}
      <Dialog open={details !== null} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>بيانات العميل</DialogTitle>
          </DialogHeader>
          {details && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-muted/40 p-3 text-xs">
                <span>الاسم: <b>{details.customer.name ?? "—"}</b></span>
                <span dir="ltr" className="text-end">{details.customer.phone}</span>
                <span>رصيد النقاط: <b className="tabular-nums">{details.customer.loyaltyPointsBalance}</b></span>
                <span>إجمالي الإنفاق: <b className="tabular-nums">{money(details.customer.totalSpent, currency)}</b></span>
                <span>نقاط مكتسبة: <b className="tabular-nums">{details.customer.lifetimePointsEarned}</b></span>
                <span>نقاط مستخدمة: <b className="tabular-nums">{details.customer.lifetimePointsRedeemed}</b></span>
                <span>إجمالي الطلبات: <b className="tabular-nums">{details.customer.totalOrders}</b></span>
                <span>آخر زيارة: {dateLabel(details.customer.lastOrderAt)}</span>
              </div>

              <div>
                <p className="mb-1.5 text-sm font-semibold">سجل الطلبات</p>
                {details.orders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">لا توجد طلبات</p>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {details.orders.map((o) => (
                      <div key={o.id} className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs">
                        <span className="font-medium tabular-nums">#{o.orderNumber}</span>
                        <span className="text-muted-foreground">{dateLabel(o.createdAt)}</span>
                        {o.loyaltyPointsEarned > 0 && <span className="text-emerald-600">+{o.loyaltyPointsEarned} نقطة</span>}
                        {o.loyaltyPointsRedeemed > 0 && <span className="text-amber-600">−{o.loyaltyPointsRedeemed} نقطة</span>}
                        <b className="tabular-nums">{money(o.total, currency)}</b>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1.5 text-sm font-semibold">سجل معاملات النقاط</p>
                {details.transactions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">لا توجد معاملات نقاط</p>
                ) : (
                  <div className="max-h-52 overflow-auto rounded-lg border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 border-b bg-muted/60 text-muted-foreground">
                        <tr>
                          <th className="p-2 text-start">التاريخ</th>
                          <th className="p-2 text-start">النوع</th>
                          <th className="p-2 text-start">النقاط</th>
                          <th className="p-2 text-start">القيمة بالجنيه</th>
                          <th className="p-2 text-start">الطلب</th>
                          <th className="p-2 text-start">الموظف</th>
                          <th className="p-2 text-start">ملاحظة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.transactions.map((tx) => (
                          <tr key={tx.id} className="border-b last:border-0">
                            <td className="p-2 whitespace-nowrap text-muted-foreground">{dateLabel(tx.createdAt)}</td>
                            <td className="p-2 whitespace-nowrap">{TXN_LABEL[tx.type] ?? tx.type}</td>
                            <td className={`p-2 tabular-nums font-semibold ${tx.points >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                              {tx.points > 0 ? `+${tx.points}` : tx.points}
                            </td>
                            <td className="p-2 tabular-nums">{tx.amountValue !== null ? money(tx.amountValue, currency) : "—"}</td>
                            <td className="p-2 tabular-nums">{tx.orderNumber ? `#${tx.orderNumber}` : "—"}</td>
                            <td className="p-2">{tx.createdBy ?? "—"}</td>
                            <td className="max-w-32 truncate p-2 text-muted-foreground">{tx.note ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit customer */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تعديل بيانات العميل</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="rounded-lg bg-muted/40 p-2 text-sm" dir="ltr">{editing?.phone}</p>
            <div className="space-y-1.5">
              <Label>الاسم</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="اسم العميل" />
            </div>
            <div className="space-y-1.5">
              <Label>ملاحظات</Label>
              <Input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="ملاحظات داخلية" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>إلغاء</Button>
            <Button onClick={submitEdit} disabled={busy}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual points adjustment */}
      <Dialog open={adjusting !== null} onOpenChange={(o) => !o && !busy && setAdjusting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تعديل النقاط — {adjusting?.name ?? adjusting?.phone}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="rounded-lg bg-muted/40 p-2 text-sm">
              الرصيد الحالي: <b className="tabular-nums">{adjusting?.loyaltyPointsBalance}</b> نقطة
            </p>
            <div className="space-y-1.5">
              <Label>عدد النقاط (موجب للإضافة، سالب للخصم)</Label>
              <Input type="number" dir="ltr" value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder="مثلاً: 50 أو -20" />
            </div>
            <div className="space-y-1.5">
              <Label>السبب (اختياري)</Label>
              <Input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="مثلاً: تعويض عن مشكلة" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjusting(null)} disabled={busy}>إلغاء</Button>
            <Button onClick={submitAdjust} disabled={busy}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
