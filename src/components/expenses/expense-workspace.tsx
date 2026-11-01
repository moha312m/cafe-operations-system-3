"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiRequestError, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { expenseInput, returnInput, categoryInput, mayExecuteExpense } from "@/lib/expense-rules";
import { beginExpenseIntent, loadExpenseIntent, completeExpenseIntent, type ExpenseIntent } from "@/lib/expense-intent";
import type { expenseDto } from "@/lib/expenses";

type Expense = ReturnType<typeof expenseDto>;
type Category = { id: string; code: string; nameAr: string; archivedAt: string | null };
type Metadata = { categories: Category[]; branches: { id: string; name: string }[] };
type Listing = { expenses: Expense[]; count: number; pageSize: number; totals: { paid: number; returned: number } };
const field = "w-full rounded-lg border bg-background p-2 disabled:opacity-60";
const button = "rounded-lg border px-4 py-2 disabled:opacity-50";
const message = (error: unknown) => error instanceof Error ? error.message : "تعذر إكمال الطلب";
const uncertainResult = (error: unknown) => !(error instanceof ApiRequestError) || error.status >= 500 || error.status === 409;
const date = (iso: string) => new Date(iso).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });

export function ExpenseWorkspace() {
  const { user, canKey, permKeys } = useApp();
  const view = canKey("expenses.view");
  const intentOwner = (user.cafeId ?? "") + ":" + user.id;
  const [pending, setPending] = useState<ExpenseIntent | null>(null);
  const [readyOwner, setReadyOwner] = useState("");
  const intentReady = readyOwner === intentOwner;
  const manage = mayExecuteExpense(user.role, new Set(permKeys));
  const [metadata, setMetadata] = useState<Metadata>({ categories: [], branches: [] });
  const [setupError, setSetupError] = useState("");
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [page, setPage] = useState(1); const [version, setVersion] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true); const [readError, setReadError] = useState("");
  const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [categoryName, setCategoryName] = useState(""); const [categoryCode, setCategoryCode] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false); const [categoryError, setCategoryError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => loadExpenseIntent(window.sessionStorage, intentOwner, "/api/expenses"))
      .then(intent => {
        if (!live) return;
        setPending(intent); setUncertain(!!intent);
        if (intent && "branchId" in intent.body) {
          setBranchId(intent.body.branchId); setCategoryId(intent.body.categoryId); setAmount(String(intent.body.amount));
          setDescription(intent.body.description); setReference(intent.body.documentReference ?? "");
        }
        setReadyOwner(intentOwner);
      }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [intentOwner]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    api<Metadata>("/api/expenses/categories")
      .then(r => { if (live) { setMetadata(r); setSetupError(""); } })
      .catch(e => { if (live) setSetupError(message(e)); });
    return () => { live = false; };
  }, [view, version]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    const q = new URLSearchParams({ page: String(page), ...(branchId ? { branchId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    api<Listing>(`/api/expenses?${q}`)
      .then(r => { if (live) { setListing(r); setReadError(""); } })
      .catch(e => { if (live) { setReadError(message(e)); setListing(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId, from, to, page, version, view]);
  function refresh() { setLoading(true); setVersion(v => v + 1); }
  async function pay(event: FormEvent) {
    event.preventDefault(); if (!intentReady) return;
    setError(""); setSuccess("");
    const result = pending ? null : expenseInput.safeParse({ branchId, categoryId, amount: Number(amount), description, ...(reference.trim() ? { documentReference: reference } : {}) });
    if (result && !result.success) { setError(result.error.issues.map(i => i.message).join("؛ ")); return; }
    setBusy(true);
    let intent = pending;
    try {
      intent ??= beginExpenseIntent(window.sessionStorage, intentOwner, "/api/expenses", result?.data);
      setPending(intent);
      const saved = await api<Expense>(intent.path, { method: "POST", body: intent.body, idempotencyKey: intent.key });
      if (!completeExpenseIntent(window.sessionStorage, intentOwner, intent)) throw new Error("هوية الطلب المعلّق اتغيرت؛ راجع نتيجته قبل حركة جديدة");
      setPending(null); setUncertain(false); setAmount(""); setDescription(""); setReference(""); setSuccess(saved.id); refresh();
    } catch (e) {
      let keep = !!pending || uncertainResult(e);
      if (intent && !keep) { try { completeExpenseIntent(window.sessionStorage, intentOwner, intent); } catch { keep = true; } }
      setPending(keep ? intent : null); setUncertain(keep && !!intent); setError(message(e));
    } finally { setBusy(false); }
  }
  async function createCategory(event: FormEvent) {
    event.preventDefault(); setCategoryError("");
    const result = categoryInput.safeParse({ code: categoryCode, nameAr: categoryName, classification: "OPERATING_EXPENSE" });
    if (!result.success) { setCategoryError(result.error.issues.map(i => i.message).join("؛ ")); return; }
    setCategoryBusy(true);
    try { await api("/api/expenses/categories", { method: "POST", body: result.data }); setCategoryName(""); setCategoryCode(""); refresh(); }
    catch (e) { setCategoryError(message(e)); } finally { setCategoryBusy(false); }
  }
  async function archive(c: Category) {
    setCategoryError(""); setCategoryBusy(true);
    try { await api(`/api/expenses/categories/${c.id}`, { method: "PATCH", body: { archived: !c.archivedAt } }); refresh(); }
    catch (e) { setCategoryError(message(e)); } finally { setCategoryBusy(false); }
  }
  if (!view) return <p role="alert">ليس لديك صلاحية عرض المصروفات.</p>;
  return <main dir="rtl" className="mx-auto max-w-5xl space-y-5">
    <h1 className="text-2xl font-bold">المصروفات التشغيلية</h1>
    <p>مصروف تشغيلي مدفوع فورًا من درجك الحالي بالجنيه المصري. المشتريات وسداد الموردين والسلف والأجور والأصول ومسحوبات المالك لها مسارات منفصلة.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <div><label htmlFor="expense-branch">الفرع</label><select id="expense-branch" className={field} value={branchId} disabled={!!user.branchId || busy || uncertain || !intentReady} onChange={e => { setBranchId(e.target.value); setPage(1); setLoading(true); }}>
        <option value="">كل الفروع — اختر فرعًا للصرف</option>{metadata.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></div>
      <div><label htmlFor="expense-from">من تاريخ — القاهرة</label><input id="expense-from" className={field} type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); setLoading(true); }} /></div>
      <div><label htmlFor="expense-to">إلى تاريخ — القاهرة</label><input id="expense-to" className={field} type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); setLoading(true); }} /></div>
    </div>
    {setupError && <p role="alert">تعذر تحميل الفروع والتصنيفات: {setupError} <button className={button} onClick={refresh}>إعادة التحميل</button></p>}
    {manage && <form onSubmit={pay} className="space-y-3 rounded-xl border p-4" aria-label="تسجيل مصروف">
      <h2 className="text-lg font-semibold">تسجيل مصروف من الدرج</h2>
      <fieldset disabled={busy || uncertain || !intentReady} className="grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="expense-category">بند المصروف المعتمد</label><select id="expense-category" className={field} value={categoryId} onChange={e => setCategoryId(e.target.value)} required>
          <option value="">اختر البند</option>{metadata.categories.filter(c => !c.archivedAt || (!!pending && c.id === categoryId)).map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
        </select></div>
        <div><label htmlFor="expense-amount">المبلغ — ج.م</label><input id="expense-amount" className={field} type="number" inputMode="decimal" min="0.01" step="0.01" max="9999999999.99" value={amount} onChange={e => setAmount(e.target.value)} required /></div>
        <div className="sm:col-span-2"><label htmlFor="expense-description">الوصف</label><textarea id="expense-description" className={field} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} required /></div>
        <div className="sm:col-span-2"><label htmlFor="expense-reference">مرجع المستند — اختياري</label><input id="expense-reference" className={field} maxLength={200} value={reference} onChange={e => setReference(e.target.value)} /></div>
      </fieldset>
      {!setupError && !metadata.categories.some(c => !c.archivedAt) && <p>لا توجد تصنيفات متاحة. ينشئ المالك بند مصروف تشغيلي أولًا.</p>}
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">يوجد طلب صرف سابق لم تُحسم نتيجته. استعد النتيجة بنفس البيانات والمفتاح، ولا تسلّم نقدًا جديدًا أثناء الاستعادة.</p>}
      <button className={button} disabled={busy || !intentReady || (!pending && (!branchId || !categoryId || !!setupError))} type="submit">{busy ? "جارٍ التحقق والحفظ…" : uncertain ? "إعادة المحاولة واستعادة النتيجة" : "تسجيل الصرف الفعلي"}</button>
      {success && <p role="status">تم حفظ أو استعادة نتيجة الطلب. <Link className="underline" href={`/expenses/${success}`}>فتح الإيصال ورد النقد</Link></p>}
    </form>}
    {readError && <p role="alert">{readError} <button className={button} onClick={refresh}>إعادة التحميل</button></p>}
    {loading ? <p role="status">جارٍ تحميل المصروفات…</p> : listing && <section aria-label="سجل المصروفات" className="space-y-3">
      <p>إجمالي المصروفات في النطاق: {money(listing.totals.paid, "EGP")}؛ النقد المردود لهذه المصروفات: {money(listing.totals.returned, "EGP")}.</p>
      {listing.expenses.length === 0 ? <p>لا توجد مصروفات في النطاق المحدد.</p> : <ul className="space-y-2">{listing.expenses.map(e => <li key={e.id} className="rounded-lg border p-3">
        <Link className="font-semibold underline" href={`/expenses/${e.id}`}>{e.categoryName} — {money(e.amount, "EGP")}</Link><p>{e.description}</p><p className="text-sm">{date(e.occurredAt)} — {e.actorName}؛ مردود {money(e.returnedAmount, "EGP")}</p>
      </li>)}</ul>}
      <div className="flex items-center gap-3"><button className={button} disabled={page === 1} onClick={() => { setPage(p => p - 1); setLoading(true); }}>السابق</button><span>صفحة {page}</span><button className={button} disabled={page * listing.pageSize >= listing.count} onClick={() => { setPage(p => p + 1); setLoading(true); }}>التالي</button></div>
    </section>}
    {user.role === "CAFE_OWNER" && manage && <section className="space-y-3 rounded-xl border p-4" aria-label="تصنيفات المصروفات">
      <h2 className="text-lg font-semibold">تصنيفات المصروفات — المالك</h2>
      <form onSubmit={createCategory} className="space-y-3">
        <label htmlFor="category-code">كود البند</label><input id="category-code" className={field} dir="ltr" maxLength={40} pattern="[A-Z0-9_]+" value={categoryCode} onChange={e => setCategoryCode(e.target.value)} required />
        <label htmlFor="category-name">اسم البند بالعربية</label><input id="category-name" className={field} maxLength={100} value={categoryName} onChange={e => setCategoryName(e.target.value)} required />
        <label className="flex gap-2"><input type="checkbox" required />أعتمد هذا البند للمصروف التشغيلي فقط، ولا يشمل مشتريات المخزون أو الموردين أو السلف أو الأجور أو الأصول أو المسحوبات.</label>
        <button className={button} disabled={categoryBusy}>إنشاء التصنيف</button>
      </form>
      {categoryError && <p role="alert">{categoryError}</p>}
      <ul className="space-y-2">{metadata.categories.map(c => <li key={c.id} className="flex flex-wrap items-center gap-3"><span>{c.nameAr}{c.archivedAt ? " — مؤرشف" : ""}</span><button className={button} disabled={categoryBusy} onClick={() => archive(c)}>{c.archivedAt ? "إتاحة البند" : "أرشفة البند"}</button></li>)}</ul>
    </section>}
  </main>;
}

