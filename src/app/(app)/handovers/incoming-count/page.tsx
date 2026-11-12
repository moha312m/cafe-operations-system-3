"use client";
// «جرد الاستلام» — the arriving employee's own blind count (stock handover v2).
// The outgoing figures are never fetched here before this count is submitted.
// Counting never waits for anything and never changes stock: it is a record,
// compared afterwards for the manager and owner.
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Item = { id: string; name: string; unit: string; isCritical: boolean; counted: { quantity: string; revision: number; countedAt: string } | null };
type View = {
  handoverId: string; status: string;
  count: { id: string; startedAt: string; submittedAt: string | null } | null;
  items: Item[];
  comparison: { lines: { inventoryItemId: string; itemName: string; label: string; raw: string | null; adjusted: string | null }[]; adjustedDifferenceCount: number; rawDifferenceCount: number } | null;
};
const LABEL: Record<string, string> = { NO_DIFFERENCE: "مطابق", EXPLAINED_BY_MOVEMENTS: "فرق مفسَّر بحركات", UNEXPLAINED: "فرق غير مفسَّر", UNAVAILABLE: "غير متاح" };
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function IncomingCount() {
  const handoverId = useSearchParams().get("handoverId") ?? "";
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!handoverId) return;
    try { setView(await api<View>(`/api/handovers/${handoverId}/incoming-count`)); }
    catch (error) { toast.error((error as Error).message); }
  }, [handoverId]);
  useEffect(() => { void load(); }, [load]);

  const post = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try { return await api<Record<string, unknown>>(`/api/handovers/${handoverId}/incoming-count`, { method: "POST", idempotencyKey: newKey(), body }); }
    catch (error) { toast.error((error as Error).message); return null; }
    finally { setBusy(null); }
  };

  const visible = useMemo(() => (view?.items ?? []).filter((i) => !filter || i.name.includes(filter)), [view, filter]);
  if (!handoverId) return <p className="p-4 text-sm">افتح جرد الاستلام من صفحة التسليم.</p>;
  if (!view) return <p className="p-4 text-sm text-muted-foreground">بيحمّل…</p>;
  const submitted = !!view.count?.submittedAt;
  const counted = view.items.filter((i) => i.counted).length;

  return (
    <div dir="rtl" className="mx-auto max-w-2xl space-y-3 p-3">
      <header>
        <h1 className="text-xl font-bold">جرد الاستلام</h1>
        <p className="text-sm text-muted-foreground">عدّ اللي قدامك بنفسك. مش هتشوف عدّ الموظف اللي قبلك غير بعد ما تقدّم جردك. الجرد ده مابيوقفش البيع ومابيغيرش رصيد المخزن.</p>
      </header>

      {!view.count ? (
        <Button className="w-full" disabled={!!busy} onClick={async () => { if (await post({ action: "start" }, "start")) await load(); }}>ابدأ جرد الاستلام</Button>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-lg border p-2 text-sm">
            <span>اتعدّ {counted} من {view.items.length}</span>
            {submitted ? <span className="font-semibold text-emerald-700">اتقدّم</span> : <span className="text-muted-foreground">لسه ماتقدّمش</span>}
          </div>
          <Input placeholder="دوّر على صنف" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="space-y-2">
            {visible.map((item) => {
              const value = draft[item.id] ?? "";
              const changing = submitted && item.counted && value !== "" && value !== item.counted.quantity;
              return (
                <li key={item.id} className="rounded-lg border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.name} <span className="text-xs text-muted-foreground">({item.unit})</span>{item.isCritical && <span className="ms-1 text-xs text-red-700">مهم</span>}</span>
                    {item.counted && <span className="text-sm tabular-nums">{Number(item.counted.quantity).toLocaleString("ar-EG", { maximumFractionDigits: 3 })}{item.counted.revision > 1 && <span className="text-xs text-muted-foreground"> (تعديل {item.counted.revision - 1})</span>}</span>}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Input inputMode="decimal" placeholder={item.counted ? "عدّل الكمية" : "الكمية"} value={value} onChange={(e) => setDraft({ ...draft, [item.id]: e.target.value })} />
                    <Button variant="outline" disabled={!value || busy === item.id || (submitted && !reason[item.id]?.trim())}
                      onClick={async () => {
                        const done = await post({ action: "line", inventoryItemId: item.id, quantity: value, reason: reason[item.id] ?? null }, item.id);
                        if (done) { setDraft({ ...draft, [item.id]: "" }); setReason({ ...reason, [item.id]: "" }); await load(); }
                      }}>سجّل</Button>
                  </div>
                  {(submitted && (changing || !item.counted) && value) ? (
                    <Input className="mt-2" placeholder="سبب التعديل بعد التقديم (مطلوب)" value={reason[item.id] ?? ""} onChange={(e) => setReason({ ...reason, [item.id]: e.target.value })} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!submitted && (
            <Button className="w-full" disabled={!!busy || counted === 0} onClick={async () => { if (await post({ action: "submit" }, "submit")) { toast.success("اتقدّم جرد الاستلام"); await load(); } }}>
              قدّم جرد الاستلام ({counted} صنف)
            </Button>
          )}
          {submitted && view.comparison && (
            <section className="space-y-1 rounded-lg border p-2 text-sm">
              <h2 className="font-semibold">المقارنة</h2>
              <p>أصناف بفرق خام: {view.comparison.rawDifferenceCount} · غير مفسَّر: {view.comparison.adjustedDifferenceCount}</p>
              <ul className="text-xs">
                {view.comparison.lines.filter((l) => l.label !== "NO_DIFFERENCE").map((l) => <li key={l.inventoryItemId}>{l.itemName}: {LABEL[l.label]}</li>)}
              </ul>
              <p className="text-xs text-muted-foreground">أي فرق اتبعت للمدير والمالك للمراجعة. محدش بيتحاسب أوتوماتيك.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function IncomingCountPage() {
  return <Suspense fallback={<p className="p-4 text-sm">بيحمّل…</p>}><IncomingCount /></Suspense>;
}
