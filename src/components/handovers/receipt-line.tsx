"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";

export function ReceiptLine({ name, busy, onConfirm }: { name: string; busy: boolean; onConfirm: (quantity: string, reason: string, note: string) => Promise<void> }) {
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [signedWithoutCount, setSignedWithoutCount] = useState(false);
  const valid = quantity.trim() !== "" && Number.isFinite(Number(quantity)) && Number(quantity) >= 0;
  return <div className="min-w-56 space-y-2 text-start">
    <label className="block">عدّ الاستلام — {name}<Input inputMode="decimal" aria-label={`عد الاستلام — ${name}`} value={quantity} onChange={e => { setQuantity(e.target.value); setSignedWithoutCount(false); }} disabled={busy} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={signedWithoutCount} disabled={busy || quantity.trim() !== ""} onChange={e => setSignedWithoutCount(e.target.checked)} />أوقّع دون عدّ مستقل (يسجل بدون كمية)</label>
    <ReasonCodeSelect domain="HANDOVER" value={reason} onChange={setReason} label="سبب الاعتراض عند وجود فرق" optional />
    <Textarea aria-label={`ملاحظة الاستلام — ${name}`} placeholder="ملاحظة الاستلام" value={note} onChange={e => setNote(e.target.value)} disabled={busy} />
    <Button size="sm" variant="outline" disabled={busy || (!valid && !signedWithoutCount)} data-testid="handover-acknowledge-confirm" onClick={() => void onConfirm(signedWithoutCount ? "" : quantity, reason, note)}>توقيع استلام السطر</Button>
  </div>;
}
