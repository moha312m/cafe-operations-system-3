"use client";

// Owner-only edit dialogs for the chart (Step 4B.2): add or change an account, and
// approve an expense category's account mapping. Each submit carries an
// Idempotency-Key that is reused only for an identical retry. Nothing here posts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { nativeFieldClassName } from "@/components/ui/input";
import { nativeButtonClassName, nativePrimaryButtonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ChartRow } from "@/lib/accounting/chart-view";

const field = nativeFieldClassName;
const label = "mb-1.5 block text-base font-semibold";
const TYPE_LABELS: Record<string, string> = { ASSET: "أصول", LIABILITY: "خصوم", EQUITY: "حقوق ملكية", REVENUE: "إيرادات", EXPENSE: "مصروفات" };
const message = (error: unknown) => (error instanceof Error ? error.message : "تعذر إكمال الطلب");

/** One key per distinct body: an identical retry replays, an edited form is a new request. */
function useRequestKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body: unknown) => {
    const text = JSON.stringify(body);
    if (last.current?.body !== text) last.current = { body: text, key: crypto.randomUUID() };
    return last.current.key;
  };
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" dir="rtl">
        <DialogTitle className="text-xl font-bold">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
const Error_ = ({ text }: { text: string }) => (text ? <p role="alert" className="text-sm font-medium text-destructive">{text}</p> : null);

