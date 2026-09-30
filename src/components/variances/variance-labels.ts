// The vocabulary the variance screens share.
//
// Arabic lives beside the screens that show it, the way the tables screen
// already does it: these labels name states of ONE feature, and a café that
// renames "متجاوَز عنها" is renaming it here, not hunting through a global
// dictionary for a key it has to guess.
//
// Every value mirrors an enum the server owns (`src/lib/variance-case.ts`).
// Nothing here decides anything — a label the server does not recognise
// simply has no button behind it.

export const VARIANCE_STATUSES = [
  "OPEN",
  "UNDER_INVESTIGATION",
  "RESPONSIBILITY_ASSIGNED",
  "APPROVED",
  "RESOLVED",
  "WAIVED",
] as const;

export type VarianceStatus = (typeof VARIANCE_STATUSES)[number];

export const VARIANCE_TYPES = ["CASH", "TENDER", "STOCK", "OPENING_EXCEPTION"] as const;
export type VarianceType = (typeof VARIANCE_TYPES)[number];

export const STATUS_LABEL: Record<VarianceStatus, string> = {
  OPEN: "مفتوحة",
  UNDER_INVESTIGATION: "تحت الفحص",
  RESPONSIBILITY_ASSIGNED: "محددة المسؤولية",
  APPROVED: "معتمدة",
  RESOLVED: "مقفولة",
  WAIVED: "متجاوَز عنها",
};

export const TYPE_LABEL: Record<VarianceType, string> = {
  CASH: "فرق كاش",
  TENDER: "فرق تحصيل",
  STOCK: "فرق مخزون",
  OPENING_EXCEPTION: "استثناء فتح",
};

/**
 * The two moves that END a case, and therefore cost the closing key.
 *
 * This mirrors `CLOSING` in `src/app/api/variances/[id]/advance/route.ts`,
 * which picks `variance.resolve` for these and `variance.investigate` for
 * everything else. Mirrored so a button nobody may press is not drawn —
 * the server still decides, and refuses a forged request either way.
 */
export const CLOSING_STATUSES: readonly VarianceStatus[] = ["RESOLVED", "WAIVED"];

export function keyForTarget(to: VarianceStatus): string {
  return CLOSING_STATUSES.includes(to) ? "variance.resolve" : "variance.investigate";
}

/**
 * Which moves the service will entertain from here.
 *
 * A mirror of `LEGAL` in `src/lib/variance-case.ts`. Convenience, not
 * enforcement: the transaction re-checks it and refuses regardless of what
 * this file allows to be drawn. `RESOLVED` is reachable only from
 * `APPROVED`, and the two terminal states offer nothing.
 */
export const LEGAL_NEXT: Record<VarianceStatus, VarianceStatus[]> = {
  OPEN: ["UNDER_INVESTIGATION", "WAIVED"],
  UNDER_INVESTIGATION: ["RESPONSIBILITY_ASSIGNED", "APPROVED", "WAIVED"],
  RESPONSIBILITY_ASSIGNED: ["APPROVED", "WAIVED"],
  APPROVED: ["RESOLVED", "WAIVED"],
  RESOLVED: [],
  WAIVED: [],
};
