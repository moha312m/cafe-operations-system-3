// Whether a branch counts materials at handover, and what a settings save
// persists for it. Pure: shared by the effective configuration, the save and
// the tests.
//
// The defect this answers: an owner picked items and a cadence for a branch
// whose café default is NO_SHIFT_COUNT, the panel still sent `enabled: false`,
// and the save pinned the branch to NO_SHIFT_COUNT. The close then skipped the
// materials step although the settings screen showed items and EVERY_SHIFT.
//
// The panel now turns counting on with any count choice, and the save rule
// below persists HYBRID for a save carrying an active count setup unless the
// owner explicitly switched counting off in that save.
//
// Reading is deliberately NOT inferred: a café-level NO_SHIFT_COUNT is set on
// purpose (the schema default is HYBRID and no screen sets it), and a branch
// that inherits it does not count until the owner saves that branch.

import type { StockCountPolicy } from "@prisma/client";

/**
 * The `stockCountPolicyOverride` a save writes, or `undefined` to leave it.
 *
 * `enabled: false` is an explicit switch-off and always wins. `enabled: true`
 * is HYBRID. With `enabled` absent, an active count setup in the save (SELECTED
 * with at least one item, or a stated materials cadence) persists HYBRID when
 * counting is currently off, so the branch never stays pinned to NO_SHIFT_COUNT
 * underneath the items the owner just picked.
 */
export function savedPolicyOverride(args: {
  enabled: boolean | undefined;
  currentlyEnabled: boolean;
  finalMode: "FULL" | "SELECTED";
  finalSelectedCount: number;
  materialsStated: boolean;
}): StockCountPolicy | undefined {
  if (args.enabled === false) return "NO_SHIFT_COUNT";
  if (args.enabled === true) return "HYBRID";
  const active = (args.finalMode === "SELECTED" && args.finalSelectedCount > 0) || args.materialsStated;
  return active && !args.currentlyEnabled ? "HYBRID" : undefined;
}

export const HANDOVER_DISABLED_BANNER = "تنبيه: جرد تسليم الشيفت غير مفعّل حاليًا لهذا الفرع. عند اختيار أصناف أو تكرار الجرد سيتم تفعيله تلقائيًا.";
/** The live summary under the selected items: what the close will ask for. */
export function selectedCountSummary(names: string[]): string | null {
  if (names.length === 0) return null;
  const examples = names.slice(0, 3).join("، ");
  return `مفعّل: جرد إلزامي لـ ${names.length} صنف (مثل: ${examples}${names.length > 3 ? "…" : ""}) عند إغلاق الشيفت حسب الجدول المحدد`;
}

/** The close's first screen: the count that follows the money, by name. */
export function materialsNextLine(items: { name: string }[]): string {
  if (items.length === 0) return "الخطوة التالية: جرد الخامات المطلوبة لهذا الشيفت";
  const names = items.slice(0, 4).map((item) => item.name).join("، ");
  return `الخطوة التالية: جرد الخامات المطلوبة لهذا الشيفت (عدد ${items.length} صنف: ${names}${items.length > 4 ? "…" : ""})`;
}
