"use client";
// «جرد التسليم والاستلام» — stock handover v2 (owner decision 2026-11-12).
// Two independent counts side by side, the recorded movements between them,
// and the manager/owner review. This page reads and records a review; it
// never moves stock or money. Every figure is the server's.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Result = "UNEXPLAINED" | "EXPLAINED" | "MISSING" | "NONE";
type ReviewStatus = "OPEN" | "IN_REVIEW" | "REVIEWED" | "RESOLVED";
type Row = {
  handoverId: string; branchName: string; closedAt: string | null; status: string; outgoingName: string; incomingName: string | null;
  outgoingCounted: boolean; incomingCounted: boolean; reliability: string; rawDifferenceCount: number; adjustedDifferenceCount: number;
  unavailableCount: number; disputedCount: number; result: Result; reviewStatus: ReviewStatus | null; classification: string | null; notes: number;
};
type Side = { quantity: string; unit: string; countedAt: string; itemVersion: string | null; source?: string } | null;
type Line = {
  inventoryItemId: string; itemName: string; unit: string; outgoing: Side; incoming: Side; raw: string | null; netMovement: string | null;
  expected: string | null; adjusted: string | null; movementCount: number; reliability: string; label: string; labelText: string; note: string | null; disputed: boolean;
};
type Detail = {
  handover: { id: string; status: string; branchName: string; closedAt: string; acceptedAt: string | null; outgoingName: string; incomingName: string | null; incomingCount: { startedAt: string; submittedAt: string | null } | null };
  comparison: { reliability: string; sameCounter: boolean; outgoingCounted: boolean; incomingCounted: boolean; lines: Line[]; rawDifferenceCount: number; adjustedDifferenceCount: number; unavailableCount: number; disputedCount: number };
  history: { id: string; reliability: string; rawDifferenceCount: number; adjustedDifferenceCount: number; computedAt: string }[];
  movements: Record<string, { type: string; quantity: string; at: string; note: string | null; by: string | null }[]>;
  review: { status: ReviewStatus; classification: string; notes: { id: string; text: string; statusFrom: string | null; statusTo: string | null; classificationFrom: string | null; classificationTo: string | null; createdAt: string; authorName: string }[] } | null;
  can: { review: boolean };
};

