"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/components/app-shell";

type ActionRequest = {
  id: string; action: "CANCEL_ORDER" | "VOID_ORDER_ITEM" | "REFUND_ORDER" | "REFUND_PAYMENT";
  status: string; mode: string; reason: string; amount: number | string; createdAt: string;
  requester: { id: string; name: string }; owner: { id: string; name: string };
  decider: { id: string; name: string } | null; executor: { id: string; name: string } | null;
  branch: { id: string; name: string }; targetOrderId: string | null; targetOrderItemId: string | null;
};
const actionNames: Record<ActionRequest["action"], string> = {
  CANCEL_ORDER: "إلغاء طلب", VOID_ORDER_ITEM: "حذف صنف من طلب",
  REFUND_ORDER: "استرداد طلب", REFUND_PAYMENT: "استرداد دفعة",
};
const statusNames: Record<string, string> = {
  PENDING: "بانتظار الاعتماد", APPROVED: "معتمد وينتظر التنفيذ", EXECUTED: "تم التنفيذ",
  REJECTED: "مرفوض", STALE: "تغيرت البيانات ويحتاج طلبًا جديدًا", EXPIRED: "انتهت المهلة",
};

export function OwnerActionQueue() {
  const { user, cafe } = useApp();
  const [requests, setRequests] = useState<ActionRequest[]>([]);
  const [passcodes, setPasscodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { setRequests((await api<{ requests: ActionRequest[] }>("/api/owner-action-requests")).requests); }
    catch { /* The server hides this panel when the user has no permission. */ }
  }, []);
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = setInterval(load, 15000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [load]);
  if (!requests.length) return null;

  async function run(request: ActionRequest, action: "ACCEPT" | "REJECT" | "PASSCODE" | "EXECUTE") {
    setBusy(request.id);
    try {
      if (action === "ACCEPT" || action === "REJECT") {
        await api(`/api/owner-action-requests/${request.id}/decision`, { method: "POST", body: { decision: action } });
        toast.success(action === "ACCEPT" ? "تم اعتماد الطلب؛ ما زال يحتاج التنفيذ" : "تم رفض الطلب");
      } else if (action === "PASSCODE") {
        await api(`/api/owner-action-requests/${request.id}/passcode`, { method: "POST", body: { passcode: passcodes[request.id] ?? "" } });
        setPasscodes((current) => ({ ...current, [request.id]: "" })); toast.success("تم الاعتماد بالباسكود؛ نفّذ الطلب الآن");
      } else {
        await api(`/api/owner-action-requests/${request.id}/execute`, { method: "POST", body: { idempotencyKey: crypto.randomUUID() } });
        toast.success("تم تنفيذ الإجراء وتسجيل منفذه");
      }
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر تنفيذ الإجراء"); }
    finally { setBusy(""); }
  }

  return <section className="space-y-3">
    <div><h2 className="text-lg font-semibold">طلبات إلغاء الأصناف والاسترداد</h2><p className="text-sm text-muted-foreground">كل طلب يسجل الموظف الطالب، المعتمد، والمنفذ كلٌ على حدة.</p></div>
    <div className="grid gap-3 lg:grid-cols-2">{requests.map((request) => <Card key={request.id}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><strong>{actionNames[request.action]}</strong><Badge variant={request.status === "PENDING" ? "destructive" : "secondary"}>{statusNames[request.status] ?? request.status}</Badge></div><span className="font-semibold tabular-nums">{money(Number(request.amount), cafe?.currency ?? "EGP")}</span></div>
        <p className="text-sm">{request.reason}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
          <div>الطالب: {request.requester.name}</div><div>الفرع: {request.branch.name}</div><div>وقت الطلب: {new Date(request.createdAt).toLocaleString("ar-EG")}</div>
          <div>المعتمد: {request.decider?.name ?? "—"}</div><div>المنفذ: {request.executor?.name ?? "—"}</div><div>المالك: {request.owner.name}</div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          {request.status === "PENDING" && user.id === request.owner.id && request.mode !== "OWNER_PASSCODE" && <>
            <Button size="sm" disabled={!!busy} onClick={() => run(request, "ACCEPT")}>اعتماد</Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(request, "REJECT")}>رفض</Button>
          </>}
          {request.status === "PENDING" && user.id === request.requester.id && request.mode !== "OWNER_REQUEST" && <>
            <Input className="max-w-40" type="password" inputMode="numeric" autoComplete="off" placeholder="باسكود المالك" value={passcodes[request.id] ?? ""} onChange={(event) => setPasscodes((current) => ({ ...current, [request.id]: event.target.value }))} />
            <Button size="sm" variant="outline" disabled={!!busy || !(passcodes[request.id] ?? "")} onClick={() => run(request, "PASSCODE")}>اعتماد بالباسكود</Button>
          </>}
          {request.status === "APPROVED" && user.id === request.requester.id && <Button size="sm" disabled={!!busy} onClick={() => run(request, "EXECUTE")}>تنفيذ الإجراء</Button>}
        </div>
      </CardContent>
    </Card>)}</div>
  </section>;
}
