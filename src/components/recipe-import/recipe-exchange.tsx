"use client";
import { useRef, useState } from "react";
import { parseRecipeFile } from "@/lib/recipe-file";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Mode = "replace" | "new-only";
type RawRow = Record<string, string | number | boolean | null>;
type RecipeSide = { items: { ingredient: string; branch: string; quantity: string; unit: string; waste: string }[]; all: boolean; reason: string | null };
type ExportChoice = { id: string; name: string; kind: "productId" | "addOnId" };
type Preview = {
  rows: { rowNumber: number; errors: string[] }[];
  groups: { name: string; scope: string; action: string; requiresConfirmation: boolean; before: RecipeSide | null; after: RecipeSide | null }[];
  stats: { total: number; errors: number; recipes: number; totals: Record<string, number> };
  previewToken: string;
};
const actions: Record<string, string> = { CREATE: "وصفة جديدة", REPLACE: "استبدال المكونات", UNCHANGED: "بدون تغيير — يحتفظ بالتأكيد", SKIP: "تجاوز الوصفة الموجودة", ERROR: "أخطاء تحتاج تصحيحًا" };
function RecipeIngredients({ recipe }: { recipe: RecipeSide | null }) {
  if (!recipe) return <span>لا توجد وصفة</span>;
  return <div className="space-y-1">
    {recipe.all && <p>تغطي كل الأحجام</p>}
    {recipe.reason && <p>غير منطبقة: {recipe.reason}</p>}
    {recipe.items.map((item, index) => <p key={index}>{item.ingredient} · {item.branch} · <bdi>{item.quantity} {item.unit}</bdi> · هدر {item.waste}%</p>)}
  </div>;
}
export function RecipeExchange({ onImported, choices }: { onImported: () => void | Promise<void>; choices: ExportChoice[] }) {
  const [selectOpen, setSelectOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [acknowledgeLegacy, setAcknowledgeLegacy] = useState(false);
  const [review, setReview] = useState<{ id: string; name: string }[]>([]);
  const lock = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<RawRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ created: number; replaced: number; unchanged: number; skipped: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  function reset() { setAcknowledgeLegacy(false); setReview([]); setRows([]); setFileName(""); setMode(null); setPreview(null); setError(null); setSummary(null); }
  async function download(template: boolean, selectedOnly = false) {
    setBusy(true);
    try {
      const params = new URLSearchParams(template ? { template: "1" } : {});
      if (selectedOnly) for (const choice of choices.filter(choice => selected.includes(choice.id))) params.append(choice.kind, choice.id);
      if (selectedOnly && !params.size) return;
      const response = await fetch("/api/recipe-import/export?" + params);
      if (!response.ok) { const body = await response.json(); throw new Error(body.error ?? "تعذر تحميل الملف"); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = template ? "recipes-template.xlsx" : "recipes-export.xlsx";
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(e instanceof Error ? e.message : "تعذر تحميل الملف"); }
    finally { setBusy(false); }
  }
  async function readFile(file: File) {
    setBusy(true); setPreview(null); setSummary(null); setRows([]); setFileName(""); setError(null);
    try {
      if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error("اختر ملف .xlsx أو .csv");
      if (file.size > 5 * 1024 * 1024) throw new Error("الحد الأقصى لحجم الملف 5 ميجابايت");
      const normalized = parseRecipeFile(await file.arrayBuffer());
      setRows(normalized); setFileName(file.name);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر قراءة الملف"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function inspect() {
    if (!mode) return;
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await api<Preview>("/api/recipe-import/preview", { method: "POST", body: { rows, mode, acknowledgeLegacy } })); }
    catch (e) { setError(e instanceof Error ? e.message : "تعذرت المعاينة"); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (lock.current || !mode || !preview?.previewToken || preview.stats.errors) return;
    lock.current = true;
    setBusy(true); setError(null);
    try {
      const result = await api<{ summary: NonNullable<typeof summary>; review: { id: string; name: string }[] }>("/api/recipe-import", { method: "POST", body: { rows, mode, previewToken: preview.previewToken, fileName, acknowledgeLegacy } });
      setReview(result.review); setSummary(result.summary); setPreview(null); setRows([]);
      toast.success("تم استيراد الوصفات؛ أكد الوصفات الجديدة أو المتغيرة بعد مراجعتها");
      void Promise.resolve().then(onImported).catch(() => toast.error("تم الحفظ، حدّث شاشة الوصفات لعرض النتيجة"));
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر الاستيراد"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <Button size="sm" variant="outline" disabled={busy || !choices.length} onClick={() => setSelectOpen(true)}>تصدير وصفات محددة</Button>
    <Dialog open={selectOpen} onOpenChange={next => { if (!busy) setSelectOpen(next); }}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>اختيار وصفات للتصدير</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">يشمل اختيار المنتج وصفته الافتراضية ووصفات أحجامه المحفوظة.</p>
        <div className="max-h-72 space-y-2 overflow-auto">{choices.map(choice => <label key={choice.id} className="flex gap-2">
          <input type="checkbox" disabled={busy} checked={selected.includes(choice.id)} onChange={event => {
            const checked = event.currentTarget.checked;
            setSelected(current => checked ? [...current, choice.id] : current.filter(id => id !== choice.id));
          }} />{choice.name}
        </label>)}</div>
        <Button disabled={busy || !choices.some(choice => selected.includes(choice.id))} onClick={() => void download(false, true)}>تنزيل Excel للمحدد ({selected.length})</Button>
      </DialogContent>
    </Dialog>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void download(false)}>تصدير كل الوصفات Excel</Button>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void download(true)}>تحميل قالب الوصفات</Button>
    <Button size="sm" disabled={busy} onClick={() => { reset(); setOpen(true); }}>استيراد الوصفات</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" dir="rtl">
        <DialogHeader><DialogTitle>استيراد وصفات Excel / CSV</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">أدخل المكونات والكميات الفعلية لكل وحدة مباعة. الاستيراد يخص الوصفات فقط؛ تبقى الأسعار والتكاليف والمخزون كما هي. الوصفات الجديدة أو المتغيرة تحتاج تأكيدًا بعد المراجعة.</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void download(true)}>تحميل القالب والمراجع</Button>
          <input ref={input} type="file" accept=".xlsx,.csv" disabled={busy} className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void readFile(file); }} />
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>اختيار ملف</Button><span className="min-w-0 break-all self-center text-sm" dir="auto">{fileName}</span>
        </div>
        <p className="text-xs text-muted-foreground">عدل Recipes فقط. استخدم المعرفات والأسماء وفرع المكون من أوراق المراجع. احذف صفوف القالب غير المطلوبة وأكمل الكميات والوحدات والهدر. الحد: 1000 صف، 5 ميجابايت.</p>
        <fieldset disabled={busy} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm font-semibold">اختر طريقة الاستيراد صراحة</legend>
          <label className="flex items-start gap-2"><input type="radio" name="recipe-import-mode" checked={mode === "replace"} onChange={() => { setMode("replace"); setPreview(null); setSummary(null); }} /><span className="text-sm">استبدال الوصفات الموجودة في الملف وإضافة الجديدة. يستبدل كل مكونات الوصفة الموجودة، ولا يحذف وصفات أخرى.</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="recipe-import-mode" checked={mode === "new-only"} onChange={() => { setMode("new-only"); setPreview(null); setSummary(null); }} /><span className="text-sm">الجديد فقط: إضافة وصفات للأصناف الموجودة التي لا تملك وصفة، وتجاوز الوصفات الموجودة.</span></label>
        </fieldset>
        {mode === "replace" && <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={acknowledgeLegacy} onChange={event => { setAcknowledgeLegacy(event.target.checked); setPreview(null); }} />أراجع الوصفات الحالية وأسمح بمعاينة ملف قديم بلا بصمة تصدير</label>}
        {review.length > 0 && <div className="text-sm"><p>وصفات تحتاج مراجعة وتأكيدًا</p><ul className="max-h-32 overflow-auto">{review.map(recipe => <li key={recipe.id}>{recipe.name}</li>)}</ul></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {summary && <p role="status" className="rounded-lg bg-muted p-3 text-sm">جديدة: {summary.created} — مستبدلة: {summary.replaced} — بدون تغيير: {summary.unchanged} — متجاوزة: {summary.skipped}</p>}
        <Button variant="outline" disabled={busy || !rows.length || !mode} onClick={() => void inspect()}>{busy ? "جارٍ التحقق…" : "معاينة الملف بدون حفظ"}</Button>
        {preview && <div className="space-y-3">
          <p className="text-sm">{preview.stats.total} صف — {preview.stats.recipes} وصفة — {preview.stats.errors} صف به أخطاء</p>
          <p className="text-sm">جديدة {preview.stats.totals.CREATE} · متغيرة {preview.stats.totals.REPLACE} · بدون تغيير {preview.stats.totals.UNCHANGED} · متجاوزة {preview.stats.totals.SKIP} · وصفات بها أخطاء {preview.stats.totals.ERROR}</p>
          {!!preview.stats.errors && <p className="text-sm text-destructive">صحح كل الأخطاء في الملف وأعد رفعه. لا يتم استيراد أي وصفة من ملف به أخطاء.</p>}
          <div className="max-h-64 overflow-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>الصنف</TableHead><TableHead>النطاق</TableHead><TableHead>النتيجة</TableHead><TableHead>قبل</TableHead><TableHead>بعد</TableHead></TableRow></TableHeader><TableBody>{preview.groups.map((g, i) => <TableRow key={i}><TableCell>{g.name}</TableCell><TableCell>{g.scope}</TableCell><TableCell>{actions[g.action] ?? g.action}{g.requiresConfirmation && ["CREATE", "REPLACE"].includes(g.action) ? " — يحتاج تأكيدًا جديدًا" : ""}</TableCell><TableCell><RecipeIngredients recipe={g.before} /></TableCell><TableCell><RecipeIngredients recipe={g.after} /></TableCell></TableRow>)}</TableBody></Table></div>
          <ul className="max-h-48 overflow-auto space-y-1 text-sm text-destructive">{preview.rows.filter(r => r.errors.length).map(r => <li key={r.rowNumber}>صف {r.rowNumber}: {r.errors.join("؛ ")}</li>)}</ul>
          <Button disabled={busy || !!preview.stats.errors || !preview.previewToken} onClick={() => void commit()}>{busy ? "جارٍ الاستيراد…" : mode === "replace" ? "تأكيد الاستبدال والاستيراد" : "تأكيد استيراد الجديد فقط"}</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
