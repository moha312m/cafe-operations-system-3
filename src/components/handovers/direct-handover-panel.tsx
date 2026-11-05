"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, money as formatMoney } from "@/lib/client";
import { UNIT_LABEL } from "@/lib/inventory";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DirectSummary } from "@/lib/handover-direct";

const unitLabel = (u: string) => UNIT_LABEL[u as keyof typeof UNIT_LABEL] ?? u;

export function DirectHandoverPanel({
  handoverId,
  branchId,
  requiredItems,
  onAccepted,
}: {
  handoverId: string;
  branchId: string;
  requiredItems: Array<{ inventoryItemId: string; itemNameSnapshot: string; unitSnapshot: string }>;
  onAccepted?: () => Promise<void> | void;
}) {
  const [summary, setSummary] = useState<DirectSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Issue reporting state
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueKind, setIssueKind] = useState<"CASH" | "STOCK_ITEM" | "OTHER">("CASH");
  const [issueItemId, setIssueItemId] = useState("");
  const [issueAmount, setIssueAmount] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueBusy, setIssueBusy] = useState(false);

  // Issue resolution state
  const [resolveIssueId, setResolveIssueId] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const acceptKeyRef = useRef<string>("");
  const issueKeyRef = useRef<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<DirectSummary>(`/api/handovers/${handoverId}/direct`);
      setSummary(data);
      setError(null);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تحميل ملخص التسليم المباشر");
      return null;
    } finally {
      setLoading(false);
    }
  }, [handoverId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!issueItemId && requiredItems[0]) {
      setIssueItemId(requiredItems[0].inventoryItemId);
    }
  }, [issueItemId, requiredItems]);

  async function handleAccept() {
    if (!summary || busy) return;
    if (!acceptKeyRef.current) {
      acceptKeyRef.current = `direct-acc-${handoverId}-${crypto.randomUUID()}`;
    }
    setBusy(true);
    try {
      let reviewVersion = summary.reviewVersion;
      if (summary.incoming.state === "NONE") {
        await api("/api/shifts", {
          method: "POST",
          body: { branchId, openingCashAmount: 0 },
        });
        const refreshed = await api<DirectSummary>(`/api/handovers/${handoverId}/direct`);
        reviewVersion = refreshed.reviewVersion;
      }
      await api(`/api/handovers/${handoverId}/direct`, {
        method: "POST",
        body: {
          reviewVersion,
          idempotencyKey: acceptKeyRef.current,
        },
      });
      toast.success("تم فتح ورديتك واستلام العهدة بنجاح");
      await load();
      await onAccepted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر استلام العهدة");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleReportIssue() {
    if (issueBusy || !issueDescription.trim()) return;
    if (!issueKeyRef.current) {
      issueKeyRef.current = `issue-${handoverId}-${crypto.randomUUID()}`;
    }
    setIssueBusy(true);
    try {
      await api(`/api/handovers/${handoverId}/issues`, {
        method: "POST",
        body: {
          kind: issueKind,
          ...(issueKind === "STOCK_ITEM" ? { inventoryItemId: issueItemId } : {}),
          ...(issueKind === "CASH" ? { amount: Number(issueAmount) } : {}),
          description: issueDescription.trim(),
          idempotencyKey: issueKeyRef.current,
        },
      });
      toast.success("تم تسجيل بلاغ الاختلاف في السجل");
      issueKeyRef.current = "";
      setIssueOpen(false);
      setIssueDescription("");
      setIssueAmount("");
      await load();
      await onAccepted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسجيل الإبلاغ عن الاختلاف");
    } finally {
      setIssueBusy(false);
    }
  }

  async function handleResolveIssue(id: string) {
    if (issueBusy || !resolveNote.trim()) return;
    setIssueBusy(true);
    try {
      await api(`/api/handover-issues/${id}/resolve`, {
        method: "POST",
        body: { note: resolveNote.trim() },
      });
      toast.success("تمت مراجعة وحسم بلاغ الاختلاف");
      setResolveIssueId(null);
      setResolveNote("");
      await load();
      await onAccepted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر حسم البلاغ");
    } finally {
      setIssueBusy(false);
    }
  }

  if (loading && !summary) {
    return <div className="h-32 animate-pulse rounded-xl border bg-muted/30" />;
  }
  if (error && !summary) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!summary || summary.target !== "SHIFT_TO_SHIFT") return null;

  const cur = summary.currency;
  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("ar-EG", { timeZone: summary.timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <section
      className="space-y-4 rounded-xl border-2 border-primary/30 bg-card p-4 text-sm shadow-xs"
      aria-label="ملخص الاستلام المباشر للعهدة"
      data-testid="direct-handover-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold">ملخص استلام العهدة المباشر</h3>
          <p className="text-xs text-muted-foreground">
            المُسلّم: {summary.outgoing.name} (شيفت #{summary.outgoing.shiftNumber}) · التقديم: {fmtDate(summary.outgoing.submittedAt)}
          </p>
        </div>
        {summary.acknowledgement ? (
          <span
            className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-200"
            data-testid="direct-handover-acknowledged-badge"
          >
            ✓ تم استلام العهدة وفتح الوردية ({summary.acknowledgement.byName ?? "المستلم"} · {fmtDate(summary.acknowledgement.at)})
          </span>
        ) : (
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            استلام بخطوة واحدة بدون إعادة عدّ
          </span>
        )}
      </div>

      {/* 1. Cash custody & deliveries */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border bg-emerald-500/5 p-3">
          <div className="text-xs font-medium text-muted-foreground">تُترك في الدرج كعهدة (رصيد افتتاح ورديتك)</div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-emerald-800 dark:text-emerald-300" data-testid="direct-summary-retained-cash">
            {summary.cash.retained === null ? "لم يُحدد بعد" : formatMoney(summary.cash.retained, cur)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.incoming.state === "WAITING"
              ? `سيُضبط رصيد افتتاح شيفتك المنتظر (#${summary.incoming.shiftNumber}) على هذا المبلغ مباشرةً.`
              : "عند الضغط على الزر أدناه ستُفتح ورديتك بهذا الرصيد الافتتاحي مباشرةً."}
          </p>
        </div>

        <div className="rounded-xl border bg-muted/20 p-3">
          <div className="text-xs font-medium text-muted-foreground">تسليمات نقدية مُعلنة للمالك / المدير</div>
          <div className="mt-1 text-base font-bold tabular-nums">
            {summary.cash.delivered === null ? "—" : formatMoney(summary.cash.delivered, cur)}
          </div>
          {summary.cash.deliveries.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">لا توجد تسليمات خارج الدرج (النقدية متروكة في الدرج).</p>
          ) : (
            <div className="mt-1.5 space-y-1">
              {summary.cash.deliveries.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-1 text-xs">
                  <span>
                    {d.destinationLabel} ({d.recipientName}): <strong className="tabular-nums">{formatMoney(d.amount, cur)}</strong>
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium",
                      d.status === "CONFIRMED" || d.status === "RESOLVED"
                        ? "bg-emerald-500/15 text-emerald-800"
                        : d.status === "DISPUTED"
                          ? "bg-rose-500/15 text-rose-800"
                          : "bg-amber-500/15 text-amber-900",
                    )}
                  >
                    {d.statusLabel}
                  </span>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                التسليم المُعلن بانتظار تأكيد المستلم من حسابه لا يعطّل استلامك للنقدية المتروكة في الدرج.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Oversight-only closing cash vs expected */}
      {summary.cash.counted !== null && (
        <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/15 px-3 py-2 text-xs">
          <span>النقد المعدود عند الإغلاق: <strong className="tabular-nums">{formatMoney(summary.cash.counted, cur)}</strong></span>
          {summary.cash.expected !== null && <span>المتوقع بالنظام: <strong className="tabular-nums">{formatMoney(summary.cash.expected, cur)}</strong></span>}
          {summary.cash.difference !== null && (
            <span>
              فرق العد عند الإغلاق:{" "}
              <strong className={cn("tabular-nums", Math.abs(summary.cash.difference) > 0.005 ? "text-amber-700" : "text-emerald-700")}>
                {summary.cash.difference > 0 ? "+" : ""}{formatMoney(summary.cash.difference, cur)}
              </strong>
            </span>
          )}
        </div>
      )}

      {/* 2. Counted stock items */}
      <div className="space-y-2 rounded-xl border bg-muted/15 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">كميات الخامات المسجلة من المُسلّم ({summary.stock.lines.length})</h4>
          {summary.discrepancies.stockLines > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-900">
              {summary.discrepancies.stockLines} صنف بفرق مسجل عند الإغلاق
            </span>
          )}
        </div>
        {!summary.stock.disclosed ? (
          <p className="text-xs text-muted-foreground">تظهر كميات الخامات بمجرد تقديم المُسلّم للعهدة.</p>
        ) : summary.stock.lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">لا توجد أصناف معدودة في هذا التسليم.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="direct-summary-stock-lines">
            {summary.stock.lines.map((l) => (
              <span
                key={l.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1 text-xs tabular-nums",
                  l.recordedDifference && "border-amber-500/50 bg-amber-500/5",
                )}
              >
                <span className="font-medium">{l.name}:</span>
                <strong>{l.quantity ?? "—"}</strong>
                <span className="text-muted-foreground">{unitLabel(l.unit)}</span>
                {l.recordedDifference && <span className="text-[11px] text-amber-800">(فرق مسجل)</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 3. Carried orders & independent readiness requirements */}
      {summary.carriedOrders && summary.carriedOrders.count > 0 && (
        <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs">
          الطلبات المنقولة مع التسليم: <strong>{summary.carriedOrders.count} طلب</strong>
          {summary.carriedOrders.unpaidTotal !== null ? ` (متبقي للتحصيل: ${formatMoney(summary.carriedOrders.unpaidTotal, cur)})` : ""}.
        </p>
      )}

      {summary.readiness && !summary.readiness.operational && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <p className="font-semibold">متطلبات جاهزية مستقلة لورديتك (#{summary.readiness.shiftNumber}):</p>
          <ul className="mt-1 list-inside list-disc">
            {summary.readiness.requirements
              .filter((r) => r.state === "pending" && r.id !== "custody")
              .map((r) => (
                <li key={r.id}>{r.label}{r.detail ? ` — ${r.detail}` : ""}</li>
              ))}
          </ul>
        </div>
      )}

      {summary.blockers.length > 0 && !summary.acknowledgement && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs" data-testid="direct-summary-blockers">
          {summary.blockers.map((b) => (
            <p key={b}>• {b}</p>
          ))}
        </div>
      )}

      {/* Primary Action + Report Discrepancy */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!summary.acknowledgement && (
          <Button
            className="h-12 flex-1 text-base font-bold"
            disabled={busy || !summary.can.acknowledge}
            onClick={() => void handleAccept()}
            data-testid="direct-handover-accept"
          >
            {busy ? "جارٍ فتح الوردية واستلام العهدة…" : "فتح ورديتي واستلام العهدة"}
          </Button>
        )}

        {summary.can.reportIssue && (
          <Button
            type="button"
            variant="outline"
            className="h-12"
            onClick={() => setIssueOpen((v) => !v)}
            data-testid="direct-handover-report-issue-toggle"
          >
            الإبلاغ عن اختلاف
          </Button>
        )}
      </div>

      {/* Report-an-issue form */}
      {issueOpen && (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3" data-testid="direct-handover-issue-form">
          <h4 className="font-semibold">الإبلاغ عن اختلاف في التسليم</h4>
          <p className="text-xs text-muted-foreground">
            يُسجّل البلاغ للمراجعة مع الحفاظ الكامل على الأرقام التاريخية المسجلة.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="issue-kind" className="text-xs">نوع الاختلاف</Label>
              <select
                id="issue-kind"
                className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                value={issueKind}
                onChange={(e) => setIssueKind(e.target.value as "CASH" | "STOCK_ITEM" | "OTHER")}
                data-testid="issue-kind-select"
              >
                <option value="CASH">نقدية الدرج</option>
                <option value="STOCK_ITEM">صنف خامات / مخزون</option>
                <option value="OTHER">ملاحظة أو اختلاف آخر</option>
              </select>
            </div>

            {issueKind === "CASH" && (
              <div className="space-y-1">
                <Label htmlFor="issue-amount" className="text-xs">مبلغ الكاش المختلف عليه</Label>
                <TouchNumberInput
                  id="issue-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  dir="ltr"
                  placeholder="0.00"
                  value={issueAmount}
                  aria-label="مبلغ الكاش المختلف عليه"
                  onValueChange={setIssueAmount}
                />
              </div>
            )}

            {issueKind === "STOCK_ITEM" && (
              <div className="space-y-1">
                <Label htmlFor="issue-item" className="text-xs">الصنف</Label>
                <select
                  id="issue-item"
                  className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm"
                  value={issueItemId}
                  onChange={(e) => setIssueItemId(e.target.value)}
                  data-testid="issue-item-select"
                >
                  {requiredItems.map((item) => (
                    <option key={item.inventoryItemId} value={item.inventoryItemId}>
                      {item.itemNameSnapshot} ({unitLabel(item.unitSnapshot)})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="issue-desc" className="text-xs">وصف الاختلاف</Label>
            <Textarea
              id="issue-desc"
              rows={2}
              maxLength={1000}
              placeholder="اكتب تفاصيل الاختلاف الملاحظ"
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={issueBusy || !issueDescription.trim() || (issueKind === "CASH" && issueAmount.trim() === "") || (issueKind === "STOCK_ITEM" && !issueItemId)}
              onClick={() => void handleReportIssue()}
              data-testid="direct-handover-issue-submit"
            >
              {issueBusy ? "جارٍ الحفظ…" : "تسجيل البلاغ"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssueOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      )}

      {/* Existing issues list & manager/owner resolution */}
      {summary.issues && summary.issues.length > 0 && (
        <div className="space-y-2 border-t pt-3" data-testid="direct-handover-issues-list">
          <h4 className="text-xs font-bold text-muted-foreground">بلاغات الاختلاف المسجلة ({summary.issues.length})</h4>
          {summary.issues.map((i) => (
            <div key={i.id} className="space-y-1.5 rounded-lg border bg-background p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {i.kind === "CASH" ? "نقدية" : i.kind === "STOCK_ITEM" ? `خامات (${i.itemNameSnapshot ?? "—"})` : "أخرى"}
                  {i.amount !== null ? ` — ${formatMoney(i.amount, cur)}` : ""}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-medium",
                    i.status === "RESOLVED" ? "bg-emerald-500/15 text-emerald-800" : "bg-amber-500/15 text-amber-900",
                  )}
                >
                  {i.status === "RESOLVED" ? "تمت المراجعة" : "مفتوح للمراجعة"}
                </span>
              </div>
              <p>{i.description}</p>
              <p className="text-muted-foreground">
                أبلغ عنه: {i.reportedByName} · {fmtDate(i.reportedAt)} ({i.afterAcceptance ? "بعد الاستلام" : "قبل الاستلام"})
              </p>
              {i.resolutionNote && (
                <p className="font-medium text-emerald-800">
                  نتيجة المراجعة ({i.resolvedByName ?? "—"}): {i.resolutionNote}
                </p>
              )}
              {i.status === "OPEN" && summary.can.resolveIssue && (
                <div className="pt-1">
                  {resolveIssueId !== i.id ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setResolveIssueId(i.id);
                        setResolveNote("");
                      }}
                      data-testid={`resolve-issue-toggle-${i.id}`}
                    >
                      تسجيل نتيجة المراجعة
                    </Button>
                  ) : (
                    <div className="mt-1 space-y-2 rounded-lg border bg-muted/20 p-2">
                      <Textarea
                        rows={2}
                        maxLength={1000}
                        placeholder="اكتب نتيجة المراجعة والمعالجة"
                        value={resolveNote}
                        onChange={(e) => setResolveNote(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={issueBusy || !resolveNote.trim()}
                          onClick={() => void handleResolveIssue(i.id)}
                          data-testid={`resolve-issue-submit-${i.id}`}
                        >
                          حفظ نتيجة المراجعة
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setResolveIssueId(null)}>
                          إلغاء
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
