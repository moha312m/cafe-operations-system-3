"use client";
import { useEffect, useId, useState } from "react";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
type Reason = { id: string; label: string; code: string };
export function ReasonCodeSelect({ domain, value, onChange, label = "سبب الفرق", optional = false }: { domain: "STOCK" | "HANDOVER"; value: string; onChange: (value: string) => void; label?: string; optional?: boolean }) {
 const { canKey } = useApp(); const id = useId();
 const [reasons, setReasons] = useState<Reason[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
 const [adding, setAdding] = useState(false); const [newLabel, setNewLabel] = useState(""); const [saving, setSaving] = useState(false);
 useEffect(() => { let alive = true; setLoading(true); setError(""); setReasons([]);
  api<{ reasons: Reason[] }>(`/api/reason-codes?domain=${domain}`).then(r => { if (alive) setReasons(r.reasons); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : "تعذر تحميل الأسباب"); }).finally(() => { if (alive) setLoading(false); });
  return () => { alive = false; };
 }, [domain]);
 async function create() { if (!newLabel.trim()) return; setSaving(true); setError("");
  try { const r = await api<{ reason: Reason }>("/api/reason-codes", { method: "POST", body: { domain, label: newLabel.trim() } }); setReasons(current => [...current, r.reason]); onChange(r.reason.id); setAdding(false); setNewLabel(""); }
  catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ السبب"); } finally { setSaving(false); }
 }
 return <div className="space-y-2"><Label htmlFor={id}>{label}{optional ? " (اختياري)" : ""}</Label>
  <select id={id} aria-label={label} value={value} onChange={e => onChange(e.target.value)} disabled={loading || saving} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">
   <option value="">{loading ? "جارٍ تحميل الأسباب…" : optional ? "بدون سبب" : "اختر السبب"}</option>{reasons.map(reason => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
  </select>
  {!loading && !reasons.length && !error && <p className="text-xs text-muted-foreground">لم تُضَف أسباب بعد؛ يحتاج المسؤول عن الإعدادات إلى إضافة سبب.</p>}
  {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  {canKey("stock_count.configure") && !adding && <Button size="sm" type="button" variant="outline" onClick={() => setAdding(true)}>إضافة سبب</Button>}
  {adding && <div className="flex gap-2"><Input aria-label="اسم السبب الجديد" placeholder="اكتب سببًا واضحًا" value={newLabel} onChange={e => setNewLabel(e.target.value)} maxLength={200} /><Button type="button" size="sm" disabled={saving || !newLabel.trim()} onClick={create}>حفظ السبب</Button></div>}
 </div>;
}