const RESULT_LABEL: Record<Result, string> = { UNEXPLAINED: "فرق غير مفسَّر", EXPLAINED: "فرق مفسَّر بحركات", MISSING: "جرد ناقص", NONE: "مطابق" };
const RESULT_TONE: Record<Result, string> = {
  UNEXPLAINED: "border-red-300 bg-red-50 text-red-800",
  EXPLAINED: "border-amber-300 bg-amber-50 text-amber-800",
  MISSING: "border-dashed border-slate-400 bg-slate-50 text-slate-700",
  NONE: "border-emerald-300 bg-emerald-50 text-emerald-800",
};
const STATUS_LABEL: Record<ReviewStatus, string> = { OPEN: "مفتوح", IN_REVIEW: "قيد المراجعة", REVIEWED: "اتراجع", RESOLVED: "اتقفل" };
const CLASS_LABEL: Record<string, string> = {
  UNCLASSIFIED: "لسه ماتصنّفش", EXPLAINED_BY_MOVEMENTS: "مفسَّر بحركات مسجلة", COUNT_ERROR: "غلط في العدّ", UNRECORDED_USAGE: "استهلاك ماتسجلش",
  WASTE_OR_DAMAGE: "هالك أو تالف", RECEIVING_OR_TRANSFER: "استلام أو تحويل", LOSS_UNEXPLAINED: "عجز غير مفسَّر", OTHER: "سبب تاني",
};
const RELIABILITY_LABEL: Record<string, string> = { CONFIRMED: "مؤكد", PROVISIONAL: "مؤقت", UNAVAILABLE: "غير متاح" };
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "—");
const qty = (v: string | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("ar-EG", { maximumFractionDigits: 3 }));
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export default function StockHandoverReportPage() {
  const { canKey } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [result, setResult] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [classification, setClassification] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (result) p.set("result", result);
    if (status) p.set("status", status);
    if (classification) p.set("classification", classification);
    if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) p.set("to", new Date(`${to}T23:59:59`).toISOString());
    return p.toString();
  }, [result, status, classification, from, to]);

  const load = useCallback(async () => {
    try {
      setRows(null);
      const data = await api<{ rows: Row[] }>(`/api/stock-handover-reports${query ? `?${query}` : ""}`);
      setRows(data.rows);
    } catch (error) {
      toast.error((error as Error).message);
      setRows([]);
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  // A notification links here with ?handoverId=… — open that handover directly.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("handoverId");
    if (id) setOpenId(id);
  }, []);

  if (!canKey("handover.manage") && !canKey("shifts.view_reports")) {
    return <p className="p-4 text-sm text-muted-foreground">التقرير ده للمدير والمالك.</p>;
  }

  const counts = (rows ?? []).reduce((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {} as Record<Result, number>);

  return (
    <div dir="rtl" className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">جرد التسليم والاستلام</h1>
        <p className="text-sm text-muted-foreground">جرد المُسلِّم وجرد المُستلِم جنب بعض. الجرد هنا للمتابعة والمحاسبة بس — مابيوقفش شغل ومابيغيرش رصيد المخزن.</p>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(Object.keys(RESULT_LABEL) as Result[]).map((k) => (
          <button key={k} type="button" onClick={() => setResult(result === k ? "" : k)}
            className={`rounded-xl border p-3 text-start ${result === k ? "ring-2 ring-primary" : ""} ${RESULT_TONE[k]}`}>
            <p className="text-xs">{RESULT_LABEL[k]}</p>
            <p className="text-2xl font-bold tabular-nums">{rows ? (counts[k] ?? 0) : "…"}</p>
          </button>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-2 rounded-xl border bg-card p-3 sm:grid-cols-5">
        <label className="text-sm">حالة المراجعة
          <select className="mt-1 w-full rounded-md border bg-background p-2" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">الكل</option>
            {(Object.keys(STATUS_LABEL) as ReviewStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="text-sm">التصنيف
          <select className="mt-1 w-full rounded-md border bg-background p-2" value={classification} onChange={(e) => setClassification(e.target.value)}>
            <option value="">الكل</option>
            {Object.entries(CLASS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="text-sm">من<Input className="mt-1" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">إلى<Input className="mt-1" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="flex items-end gap-2">
          <Button variant="outline" className="flex-1" onClick={() => void load()}>تحديث</Button>
          <a className="flex h-9 flex-1 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" href={`/api/stock-handover-reports?${query}${query ? "&" : ""}format=xlsx`}>Excel</a>
        </div>
      </section>

      {rows === null ? <p className="text-sm text-muted-foreground">بيحمّل…</p> : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">مفيش تسليمات بالفلتر ده.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.handoverId}>
              <button type="button" onClick={() => setOpenId(r.handoverId)} className="w-full rounded-xl border bg-card p-3 text-start hover:bg-muted/50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{r.branchName} · {fmtDate(r.closedAt)}</span>
                  <Pill className={RESULT_TONE[r.result]}>{RESULT_LABEL[r.result]}</Pill>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  المُسلِّم: {r.outgoingName} {r.outgoingCounted ? "" : "(ماعدّش)"} · المُستلِم: {r.incomingName ?? "—"} {r.incomingCounted ? "" : "(ماعدّش)"}
                </p>
                <p className="mt-1 flex flex-wrap gap-2 text-xs">
                  <span>فرق خام: {r.rawDifferenceCount}</span>
                  <span>غير مفسَّر: {r.adjustedDifferenceCount}</span>
                  <span>غير متاح: {r.unavailableCount}</span>
                  {r.disputedCount > 0 && <span className="font-semibold text-red-700">اعتراض المُستلِم: {r.disputedCount}</span>}
                  <span>الموثوقية: {RELIABILITY_LABEL[r.reliability] ?? r.reliability}</span>
                  <span>المراجعة: {r.reviewStatus ? STATUS_LABEL[r.reviewStatus] : "—"}</span>
                  {r.classification && <span>التصنيف: {CLASS_LABEL[r.classification]}</span>}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!openId} onOpenChange={(open) => !open && setOpenId(null)}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto" dir="rtl">
          {openId && <DetailView handoverId={openId} onChanged={() => void load()} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailView({ handoverId, onChanged }: { handoverId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string>("");
  const [classification, setClassification] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey);
  const load = useCallback(async () => {
    try { setDetail(await api<Detail>(`/api/stock-handover-reports/${handoverId}`)); }
    catch (error) { toast.error((error as Error).message); }
  }, [handoverId]);
  useEffect(() => { void load(); }, [load]);

  if (!detail) return <p className="p-4 text-sm text-muted-foreground">بيحمّل…</p>;
  const { handover: h, comparison: c } = detail;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/stock-handover-reports/${handoverId}`, { method: "POST", idempotencyKey: key, body: { text, status: status || null, classification: classification || null } });
      toast.success("اتسجلت الملاحظة");
      setText(""); setStatus(""); setClassification(""); setKey(newKey());
      await load(); onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{h.branchName} · {fmtDate(h.closedAt)}</DialogTitle>
        <DialogDescription>
          المُسلِّم: {h.outgoingName} · المُستلِم: {h.incomingName ?? "—"} · الموثوقية: {RELIABILITY_LABEL[c.reliability] ?? c.reliability}
          {c.sameCounter && " · نفس الشخص عدّ الجردين"}
        </DialogDescription>
      </DialogHeader>

      {!c.outgoingCounted && <p className="rounded-md border border-dashed p-2 text-sm">المُسلِّم ماعدّش الخامات — المقارنة غير متاحة للأصناف دي، ومش محسوبة صفر.</p>}
      {!c.incomingCounted && <p className="rounded-md border border-dashed p-2 text-sm">المُستلِم لسه ماقدّمش جرده.</p>}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/60 text-xs">
            <tr>
              <th className="p-2 text-start">الصنف</th><th className="p-2">عدّ المُسلِّم</th><th className="p-2">عدّ المُستلِم</th><th className="p-2">الفرق الخام</th>
              <th className="p-2">صافي الحركات</th><th className="p-2">المتوقع</th><th className="p-2">بعد الحركات</th><th className="p-2 text-start">النتيجة</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.inventoryItemId} className="border-t align-top">
                <td className="p-2">{l.itemName} <span className="text-xs text-muted-foreground">({l.unit})</span></td>
                <td className="p-2 text-center tabular-nums">{qty(l.outgoing?.quantity)}</td>
                <td className="p-2 text-center tabular-nums">{qty(l.incoming?.quantity)}{l.incoming?.source === "LEGACY_SHEET" && <span className="block text-xs text-muted-foreground">من ورقة الاستلام</span>}</td>
                <td className="p-2 text-center tabular-nums">{qty(l.raw)}</td>
                <td className="p-2 text-center tabular-nums">{qty(l.netMovement)}{l.movementCount ? <span className="block text-xs text-muted-foreground">{l.movementCount} حركة</span> : null}</td>
                <td className="p-2 text-center tabular-nums">{qty(l.expected)}</td>
                <td className={`p-2 text-center font-semibold tabular-nums ${l.adjusted && Number(l.adjusted) !== 0 ? "text-red-700" : ""}`}>{qty(l.adjusted)}</td>
                <td className="p-2">{l.labelText}{l.disputed && <span className="block text-xs font-semibold text-red-700">المُستلِم اعترض على السطر ده</span>}{l.note && <span className="block text-xs text-muted-foreground">{l.note}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Object.keys(detail.movements).length > 0 && (
        <details className="rounded-lg border p-2">
          <summary className="cursor-pointer text-sm font-semibold">الحركات المسجلة بين الجردين</summary>
          {Object.entries(detail.movements).map(([itemId, moves]) => (
            <div key={itemId} className="mt-2">
              <p className="text-sm font-medium">{c.lines.find((l) => l.inventoryItemId === itemId)?.itemName}</p>
              <ul className="text-xs text-muted-foreground">
                {moves.map((m, i) => <li key={i}>{fmtDate(m.at)} · {m.type} · {qty(m.quantity)}{m.by ? ` · ${m.by}` : ""}{m.note ? ` · ${m.note}` : ""}</li>)}
              </ul>
            </div>
          ))}
        </details>
      )}

      {detail.history.length > 1 && (
        <details className="rounded-lg border p-2">
          <summary className="cursor-pointer text-sm font-semibold">نسخ المقارنة السابقة ({detail.history.length})</summary>
          <ul className="mt-1 text-xs">
            {detail.history.map((v) => <li key={v.id}>{fmtDate(v.computedAt)} · فرق خام {v.rawDifferenceCount} · غير مفسَّر {v.adjustedDifferenceCount} · {RELIABILITY_LABEL[v.reliability]}</li>)}
          </ul>
        </details>
      )}

      <section className="space-y-2 rounded-lg border p-3">
        <h3 className="text-sm font-semibold">المراجعة {detail.review ? `· ${STATUS_LABEL[detail.review.status]} · ${CLASS_LABEL[detail.review.classification]}` : "· لسه مفيش"}</h3>
        <ol className="space-y-1 text-sm">
          {(detail.review?.notes ?? []).map((n) => (
            <li key={n.id} className="rounded-md bg-muted/40 p-2">
              <p>{n.text}</p>
              <p className="text-xs text-muted-foreground">
                {n.authorName} · {fmtDate(n.createdAt)}
                {n.statusTo && ` · الحالة: ${STATUS_LABEL[n.statusFrom as ReviewStatus] ?? "—"} ← ${STATUS_LABEL[n.statusTo as ReviewStatus]}`}
                {n.classificationTo && ` · التصنيف: ${CLASS_LABEL[n.classificationTo]}`}
              </p>
            </li>
          ))}
        </ol>
        {detail.can.review && (
          <div className="space-y-2">
            <textarea className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" placeholder="اكتب اللي اتعرف عن الفرق (مطلوب)" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select className="rounded-md border bg-background p-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">من غير تغيير الحالة</option>
                {(Object.keys(STATUS_LABEL) as ReviewStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <select className="rounded-md border bg-background p-2 text-sm" value={classification} onChange={(e) => setClassification(e.target.value)}>
                <option value="">من غير تغيير التصنيف</option>
                {Object.entries(CLASS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <Button disabled={saving || !text.trim()} onClick={() => void save()}>{saving ? "بيتسجل…" : "سجّل الملاحظة"}</Button>
            </div>
            <p className="text-xs text-muted-foreground">الملاحظات مابتتمسحش ومابتتعدلش. أي تسوية للمخزن بتتعمل من «تسوية المخزون» العادية.</p>
          </div>
        )}
      </section>
    </div>
  );
}
