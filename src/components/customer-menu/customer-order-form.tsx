"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type CustomerOrderDetails = {
  customerName: string;
  customerPhone: string;
  tableNumber: string;
  notes: string;
};

// Checkout fields: table (locked when it came from the QR link), name,
// phone, order notes. Totals + submit live in the sheet's pinned footer.
export function CustomerOrderForm({
  details,
  tableLocked,
  phoneRequired = false,
  onChange,
}: {
  details: CustomerOrderDetails;
  tableLocked: boolean;
  phoneRequired?: boolean;
  onChange: (details: CustomerOrderDetails) => void;
}) {
  const set = (patch: Partial<CustomerOrderDetails>) =>
    onChange({ ...details, ...patch });

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-semibold">بيانات الطلب</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">رقم الترابيزة</Label>
          <Input
            className="h-11"
            value={details.tableNumber}
            disabled={tableLocked}
            readOnly={tableLocked}
            placeholder="مثلاً: 5"
            inputMode="numeric"
            onChange={(e) => set({ tableNumber: e.target.value })}
          />
          {tableLocked && (
            <p className="text-[11px] text-muted-foreground">
              اتحدد من كود الترابيزة
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">اسم العميل *</Label>
          <Input
            className="h-11"
            value={details.customerName}
            placeholder="اسمك"
            autoComplete="name"
            onChange={(e) => set({ customerName: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">
          {phoneRequired ? "رقم الموبايل *" : "رقم الموبايل (اختياري)"}
        </Label>
        <Input
          className="h-11"
          dir="ltr"
          inputMode="tel"
          autoComplete="tel"
          placeholder="01xx xxx xxxx"
          value={details.customerPhone}
          onChange={(e) => set({ customerPhone: e.target.value })}
        />
        {phoneRequired && (
          <p className="text-[11px] text-muted-foreground">
            رقم الموبايل مطلوب عشان نضيف نقاط الولاء على طلبك.
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">ملاحظات الطلب</Label>
        <Textarea
          rows={2}
          placeholder="أي ملاحظات على الطلب كله"
          value={details.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        الطلب هيوصل للكافيه للمراجعة — الدفع عند التسليم.
      </p>
    </div>
  );
}
