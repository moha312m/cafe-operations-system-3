"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { api } from "@/lib/client";
import { TableInvoices } from "./table-invoices";
import type { OrderType } from "./types";

const TYPES: { value: OrderType; label: string; icon: string }[] = [
  { value: "DINE_IN", label: t.orderTypes.DINE_IN, icon: "🍽️" },
  { value: "TAKEAWAY", label: t.orderTypes.TAKEAWAY, icon: "🥡" },
  { value: "DELIVERY", label: t.orderTypes.DELIVERY, icon: "🛵" },
];

export type CustomerDetails = {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  tableNumber: string;
};

type SelectorTable = {
  id: string;
  tableNumber: string;
  displayName: string | null;
  area: string | null;
  seatsCount: number | null;
  session: { id: string; displayStatus: string; remainingAmount: number; startedAt: string } | null;
};

const STATUS: Record<string, { card: string; badge: string; label: string }> = {
  AVAILABLE:          { card: "border-emerald-500/40 hover:border-emerald-500/70", badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", label: "متاحة" },
  OCCUPIED:           { card: "border-blue-500/50", badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400", label: "مشغولة" },
  PENDING_COLLECTION: { card: "border-amber-500/50", badge: "bg-amber-500/12 text-amber-700 dark:text-amber-400", label: "في انتظار التحصيل" },
  PARTIAL:            { card: "border-violet-500/50", badge: "bg-violet-500/12 text-violet-700 dark:text-violet-400", label: "مدفوعة جزئيًا" },
  READY_TO_CLOSE:     { card: "border-emerald-500/50", badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", label: "جاهزة للقفل" },
};

function statusOf(tbl: SelectorTable) {
  return tbl.session ? (STATUS[tbl.session.displayStatus] ?? STATUS.OCCUPIED) : STATUS.AVAILABLE;
}

function sinceLabel(startedAt: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000), 0);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `منذ ${m} دقيقة`;
  if (h === 1) return `منذ ساعة${m ? ` و ${m} د` : ""}`;
  return `منذ ${h} ساعات${m ? ` و ${m} د` : ""}`;
}

// Order type picker (3 big cards). For dine-in the table is chosen through a
// modal so the cart panel stays short and stable.
export function OrderTypeSelector({
  type,
  details,
  branchId,
  tableReloadKey = 0,
  onTypeChange,
  onDetailsChange,
}: {
  type: OrderType;
  details: CustomerDetails;
  branchId?: string;
  tableReloadKey?: number;
  onTypeChange: (type: OrderType) => void;
  onDetailsChange: (details: CustomerDetails) => void;
}) {
  const set = (patch: Partial<CustomerDetails>) =>
    onDetailsChange({ ...details, ...patch });

  const [tables, setTables] = useState<SelectorTable[] | null>(null);
  const [allowCustom, setAllowCustom] = useState(false);
  const [manual, setManual] = useState(false);
  // Bumped after an in-place invoice change (payment/close) to refetch the grid.
  const [localReload, setLocalReload] = useState(0);

  useEffect(() => {
    if (type !== "DINE_IN" || !branchId) return;
    let stale = false;
    api<{ tables: SelectorTable[]; allowCustomTables: boolean }>(`/api/tables/selector?branchId=${branchId}`)
      .then((r) => { if (!stale) { setTables(r.tables); setAllowCustom(r.allowCustomTables); } })
      .catch(() => { if (!stale) { setTables([]); setAllowCustom(true); } });
    return () => { stale = true; };
  }, [type, branchId, tableReloadKey, localReload]);

  const selected = details.tableNumber.trim();
  const selectedTbl = tables?.find((x) => x.tableNumber === selected) ?? null;
  const selectedSession = selectedTbl?.session ?? null;

  return (
    <div className="space-y-3">
      {/* ── Order type: 3 big cards ── */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">نوع الطلب</p>
        <div className="grid grid-cols-3 gap-2">
          {TYPES.map((tp) => (
            <button
              key={tp.value}
              type="button"
              onClick={() => onTypeChange(tp.value)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl border-2 py-2.5 text-sm font-semibold transition-all",
                type === tp.value
                  ? "border-primary bg-primary text-primary-foreground shadow-sm"
                  : "border-border bg-card hover:border-primary/40 hover:bg-accent"
              )}
            >
              <span className="text-2xl leading-none">{tp.icon}</span>
              {tp.label}
            </button>
          ))}
        </div>
      </div>

      {type === "DINE_IN" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">اختر الترابيزة</p>
            {allowCustom && (
              <button type="button" onClick={() => setManual((v) => !v)}
                className="text-[11px] text-muted-foreground underline hover:text-foreground">
                {manual ? "اختيار من الشبكة" : "إدخال رقم يدوي"}
              </button>
            )}
          </div>

          {/* Direct visible table grid — no modal, no compact row. */}
          {tables === null ? (
            <p className="text-xs text-muted-foreground">جاري تحميل الترابيزات…</p>
          ) : manual ? (
            <Input placeholder={t.pos.tableNumber} dir="ltr" value={details.tableNumber} onChange={(e) => set({ tableNumber: e.target.value })} />
          ) : tables.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">لا توجد ترابيزات لهذا الفرع</p>
          ) : (
            <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pe-0.5 sm:grid-cols-3">
              {tables.map((tbl) => {
                const active = tbl.tableNumber === selected;
                const st = statusOf(tbl);
                return (
                  <button
                    key={tbl.id}
                    type="button"
                    onClick={() => set({ tableNumber: tbl.tableNumber })}
                    className={cn(
                      "flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border-2 p-2 text-center transition-all",
                      active
                        ? "border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm"
                        : cn("bg-card hover:shadow-sm", st.card)
                    )}
                  >
                    <span className="font-heading text-lg font-bold tabular-nums text-foreground">ترابيزة {tbl.tableNumber}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", st.badge)}>{st.label}</span>
                    {tbl.session && (
                      <span className="text-[10px] leading-tight text-muted-foreground">
                        المتبقي {tbl.session.remainingAmount} ج.م
                        <br />
                        {sinceLabel(tbl.session.startedAt)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Optional customer name */}
          <Input
            placeholder={t.pos.customerNameOptional}
            value={details.customerName}
            onChange={(e) => set({ customerName: e.target.value })}
          />

          {selectedSession ? (
            <p className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-blue-700 dark:text-blue-400">
              يوجد حساب مفتوح على الترابيزة رقم {selected}، سيتم إضافة الطلب على نفس الحساب.{" "}
              <Link href="/tables" className="font-semibold underline">عرض الحساب</Link>
            </p>
          ) : selected ? (
            <p className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
              سيتم فتح حساب جديد على الترابيزة رقم {selected}
            </p>
          ) : null}

          {/* فواتير الترابيزة — collapsible invoice cards for the selected table. */}
          {selected && branchId && (
            <TableInvoices
              branchId={branchId}
              tableNumber={selected}
              reloadKey={tableReloadKey + localReload}
              onChanged={() => setLocalReload((k) => k + 1)}
            />
          )}
        </div>
      )}

      {type === "TAKEAWAY" && (
        <Input
          placeholder={t.pos.customerNameOptional}
          value={details.customerName}
          onChange={(e) => set({ customerName: e.target.value })}
        />
      )}
      {type === "DELIVERY" && (
        <div className="space-y-2">
          {/* Phone lives in the customer/loyalty block below the selector. */}
          <Input
            placeholder={t.pos.customerNameRequired}
            value={details.customerName}
            onChange={(e) => set({ customerName: e.target.value })}
          />
          <Input
            placeholder={t.pos.deliveryAddress}
            value={details.deliveryAddress}
            onChange={(e) => set({ deliveryAddress: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
