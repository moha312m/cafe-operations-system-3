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

// Order type picker plus the contextual fields each type needs:
// dine-in → table (required); takeaway → optional name;
// delivery → name (required) + phone/address.
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

  // Open-session hint: typing a table number that already has an open
  // bill shows "the order will be added to table X's bill".
  const [openTable, setOpenTable] = useState<{ table: string; sessionId: string } | null>(null);
  const tableNumber = details.tableNumber.trim();
  useEffect(() => {
    if (type !== "DINE_IN" || !tableNumber || !branchId) {
      setOpenTable(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api<{ sessions: { id: string; tableNumber: string }[] }>(
        `/api/tables?branchId=${branchId}&tableNumber=${encodeURIComponent(tableNumber)}`
      )
        .then((r) => {
          if (!stale) {
            const s = r.sessions[0];
            setOpenTable(s ? { table: s.tableNumber, sessionId: s.id } : null);
          }
        })
        .catch(() => !stale && setOpenTable(null)); // e.g. no tables.view permission
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [type, tableNumber, branchId]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => onTypeChange(t.value)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg border py-2 text-xs font-medium transition-colors",
              type === t.value
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-card hover:bg-accent"
            )}
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {type === "DINE_IN" && (
        <>
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
          {openTable && (
            <p className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-700 dark:text-blue-400">
              سيتم إضافة الطلب على حساب الترابيزة رقم {openTable.table} ·{" "}
              <Link href="/tables" className="font-semibold underline">
                عرض حساب الترابيزة
              </Link>
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
