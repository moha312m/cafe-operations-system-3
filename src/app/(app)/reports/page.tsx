"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Report = {
  date: string;
  totals: {
    orders: number;
    cancelled: number;
    gross: number;
    discounts: number;
    tax: number;
    revenue: number;
    avgOrderValue: number;
  };
  shifts: { open: number; closed: number; cashDifferenceTotal: number };
  byPaymentMethod: { method: string; amount: number; count: number }[];
  byBranch: { branchId: string; branchName: string; revenue: number; orders: number }[];
  byCashier: { cashierId: string; cashierName: string; amount: number; count: number }[];
  items: { product: string; variant: string | null; quantity: number; revenue: number }[];
};

const METHOD_LABELS: Record<string, string> = {
  CASH: "كاش",
  CARD: "فيزا",
  WALLET: "محفظة",
  MIXED: "مختلط",
};

export default function ReportsPage() {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "USD";
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api<Report>(`/api/reports/daily?date=${date}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل التقرير");
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">تقرير قفلة اليوم</h1>
        <Input
          type="date"
          className="w-44"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {report && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "مبيعات اليوم", value: money(report.totals.revenue, currency) },
              { label: "عدد الطلبات", value: String(report.totals.orders) },
              { label: "متوسط قيمة الطلب", value: money(report.totals.avgOrderValue, currency) },
              { label: "الخصومات", value: money(report.totals.discounts, currency) },
              { label: "الشيفتات المفتوحة", value: String(report.shifts.open) },
              { label: "الشيفتات المقفولة", value: String(report.shifts.closed) },
              {
                label: "فروقات الكاش",
                value: money(report.shifts.cashDifferenceTotal, currency),
              },
              { label: "الضريبة المحصّلة", value: money(report.totals.tax, currency) },
            ].map((stat) => (
              <Card key={stat.label}>
                <CardHeader className="pb-1">
                  <CardTitle className="text-sm font-normal text-muted-foreground">
                    {stat.label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">المدفوعات حسب الطريقة</CardTitle>
              </CardHeader>
              <CardContent>
                {report.byPaymentMethod.length === 0 ? (
                  <p className="text-sm text-muted-foreground">مفيش مدفوعات.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الطريقة</TableHead>
                        <TableHead className="text-end">عدد العمليات</TableHead>
                        <TableHead className="text-end">المبلغ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.byPaymentMethod.map((p) => (
                        <TableRow key={p.method}>
                          <TableCell>{METHOD_LABELS[p.method] ?? p.method}</TableCell>
                          <TableCell className="text-end tabular-nums">{p.count}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {money(p.amount, currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">المبيعات حسب الفرع</CardTitle>
              </CardHeader>
              <CardContent>
                {report.byBranch.length === 0 ? (
                  <p className="text-sm text-muted-foreground">مفيش طلبات مكتملة.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الفرع</TableHead>
                        <TableHead className="text-end">الطلبات</TableHead>
                        <TableHead className="text-end">المبيعات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.byBranch.map((b) => (
                        <TableRow key={b.branchId}>
                          <TableCell>{b.branchName}</TableCell>
                          <TableCell className="text-end tabular-nums">{b.orders}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {money(b.revenue, currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">مبيعات كل كاشير</CardTitle>
            </CardHeader>
            <CardContent>
              {report.byCashier.length === 0 ? (
                <p className="text-sm text-muted-foreground">مفيش مبيعات.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>الكاشير</TableHead>
                      <TableHead className="text-end">عدد العمليات</TableHead>
                      <TableHead className="text-end">المبلغ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byCashier.map((c) => (
                      <TableRow key={c.cashierId}>
                        <TableCell>{c.cashierName}</TableCell>
                        <TableCell className="text-end tabular-nums">{c.count}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {money(c.amount, currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">مبيعات الأصناف</CardTitle>
            </CardHeader>
            <CardContent>
              {report.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">مفيش أصناف اتباعت.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>المنتج</TableHead>
                      <TableHead>الحجم</TableHead>
                      <TableHead className="text-end">الكمية</TableHead>
                      <TableHead className="text-end">المبيعات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{item.product}</TableCell>
                        <TableCell>{item.variant ?? "—"}</TableCell>
                        <TableCell className="text-end tabular-nums">{item.quantity}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {money(item.revenue, currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {report.totals.cancelled > 0 && (
            <p className="text-sm text-muted-foreground">
              عدد {report.totals.cancelled} طلب اتلغى في اليوم ده.
            </p>
          )}
        </>
      )}
    </div>
  );
}
