"use client";

// Branch currency (v1: one currency for the whole cafe; every branch shows it).
//
// The owner picks the currency before the first financial record. After that it is locked: no conversion of
// history exists, so the only safe change is none. The server checks everything again; this card only shows
// the state and asks for the reason.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { CURRENCIES, currencyMeta } from "@/lib/currency";
import { formatDateTime } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type State = {
  cafeCurrency: string;
  branches: { id: string; name: string; currencyCode: string }[];
  locked: boolean;
  history: { id: string; entityId: string | null; createdAt: string; user: { name: string } | null; details: { from?: string; to?: string; reason?: string } | null }[];
};

const label = (code: string) => {
  const meta = currencyMeta(code);
  return meta ? `${meta.nameAr} (${meta.code} · ${meta.symbol})` : code;
};

export function BranchCurrencyCard({ branchId }: { branchId: string }) {
  const { user, canKey } = useApp();
  const canEdit = user.role === "CAFE_OWNER" && canKey("settings.edit");
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const requestKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setState(await api<State>(`/api/branches/${branchId}/currency`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل العملة");
    }
  }, [branchId]);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);

  const term = search.trim().toLowerCase();
  const options = CURRENCIES.filter(c => !term || `${c.nameAr} ${c.code} ${c.symbol}`.toLowerCase().includes(term));
  const nameOf = (id: string | null) => state?.branches.find(b => b.id === id)?.name;

  function startChange() {
    if (!picked || !state || picked === state.cafeCurrency) return;
    requestKey.current = crypto.randomUUID();
    setReason("");
    setDialogError("");
    setOpen(true);
  }

  async function confirm() {
    if (!picked || busy) return;
    setBusy(true);
    setDialogError("");
    try {
      await api(`/api/branches/${branchId}/currency`, {
        method: "PATCH",
        body: { currencyCode: picked, reason },
        idempotencyKey: requestKey.current ?? crypto.randomUUID(),
      });
      toast.success("اتغيّرت العملة");
      setOpen(false);
      setPicked(null);
      await load();
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "تعذر تغيير العملة");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="branch-currency-card">
      <CardHeader><CardTitle className="text-base">عملة الفروع</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          كل فروع الكافيه بتستخدم عملة واحدة، وبتظهر في الشاشات والإيصالات والتقارير. أول حركة مالية بتقفل العملة، ومفيش تحويل للأرقام القديمة.
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!state ? (
          !error && <p className="text-sm text-muted-foreground">جاري التحميل…</p>
        ) : (
          <>
            <ul className="divide-y rounded-lg border text-sm">
              {state.branches.map(b => (
                <li key={b.id} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate font-medium">{b.name}</span>
                  <span className="shrink-0 text-muted-foreground" dir="auto">{label(b.currencyCode)}</span>
                </li>
              ))}
            </ul>

            {state.locked ? (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                العملة مقفلة لوجود حركات مالية — مش هتتغير تاني عشان الأرقام القديمة تفضل بمعناها.
              </p>
            ) : canEdit ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="currency-search">ابحث عن عملة</Label>
                  <Input id="currency-search" className="h-11 text-base" value={search} onChange={e => setSearch(e.target.value)} placeholder="الاسم أو الرمز، مثلًا SAR" />
                </div>
                <div role="radiogroup" aria-label="العملة" className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-1">
                  {options.length === 0 && <p className="p-3 text-sm text-muted-foreground">مفيش عملة مطابقة.</p>}
                  {options.map(c => {
                    const selected = (picked ?? state.cafeCurrency) === c.code;
                    return (
                      <button
                        key={c.code}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!c.supported}
                        onClick={() => setPicked(c.code)}
                        className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-start text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                      >
                        <span className="min-w-0 truncate">{c.nameAr}</span>
                        <span className="shrink-0 text-xs" dir="ltr">{c.code} · {c.symbol}{!c.supported ? " · غير مدعومة حالياً" : ""}</span>
                      </button>
                    );
                  })}
                </div>
                <Button className="min-h-11" disabled={!picked || picked === state.cafeCurrency} onClick={startChange}>تغيير العملة…</Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">تغيير العملة للمالك فقط.</p>
            )}

            {state.history.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold">آخر التغييرات</h3>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {state.history.map(h => (
                    <li key={h.id}>
                      {formatDateTime(h.createdAt)} · {nameOf(h.entityId) ?? "فرع"} · من {h.details?.from ?? "—"} إلى {h.details?.to ?? "—"} · {h.user?.name ?? "—"}{h.details?.reason ? ` · ${h.details.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>تأكيد تغيير العملة</DialogTitle>
              <DialogDescription>
                من {state ? label(state.cafeCurrency) : ""} إلى {picked ? label(picked) : ""}. التغيير بيشمل كل الفروع، وبعد أول حركة مالية مش هينفع يتغير تاني.
              </DialogDescription>
            </DialogHeader>
            <p className="rounded-lg bg-muted p-3 text-sm">
              أسعار المنيو وتكاليف الخامات هتتقرأ بالعملة الجديدة من غير تحويل — راجعها بعد التغيير.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="currency-reason">سبب التغيير</Label>
              <Input id="currency-reason" className="h-11 text-base" value={reason} maxLength={300} onChange={e => setReason(e.target.value)} />
            </div>
            {dialogError && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}
            <DialogFooter>
              <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>رجوع</Button>
              <Button className="min-h-11" disabled={busy || reason.trim().length < 3} onClick={() => void confirm()}>{busy ? "جاري الحفظ…" : "تأكيد التغيير"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
