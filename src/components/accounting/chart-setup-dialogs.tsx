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

export type AccountDialogMode = "create" | "group" | "sub" | "edit";
type LockedRow = ChartRow & { locks?: { identity: string; deactivate: string | null; move: string | null; code: string | null } };
const NORMAL_SIDE: Record<string, string> = { ASSET: "مدين", EXPENSE: "مدين", LIABILITY: "دائن", EQUITY: "دائن", REVENUE: "دائن" };
const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

function Locked({ reason }: { reason: string }) {
  return <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground"><span aria-hidden>🔒</span><span>{reason}</span></p>;
}

export function getDefaultParentId(chosenType: string, allHeaders: ChartRow[]): string {
  const matching = allHeaders.filter((h) => h.type === chosenType);
  if (matching.length === 0) return "";
  if (chosenType === "EXPENSE") {
    const p5400 = matching.find((h) => h.code === "5400");
    if (p5400) return p5400.id;
    const p5000 = matching.find((h) => h.code === "5000");
    if (p5000) return p5000.id;
  }
  if (chosenType === "ASSET") {
    const p1000 = matching.find((h) => h.code === "1000");
    if (p1000) return p1000.id;
  }
  if (chosenType === "LIABILITY") {
    const p2000 = matching.find((h) => h.code === "2000");
    if (p2000) return p2000.id;
  }
  if (chosenType === "EQUITY") {
    const p3000 = matching.find((h) => h.code === "3000");
    if (p3000) return p3000.id;
  }
  if (chosenType === "REVENUE") {
    const p4000 = matching.find((h) => h.code === "4000");
    if (p4000) return p4000.id;
  }
  return matching.find((h) => !h.parentId)?.id ?? matching[0].id;
}

export function suggestNextCode(chosenType: string, rows: ChartRow[]): string {
  const prefix = chosenType === "ASSET" ? "1" : chosenType === "LIABILITY" ? "2" : chosenType === "EQUITY" ? "3" : chosenType === "REVENUE" ? "4" : "5";
  const existing = new Set(rows.map((r) => r.code));
  const start = chosenType === "EXPENSE" ? 5410 : parseInt(`${prefix}100`, 10);
  for (let c = start; c < parseInt(`${prefix}990`, 10); c += 10) {
    const s = String(c);
    if (!existing.has(s)) return s;
  }
  for (let c = parseInt(`${prefix}001`, 10); c <= parseInt(`${prefix}999`, 10); c++) {
    const s = String(c);
    if (!existing.has(s)) return s;
  }
  return "";
}

/**
 * Unified account creation and editing dialog.
 * Creates operational accounts by default (isPostable: true) with automatic parent group matching,
 * or optional header groups (isPostable: false).
 */
