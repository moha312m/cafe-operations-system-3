"use client";
import { nativeFieldClassName } from "@/components/ui/input";
import { nativeButtonClassName, nativePrimaryButtonClassName } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { PageHeader } from "@/components/cafe/ui";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiRequestError, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { expenseInput, returnInput, categoryInput, categoryUpdateInput, mayExecuteExpense } from "@/lib/expense-rules";
import { beginExpenseIntent, loadExpenseIntent, completeExpenseIntent, type ExpenseIntent } from "@/lib/expense-intent";
import type { expenseDto } from "@/lib/expenses";

type Expense = ReturnType<typeof expenseDto>;
type Category = { id: string; code: string; nameAr: string; archivedAt: string | null };
type Metadata = { categories: Category[]; branches: { id: string; name: string }[] };
type Breakdown = { branchId: string; branchName: string; categoryId: string; categoryName: string; categoryCode: string; count: number; paid: number };
type Listing = { branchNames: Record<string, string>; breakdown: Breakdown[]; expenses: Expense[]; count: number; pageSize: number; totals: { paid: number; returned: number } };
const field = nativeFieldClassName;
const button = nativeButtonClassName;
const primary = nativePrimaryButtonClassName;
const label = "mb-1.5 block text-base font-semibold";
const linkButton = cn(nativePrimaryButtonClassName, "min-h-11 justify-center text-base");
const issueMap = (issues: { path: PropertyKey[]; message: string }[]) => {
  const out: Record<string, string> = {};
  for (const i of issues) { const k = String(i.path[0] ?? "form"); out[k] = out[k] ? out[k] + "؛ " + i.message : i.message; }
  return out;
};
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
  const canManageCategories = user.role === "CAFE_OWNER" && manage;
  const [categorySearch, setCategorySearch] = useState("");
  const [rename, setRename] = useState<Category | null>(null);
  const [renameName, setRenameName] = useState("");
  const [expenseBranch, setExpenseBranch] = useState(user.branchId ?? "");
  const [metadata, setMetadata] = useState<Metadata>({ categories: [], branches: [] });
  const [setupError, setSetupError] = useState("");
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState(""); const [filterCategory, setFilterCategory] = useState("");
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [categoryErrors, setCategoryErrors] = useState<Record<string, string>>({}); const [categoryAck, setCategoryAck] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false); const [categoryError, setCategoryError] = useState("");
  const [createOpen, setCreateOpen] = useState(false); const [categoriesOpen, setCategoriesOpen] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => loadExpenseIntent(window.sessionStorage, intentOwner, "/api/expenses"))
      .then(intent => {
        if (!live) return;
        setPending(intent); setUncertain(!!intent);
        if (intent && "branchId" in intent.body) {
          setExpenseBranch(intent.body.branchId); setCategoryId(intent.body.categoryId); setAmount(String(intent.body.amount));
          setDescription(intent.body.description); setReference(intent.body.documentReference ?? "");
        }
        setReadyOwner(intentOwner);
      }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [intentOwner]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    const controller = new AbortController();
    api<Metadata>("/api/expenses/categories", {signal:controller.signal,readTimeoutMs:20_000})
      .then(r => { if (live) { setMetadata(r); setSetupError(""); } })
      .catch(e => { if (live) setSetupError(message(e)); });
    return () => { live = false; controller.abort(); };
  }, [view, version]);
  useEffect(() => {
    if (!view) return;
    let live = true;
    const q = new URLSearchParams({ page: String(page), ...(search ? { q: search } : {}), ...(filterCategory ? { categoryId: filterCategory } : {}), ...(branchId ? { branchId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    const controller = new AbortController();
    api<Listing>(`/api/expenses?${q}`, {signal:controller.signal,readTimeoutMs:20_000})
      .then(r => { if (live) { setListing(r); setReadError(""); } })
      .catch(e => { if (live) { setReadError(message(e)); setListing(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [branchId, from, to, page, version, view, search, filterCategory]);
  function refresh() { setLoading(true); setVersion(v => v + 1); }
  async function pay(event: FormEvent) {
    event.preventDefault(); if (!intentReady) return;
    setError(""); setSuccess(""); setFieldErrors({});
    if (!pending) {
      const missing: Record<string, string> = {};
      if (!expenseBranch) missing.branchId = "اختر فرع الصرف";
      if (!metadata.categories.some(c => c.id === categoryId && !c.archivedAt)) missing.categoryId = "اختر تصنيفًا نشطًا من القائمة";
      if (!(Number(amount) > 0)) missing.amount = "أدخل مبلغًا أكبر من صفر";
      if (!description.trim()) missing.description = "اكتب وصف المصروف";
      if (Object.keys(missing).length) { setFieldErrors(missing); return; }
    }
    const result = pending ? null : expenseInput.safeParse({ branchId: expenseBranch, categoryId, amount: Number(amount), description, ...(reference.trim() ? { documentReference: reference } : {}) });
    if (result && !result.success) {
      const issues = issueMap(result.error.issues);
      const known = ["branchId", "categoryId", "amount", "description"];
      setFieldErrors(Object.fromEntries(Object.entries(issues).filter(([k]) => known.includes(k))));
      const rest = Object.entries(issues).filter(([k]) => !known.includes(k)).map(([, m]) => m);
      if (rest.length || !Object.keys(issues).some(k => known.includes(k))) setError(rest.join("؛ ") || "راجع بيانات المصروف");
      return;
    }
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
    event.preventDefault(); setCategoryError(""); setCategoryErrors({});
    const result = categoryInput.safeParse({ code: categoryCode, nameAr: categoryName, classification: "OPERATING_EXPENSE" });
    if (!result.success || !categoryAck) {
      const issues = result.success ? {} : issueMap(result.error.issues);
      setCategoryErrors({ ...(issues.nameAr ? { nameAr: issues.nameAr } : {}), ...(issues.code ? { code: issues.code } : {}), ...(categoryAck ? {} : { ack: "أكّد أن البند للمصروف التشغيلي فقط" }) });
      const rest = Object.entries(issues).filter(([k]) => k !== "nameAr" && k !== "code").map(([, m]) => m);
      if (rest.length) setCategoryError(rest.join("؛ "));
      return;
    }
    setCategoryBusy(true);
    try { await api("/api/expenses/categories", { method: "POST", body: result.data }); setCategoryName(""); setCategoryCode(""); setCategoryAck(false); refresh(); }
    catch (e) { setCategoryError(message(e)); } finally { setCategoryBusy(false); }
  }
  async function saveRename(event: FormEvent) {
    event.preventDefault();
    if (!rename) return;
    const result = categoryUpdateInput.safeParse({ nameAr: renameName });
    if (!result.success) { setCategoryError(result.error.issues.map(issue => issue.message).join("، ")); return; }
    setCategoryError(""); setCategoryBusy(true);
    try {
      await api(`/api/expenses/categories/${rename.id}`, { method: "PATCH", body: result.data });
      setRename(null); refresh();
    } catch (e) { setCategoryError(message(e)); } finally { setCategoryBusy(false); }
  }
  async function archive(c: Category) {
    setCategoryError(""); setCategoryBusy(true);
    try { await api(`/api/expenses/categories/${c.id}`, { method: "PATCH", body: { archived: !c.archivedAt } }); refresh(); }
    catch (e) { setCategoryError(message(e)); } finally { setCategoryBusy(false); }
  }
  if (!view) return <p role="alert">ليس لديك صلاحية عرض المصروفات.</p>;
  const activeCategories = metadata.categories.filter(c => !c.archivedAt);
  const query = categorySearch.trim().toLowerCase();
  const categoryChoices = metadata.categories.filter(c =>
    (!!pending && c.id === categoryId) || (!c.archivedAt && (c.id === categoryId || `${c.nameAr} ${c.code}`.toLowerCase().includes(query))));
  const selectedCategory = metadata.categories.find(c => c.id === categoryId);
  const branchLabel = branchId ? (metadata.branches.find(b => b.id === branchId)?.name ?? "فرع محدد") : "كل الفروع";
  const categoryLabel = filterCategory ? (metadata.categories.find(c => c.id === filterCategory)?.nameAr ?? "تصنيف محدد") : "";
  const rangeLabel = from || to ? `${from || "البداية"} ← ${to || "اليوم"}` : "كل الفترات";
  const appliedFilters = [
    ...(search ? [`بحث: ${search}`] : []), ...(categoryLabel ? [`التصنيف: ${categoryLabel}`] : []),
    ...(branchId ? [`الفرع: ${branchLabel}`] : []), ...(from || to ? [`الفترة (القاهرة): ${rangeLabel}`] : []),
  ];
  const clearFilters = () => { setSearch(""); setFilterCategory(""); setFrom(""); setTo(""); if (!user.branchId) setBranchId(""); setPage(1); setLoading(true); };
  function openExpense() {
    if (!pending) setExpenseBranch(user.branchId ?? branchId);
    setCategorySearch(""); setFieldErrors({}); setError("");
    setCreateOpen(true);
  }
  const touchChange = (apply: () => void) => { apply(); setPage(1); setLoading(true); };
  return <main dir="rtl" className="workspace-page">
    <PageHeader title="مصروفات التشغيل" subtitle="سجل المصروفات وردود النقد من درج الوردية">
      <div className="flex flex-wrap items-center gap-3">
        {manage && <button className={primary + " min-h-12 px-6 text-base font-bold"} onClick={openExpense}>{uncertain ? "استعادة نتيجة المصروف المعلق" : "+ إضافة مصروف"}</button>}
        {canManageCategories && <button className={button + " min-h-12 px-5 text-base"} onClick={() => { setCategoryError(""); setCategoriesOpen(true); }}>إدارة تصنيفات المصروفات</button>}
        <Link href="/finance" className="inline-flex min-h-11 items-center text-base font-medium text-primary underline">مساحة الماليات ←</Link>
      </div>
    </PageHeader>
    <p className="max-w-3xl text-base leading-relaxed text-muted-foreground">مصروف تشغيلي مدفوع فورًا من درجك الحالي بالجنيه المصري. المشتريات وسداد الموردين والسلف والأجور والأصول ومسحوبات المالك لها مسارات منفصلة.</p>
    {setupError && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-base text-destructive">تعذر تحميل الفروع والتصنيفات: {setupError} <button className={button} onClick={refresh}>إعادة التحميل</button></p>}
    {readError && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-base text-destructive">{readError} <button className={button} onClick={refresh}>إعادة التحميل</button></p>}

    <section aria-label="ملخص المصروفات" className="grid gap-4 md:grid-cols-2">
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold text-muted-foreground">إجمالي المصروفات</h2>
        <p className="mt-2 text-4xl font-bold tabular-nums leading-tight text-foreground">{listing ? <bdi>{money(listing.totals.paid, "EGP")}</bdi> : "—"}</p>
        <p className="mt-2 text-sm text-muted-foreground">صرف نقدي من الدرج ضمن النطاق: {rangeLabel} — {branchLabel}{categoryLabel ? ` — ${categoryLabel}` : ""}</p>
      </div>
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold text-muted-foreground">النقد المرتجع</h2>
        <p className="mt-2 text-4xl font-bold tabular-nums leading-tight text-primary">{listing ? <bdi>{money(listing.totals.returned, "EGP")}</bdi> : "—"}</p>
        <p className="mt-2 text-sm text-muted-foreground">يشمل النقد المرتبط بالمصروفات المطابقة فقط، بصرف النظر عن تاريخ الرد.</p>
      </div>
    </section>

    <section aria-label="تصفية المصروفات" className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-bold">تصفية التقرير</h2><p className="text-sm text-muted-foreground">الفرع هنا يحدد ما يظهر في التقرير فقط؛ فرع الصرف يُختار داخل نافذة إضافة المصروف.</p></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div><label className={label} htmlFor="expense-search">بحث في المصروفات</label><input id="expense-search" className={field} maxLength={120} placeholder="الوصف أو المرجع" value={search} onChange={e => touchChange(() => setSearch(e.target.value))} /></div>
        <div><label className={label} htmlFor="expense-filter-category">التصنيف</label><select id="expense-filter-category" className={field} value={filterCategory} onChange={e => touchChange(() => setFilterCategory(e.target.value))}><option value="">كل التصنيفات</option>{metadata.categories.map(c => <option key={c.id} value={c.id}>{c.nameAr}{c.archivedAt ? " — مؤرشف" : ""}</option>)}</select></div>
        <div><label className={label} htmlFor="expense-branch">فرع التقرير</label><select id="expense-branch" className={field} value={branchId} disabled={!!user.branchId || busy || uncertain || !intentReady} onChange={e => touchChange(() => setBranchId(e.target.value))}>
          <option value="">كل الفروع</option>{metadata.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select></div>
        <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:col-span-1">
          <div><label className={label} htmlFor="expense-from">من تاريخ (القاهرة)</label><input id="expense-from" className={field} type="date" value={from} onChange={e => touchChange(() => setFrom(e.target.value))} /></div>
          <div><label className={label} htmlFor="expense-to">إلى تاريخ (القاهرة)</label><input id="expense-to" className={field} type="date" value={to} onChange={e => touchChange(() => setTo(e.target.value))} /></div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="الفلاتر المطبقة">
        <span className="text-base font-semibold">الفلاتر المطبقة:</span>
        {appliedFilters.length ? appliedFilters.map(f => <span key={f} className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary [overflow-wrap:anywhere]">{f}</span>) : <span className="text-sm text-muted-foreground">بدون فلاتر — كل المصروفات</span>}
        {appliedFilters.length > 0 && <button type="button" className={button + " min-h-11 text-sm"} onClick={clearFilters}>مسح الفلاتر</button>}
      </div>
    </section>

    {loading ? <p role="status" className="workspace-state text-base">جارٍ تحميل المصروفات…</p> : listing && <section aria-label="سجل المصروفات" className="space-y-5">
      <h2 className="text-xl font-bold">سجل المصروفات <span className="text-base font-normal text-muted-foreground">({listing.count})</span></h2>
      {listing.expenses.length === 0 ? <p className="workspace-state text-base">لا توجد مصروفات في النطاق المحدد.</p> : <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{listing.expenses.map(e => <li key={e.id}>
        <article className="flex h-full flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm" aria-label={`${e.categoryName} — ${money(e.amount, "EGP")}`}>
          <header className="space-y-2">
            <p className="text-3xl font-bold tabular-nums leading-tight"><bdi>{money(e.amount, "EGP")}</bdi></p>
            <p className="inline-block rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary [overflow-wrap:anywhere]">{e.categoryName}</p>
          </header>
          <dl className="flex-1 divide-y divide-border/60 text-base">
            <div className="py-2"><dt className="text-sm text-muted-foreground">الوصف</dt><dd className="[overflow-wrap:anywhere]">{e.description}</dd></div>
            <div className="py-2"><dt className="text-sm text-muted-foreground">الفرع</dt><dd>{listing.branchNames[e.branchId] ?? "فرع غير متاح"}</dd></div>
            <div className="py-2"><dt className="text-sm text-muted-foreground">الموظف</dt><dd>{e.actorName}</dd></div>
            <div className="py-2"><dt className="text-sm text-muted-foreground">التاريخ (القاهرة)</dt><dd>{date(e.occurredAt)}</dd></div>
            <div className="py-2"><dt className="text-sm text-muted-foreground">النقد المرتجع</dt><dd className="font-semibold tabular-nums"><bdi>{money(e.returnedAmount, "EGP")}</bdi></dd></div>
          </dl>
          <Link href={`/expenses/${e.id}`} className={linkButton + " w-full"}>عرض التفاصيل</Link>
        </article>
      </li>)}</ul>}
      <div className="flex flex-wrap items-center justify-center gap-4"><button className={button + " min-h-11 px-5 text-base"} disabled={page === 1} onClick={() => { setPage(p => p - 1); setLoading(true); }}>السابق</button><span className="text-base font-medium">صفحة {page}</span><button className={button + " min-h-11 px-5 text-base"} disabled={page * listing.pageSize >= listing.count} onClick={() => { setPage(p => p + 1); setLoading(true); }}>التالي</button></div>
      {listing.breakdown.length > 0 && <section className="rounded-2xl border border-border/70 bg-muted/40 p-5" aria-label="ملخص الصرف حسب الفرع والتصنيف">
        <h2 className="text-lg font-bold">الصرف حسب الفرع والتصنيف</h2>
        <p className="mt-1 text-sm text-muted-foreground">لكل النتائج المطابقة لفترة الصرف والفلاتر. الأسماء كما سُجلت وقت الصرف. النقد المرتجع معروض في بطاقة الملخص أعلاه.</p>
        <ul className="mt-4 grid gap-3 md:grid-cols-2">{listing.breakdown.map(group => <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card p-4" key={JSON.stringify([group.branchId, group.categoryId, group.categoryName, group.categoryCode])}>
          <div className="min-w-0"><p className="text-base font-semibold [overflow-wrap:anywhere]">{group.categoryName} <bdi className="text-sm font-normal text-muted-foreground">({group.categoryCode})</bdi></p><p className="text-sm text-muted-foreground">{group.branchName} — {group.count} {group.count === 1 ? "مصروف" : "مصروفات"}</p></div>
          <p className="text-xl font-bold tabular-nums"><bdi>{money(group.paid, "EGP")}</bdi></p>
        </li>)}</ul>
      </section>}
    </section>}

    {manage && <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto p-0 sm:max-w-2xl" dir="rtl"><form onSubmit={pay} noValidate className="flex flex-col" aria-label="تسجيل مصروف">
      <div className="space-y-5 p-5">
        <DialogTitle className="text-xl font-bold">إضافة مصروف تشغيلي</DialogTitle>
        <p className="text-base text-muted-foreground">يُصرف المبلغ فورًا من درج الوردية الحالي في الفرع المختار.</p>
        <fieldset disabled={busy || uncertain || !intentReady} className="space-y-5">
          <div className="space-y-4 rounded-xl border border-border/70 p-4">
            <p className="text-base font-bold">١. المبلغ والفرع</p>
            <div><label className={label} htmlFor="expense-amount">المبلغ — ج.م</label>
              <input id="expense-amount" className={field + " h-14 text-2xl font-bold"} type="number" inputMode="decimal" min="0.01" step="0.01" max="9999999999.99" placeholder="0.00" aria-invalid={!!fieldErrors.amount} aria-describedby={fieldErrors.amount ? "expense-amount-error" : undefined} value={amount} onChange={e => setAmount(e.target.value)} />
              {fieldErrors.amount && <p id="expense-amount-error" role="alert" className="mt-1 text-sm font-medium text-destructive">{fieldErrors.amount}</p>}</div>
            <div><label className={label} htmlFor="expense-create-branch">فرع الصرف — درج الصرف</label>
              <select id="expense-create-branch" className={field} value={expenseBranch} disabled={!!user.branchId || busy || uncertain || !intentReady} aria-invalid={!!fieldErrors.branchId} aria-describedby={fieldErrors.branchId ? "expense-branch-error" : undefined} onChange={e => setExpenseBranch(e.target.value)}><option value="">اختر الفرع الذي سيتم الصرف من درجه</option>{metadata.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              {fieldErrors.branchId && <p id="expense-branch-error" role="alert" className="mt-1 text-sm font-medium text-destructive">{fieldErrors.branchId}</p>}</div>
          </div>
          <div className="space-y-3 rounded-xl border border-border/70 p-4">
            <p className="text-base font-bold">٢. التصنيف</p>
            <label className={label} htmlFor="expense-category-search">ابحث عن تصنيف بالاسم أو الكود</label>
            <input id="expense-category-search" className={field} type="search" placeholder="مثال: نظافة" value={categorySearch} onChange={e => setCategorySearch(e.target.value)} aria-controls="expense-category" />
            <div id="expense-category" role="listbox" aria-label="تصنيف المصروف النشط" className="grid max-h-56 gap-2 overflow-y-auto">
              {categoryChoices.map(c => <button key={c.id} type="button" role="option" aria-selected={c.id === categoryId} onClick={() => setCategoryId(c.id)}
                className={cn("flex min-h-12 items-center justify-between gap-3 rounded-xl border px-4 py-2 text-start text-base", c.id === categoryId ? "border-primary bg-primary/10 font-semibold" : "border-border bg-card hover:border-primary")}>
                <span className="[overflow-wrap:anywhere]">{c.nameAr} <bdi className="text-sm text-muted-foreground">({c.code})</bdi></span>{c.id === categoryId && <span aria-hidden="true" className="text-primary">✓</span>}</button>)}
            </div>
            {query && !categoryChoices.length && <p role="status" className="text-base text-muted-foreground">لا يوجد تصنيف مطابق للبحث.</p>}
            {selectedCategory && <p className="text-sm text-muted-foreground">التصنيف المختار: <strong className="text-foreground">{selectedCategory.nameAr}</strong></p>}
            {fieldErrors.categoryId && <p role="alert" className="text-sm font-medium text-destructive">{fieldErrors.categoryId}</p>}
          </div>
          <div className="space-y-4 rounded-xl border border-border/70 p-4">
            <p className="text-base font-bold">٣. التفاصيل</p>
            <div><label className={label} htmlFor="expense-description">الوصف</label><textarea id="expense-description" className={field + " min-h-24"} maxLength={500} aria-invalid={!!fieldErrors.description} aria-describedby={fieldErrors.description ? "expense-description-error" : undefined} value={description} onChange={e => setDescription(e.target.value)} />
              {fieldErrors.description && <p id="expense-description-error" role="alert" className="mt-1 text-sm font-medium text-destructive">{fieldErrors.description}</p>}</div>
            <div><label className={label} htmlFor="expense-reference">مرجع المستند — اختياري</label><input id="expense-reference" className={field} maxLength={200} value={reference} onChange={e => setReference(e.target.value)} /></div>
          </div>
        </fieldset>
        {!setupError && !activeCategories.length && <div className="space-y-2 rounded-xl border border-border/70 p-4 text-base">
          <p>لا توجد تصنيفات نشطة. يلزم إعداد تصنيف قبل تسجيل المصروف.</p>
          {canManageCategories ? <button type="button" className={button} onClick={() => { setCreateOpen(false); setCategoriesOpen(true); }}>إعداد تصنيفات المصروفات</button>
            : <p>اطلب من مالك الكافيه إتاحة تصنيف للصرف.</p>}
        </div>}
        {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-base font-medium text-destructive">{error}</p>}
        {uncertain && <p role="status" className="rounded-xl border border-border bg-muted/50 p-3 text-base">يوجد طلب صرف سابق لم تُحسم نتيجته. استعد النتيجة بنفس البيانات والمفتاح، ولا تسلّم نقدًا جديدًا أثناء الاستعادة.</p>}
        {success && <p role="status" className="rounded-xl bg-primary/10 p-3 text-base">تم حفظ أو استعادة نتيجة الطلب. <Link className="font-semibold underline" href={`/expenses/${success}`}>فتح الإيصال ورد النقد</Link></p>}
      </div>
      <div className="sticky bottom-0 flex flex-wrap gap-3 border-t border-border bg-card p-4">
        <button className={primary + " min-h-12 flex-1 text-base font-bold"} disabled={busy || !intentReady || (!pending && !!setupError)} type="submit">{busy ? "جارٍ التحقق والحفظ…" : uncertain ? "إعادة المحاولة واستعادة النتيجة" : "تسجيل الصرف الفعلي"}</button>
        <button type="button" className={button + " min-h-12 px-5 text-base"} onClick={() => setCreateOpen(false)}>إغلاق</button>
      </div>
    </form></DialogContent></Dialog>}

    {canManageCategories && <Dialog open={categoriesOpen} onOpenChange={setCategoriesOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" dir="rtl"><DialogTitle className="text-xl font-bold">تصنيفات المصروفات</DialogTitle><section className="space-y-5" aria-label="تصنيفات المصروفات">
      <form onSubmit={createCategory} noValidate className="space-y-4 rounded-xl border border-border/70 p-4">
        <h2 className="text-lg font-bold">إضافة تصنيف جديد</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className={label} htmlFor="category-name">اسم البند بالعربية</label><input id="category-name" className={field} maxLength={100} value={categoryName} aria-invalid={!!categoryErrors.nameAr} onChange={e => setCategoryName(e.target.value)} />{categoryErrors.nameAr && <p role="alert" className="mt-1 text-sm font-medium text-destructive">{categoryErrors.nameAr}</p>}</div>
          <div><label className={label} htmlFor="category-code">كود البند</label><input id="category-code" className={field} dir="ltr" maxLength={40} placeholder="CLEANING" value={categoryCode} aria-invalid={!!categoryErrors.code} onChange={e => setCategoryCode(e.target.value)} />{categoryErrors.code && <p role="alert" className="mt-1 text-sm font-medium text-destructive">{categoryErrors.code}</p>}</div>
        </div>
        <label className="flex items-start gap-3 text-base"><input type="checkbox" className="mt-1 size-5" checked={categoryAck} onChange={e => setCategoryAck(e.target.checked)} />أعتمد هذا البند للمصروف التشغيلي فقط، ولا يشمل مشتريات المخزون أو الموردين أو السلف أو الأجور أو الأصول أو المسحوبات.</label>
        {categoryErrors.ack && <p role="alert" className="text-sm font-medium text-destructive">{categoryErrors.ack}</p>}
        <button className={primary + " min-h-12 w-full text-base font-bold sm:w-auto"} disabled={categoryBusy}>إنشاء التصنيف</button>
      </form>
      {categoryError && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-base font-medium text-destructive">{categoryError}</p>}
      <div className="space-y-3"><h2 className="text-lg font-bold">التصنيفات الحالية</h2>
      <ul className="space-y-3">{metadata.categories.map(c => <li key={c.id} className="space-y-3 rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-base font-semibold [overflow-wrap:anywhere]">{c.nameAr} <bdi className="text-sm font-normal text-muted-foreground">({c.code})</bdi> <span className={cn("ms-2 rounded-full px-2 py-0.5 text-sm font-medium", c.archivedAt ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>{c.archivedAt ? "مؤرشف" : "نشط"}</span></p>
          <div className="flex flex-wrap gap-2">
            <button className={button + " min-h-11 text-base"} disabled={categoryBusy} onClick={() => { setRename(c); setRenameName(c.nameAr); setCategoryError(""); }}>تعديل الاسم</button>
            <button className={button + " min-h-11 text-base"} disabled={categoryBusy} onClick={() => void archive(c)}>{c.archivedAt ? "إتاحة البند" : "أرشفة البند"}</button>
          </div>
        </div>
        {rename?.id === c.id && <form onSubmit={saveRename} className="space-y-3 rounded-lg bg-muted/40 p-3">
          <label className={label} htmlFor="category-rename">الاسم الجديد للتصنيف</label>
          <input id="category-rename" className={field} maxLength={100} value={renameName} onChange={e => setRenameName(e.target.value)} required />
          <p className="text-sm text-muted-foreground">تظهر التسمية الجديدة في المصروفات اللاحقة. تبقى التسمية المسجلة في الإيصالات السابقة.</p>
          <div className="flex flex-wrap gap-2"><button className={primary + " min-h-11 text-base"} disabled={categoryBusy}>حفظ الاسم</button>
          <button className={button + " min-h-11 text-base"} type="button" disabled={categoryBusy} onClick={() => setRename(null)}>إلغاء</button></div>
        </form>}
      </li>)}</ul></div>
    </section></DialogContent></Dialog>}
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
    const controller = new AbortController();
    api<{ expense: Expense; drawerStatus: string }>(`/api/expenses/${id}`, {signal:controller.signal,readTimeoutMs:20_000})
      .then(r => { if (live) { setData(r); setError(""); } })
      .catch(e => { if (live) setError(message(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
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
  return <main dir="rtl" className="mx-auto flex max-w-3xl flex-col gap-5">
    <style>{`@media print { .expense-no-print { display: none !important; } }`}</style>
    <Link href="/expenses" className="expense-no-print inline-flex min-h-11 items-center text-base font-medium text-primary underline">← العودة للمصروفات</Link><h1 className="text-2xl font-bold">إيصال مصروف ورد النقد</h1>
    {loading && <p role="status" className="text-base">جارٍ تحميل الإيصال…</p>}
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-base font-medium text-destructive">{error}</p>}
    {!data && !loading && <button className={button + " min-h-11 text-base"} onClick={() => { setLoading(true); setVersion(v => v + 1); }}>إعادة التحميل</button>}
    {data && <>
      <article className="space-y-5 rounded-2xl border border-border/70 bg-card p-5 shadow-sm" aria-label="إيصال المصروف">
        <header className="space-y-2">
          <p className="text-4xl font-bold tabular-nums leading-tight"><bdi>{money(data.expense.amount, "EGP")}</bdi></p>
          <p className="inline-block rounded-full bg-primary/10 px-3 py-1 text-base font-semibold text-primary [overflow-wrap:anywhere]">{data.expense.categoryName}</p>
          <p className="text-sm text-muted-foreground">مصروف تشغيلي مدفوع من الدرج — {data.expense.currency}</p>
        </header>
        <p className="text-base leading-relaxed [overflow-wrap:anywhere]">{data.expense.description}</p>
        <dl className="divide-y divide-border/60 text-base">
          <div className="py-2"><dt className="text-sm text-muted-foreground">رقم المصروف</dt><dd className="break-all">{data.expense.id}</dd></div>
          <div className="py-2"><dt className="text-sm text-muted-foreground">الفرع / الوردية الأصلية</dt><dd className="break-all">{data.expense.branchId} / {data.expense.shiftId}</dd></div>
          <div className="py-2"><dt className="text-sm text-muted-foreground">المنفذ ووقت الصرف — القاهرة</dt><dd>{data.expense.actorName} — {date(data.expense.occurredAt)}</dd></div>
          <div className="py-2"><dt className="text-sm text-muted-foreground">مرجع المستند</dt><dd className="[overflow-wrap:anywhere]">{data.expense.documentReference ?? "لا يوجد"}</dd></div>
          <div className="py-2"><dt className="text-sm text-muted-foreground">النقد المرتجع / المتبقي غير المرتجع</dt><dd className="font-semibold tabular-nums"><bdi>{money(data.expense.returnedAmount, "EGP")}</bdi> / <bdi>{money(data.expense.unrecoveredAmount, "EGP")}</bdi></dd></div>
        </dl>
        <section className="space-y-2"><h3 className="text-lg font-bold">ردود نقدية موثقة</h3>
        {data.expense.returns.length === 0 ? <p className="text-base text-muted-foreground">لم يُسجل رد نقد.</p> : <ul className="space-y-3">{data.expense.returns.map(r => <li key={r.id} className="rounded-xl border border-border/70 p-3 text-base">
          <p className="font-semibold tabular-nums"><bdi>{money(r.amount, "EGP")}</bdi> — <span className="font-normal [overflow-wrap:anywhere]">{r.reason}</span></p><p className="text-sm text-muted-foreground">{r.actorName} — {date(r.occurredAt)}</p><p className="text-sm text-muted-foreground">مرجع: {r.documentReference ?? "لا يوجد"}</p>
        </li>)}</ul>}</section>
        <button className={button + " expense-no-print min-h-11 text-base"} onClick={() => window.print()}>طباعة الإيصال</button>
      </article>
      {mayExecuteExpense(user.role, new Set(permKeys)) && (pending || data.expense.unrecoveredAmount > 0) && <section className="expense-no-print space-y-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="text-lg font-bold">تسجيل عودة نقد فعلية</h2>
        <p className="text-base text-muted-foreground">لا يمحو المصروف. يُقبل فقط إلى الدرج الأصلي وهو مفتوح وفي عهدتك. الرد إلى درج آخر أو بعد الإقفال يحتاج مسارًا منفصلًا.</p>
        {data.drawerStatus !== "OPEN" && !pending ? <p role="status" className="text-base">الدرج الأصلي مغلق أو قيد التسليم؛ الرد غير متاح في هذه الدفعة.</p> : <form onSubmit={receive} className="space-y-4">
          <fieldset disabled={busy || uncertain || !intentReady} className="space-y-4">
            <div><label className={label} htmlFor="return-amount">النقد الذي عاد — ج.م</label><input id="return-amount" className={field + " h-14 text-2xl font-bold"} type="number" inputMode="decimal" min="0.01" step="0.01" max={data.expense.unrecoveredAmount} value={amount} onChange={e => setAmount(e.target.value)} required /></div>
            <div><label className={label} htmlFor="return-reason">سبب ودليل عودة النقد</label><textarea id="return-reason" className={field + " min-h-24"} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} required /></div>
            <div><label className={label} htmlFor="return-reference">مرجع المستند — اختياري</label><input id="return-reference" className={field} maxLength={200} value={reference} onChange={e => setReference(e.target.value)} /></div>
            <label className="flex items-start gap-3 text-base"><input type="checkbox" className="mt-1 size-5" required />أؤكد استلام النقد فعليًا في الدرج الأصلي.</label>
          </fieldset>
          {uncertain && <p role="status" className="rounded-xl border border-border bg-muted/50 p-3 text-base">يوجد طلب رد سابق لم تُحسم نتيجته. استعد نتيجته؛ لا تستلم نقدًا جديدًا أثناء الاستعادة.</p>}
          <button className={primary + " min-h-12 w-full text-base font-bold"} disabled={busy || !intentReady}>{busy ? "جارٍ الحفظ…" : uncertain ? "إعادة المحاولة بنفس الطلب" : "تسجيل النقد المستلم"}</button>
        </form>}
      </section>}
      {saved && <p role="status" className="rounded-xl bg-primary/10 p-3 text-base">تم تسجيل عودة النقد وحفظ دليلها.</p>}
    </>}
  </main>;
}
