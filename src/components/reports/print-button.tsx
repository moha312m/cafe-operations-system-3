"use client";

// Screen-only print trigger for the standalone A4 report pages.
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} style={{ font: "inherit", padding: "6px 14px", border: "1px solid #888", borderRadius: 8, background: "#fff", cursor: "pointer" }}>
      طباعة
    </button>
  );
}
