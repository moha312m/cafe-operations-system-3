"use client";

import { money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

export type CustomerOrderDetails = {
  customerName: string;
  customerPhone: string;
  tableNumber: string;
  notes: string;
};

// Checkout form: table (locked when it came from the QR link), name,
// phone, order notes, totals, submit.
export function CustomerOrderForm({
  details,
  tableLocked,
  currency,
  subtotal,
  taxRate,
  total,
  submitting,
  error,
  onChange,
  onSubmit,
}: {
  details: CustomerOrderDetails;
  tableLocked: boolean;
  currency: string;
  subtotal: number;
  taxRate: number;
  total: number;
  submitting: boolean;
  error: string | null;
  onChange: (details: CustomerOrderDetails) => void;
  onSubmit: () => void;
}) {
  const set = (patch: Partial<CustomerOrderDetails>) =>
    onChange({ ...details, ...patch });
  const valid = details.customerName.trim().length >= 2;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">رقم الترابيزة</Label>
          <Input
            value={details.tableNumber}
            disabled={tableLocked}
            placeholder="مثلاً: 5"
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
            value={details.customerName}
            placeholder="اسمك"
            onChange={(e) => set({ customerName: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">رقم الموبايل (اختياري)</Label>
        <Input
          dir="ltr"
          inputMode="tel"
          placeholder="01xx xxx xxxx"
          value={details.customerPhone}
          onChange={(e) => set({ customerPhone: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">ملاحظات</Label>
        <Textarea
          rows={2}
          placeholder="أي ملاحظات على الطلب كله"
          value={details.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>

      <Separator />
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">الإجمالي قبل الضريبة</span>
          <span className="tabular-nums">{money(subtotal, currency)}</span>
        </div>
        {taxRate > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">الضريبة ({taxRate}٪)</span>
            <span className="tabular-nums">{money(total - subtotal, currency)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-bold">
          <span>الإجمالي</span>
          <span className="tabular-nums">{money(total, currency)}</span>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        size="lg"
        className="h-12 w-full text-base font-semibold"
        disabled={!valid || submitting}
        onClick={onSubmit}
      >
        {submitting ? "جاري الإرسال…" : "إرسال الطلب"}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">
        الطلب هيوصل للويتر للمراجعة قبل التحضير — الدفع عند التسليم.
      </p>
    </div>
  );
}
