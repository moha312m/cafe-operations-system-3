// What the /handovers page asks of the viewer right now, as one ordered list.
//
// Each panel on the page checks its own server list and reports how many items
// are waiting (or that it could not check). This turns those reports into the
// one step to do now and the ones after it. Wording and order only: nothing
// here decides a transition, hides a requirement the server enforces, or
// counts anything — the panels and the APIs keep every rule.

export type PendingSource = "handover" | "night-cash" | "opening" | "place" | "cash-deliveries";
/** A panel's report: how many are waiting, "error" when it could not check, null while it is still checking. */
export type PendingReport = number | "error" | null;
export type PendingReports = Partial<Record<PendingSource, PendingReport>>;

export type NextStep = { source: PendingSource; count: number; title: string; action: string };
export type NextSteps = {
  /** Steps with something waiting, most urgent first. */
  steps: NextStep[];
  /** Panels that could not check; their own error stays visible on the page. */
  failed: PendingSource[];
  /** True while any panel has not reported yet. */
  checking: boolean;
};

// A handover in progress first; then what the next shift needs before it can sell
// (drawer cash, opening stock, the place); cash handed to the owner/manager last,
// because it never blocks the next shift.
export const STEP_ORDER: PendingSource[] = ["handover", "night-cash", "opening", "place", "cash-deliveries"];

const TEXT: Record<PendingSource, { title: (n: number) => string; action: string }> = {
  handover: { title: (n) => (n === 1 ? "تسليم شيفت مستني خطوة" : `${n} تسليمات مستنية خطوة`), action: "افتح التسليم" },
  "night-cash": { title: () => "عدّ واستلام كاش الدرج من شيفت الليل", action: "عدّ الكاش" },
  opening: { title: () => "جرد الافتتاح والتحقق من عهدة الفرع", action: "ابدأ" },
  place: { title: () => "فحص المكان والأجهزة", action: "ابدأ الفحص" },
  "cash-deliveries": { title: (n) => (n === 1 ? "تسليم نقدية مستني تأكيد" : `${n} تسليمات نقدية مستنية تأكيد`), action: "راجع وأكّد" },
};

export function nextSteps(reports: PendingReports, sources: PendingSource[] = STEP_ORDER): NextSteps {
  const steps: NextStep[] = [];
  const failed: PendingSource[] = [];
  let checking = false;
  for (const source of STEP_ORDER) {
    if (!sources.includes(source)) continue;
    const report = reports[source];
    if (report === undefined || report === null) { checking = true; continue; }
    if (report === "error") { failed.push(source); continue; }
    if (report > 0) steps.push({ source, count: report, title: TEXT[source].title(report), action: TEXT[source].action });
  }
  return { steps, failed, checking };
}

export const STEP_LABEL: Record<PendingSource, string> = {
  handover: "التسليمات",
  "night-cash": "كاش الدرج من شيفت الليل",
  opening: "التحقق من العهدة الافتتاحية",
  place: "استلام المكان والأجهزة",
  "cash-deliveries": "تأكيد النقدية المُسلّمة للمالك / المدير",
};

/** The anchor each panel renders, so the card can bring it into view. */
export const stepAnchor = (source: PendingSource) => `handover-step-${source}`;
