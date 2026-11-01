// Client-safe copy for the HND-UX-004 materials decision (no server imports).

/** Arabic copy for the decision, shared by the close screen and the report. */
export function materialsDecisionLabel(d: { due: boolean; reason: string }): string {
  if (!d.due) return "جرد الخامات غير مستحق حسب الجدول";
  if (d.reason === "FULL_COUNT_DUE") return "جرد كامل مستحق حسب الجدول";
  if (d.reason === "BRANCH_CUSTODY") return "جرد لتخزين كاش الليل في عهدة الفرع";
  if (d.reason === "PERIOD_DUE") return "جرد الخامات مستحق حسب الجدول";
  return "جرد الخامات كل شيفت";
}

export const CADENCE_LABEL: Record<string, string> = { EVERY_SHIFT: "كل شيفت", DAILY: "يومي", WEEKLY: "أسبوعي" };
