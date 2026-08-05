"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { api } from "@/lib/client";
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

const STATUS_TONE: Record<string, string> = {
  OCCUPIED: "border-blue-500/50 bg-blue-500/10",
  PENDING_COLLECTION: "border-amber-500/50 bg-amber-500/10",
  PARTIAL: "border-violet-500/50 bg-violet-500/10",
  READY_TO_CLOSE: "border-emerald-500/50 bg-emerald-500/10",
};
const STATUS_LABEL: Record<string, string> = {
  OCCUPIED: "مشغولة", PENDING_COLLECTION: "في انتظار التحصيل",
  PARTIAL: "مدفوعة جزئيًا", READY_TO_CLOSE: "جاهزة للقفل",
};

function sinceLabel(startedAt: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000), 0);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `منذ ${m} دقيقة`;
  if (h === 1) return `منذ ساعة${m ? ` و ${m} د` : ""}`;
  return `منذ ${h} ساعات${m ? ` و ${m} د` : ""}`;
}

// Order type picker plus the contextual fields each type needs:
// dine-in → visual table selector (configured tables); takeaway → optional
// name; delivery → name (required) + phone/address.
export function OrderTypeSelector({
  type,
  details,
  branchId,
  onTypeChange,
  onDetailsChange,
}: {
  type: OrderType;
  details: CustomerDetails;
  branchId?: string;
  onTypeChange: (type: OrderType) => void;
  onDetailsChange: (details: CustomerDetails) => void;
}) {
  const set = (patch: Partial<CustomerDetails>) =>
    onDetailsChange({ ...details, ...patch });

  const [tables, setTables] = useState<SelectorTable[] | null>(null);
  const [allowCustom, setAllowCustom] = useState(true);

  // Load the branch's configured tables for the visual picker.
  useEffect(() => {
    if (type !== "DINE_IN" || !branchId) return;
    let stale = false;
    api<{ tables: SelectorTable[]; allowCustomTables: boolean }>(`/api/tables/selector?branchId=${branchId}`)
      .then((r) => { if (!stale) { setTables(r.tables); setAllowCustom(r.allowCustomTables); } })
      .catch(() => { if (!stale) { setTables([]); setAllowCustom(true); } }); // no permission/feature → manual only
    return () => { stale = true; };
  }, [type, branchId]);

  const selected = details.tableNumber.trim();
  const selectedSession = tables?.find((x) => x.tableNumber === selected)?.session ?? null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {TYPES.map((tp) => (
          <button
            key={tp.value}
            type="button"
            onClick={() => onTypeChange(tp.value)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg border py-2 text-xs font-medium transition-colors",
              type === tp.value
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-card hover:bg-accent"
            )}
          >
            <span className="text-base leading-none">{tp.icon}</span>
            {tp.label}
          </button>
        ))}
      </div>

      {type === "DINE_IN" && (
        <>
          {/* Visual table selector */}
          {tables && tables.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">اختر الترابيزة</p>
              <div className="grid max-h-44 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-5">
                {tables.map((tbl) => {
                  const active = tbl.tableNumber === selected;
                  const tone = tbl.session ? STATUS_TONE[tbl.session.displayStatus] ?? "" : "";
                  return (
                    <button
                      key={tbl.id}
                      type="button"
                      onClick={() => set({ tableNumber: tbl.tableNumber })}
                      title={tbl.session ? STATUS_LABEL[tbl.session.displayStatus] : "متاحة"}
                      className={cn(
                        "flex flex-col items-center gap-0.5 rounded-lg border-2 px-1 py-1.5 text-xs transition-colors",
                        active ? "border-primary ring-2 ring-primary/30" : tone || "border-border hover:bg-accent"
                      )}
                    >
                      <span className="font-bold tabular-nums">{tbl.tableNumber}</span>
                      {tbl.session && <span className="size-1.5 rounded-full bg-current opacity-60" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : tables && tables.length === 0 && !allowCustom ? (
            <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
              لم يتم إنشاء ترابيزات لهذا الفرع بعد ·{" "}
              <Link href="/tables/setup" className="font-semibold underline">إنشاء ترابيزات الآن</Link>
            </p>
          ) : null}

          {/* Manual table number — only if the cafe allows custom tables. */}
          {allowCustom && (
            <div className="flex gap-2">
              <Input
                placeholder={t.pos.tableNumber}
                className="w-32"
                value={details.tableNumber}
                onChange={(e) => set({ tableNumber: e.target.value })}
              />
              <Input
                placeholder={t.pos.customerNameOptional}
                value={details.customerName}
                onChange={(e) => set({ customerName: e.target.value })}
              />
            </div>
          )}
          {!allowCustom && (
            <Input
              placeholder={t.pos.customerNameOptional}
              value={details.customerName}
              onChange={(e) => set({ customerName: e.target.value })}
            />
          )}

          {/* Open-bill hint for the selected table. */}
          {selectedSession && (
            <p className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-700 dark:text-blue-400">
              سيتم إضافة الطلب على حساب الترابيزة رقم {selected} · يوجد حساب مفتوح · المتبقي {selectedSession.remainingAmount} ج.م · {sinceLabel(selectedSession.startedAt)}{" "}
              <Link href="/tables" className="font-semibold underline">عرض حساب الترابيزة</Link>
            </p>
          )}
        </>
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
          <div className="flex gap-2">
            <Input
              placeholder={t.pos.customerNameRequired}
              value={details.customerName}
              onChange={(e) => set({ customerName: e.target.value })}
            />
            <Input
              placeholder={t.common.phone}
              className="w-32"
              value={details.customerPhone}
              onChange={(e) => set({ customerPhone: e.target.value })}
            />
          </div>
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