export function ExpenseDetail({ id }: { id: string }) {
  const { user, permKeys, canKey } = useApp();
  const view = canKey("expenses.view");
  const intentOwner = (user.cafeId ?? "") + ":" + user.id;
  const intentPath = "/api/expenses/" + id + "/returns";
  const [pending, setPending] = useState<ExpenseIntent | null>(null);
  const [readyOwner, setReadyOwner] = useState("");
  const intentReady = readyOwner === intentOwner;
  const [data, setData] = useState<{ expense: Expense; drawerStatus: string } | null>(null);
  const [version, setVersion] = useState(0); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState(""); const [reason, setReason] = useState(""); const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => loadExpenseIntent(window.sessionStorage, intentOwner, intentPath))
      .then(intent => {
        if (!live) return;
        setPending(intent); setUncertain(!!intent);
        if (intent && "reason" in intent.body) { setAmount(String(intent.body.amount)); setReason(intent.body.reason); setReference(intent.body.documentReference ?? ""); }
        setReadyOwner(intentOwner);
      }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [intentOwner, intentPath]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    api<{ expense: Expense; drawerStatus: string }>(`/api/expenses/${id}`)
      .then(r => { if (live) { setData(r); setError(""); } })
      .catch(e => { if (live) setError(message(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, version, view]);
  async function receive(event: FormEvent) {
    event.preventDefault(); if (!intentReady) return;
    setSaved(false); setError("");
    const result = pending ? null : returnInput.safeParse({ amount: Number(amount), reason, ...(reference.trim() ? { documentReference: reference } : {}) });
    if (result && !result.success) { setError(result.error.issues.map(i => i.message).join("؛ ")); return; }
    setBusy(true);
    let intent = pending;
    try {
      intent ??= beginExpenseIntent(window.sessionStorage, intentOwner, intentPath, result?.data);
      setPending(intent);
      const expense = await api<Expense>(intent.path, { method: "POST", body: intent.body, idempotencyKey: intent.key });
      if (!completeExpenseIntent(window.sessionStorage, intentOwner, intent)) throw new Error("هوية الطلب المعلّق اتغيرت؛ راجع نتيجته قبل حركة جديدة");
      setData(d => d ? { ...d, expense } : d); setPending(null); setUncertain(false); setSaved(true); setAmount(""); setReason(""); setReference("");
    } catch (e) {
      let keep = !!pending || uncertainResult(e);
      if (intent && !keep) { try { completeExpenseIntent(window.sessionStorage, intentOwner, intent); } catch { keep = true; } }
      setPending(keep ? intent : null); setUncertain(keep && !!intent); setError(message(e));
    } finally { setBusy(false); }
  }
  if (!view) return <p role="alert">ليس لديك صلاحية عرض المصروف.</p>;
  return <main dir="rtl" className="mx-auto max-w-3xl space-y-4">
    <style>{`@media print { .expense-no-print { display: none !important; } }`}</style>
    <Link href="/expenses" className="expense-no-print underline">العودة للمصروفات</Link><h1 className="text-2xl font-bold">إيصال مصروف ورد النقد</h1>
    {loading && <p role="status">جارٍ تحميل الإيصال…</p>}
    {error && <p role="alert">{error}</p>}
    {!data && !loading && <button className={button} onClick={() => { setLoading(true); setVersion(v => v + 1); }}>إعادة التحميل</button>}
    {data && <>
      <article className="space-y-3 rounded-xl border p-4" aria-label="إيصال المصروف">
        <h2 className="text-xl font-semibold">{data.expense.categoryName} — {money(data.expense.amount, "EGP")}</h2>
        <p>مصروف تشغيلي مدفوع من الدرج — {data.expense.currency}</p><p>{data.expense.description}</p>
        <dl className="space-y-2">
          <div><dt>رقم المصروف</dt><dd className="break-all">{data.expense.id}</dd></div>
          <div><dt>الفرع / الوردية الأصلية</dt><dd className="break-all">{data.expense.branchId} / {data.expense.shiftId}</dd></div>
          <div><dt>المنفذ ووقت الصرف — القاهرة</dt><dd>{data.expense.actorName} — {date(data.expense.occurredAt)}</dd></div>
          <div><dt>مرجع المستند</dt><dd>{data.expense.documentReference ?? "لا يوجد"}</dd></div>
          <div><dt>النقد المردود / المتبقي غير المردود</dt><dd>{money(data.expense.returnedAmount, "EGP")} / {money(data.expense.unrecoveredAmount, "EGP")}</dd></div>
        </dl>
        <h3 className="font-semibold">ردود نقدية موثقة</h3>
        {data.expense.returns.length === 0 ? <p>لم يُسجل رد نقد.</p> : <ul className="space-y-2">{data.expense.returns.map(r => <li key={r.id} className="rounded-lg border p-2">
          {money(r.amount, "EGP")} — {r.reason}<p>{r.actorName} — {date(r.occurredAt)}</p><p>مرجع: {r.documentReference ?? "لا يوجد"}</p>
        </li>)}</ul>}
        <button className={button + " expense-no-print"} onClick={() => window.print()}>طباعة الإيصال</button>
      </article>
      {mayExecuteExpense(user.role, new Set(permKeys)) && (pending || data.expense.unrecoveredAmount > 0) && <section className="expense-no-print rounded-xl border p-4">
        <h2 className="text-lg font-semibold">تسجيل عودة نقد فعلية</h2>
        <p>لا يمحو المصروف. يُقبل فقط إلى الدرج الأصلي وهو مفتوح وفي عهدتك. الرد إلى درج آخر أو بعد الإقفال يحتاج مسارًا منفصلًا.</p>
        {data.drawerStatus !== "OPEN" && !pending ? <p role="status">الدرج الأصلي مغلق أو قيد التسليم؛ الرد غير متاح في هذه الدفعة.</p> : <form onSubmit={receive} className="space-y-3">
          <fieldset disabled={busy || uncertain || !intentReady} className="space-y-2">
            <label htmlFor="return-amount">النقد الذي عاد — ج.م</label><input id="return-amount" className={field} type="number" inputMode="decimal" min="0.01" step="0.01" max={data.expense.unrecoveredAmount} value={amount} onChange={e => setAmount(e.target.value)} required />
            <label htmlFor="return-reason">سبب ودليل عودة النقد</label><textarea id="return-reason" className={field} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} required />
            <label htmlFor="return-reference">مرجع المستند — اختياري</label><input id="return-reference" className={field} maxLength={200} value={reference} onChange={e => setReference(e.target.value)} />
            <label className="flex gap-2"><input type="checkbox" required />أؤكد استلام النقد فعليًا في الدرج الأصلي.</label>
          </fieldset>
          {uncertain && <p role="status">يوجد طلب رد سابق لم تُحسم نتيجته. استعد نتيجته؛ لا تستلم نقدًا جديدًا أثناء الاستعادة.</p>}
          <button className={button} disabled={busy || !intentReady}>{busy ? "جارٍ الحفظ…" : uncertain ? "إعادة المحاولة بنفس الطلب" : "تسجيل النقد المستلم"}</button>
        </form>}
      </section>}
      {saved && <p role="status">تم تسجيل عودة النقد وحفظ دليلها.</p>}
    </>}
  </main>;
}
