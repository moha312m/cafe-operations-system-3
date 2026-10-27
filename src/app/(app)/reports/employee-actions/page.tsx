"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { useApp } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Person = { id: string; name: string };
type RequestRow = {
  id: string; action: string; status: string; amount: number | string; reason: string; createdAt: string;
  decidedAt: string | null; executedAt: string | null;
  requester: Person; decider: Person | null; executor: Person | null; owner: Person; branch: { name: string };
  order: { orderNumber: number } | null; orderItem: { productName: string; variantName: string | null } | null;
  events: { event: string; note: string | null; createdAt: string; actor: Person }[];
};
type Report = { requests: RequestRow[]; employees: Person[]; branches: { id: string; name: string }[]; range: { from: string; to: string } };
const actionName: Record<string, string> = { CANCEL_ORDER: "إلغاء طلب", VOID_ORDER_ITEM: "حذف صنف", REFUND_ORDER: "استرداد طلب", REFUND_PAYMENT: "استرداد دفعة" };
const statusName: Record<string, string> = { PENDING: "بانتظار الموافقة", APPROVED: "معتمد", EXECUTED: "تم التنفيذ", REJECTED: "مرفوض", STALE: "تغيرت البيانات", EXPIRED: "انتهت المهلة" };

export default function EmployeeActionsReportPage() {
  const { cafe } = useApp();
  const today = dateStrInTz(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ from, to });
      if (employeeId) query.set("employeeId", employeeId);
      if (branchId) query.set("branchId", branchId);
      setReport(await api<Report>(`/api/reports/employee-actions?${query}`));
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر تحميل التقرير"); }
  }, [from, to, employeeId, branchId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  return <div className="space-y-4">
    <div><h1 className="text-2xl font-semibold">تقرير مسؤولية الموظفين عن الإلغاء والاسترداد</h1><p className="text-sm text-muted-foreground">يعرض طالب الإجراء والمعتمد والمنفذ، مع وقت الطلب والسبب وحالة الإجراء.</p></div>
    <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-sm">من<Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="space-y-1 text-sm">إلى<Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <label className="space-y-1 text-sm">الموظف<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3"><option value="">كل الموظفين</option>{report?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
      <label className="space-y-1 text-sm">الفرع<select value={branchId} onChange={(event) => setBranchId(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3"><option value="">كل الفروع</option>{report?.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">الطلبات ({report?.requests.length ?? 0})</CardTitle></CardHeader><CardContent>
      {report?.requests.length ? <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow><TableHead>الوقت</TableHead><TableHead>الإجراء والسبب</TableHead><TableHead>القيمة</TableHead><TableHead>طالب الإجراء</TableHead><TableHead>المعتمد</TableHead><TableHead>المنفذ</TableHead><TableHead>الحالة</TableHead><TableHead>الفرع</TableHead></TableRow></TableHeader>
        <TableBody>{report.requests.map((row) => <TableRow key={row.id}>
          <TableCell className="whitespace-nowrap">{new Date(row.createdAt).toLocaleString("ar-EG")}</TableCell>
          <TableCell className="min-w-56">{actionName[row.action] ?? row.action}{row.order && ` #${row.order.orderNumber}`}{row.orderItem && ` · ${row.orderItem.productName}${row.orderItem.variantName ? ` (${row.orderItem.variantName})` : ""}`}<span className="block text-xs text-muted-foreground">{row.reason}</span></TableCell>
          <TableCell className="whitespace-nowrap">{money(Number(row.amount), cafe?.currency ?? "EGP")}</TableCell><TableCell>{row.requester.name}</TableCell><TableCell>{row.decider?.name ?? "—"}</TableCell><TableCell>{row.executor?.name ?? "—"}</TableCell><TableCell>{statusName[row.status] ?? row.status}</TableCell><TableCell>{row.branch.name}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div> : <p className="text-sm text-muted-foreground">لا توجد طلبات في الفترة المحددة.</p>}
    </CardContent></Card>
  </div>;
}