export function AccountDialog({ account, rows, onClose, onSaved }: { account: ChartRow | null; rows: ChartRow[]; onClose: () => void; onSaved: () => void }) {
  const editing = !!account;
  const system = !!account?.systemKey;
  const headers = rows.filter((r) => !r.isPostable);
  const [parentId, setParentId] = useState(account?.parentId ?? headers.find((h) => h.type === "EXPENSE")?.id ?? headers[0]?.id ?? "");
  const [code, setCode] = useState(account?.code ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [isActive, setIsActive] = useState(account?.isActive ?? true);
  const [isPostable, setIsPostable] = useState(true);
  const [contra, setContra] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyFor = useRequestKey();
  const parent = headers.find((h) => h.id === parentId);
  const parentChoices = editing ? headers.filter((h) => h.type === account!.type && h.id !== account!.id) : headers;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (editing) {
        const body: Record<string, unknown> = { reason };
        if (name !== account!.name) body.name = name;
        if (code !== account!.code) body.code = code;
        if (!system && isActive !== account!.isActive) body.isActive = isActive;
        if (!system && parentId && parentId !== account!.parentId) body.parentId = parentId;
        await api(`/api/accounting/accounts/${account!.id}`, { method: "PATCH", body, idempotencyKey: keyFor({ id: account!.id, ...body }) });
      } else {
        const body = { code, name, type: parent?.type, parentId, isPostable, contra, reason };
        await api("/api/accounting/accounts", { method: "POST", body, idempotencyKey: keyFor(body) });
      }
      onSaved(); onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  return (
    <Shell title={editing ? `تعديل الحساب ${account!.code}` : "إضافة حساب جديد"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">بيغيّر دليل الحسابات بس. مفيش قيد بيتعمل أو بيتعدّل، والقيود المرحّلة بتفضل زي ما هي.{system && " ده حساب نظام: الاسم والكود بس اللي يتعدلوا، لأن الترحيل بيوصله بمفتاحه."}</p>
        {(!editing || !system) && (
          <div>
            <label className={label} htmlFor="acct-parent">الحساب الرئيسي (الأب)</label>
            <select id="acct-parent" className={field} value={parentId} onChange={(e) => setParentId(e.target.value)} required>
              {parentChoices.map((h) => <option key={h.id} value={h.id}>{h.code} — {h.name} ({TYPE_LABELS[h.type] ?? h.type})</option>)}
            </select>
            {!editing && parent && <p className="mt-1 text-sm text-muted-foreground">النوع: {TYPE_LABELS[parent.type] ?? parent.type}</p>}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className={label} htmlFor="acct-code">الكود (4 أرقام)</label><input id="acct-code" className={field} dir="ltr" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div><label className={label} htmlFor="acct-name">الاسم</label><input id="acct-name" className={field} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
        {!editing && (
          <div className="space-y-2">
            <label className="flex items-center gap-3 text-base"><input type="checkbox" className="size-5" checked={isPostable} onChange={(e) => setIsPostable(e.target.checked)} />حساب يقبل قيود (مش رئيسي)</label>
            <label className="flex items-center gap-3 text-base"><input type="checkbox" className="size-5" checked={contra} onChange={(e) => setContra(e.target.checked)} />حساب عكسي (جانبه عكس طبيعة نوعه)</label>
          </div>
        )}
        {editing && !system && <label className="flex items-center gap-3 text-base"><input type="checkbox" className="size-5" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />نشط</label>}
        <div><label className={label} htmlFor="acct-reason">السبب</label><input id="acct-reason" className={field} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <Error_ text={error} />
        <button className={nativePrimaryButtonClassName + " min-h-12 w-full text-base font-bold sm:w-auto"} disabled={busy}>{busy ? "جارٍ الحفظ…" : editing ? "حفظ التعديل" : "إضافة الحساب"}</button>
      </form>
    </Shell>
  );
}

export type MappingTarget = { categoryId: string; categoryName: string; categoryCode: string; latestEffectiveFrom: string | null; currentAccountId: string | null; suggestedCode: string | null };
type Preview = { impact: { count: number; total: number; postedCount: number; postedTotal: number }; latestEffectiveFrom: string | null };

export function MappingDialog({ target, accounts, onClose, onSaved }: { target: MappingTarget; accounts: { id: string; code: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const suggested = accounts.find((a) => a.code === target.suggestedCode)?.id ?? "";
  const [accountId, setAccountId] = useState(target.currentAccountId ?? suggested);
  const [ended, setEnded] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(dateStrInTz(new Date()));
  const [reason, setReason] = useState("");
  const [approvalRef, setApprovalRef] = useState("");
  const [ack, setAck] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyFor = useRequestKey();

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<Preview>(`/api/accounting/expense-category-mappings/preview?${new URLSearchParams({ categoryId: target.categoryId, effectiveFrom })}`)
        .then((p) => { if (!cancelled) setPreview(p); }).catch(() => { if (!cancelled) setPreview(null); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [effectiveFrom, target.categoryId]);

  const needsAck = !!preview && preview.impact.postedCount > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const body = { categoryId: target.categoryId, accountId: ended ? null : accountId || null, effectiveFrom, expectedLatestEffectiveFrom: target.latestEffectiveFrom, reason, approvalRef, acknowledgePostedNotReclassified: ack };
      if (!ended && !accountId) throw new Error("اختار الحساب أو إنهاء الربط");
      await api("/api/accounting/expense-category-mappings", { method: "POST", body, idempotencyKey: keyFor(body) });
      onSaved(); onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  return (
    <Shell title={`اعتماد ربط «${target.categoryName}»`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">الربط بيتحفظ من تاريخ معيّن وبيتراكم في السجل. مابيغيّرش أي قيد مرحّل، ومابيرحّلش مصروفات. {target.latestEffectiveFrom ? `آخر ربط محفوظ من ${target.latestEffectiveFrom}.` : "مفيش ربط محفوظ لسه."}</p>
        <label className="flex items-center gap-3 text-base"><input type="checkbox" className="size-5" checked={ended} onChange={(e) => setEnded(e.target.checked)} />إنهاء الربط من التاريخ ده (من غير حساب)</label>
        {!ended && (
          <div>
            <label className={label} htmlFor="map-account">حساب المصروف</label>
            <select id="map-account" className={field} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">اختار الحساب…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
            {target.suggestedCode && !suggested && <p className="mt-1 text-sm text-muted-foreground">الحساب المقترح {target.suggestedCode} مش موجود بعد. أضفه الأول من «حساب جديد».</p>}
          </div>
        )}
        <div><label className={label} htmlFor="map-date">ساري من</label><input id="map-date" type="date" className={field} dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></div>
        {preview && (
          <p className="rounded-lg border p-3 text-sm" role="status">
            مصروفات التصنيف ده من التاريخ ده: {preview.impact.count} (إجمالي {preview.impact.total}). المترحّل منها فعلًا: {preview.impact.postedCount}.
          </p>
        )}
        {needsAck && <label className="flex items-start gap-3 text-base"><input type="checkbox" className="mt-1 size-5" checked={ack} onChange={(e) => setAck(e.target.checked)} />فاهم إن المصروفات المترحّلة بالفعل مش هتتصنّف تاني، وأي تصحيح ليها بيتم بقيد عكسي منفصل.</label>}
        <div><label className={label} htmlFor="map-reason">السبب</label><input id="map-reason" className={field} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div><label className={label} htmlFor="map-ref">مرجع اعتماد المحاسب</label><input id="map-ref" className={field} maxLength={120} value={approvalRef} onChange={(e) => setApprovalRef(e.target.value)} /></div>
        <Error_ text={error} />
        <button className={nativePrimaryButtonClassName + " min-h-12 w-full text-base font-bold sm:w-auto"} disabled={busy}>{busy ? "جارٍ الحفظ…" : "اعتماد الربط"}</button>
        <button type="button" className={nativeButtonClassName + " min-h-12 w-full sm:me-2 sm:w-auto"} onClick={onClose}>إلغاء</button>
      </form>
    </Shell>
  );
}
