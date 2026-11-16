"use client";

import { useEffect } from "react";

// Screen-only action bar for the receipt page (hidden in print via
// .no-print). autoPrint fires the browser print dialog on load — the
// deep link POS uses for "طباعة الريسيت".
export function PrintActions({ autoPrint, printLabel = "🖨️ طباعة الريسيت" }: { autoPrint: boolean; printLabel?: string }) {
  useEffect(() => {
    if (!autoPrint) return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [autoPrint]);

  return (
    <div className="no-print" style={{ display: "flex", gap: 8, justifyContent: "center", padding: "16px 0" }}>
      <button
        onClick={() => window.print()}
        style={{
          background: "#111", color: "#fff", border: 0, borderRadius: 10,
          padding: "10px 22px", fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}
      >
        {printLabel}
      </button>
      <button
        onClick={() => (window.history.length > 1 ? window.history.back() : window.close())}
        style={{
          background: "#fff", color: "#111", border: "1px solid #ddd", borderRadius: 10,
          padding: "10px 22px", fontSize: 14, cursor: "pointer",
        }}
      >
        إغلاق
      </button>
    </div>
  );
}
