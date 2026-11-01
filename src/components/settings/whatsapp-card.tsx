"use client";

// The owner's WhatsApp Business connection: every shift close sends a report
// to the number set here. The access token is write-only — the screen only
// learns whether one is stored, and the field stays empty after saving.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type View = {
  enabled: boolean;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
  recipientPhone: string;
  tokenSet: boolean;
  templateBody: string;
  paramCount: number;
  recentLogs: { createdAt: string; status: string; trigger: string; error: string | null; recipientMasked: string | null }[];
};

const TRIGGER_LABEL: Record<string, string> = { AUTO: "تلقائي", MANUAL: "يدوي", TEST: "تجربة" };

export function WhatsAppCard() {
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState({ phoneNumberId: "", templateName: "", templateLanguage: "ar", recipientPhone: "" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(v: View) {
    setView(v);
    setForm({
      phoneNumberId: v.phoneNumberId,
      templateName: v.templateName,
      templateLanguage: v.templateLanguage,
      recipientPhone: v.recipientPhone,
    });
    setToken("");
  }

  useEffect(() => {
    let cancelled = false;
    api<View>("/api/cafe/whatsapp")
      .then((v) => {
        if (!cancelled) apply(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "فشل تحميل إعدادات واتساب");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(extra: { enabled?: boolean } = {}) {
    if (!view) return;
    const body: Record<string, unknown> = { ...extra };
    if (form.phoneNumberId.trim() !== view.phoneNumberId) body.phoneNumberId = form.phoneNumberId.trim();
    if (form.templateName.trim() !== view.templateName) body.templateName = form.templateName.trim();
    if (form.templateLanguage.trim() !== view.templateLanguage) body.templateLanguage = form.templateLanguage.trim();
    if (form.recipientPhone.trim() !== view.recipientPhone) body.recipientPhone = form.recipientPhone.trim();
    if (token.trim()) body.accessToken = token.trim();
    if (Object.keys(body).length === 0) {
      toast.info("مفيش تغيير");
      return;
    }
    setBusy(true);
    try {
      const v = await api<View>("/api/cafe/whatsapp", { method: "PATCH", body });
      apply(v);
      toast.success(
        extra.enabled === true ? "تم تفعيل إرسال التقرير على واتساب" : extra.enabled === false ? "تم إيقاف واتساب" : "تم الحفظ"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const r = await api<{ shiftNumber: number }>("/api/cafe/whatsapp/test", { method: "POST" });
      toast.success(`اتبعت تقرير شيفت #${r.shiftNumber} كتجربة ✅`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الإرسال");
    } finally {
      setBusy(false);
      api<View>("/api/cafe/whatsapp").then(setView).catch(() => {});
    }
  }

  const field = (key: keyof typeof form, label: string, placeholder: string) => (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      <Input
        dir="ltr"
        value={form[key]}
        placeholder={placeholder}
        disabled={busy || !view}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  return (
    <Card data-testid="whatsapp-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          📲 تقرير قفل الشيفت على واتساب
          {view && (
            <span
              className={
                "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                (view.enabled ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground")
              }
            >
              {view.enabled ? "مفعّل" : "متوقف"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          كل ما شيفت يتقفل، يوصلك على واتساب ملخص: المبيعات، النقدية المتوقعة والفعلية، العجز أو الزيادة، والأوردرات اللي
          اترحّلت. محتاج حساب WhatsApp Business على Meta وقالب رسالة متوافق عليه.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {field("phoneNumberId", "Phone Number ID", "123456789012345")}
          {field("recipientPhone", "رقم المستلم (موبايلك)", "01012345678")}
          {field("templateName", "اسم القالب", "shift_close_report")}
          {field("templateLanguage", "لغة القالب", "ar")}
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium">
            Access Token {view?.tokenSet && <span className="text-emerald-700">(محفوظ ✓ — اكتب واحد جديد بس لو عايز تغيّره)</span>}
          </span>
          <Input
            type="password"
            dir="ltr"
            autoComplete="off"
            value={token}
            placeholder={view?.tokenSet ? "••••••••" : "EAAG…"}
            disabled={busy || !view}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => save()} disabled={busy || !view}>
            حفظ البيانات
          </Button>
          {view && !view.enabled && (
            <Button onClick={() => save({ enabled: true })} disabled={busy}>
              حفظ وتفعيل
            </Button>
          )}
          {view?.enabled && (
            <>
              <Button variant="outline" onClick={sendTest} disabled={busy}>
                ابعت تجربة (آخر شيفت مقفول)
              </Button>
              <Button variant="ghost" onClick={() => save({ enabled: false })} disabled={busy}>
                إيقاف
              </Button>
            </>
          )}
        </div>

        {view && (
          <details className="rounded-lg border bg-muted/30 p-3 text-xs">
            <summary className="cursor-pointer font-medium">نص القالب اللي تسجّله في Meta ({view.paramCount} متغيرات)</summary>
            <pre dir="rtl" className="mt-2 whitespace-pre-wrap font-sans leading-6">{view.templateBody}</pre>
            <p className="mt-2 text-muted-foreground">
              سجّله من WhatsApp Manager ← Message templates، نوع Utility، بنفس ترتيب المتغيرات، واستنى الموافقة. المتغير
              الأخير رابط التقرير، ومحتاج يكون متظبط APP_BASE_URL على السيرفر.
            </p>
          </details>
        )}

        {view && view.recentLogs.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-semibold">آخر محاولات الإرسال</p>
            {view.recentLogs.map((l, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {new Date(l.createdAt).toLocaleString("ar-EG")} · {TRIGGER_LABEL[l.trigger] ?? l.trigger} ·{" "}
                {l.status === "SENT" ? (
                  <span className="text-emerald-700">اتبعت ✓</span>
                ) : (
                  <span className="text-red-600">فشل: {l.error}</span>
                )}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
