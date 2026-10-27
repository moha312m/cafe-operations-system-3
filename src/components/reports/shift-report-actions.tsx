"use client";

import { useState } from "react";

// Screen-only actions for the shift report page (hidden in print via
// .no-print): print, and — for oversight with WhatsApp enabled — send it to
// the café's WhatsApp recipient now.
export function ShiftReportActions({ shiftId, canSend }: { shiftId: string; canSend: boolean }) {
  const [state, setState] = useState<{ busy: boolean; note: string | null; ok: boolean }>({ busy: false, note: null, ok: false });

  async function send() {
    setState({ busy: true, note: null, ok: false });
    try {
      const res = await fetch(`/api/shifts/${shiftId}/report/whatsapp`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setState(res.ok
        ? { busy: false, note: "اتبعت على واتساب ✅", ok: true }
        : { busy: false, note: body.error ?? "فشل الإرسال", ok: false });
    } catch {
      setState({ busy: false, note: "تعذر الاتصال بالسيرفر", ok: false });
    }
  }

  const btn = {
    border: 0, borderRadius: 10, padding: "10px 22px", fontSize: 14, fontWeight: 600, cursor: "pointer",
  } as const;

  return (
    <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "16px 0" }}>
      <button onClick={() => window.print()} style={{ ...btn, background: "#111", color: "#fff" }}>
        🖨️ طباعة التقرير
      </button>
      {canSend && (
        <button
          data-testid="send-shift-report-whatsapp"
          onClick={send}
          disabled={state.busy}
          style={{ ...btn, background: "#16a34a", color: "#fff", opacity: state.busy ? 0.6 : 1 }}
        >
          {state.busy ? "جاري الإرسال…" : "📲 ابعته على واتساب"}
        </button>
      )}
      <button
        onClick={() => (window.history.length > 1 ? window.history.back() : window.close())}
        style={{ ...btn, background: "#fff", color: "#111", border: "1px solid #ddd", fontWeight: 400 }}
      >
        رجوع
      </button>
      {state.note && (
        <p style={{ width: "100%", textAlign: "center", fontSize: 13, color: state.ok ? "#15803d" : "#b91c1c", margin: 0 }}>
          {state.note}
        </p>
      )}
    </div>
  );
}
