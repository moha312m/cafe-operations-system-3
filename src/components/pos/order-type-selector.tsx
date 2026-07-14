"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
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
  onTypeChange,
  onDetailsChange,
}: {
  type: OrderType;
  details: CustomerDetails;
  onTypeChange: (type: OrderType) => void;
  onDetailsChange: (details: CustomerDetails) => void;
}) {
  const set = (patch: Partial<CustomerDetails>) =>
    onDetailsChange({ ...details, ...patch });

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