export function AccountDialog({ mode, account, rows, onClose, onSaved }: { mode: AccountDialogMode; account: LockedRow | null; rows: ChartRow[]; onClose: () => void; onSaved: () => void }) {
  const editing = mode === "edit" && !!account;
  const system = !!account?.systemKey;
  const headers = rows.filter((r) => !r.isPostable);
  const [isGroup, setIsGroup] = useState<boolean>(editing ? !account!.isPostable : mode === "group");
  const [type, setType] = useState<string>(account?.type ?? "EXPENSE");
  const [parentId, setParentId] = useState<string>(() => {
    if (account?.parentId) return account.parentId;
    if (mode === "group") return "";
    return getDefaultParentId(account?.type ?? "EXPENSE", headers);
  });
  const [code, setCode] = useState<string>(() => {
    if (account?.code) return account.code;
    return suggestNextCode("EXPENSE", rows);
  });
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState(account?.name ?? "");
  const [isActive, setIsActive] = useState(account?.isActive ?? true);
  const [contra, setContra] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyFor = useRequestKey();

  const handleTypeChange = (newType: string) => {
    setType(newType);
    if (!isGroup) {
      setParentId(getDefaultParentId(newType, headers));
    } else {
      setParentId("");
    }
    if (!codeTouched && !editing) {
      setCode(suggestNextCode(newType, rows));
    }
  };

  const handleGroupToggle = (nextGroup: boolean) => {
    setIsGroup(nextGroup);
    if (nextGroup) {
      setParentId("");
    } else {
      setParentId(getDefaultParentId(type, headers));
    }
  };

  const parent = headers.find((h) => h.id === parentId);
  const parentChoices = editing
    ? headers.filter((h) => h.type === account!.type && h.id !== account!.id)
    : headers.filter((h) => h.type === type);
  const side = contra ? (NORMAL_SIDE[type] === "مدين" ? "دائن" : "مدين") : (NORMAL_SIDE[type] ?? "مدين");
  const locks = account?.locks;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (editing) {
        const finalReason = reason.trim() || "تعديل بيانات الحساب";
        const body: Record<string, unknown> = { reason: finalReason };
        if (name !== account!.name) body.name = name;
        if (code !== account!.code) body.code = code;
        if (!system && !locks?.deactivate && isActive !== account!.isActive) body.isActive = isActive;
        if (!system && !locks?.move && parentId && parentId !== account!.parentId) body.parentId = parentId;
        await api(`/api/accounting/accounts/${account!.id}`, { method: "PATCH", body, idempotencyKey: keyFor({ id: account!.id, ...body }) });
      } else {
        const isPostable = !isGroup;
        const finalReason = reason.trim() || (isPostable ? "إضافة حساب تشغيلي جديد" : "إنشاء مجموعة رئيسية جديدة");
        const effectiveParentId = isPostable ? (parentId || getDefaultParentId(type, headers)) : (parentId || null);

        if (isPostable && !effectiveParentId) {
          throw new Error("لا توجد مجموعة رئيسية لهذا النوع. أنشئ مجموعة رئيسية أولاً أو حوّل الحساب لمجموعة رئيسية");
        }
        if (name.trim().length < 2) {
          throw new Error("اسم الحساب مطلوب (حرفين على الأقل)");
        }
        if (!/^\d{4}$/.test(code.trim())) {
          throw new Error("الكود يجب أن يتكون من 4 أرقام");
        }

        const body = {
          code: code.trim(),
          name: name.trim(),
          type,
          parentId: effectiveParentId || null,
          isPostable,
          contra: isPostable ? contra || undefined : undefined,
          reason: finalReason,
        };
        await api("/api/accounting/accounts", { method: "POST", body, idempotencyKey: keyFor(body) });
      }
      onSaved(); onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  const title = editing ? `تعديل الحساب ${account!.code}` : isGroup ? "إضافة حساب رئيسي (مجموعة)" : "إضافة حساب";
  return (
    <Shell title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">بيغيّر دليل الحسابات بس. مفيش قيد بيتعمل أو بيتعدّل، والقيود المرحّلة بتفضل زي ما هي.</p>

        {!editing && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="acct-name">اسم الحساب بالعربي</label>
                <input
                  id="acct-name"
                  className={field}
                  maxLength={100}
                  placeholder="مثال: مستلزمات نظافة، صيانة ماكينة"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className={label} htmlFor="acct-type">نوع الحساب</label>
                <select
                  id="acct-type"
                  className={field}
                  value={type}
                  onChange={(e) => handleTypeChange(e.target.value)}
                >
                  {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="acct-code">الكود (4 أرقام)</label>
                <input
                  id="acct-code"
                  className={field}
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="مثال: 5410"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setCodeTouched(true);
                  }}
                />
              </div>
              <div>
                <label className={label} htmlFor="acct-parent">
                  {isGroup ? "تحت أي مجموعة؟ (اختياري)" : "المجموعة الرئيسية (الحساب الأب)"}
                </label>
                <select
                  id="acct-parent"
                  className={field}
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  {isGroup && <option value="">— بدون: مجموعة جذر تحت النوع —</option>}
                  {parentChoices.map((h) => <option key={h.id} value={h.id}>{h.code} — {h.name}</option>)}
                </select>
                {!isGroup && parent && (
                  <p className="mt-1 text-xs text-muted-foreground">يتبع مجموعة: {parent.code} — {parent.name}</p>
                )}
                {!isGroup && parentChoices.length === 0 && (
                  <p role="alert" className="mt-1 text-xs text-destructive">لا توجد مجموعة رئيسية لهذا النوع. أنشئ مجموعة أولاً أو حوّل الحساب لمجموعة رئيسية.</p>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <label className="flex items-center gap-3 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 rounded"
                  checked={isGroup}
                  onChange={(e) => handleGroupToggle(e.target.checked)}
                />
                <span>حساب رئيسي (مجموعة تجمع حسابات ولا يقبل قيود مباشرة)</span>
              </label>
              <p className="text-xs text-muted-foreground">الجانب الطبيعي: <b className="text-foreground">{side}</b> — {isGroup ? "المجموعة مابتاخدش قيود." : "حساب تشغيلي يقبل قيود."}</p>
              {!isGroup && (
                <label className="flex items-center gap-3 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    className="size-4 rounded"
                    checked={contra}
                    onChange={(e) => setContra(e.target.checked)}
                  />
                  <span>حساب عكسي (جانبه عكس طبيعة نوعه، مثل خصومات المشتريات ومردودات المبيعات)</span>
                </label>
              )}
            </div>
          </>
        )}

        {editing && (
          <>
            {(mode !== "edit" || !system) && (
              <div>
                <label className={label} htmlFor="acct-parent">المجموعة (الحساب الأب)</label>
                <select id="acct-parent" className={field} value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={editing && !!locks?.move}>
                  <option value="">— بدون تغيير —</option>
                  {parentChoices.map((h) => <option key={h.id} value={h.id}>{h.code} — {h.name} ({TYPE_LABELS[h.type] ?? h.type})</option>)}
                </select>
                {editing && locks?.move && <Locked reason={locks.move} />}
              </div>
            )}
            {editing && system && account!.parentCode && <p className="text-sm text-muted-foreground">المجموعة: {account!.parentCode} — {account!.parentName}</p>}
            {editing && system && locks?.move && <Locked reason={locks.move} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className={label} htmlFor="acct-code">الكود (4 أرقام)</label><input id="acct-code" className={field} dir="ltr" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value)} /></div>
              <div><label className={label} htmlFor="acct-name">الاسم بالعربي</label><input id="acct-name" className={field} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
            </div>
            <label className="flex items-center gap-3 text-base"><input type="checkbox" className="size-5" checked={isActive} disabled={!!locks?.deactivate && account!.isActive} onChange={(e) => setIsActive(e.target.checked)} />نشط</label>
            {locks?.deactivate && account!.isActive && <Locked reason={locks.deactivate} />}
            <div className="rounded-lg border border-dashed p-3 text-sm">
              <p className="font-semibold">ثابت — مش بيتغير من هنا</p>
              <p className="mt-1 text-muted-foreground">{locks?.identity ?? "النوع والجانب وكونه رئيسي أو يقبل قيود ثابتين بعد الإنشاء."}</p>
              {system && <p className="mt-1 text-muted-foreground">الكود والاسم بيتعدلوا بأمان لأن الترحيل بيوصل للحساب بمفتاحه مش بكوده.</p>}
            </div>
          </>
        )}

        <div>
          <label className={label} htmlFor="acct-reason">السبب أو الملاحظات (اختياري)</label>
          <input
            id="acct-reason"
            className={field}
            maxLength={300}
            placeholder={isGroup ? "مثال: مجموعة رئيسية للمصروفات" : "مثال: حساب تشغيلي لمصروفات النظافة"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Error_ text={error} />
        <button className={nativePrimaryButtonClassName + " min-h-12 w-full text-base font-bold sm:w-auto"} disabled={busy}>{busy ? "جارٍ الحفظ…" : editing ? "حفظ التعديل" : "إضافة الحساب"}</button>
      </form>
    </Shell>
  );
}

export const UnifiedAccountDialog = AccountDialog;

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
