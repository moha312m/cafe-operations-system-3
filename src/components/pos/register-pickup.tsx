"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/components/app-shell";
import { CollectPaymentPanel } from "@/components/pos/collect-payment-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiRequestError, money } from "@/lib/client";
import type { OrderPage } from "@/lib/order-pages-client";
import { awaitPickupResponse, listPickupAttempts, PAID_AWAITING_HANDOFF, pickupAction, pickupSettled, readPickupAttempt, type PickupCollectionAttempt, type PickupOrderState } from "@/lib/register-pickup";

type Branch = { id: string; name: string };
type PickupRow = Omit<PickupOrderState, "status"> & {
  id: string; orderNumber: number; customerName: string | null; customer: { name: string | null } | null; branch: Branch;
};
const paymentLabels: Record<string, string> = { PAID: "مدفوع", PARTIAL: "مدفوع جزئيًا", PENDING_COLLECTION: "في انتظار التحصيل", UNPAID: "غير مدفوع" };

export function RegisterPickup({ active, branchId, branches, currency }: {
  active: boolean; branchId: string; branches: readonly Branch[]; currency: string;
}) {
  const { user, can, canKey } = useApp();
  const canChooseBranch = user.role === "CAFE_OWNER" && !user.branchId;
  const [branchChoice, setBranchChoice] = useState<string | null>(null);
  const scope = canChooseBranch ? (branchChoice ?? branchId) : (user.branchId ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<{ scope: string; query: string; cursors: (string | null)[] } | null>(null);
  const cursors = selection?.scope === scope && selection.query === query ? selection.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const [result, setResult] = useState<{ identity: string; page?: OrderPage<PickupRow>; error?: string } | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<PickupCollectionAttempt[]>([]);
  const [recoveryError, setRecoveryError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const flight = useRef(false);
  const [notice, setNotice] = useState<{ id: string; text: string; recoveryHref?: string } | null>(null);
  const identity = JSON.stringify([user.id, scope, query, cursor]);
  const canRead = can("orders:read");
  const permissions = { collect: can("payments:create") && canKey("pos.collect_payment"), serve: can("orders:update-status") };

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!active || !permissions.collect) return;
    const timer = setTimeout(() => {
      try { setRecoveries(listPickupAttempts(sessionStorage, user.id)); setRecoveryError(false); }
      catch { setRecoveries([]); setRecoveryError(true); }
    }, 0);
    return () => clearTimeout(timer);
  }, [active, permissions.collect, user.id, version]);

  useEffect(() => {
    if (!active || !canRead || (canChooseBranch ? branches.length === 0 : !scope)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ workspace: "pickup", pageSize: "30" });
    if (scope) params.set("branchId", scope);
    if (query) params.set("q", query);
    if (cursor) params.set("cursor", cursor);
    let reading = false;
    async function read() {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const page = await api<OrderPage<PickupRow>>(`/api/orders?${params}`, { signal: controller.signal, readTimeoutMs: 15_000 });
        if (!controller.signal.aborted) setResult({ identity, page });
      } catch (e) {
        if (!controller.signal.aborted) setResult({ identity, error: e instanceof Error ? e.message : "تعذر تحميل الطلبات" });
      } finally { reading = false; }
    }
    void read();
    const timer = !cursor && !dialog ? setInterval(read, 12_000) : undefined;
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, canRead, canChooseBranch, branches.length, scope, query, cursor, identity, version, dialog]);

  function refresh() { setVersion(value => value + 1); }

  async function handoff(row: PickupRow) {
    if (flight.current || !permissions.serve) return;
    if (permissions.collect) {
      try {
        if (readPickupAttempt(sessionStorage, user.id, row.id)) { setDialog(row.id); return; }
      } catch { /* A handoff-only route cannot charge or repeat a payment. */ }
    }
    flight.current = true;
    setPending(row.id);
    setNotice(null);
    try {
      await awaitPickupResponse(signal => api(`/api/orders/${encodeURIComponent(row.id)}/status`, { signal, method: "PATCH", body: { status: "SERVED", pickup: true } }));
      toast.success(`تم تسليم الطلب #${row.orderNumber}`);
    } catch (e) {
      const confirmed = await api<{ order: PickupOrderState }>(`/api/orders/${encodeURIComponent(row.id)}`, { readTimeoutMs: 10_000 }).catch(() => null);
      if (confirmed?.order.status === "SERVED") toast.success(`تم تسليم الطلب #${row.orderNumber}`);
      else {
        const reason = e instanceof Error ? e.message : "تعذر تأكيد التسليم";
        const code = e instanceof ApiRequestError ? (e.payload as { code?: unknown } | null)?.code : undefined;
        const custodyBlocked = code === "STOCK_CUSTODY_REQUIRED"
          || (e instanceof ApiRequestError && (e.status === 428 || (e.status === 409 && /عهدة/.test(reason))))
          || /عهدة/.test(reason);
        setNotice({
          id: row.id,
          text: confirmed?.order.status === "READY" && pickupSettled(confirmed.order)
            ? `${PAID_AWAITING_HANDOFF}. ${reason}` : reason,
          ...(custodyBlocked ? { recoveryHref: "/current-shift" } : {}),
        });
      }
    } finally {
      setPending(null);
      flight.current = false;
      refresh();
    }
  }

  if (!active) return null;
  const current = identity === result?.identity && search.trim() === query ? result : null;
  const page = current?.page;
  const visibleRecoveries = permissions.collect ? recoveries.filter(attempt => !!attempt.reference && (!scope ? canChooseBranch : attempt.reference.branchId === scope)) : [];
  return <section aria-label="استلام الطلبات" className="space-y-3 rounded-xl border bg-card p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-48 flex-1" value={search} maxLength={100}
        aria-label="ابحث برقم الطلب أو اسم العميل" placeholder="رقم الطلب أو اسم العميل" onChange={event => setSearch(event.target.value)} />
      {canChooseBranch && <label className="flex items-center gap-2 text-sm">الفرع
        <select className="h-9 rounded-md border bg-background px-2" value={scope} onChange={event => setBranchChoice(event.target.value)}>
          <option value="">كل الفروع</option>
          {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>}
      <Button variant="outline" onClick={refresh}>تحديث الطلبات</Button>
      <Button variant="ghost" render={<Link href="/orders" />}>سجل الطلبات</Button>
    </div>
    {recoveryError && permissions.collect && <p role="alert" className="text-sm text-destructive">تعذر قراءة سجل المحاولات على الجهاز. راجع الدفعات قبل تحصيل جديد.</p>}
    {visibleRecoveries.length > 0 && <section aria-label="محاولات التحصيل بانتظار التأكيد" className="space-y-2 rounded-lg border p-3">
      <p className="font-semibold">محاولات تحصيل بانتظار التأكيد</p>
      {visibleRecoveries.map(attempt => <div key={attempt.body.orderId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>طلب <bdi>#{attempt.reference!.orderNumber}</bdi>{!scope && ` · ${branches.find(branch => branch.id === attempt.reference!.branchId)?.name ?? "فرع الطلب"}`}</span>
        <Button variant="outline" disabled={!!pending} onClick={() => setDialog(attempt.body.orderId)}>تأكيد نتيجة التحصيل</Button>
      </div>)}
    </section>}
    {!canRead || (!canChooseBranch && !scope) ? <p role="alert">استلام الطلبات يتطلب صلاحية قراءة الطلبات وفرعًا محددًا.</p>
      : current?.error ? <p role="alert" className="text-destructive">{current.error}</p>
      : !page ? <p role="status">جاري تحميل الطلبات الجاهزة…</p>
      : !page.orders.length ? <p role="status">لا توجد طلبات جاهزة مطابقة.</p>
      : <ul className="divide-y rounded-lg border">
        {page.orders.map(row => {
          const action = pickupAction(row, permissions);
          return <li key={row.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold"><bdi>#{row.orderNumber}</bdi>{!scope && ` · ${row.branch.name}`}</p>
                {(row.customerName || row.customer?.name) && <p className="text-sm text-muted-foreground">{row.customerName || row.customer?.name}</p>}
              </div>
              <div className="text-sm">
                <p>{paymentLabels[row.paymentStatus] ?? row.paymentStatus}</p>
                <p>المتبقي: <bdi className="font-semibold">{money(Number(row.remainingAmount), currency)}</bdi></p>
              </div>
              {action === "handoff" ? <Button disabled={!!pending} onClick={() => void handoff(row)}>
                {pending === row.id ? "جاري التسليم…" : "تسليم الطلب"}
              </Button> : action ? <Button disabled={!!pending} onClick={() => setDialog(row.id)}>
                {action === "collect-and-handoff" ? "حصّل وسلّم" : "تحصيل الدفع"}
              </Button> : <p className="text-sm text-muted-foreground">الإجراء غير متاح بصلاحياتك الحالية</p>}
            </div>
            {notice?.id === row.id && <p role="alert" className="text-sm text-destructive">{notice.text}{notice.recoveryHref && <Link href={notice.recoveryHref} className="underline ms-2">مراجعة العهدة والشيفت</Link>}</p>}
          </li>;
        })}
      </ul>}
    {page && (cursor || page.pageInfo.nextCursor) && <div className="flex gap-2">
      <Button variant="outline" disabled={!cursor} onClick={() => setSelection({ scope, query, cursors: cursors.slice(0, -1) })}>السابق</Button>
      <Button variant="outline" disabled={!page.pageInfo.nextCursor} onClick={() => setSelection({ scope, query, cursors: [...cursors, page.pageInfo.nextCursor] })}>المزيد من الطلبات</Button>
    </div>}
    {dialog && <CollectPaymentPanel key={dialog} orderId={dialog} currency={currency}
      needsShift={permissions.collect}
      pickup={{ onChange: refresh }}
      onDone={() => { setDialog(null); refresh(); }} onClose={() => { setDialog(null); refresh(); }} />}
  </section>;
}
