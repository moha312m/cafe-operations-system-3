"use client";

// What a handover close does with orders still open in the branch, as the
// owner sets it. Off by default: the close is refused until every order is
// served or cancelled. On: the incoming shift takes them over.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function HandoverPolicyCard() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedMinutes, setSavedMinutes] = useState<number | null>(null);
  const [minutesInput, setMinutesInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ carryOpenOrdersOnHandover: boolean; staleOrderAlertMinutes: number }>("/api/cafe/handover-policy")
      .then((r) => {
        if (cancelled) return;
        setSaved(r.carryOpenOrdersOnHandover);
        setSavedMinutes(r.staleOrderAlertMinutes);
        setMinutesInput(String(r.staleOrderAlertMinutes));
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "فشل تحميل إعداد تسليم الشيفت");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const r = await api<{ carryOpenOrdersOnHandover: boolean }>("/api/cafe/handover-policy", {
        method: "PATCH",
        body: { carryOpenOrdersOnHandover: next },
      });
      setSaved(r.carryOpenOrdersOnHandover);
      toast.success(r.carryOpenOrdersOnHandover
        ? "تم التفعيل: الشيفت اللي جاي هيستلم الأوردرات المفتوحة"
        : "تم الإيقاف: لازم الأوردرات تتقفل قبل تسليم الشيفت");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل حفظ الإعداد");
    } finally {
      setBusy(false);
    }
  }

  const minutesValue = Number(minutesInput);
  const minutesValid = minutesInput.trim() !== "" && Number.isInteger(minutesValue) && minutesValue >= 0 && minutesValue <= 2880;

  async function saveMinutes() {
    if (!minutesValid || minutesValue === savedMinutes) return;
    setBusy(true);
    try {
      const r = await api<{ staleOrderAlertMinutes: number }>("/api/cafe/handover-policy", {
        method: "PATCH",
        body: { staleOrderAlertMinutes: minutesValue },
      });
      setSavedMinutes(r.staleOrderAlertMinutes);
      setMinutesInput(String(r.staleOrderAlertMinutes));
      toast.success(r.staleOrderAlertMinutes === 0 ? "تم إيقاف تنبيه الأوردرات المنسية" : "تم حفظ وقت تنبيه الأوردرات المنسية");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل حفظ الإعداد");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="handover-policy-card">
      <CardHeader>
        <CardTitle className="text-base">🔁 تسليم الشيفت والأوردرات المفتوحة</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          لما الكاشير يقفل الشيفت وفي أوردرات لسه متقدمتش أو متحصّلتش، تعمل إيه؟
        </p>

        <div className="space-y-2">
          {[
            {
              value: false,
              title: "امنع القفل لحد ما الأوردرات تخلص",
              desc: "لازم كل أوردر يتقدم أو يتلغي قبل تسليم الشيفت. الشيفت اللي ماشي مسؤول عن كل حاجة اتضربت عليه.",
            },
            {
              value: true,
              title: "الشيفت اللي جاي يستلم الأوردرات المفتوحة",
              desc: "الشيفت يتقفل عادي، والأوردرات المفتوحة تتنقل للشيفت اللي جاي: هو اللي يقدّمها ويحصّل الفلوس اللي لسه متدفعتش في درجه. الأوردرات اللي كانت بتتحضر أو جاهزة يتخصم مكوناتها من مخزون الشيفت اللي ماشي قبل الجرد، عشان الجرد ميطلعش عجز غلط على حد. كل أوردر بيتسجل في سجل التسليم.",
            },
          ].map((opt) => {
            const active = saved === opt.value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                disabled={busy || saved === null || active}
                onClick={() => toggle(opt.value)}
                className={
                  "w-full rounded-lg border-2 p-3 text-start transition-colors disabled:cursor-default " +
                  (active ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40")
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "size-4 shrink-0 rounded-full border-2 " +
                      (active ? "border-primary bg-primary" : "border-muted-foreground/40")
                    }
                  />
                  <span className="text-sm font-semibold">{opt.title}</span>
                  {active && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">الحالي</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{opt.desc}</p>
              </button>
            );
          })}
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-semibold">⏰ تنبيه الأوردرات المنسية</p>
          <p className="text-xs text-muted-foreground">
            أي أوردر فضل من غير ما يتقدم، أو اتقدم ومتحصّلش، أكتر من عدد الدقائق دي هيظهر لك وللمدير
            في شريط فوق الصفحة، ومعاه زرار «اتقدم» أو «اتلغى» أو «حصّل». اكتب 0 لإيقاف التنبيه.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              dir="ltr"
              min={0}
              max={2880}
              step={1}
              className="w-24"
              aria-label="دقائق تنبيه الأوردرات المنسية"
              value={minutesInput}
              disabled={busy || savedMinutes === null}
              onChange={(e) => setMinutesInput(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">دقيقة</span>
            <Button
              variant="outline"
              onClick={saveMinutes}
              disabled={busy || !minutesValid || minutesValue === savedMinutes}
            >
              حفظ
            </Button>
          </div>
          {!minutesValid && minutesInput.trim() !== "" && (
            <p className="text-xs text-red-600">عدد الدقائق لازم يكون رقم صحيح من 0 لـ 2880</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
