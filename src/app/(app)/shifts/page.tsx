"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ShiftRow = {
  id: string;
  shiftNumber: number;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  totalSales: string;
  expectedCashAmount: string;
  actualCashAmount: string | null;
  cashDifference: string | null;
  cashier: { name: string };
  branch: { name: string };
};

type Branch = { id: string; name: string };

type ShiftDetail = {
  shift: ShiftRow & {
    openingCashAmount: string;
    totalCashSales: string;
    totalCardSales: string;
    totalWalletSales: string;
    totalDiscounts: string;
    totalRefunds: string;
    orderCount: number;
    notes: string | null;
  };
  orders: { id: string; orderNumber: number; total: string; status: string }[];
  payments: {
    id: string;
    amount: string;
    method: string;
    status: string;
    order: { orderNumber: number } | null;
  }[];
  refunds: { id: string; amount: string; method: string }[];
  auditLogs: { id: string; action: string; createdAt: string; user: { name: string } | null }[];
};

const fmtTime = (v: string) =>
  new Date(v).toLocaleString("ar-EG", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function diffBadge(diff: string | null) {
  if (diff === null) return <span className="text-muted-foreground">—</span>;
  const n = Number(diff);
  if (Math.abs(n) < 0.01)
    return <span className="text-emerald-600">{t.shifts.matched}</span>;
  return (
    <span className={n > 0 ? "text-sky-600" : "text-red-600"}>
      {n > 0 ? "+" : ""}
      {n.toFixed(2)}
    </span>
  );
}

export default function ShiftReportsPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "USD";

  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [date, setDate] = useState("");
  const [status, setStatus] = useState("ALL");
  const [branchId, setBranchId] = useState("ALL");
  const [detail, setDetail] = useState<ShiftDetail | null>(null);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches")
        .then((r) => setBranches(r.branches))
        .catch(() => {});
    }
  }, [user.branchId]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (status !== "ALL") params.set("status", status);
    if (branchId !== "ALL") params.set("branchId", branchId);
    try {
      const { shifts } = await api<{ shifts: ShiftRow[] }>(
        `/api/shifts?${params.toString()}`
      );
      setShifts(shifts);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الشيفتات");
    }
  }, [date, status, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDetail(id: string) {
    try {
      setDetail(await api<ShiftDetail>(`/api/shifts/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الشيفت");
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t.shifts.reports}</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          className="w-44"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Select value={status} onValueChange={(v) => setStatus(v ?? "ALL")}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">كل الحالات</SelectItem>
            <SelectItem value="OPEN">{t.shiftStatus.OPEN}</SelectItem>
            <SelectItem value="CLOSED">{t.shiftStatus.CLOSED}</SelectItem>
          </SelectContent>
        </Select>
        {!user.branchId && branches.length > 0 && (
          <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "ALL")}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder={t.shifts.branch} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">كل الفروع</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.shifts.shiftNumber}</TableHead>
              <TableHead>{t.shifts.cashier}</TableHead>
              <TableHead>{t.shifts.branch}</TableHead>
              <TableHead>{t.shifts.openedAt}</TableHead>
              <TableHead>{t.shifts.closedAt}</TableHead>
              <TableHead className="text-end">{t.shifts.totalSales}</TableHead>
              <TableHead className="text-end">{t.shifts.expectedCash}</TableHead>
              <TableHead className="text-end">{t.shifts.actualCash}</TableHead>
              <TableHead className="text-end">{t.shifts.difference}</TableHead>
              <TableHead>{t.shifts.status}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shifts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-muted-foreground">
                  مفيش شيفتات
                </TableCell>
              </TableRow>
            ) : (
              shifts.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">#{s.shiftNumber}</TableCell>
                  <TableCell>{s.cashier.name}</TableCell>
                  <TableCell>{s.branch.name}</TableCell>
                  <TableCell className="text-xs">{fmtTime(s.openedAt)}</TableCell>
                  <TableCell className="text-xs">
                    {s.closedAt ? fmtTime(s.closedAt) : "—"}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {money(s.totalSales, currency)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {money(s.expectedCashAmount, currency)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {s.actualCashAmount ? money(s.actualCashAmount, currency) : "—"}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {diffBadge(s.cashDifference)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "OPEN" ? "default" : "secondary"}>
                      {t.shiftStatus[s.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => openDetail(s.id)}>
                      تفاصيل
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t.shifts.details} #{detail.shift.shiftNumber} — {detail.shift.cashier.name}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 p-3">
                  {[
                    [t.shifts.openingCash, money(detail.shift.openingCashAmount, currency)],
                    [t.shifts.cashSales, money(detail.shift.totalCashSales, currency)],
                    [t.shifts.cardSales, money(detail.shift.totalCardSales, currency)],
                    [t.shifts.walletSales, money(detail.shift.totalWalletSales, currency)],
                    [t.shifts.discounts, money(detail.shift.totalDiscounts, currency)],
                    [t.shifts.refunds, money(detail.shift.totalRefunds, currency)],
                    [t.shifts.orderCount, String(detail.shift.orderCount)],
                    [t.shifts.expectedCash, money(detail.shift.expectedCashAmount, currency)],
                    [
                      t.shifts.actualCash,
                      detail.shift.actualCashAmount
                        ? money(detail.shift.actualCashAmount, currency)
                        : "—",
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ))}
                  <div className="col-span-2 flex justify-between border-t pt-1.5 font-semibold">
                    <dt>{t.shifts.difference}</dt>
                    <dd>{diffBadge(detail.shift.cashDifference)}</dd>
                  </div>
                </dl>

                {detail.shift.notes && (
                  <p className="text-muted-foreground">
                    {t.shifts.notes}: {detail.shift.notes}
                  </p>
                )}

                <Section title={`${t.shifts.ordersInShift} (${detail.orders.length})`}>
                  {detail.orders.map((o) => (
                    <div key={o.id} className="flex justify-between">
                      <span>طلب #{o.orderNumber}</span>
                      <span className="tabular-nums">{money(o.total, currency)}</span>
                    </div>
                  ))}
                </Section>

                <Section title={`${t.shifts.payments} (${detail.payments.length})`}>
                  {detail.payments.map((p) => (
                    <div key={p.id} className="flex justify-between">
                      <span>
                        {t.paymentMethods[p.method as keyof typeof t.paymentMethods] ?? p.method}
                        {p.order ? ` · طلب #${p.order.orderNumber}` : ""}
                        {p.status === "REFUNDED" ? ` · ${t.paymentStatus.REFUNDED}` : ""}
                      </span>
                      <span className="tabular-nums">{money(p.amount, currency)}</span>
                    </div>
                  ))}
                </Section>

                <Section title={`${t.shifts.auditTrail} (${detail.auditLogs.length})`}>
                  {detail.auditLogs.map((a) => (
                    <div key={a.id} className="flex justify-between text-xs">
                      <span>{a.action}</span>
                      <span className="text-muted-foreground">
                        {a.user?.name ?? "—"} · {fmtTime(a.createdAt)}
                      </span>
                    </div>
                  ))}
                </Section>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div>
      <h3 className="mb-1.5 font-semibold">{title}</h3>
      <div className="space-y-1 rounded-lg border p-2">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">لا يوجد</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
