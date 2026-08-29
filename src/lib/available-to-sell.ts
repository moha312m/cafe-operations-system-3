// ── Available-to-sell: the arithmetic, and nothing else ──────────────
//
// "How many more of these can this branch actually make?"
//
// The POS has always been able to answer "not this one". It has never been
// able to answer "five", and those are different questions asked by different
// people: the first is a refusal at the till, the second is what a cashier
// needs in order to stop promising a drink two customers ahead of the
// shortage.
//
// This module holds the whole calculation and touches no database. That is
// deliberate, and it is the same split `charges.ts` has against
// `financials.ts`: the cashier's browser recomputes availability on every
// cart tap, and it must get the SAME answer as the server that will accept
// the order. One implementation, imported by both, is the only way that
// stays true — a second copy in the client is exactly how a POS comes to
// disagree with the order it just posted.
//
// ── The five answers ──
//
// Four of them are not numbers, and each names a different person's problem:
//
//   EXACT              a count we stand behind, possibly zero
//   UNKNOWN            the recipe does not resolve — fix the recipe
//   NOT_STOCK_TRACKED  recorded as consuming nothing — nothing to fix
//   NOT_STOCKED        recipe fine, this branch never carried the ingredient
//   PER_VARIANT        the sizes differ, so the product has no one count
//
// Collapsing any of them into 0 is the failure that matters. "Out of stock"
// and "nobody wrote the recipe down" look identical on a card and send
// entirely different people to entirely different screens.
//
// ── Why the arithmetic is in thousandths ──
//
// Stock is Decimal(12,3) and recipe quantities are converted and rounded to
// the same three places. In IEEE 754, 0.48 / 0.16 is 2.9999999999999996, so a
// branch holding exactly three portions would be told two. Everything below
// converts to integer thousandths first and divides there, which is exact for
// every value either side can hold.

import type { InventoryUnit, InventoryEnforcementMode } from "@prisma/client";

/** Integer thousandths of a Decimal(12,3) quantity. Exact for our domain. */
const milli = (n: number): number => Math.round(n * 1000);

export type AvailabilityState =
  | "EXACT"
  | "UNKNOWN"
  | "NOT_STOCK_TRACKED"
  | "NOT_STOCKED"
  | "PER_VARIANT";

/**
 * One branch stock row, as much of it as the till is allowed to know.
 *
 * `free` is what is left after the branch's LIVE commitments — the accepted
 * orders that have not been deducted yet — so it is already "what a new sale
 * may draw on", not the shelf balance.
 *
 * There is no id here on purpose. A cashier never names an inventory row, so
 * shipping its primary key into a screen that has no use for it would be
 * leaking storage keys; requirements address ingredients by their position in
 * this list and nowhere else.
 */
export type IngredientSlot = { name: string; unit: InventoryUnit; free: number };

/** `[slot index, quantity per one unit sold]`, in the slot's own stock unit. */
export type Requirement = [slot: number, perUnit: number];

export type ConfigurationRequirement = {
  productId: string;
  variantId: string | null;
  state: AvailabilityState;
  requirements: Requirement[];
  /** Ingredient names the recipe wants and this branch does not carry. */
  missing: string[];
  /** RecipeIssue values, when the consumption could not be read. */
  issues: string[];
};

export type AddOnRequirement = {
  addOnId: string;
  state: AvailabilityState;
  requirements: Requirement[];
  missing: string[];
  issues: string[];
};

/**
 * One branch's whole availability picture, in one payload.
 *
 * A café has dozens of products and most have sizes, so "ask per card" is not
 * a slower version of the right design — it is a different one that falls
 * over at the counter. The free quantities travel once and every
 * configuration carries only its per-unit draw against them, which is also
 * exactly what the browser needs to recompute the cart without a round trip.
 */
export type BranchAvailability = {
  branchId: string;
  mode: InventoryEnforcementMode;
  generatedAt: string;
  /**
   * Open orders accepted before the commitment ledger existed, whose draw on
   * this shelf is not recorded anywhere. Never folded into the numbers —
   * recomputing them from today's recipe would invent history — so it is
   * reported alongside instead, and the POS says the count is approximate
   * while any are outstanding.
   */
  uncertainOpenOrders: number;
  ingredients: IngredientSlot[];
  configurations: ConfigurationRequirement[];
  addOns: AddOnRequirement[];
};

export type ConfigurationAvailability = {
  state: AvailabilityState;
  /** Whole units, never negative. Null for every state except EXACT. */
  units: number | null;
  /** The ingredient that caps the count, for the cashier's tooltip. */
  limiting: string | null;
  missing: string[];
  issues: string[];
  /** For PER_VARIANT: the spread across the product's sizes. */
  range: { min: number; max: number } | null;
};

/** What one cart line is asking the branch to make. */
export type CartDemandLine = {
  productId: string;
  variantId: string | null;
  addOnIds: string[];
  quantity: number;
};

export type Selection = {
  productId: string;
  variantId: string | null;
  addOnIds?: string[];
};

/**
 * How many whole units one ingredient supports.
 *
 * The boundary is inclusive: a branch holding exactly 0.480 KG may sell three
 * drinks that take 0.160 KG each and finish at zero. A partial portion is not
 * a sale, so the division truncates rather than rounds.
 *
 * A per-unit draw that rounds to zero is treated as non-limiting rather than
 * as infinite capacity or a division by zero. That is not a special case
 * invented here: `theoreticalConsumption` rounds to three places too, so such
 * a line deducts nothing at SERVED either, and availability agreeing with the
 * deduction matters more than the theoretical purity of the number.
 */
export function unitsSupported(free: number, perUnit: number): number {
  const per = milli(perUnit);
  if (per <= 0) return Number.POSITIVE_INFINITY;
  const have = milli(free);
  if (have <= 0) return 0;
  return Math.floor(have / per);
}

const EMPTY: ConfigurationAvailability = {
  state: "UNKNOWN", units: null, limiting: null, missing: [], issues: [], range: null,
};

/**
 * Merge a base configuration with the add-ons chosen alongside it.
 *
 * Shared ingredients are summed, not raced: 0.100 KG of milk in the drink and
 * 0.050 in the extra shot is a 0.150 cup, and asking the two questions
 * separately against the same 0.600 balance would answer six when the honest
 * answer is four.
 *
 * An unreadable add-on makes the whole configuration unreadable, for the same
 * reason a half-resolved recipe does: what is missing is a quantity, and the
 * part that did resolve is not the answer to "what does this cup draw".
 */
function combine(
  base: ConfigurationRequirement | undefined,
  addOns: AddOnRequirement[]
): { state: AvailabilityState; perSlot: Map<number, number>; missing: string[]; issues: string[] } | null {
  if (!base) return null;

  const parts: { state: AvailabilityState; requirements: Requirement[]; missing: string[]; issues: string[] }[] =
    [base, ...addOns];

  const missing = new Set<string>();
  const issues = new Set<string>();
  let unknown = false;

  for (const part of parts) {
    for (const m of part.missing) missing.add(m);
    for (const i of part.issues) issues.add(i);
    if (part.state === "UNKNOWN") unknown = true;
  }

  const perSlot = new Map<number, number>();
  for (const part of parts) {
    for (const [slot, qty] of part.requirements) {
      perSlot.set(slot, round3((perSlot.get(slot) ?? 0) + qty));
    }
  }

  // Order matters, and this is the order the café's own policy already
  // distinguishes. An unreadable draw is the most serious gap — it is not a
  // shortage, it is an unknown — and a branch that has never carried an
  // ingredient comes next. Only when neither applies is there a number.
  const state: AvailabilityState = unknown
    ? "UNKNOWN"
    : missing.size > 0
      ? "NOT_STOCKED"
      : perSlot.size === 0
        ? "NOT_STOCK_TRACKED"
        : "EXACT";

  return { state, perSlot, missing: [...missing], issues: [...issues] };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function fromSlots(
  combined: NonNullable<ReturnType<typeof combine>>,
  ingredients: IngredientSlot[],
  extraDemand: Map<number, number>
): ConfigurationAvailability {
  const base = {
    state: combined.state,
    units: null as number | null,
    limiting: null as string | null,
    missing: combined.missing,
    issues: combined.issues,
    range: null,
  };
  if (combined.state !== "EXACT") return base;

  let units = Number.POSITIVE_INFINITY;
  let limiting: string | null = null;

  for (const [slot, perUnit] of combined.perSlot) {
    const ingredient = ingredients[slot];
    if (!ingredient) continue;
    const free = round3(ingredient.free - (extraDemand.get(slot) ?? 0));
    const supported = unitsSupported(free, perUnit);
    if (supported < units) {
      units = supported;
      limiting = ingredient.name;
    }
  }

  // Every line rounded to a zero draw. Nothing constrains the count and
  // nothing will be deducted either, so there is no number to report.
  if (!Number.isFinite(units)) {
    return { ...base, state: "NOT_STOCK_TRACKED", units: null, limiting: null };
  }
  return { ...base, units: Math.max(0, units), limiting };
}

/**
 * What one cart demands of the branch, aggregated per ingredient slot.
 *
 * Aggregation is across the WHOLE cart before anything is compared, which is
 * the same rule the pre-sale check applies for the same reason: 0.300 KG of
 * ice cream satisfies 0.220 twice if you ask twice, and never satisfies 0.440
 * once. Lines that reach the same ingredient by different routes — two sizes,
 * a base and an add-on, two separate lines — land on one total.
 *
 * A line whose own consumption is unreadable contributes nothing. There is no
 * quantity to contribute, and guessing one would put a fabricated draw into
 * the number this whole module exists to keep honest.
 */
export function cartDemand(
  a: BranchAvailability,
  cart: CartDemandLine[]
): Map<number, number> {
  const demand = new Map<number, number>();
  for (const line of cart) {
    if (line.quantity <= 0) continue;
    const combined = combine(
      findRequirement(a, line.productId, line.variantId),
      resolveAddOns(a, line.addOnIds)
    );
    if (!combined || combined.state !== "EXACT") continue;
    for (const [slot, perUnit] of combined.perSlot) {
      demand.set(slot, round3((demand.get(slot) ?? 0) + perUnit * line.quantity));
    }
  }
  return demand;
}

function resolveAddOns(a: BranchAvailability, addOnIds: string[] | undefined): AddOnRequirement[] {
  if (!addOnIds?.length) return [];
  return addOnIds.map(
    (id) =>
      a.addOns.find((x) => x.addOnId === id) ?? {
        addOnId: id,
        // An add-on the board does not know about is an unreadable draw, not
        // a free one. Failing towards UNKNOWN keeps a stale client from
        // quietly under-counting a sale.
        state: "UNKNOWN" as const,
        requirements: [],
        missing: [],
        issues: ["MISSING_ADDON_RECIPE"],
      }
  );
}

function findRequirement(
  a: BranchAvailability,
  productId: string,
  variantId: string | null
): ConfigurationRequirement | undefined {
  return a.configurations.find(
    (c) => c.productId === productId && (c.variantId ?? null) === (variantId ?? null)
  );
}

/** Availability for one configuration against the shelf as it stands. */
export function configurationFor(
  a: BranchAvailability,
  productId: string,
  variantId: string | null,
  addOnIds: string[] = []
): ConfigurationAvailability {
  return cartAdjusted(a, { productId, variantId, addOnIds }, []);
}

/**
 * Availability for one configuration with this cart's demand already spent.
 *
 * The cashier has five and adds two; the card must say three, immediately and
 * without a round trip. Everything needed for that arrived with the board, so
 * this is pure arithmetic over numbers the browser already holds.
 */
export function cartAdjusted(
  a: BranchAvailability,
  selection: Selection,
  cart: CartDemandLine[]
): ConfigurationAvailability {
  const requirement = findRequirement(a, selection.productId, selection.variantId ?? null);
  if (!requirement) return EMPTY;

  // A product whose sizes draw differently has no one number, and picking
  // either size's would be a lie about the other. The spread is reported so
  // the card can still say something useful without saying something false.
  if (requirement.state === "PER_VARIANT") {
    const demand = cartDemand(a, cart);
    const sizes = a.configurations
      .filter((c) => c.productId === selection.productId && c.variantId)
      .map((c) => fromSlots(combine(c, resolveAddOns(a, selection.addOnIds))!, a.ingredients, demand));
    const counts = sizes.filter((s) => s.state === "EXACT").map((s) => s.units!);
    return {
      state: "PER_VARIANT",
      units: null,
      limiting: null,
      missing: [...new Set(sizes.flatMap((s) => s.missing))],
      issues: [...new Set(sizes.flatMap((s) => s.issues))],
      range: counts.length
        ? { min: Math.min(...counts), max: Math.max(...counts) }
        : null,
    };
  }

  const combined = combine(requirement, resolveAddOns(a, selection.addOnIds));
  if (!combined) return EMPTY;
  return fromSlots(combined, a.ingredients, cartDemand(a, cart));
}

// ── What the cashier reads ───────────────────────────────────────────

export type AvailabilityTone = "ok" | "low" | "out" | "unknown";

export type AvailabilityLabel = {
  text: string;
  /** A second line, when the number alone would mislead. */
  hint: string | null;
  tone: AvailabilityTone;
};

/** Below this many units the badge stops being quiet. */
export const LOW_STOCK_THRESHOLD = 3;

/**
 * The one place a state becomes Arabic.
 *
 * Shared by the product card, the size picker and the cart line so the same
 * fact cannot acquire three wordings. The permission a café has granted goes
 * in the HINT and never in the number: a branch that may sell into a negative
 * balance still has zero on the shelf, and "غير محدود" would be a claim about
 * stock that no mode makes.
 */
export function availabilityLabel(
  a: ConfigurationAvailability,
  opts: { mode: InventoryEnforcementMode; afterCart?: boolean }
): AvailabilityLabel {
  switch (a.state) {
    case "UNKNOWN":
      return { text: "غير محسوب", hint: "الوصفة غير مضبوطة", tone: "unknown" };
    case "NOT_STOCK_TRACKED":
      return { text: "غير مرتبط بالمخزون", hint: null, tone: "unknown" };
    case "NOT_STOCKED":
      return {
        text: "غير مسجل بالمخزون",
        hint: a.missing.length ? `الخامة «${a.missing[0]}» مش مسجلة في الفرع` : null,
        tone: "unknown",
      };
    case "PER_VARIANT":
      return {
        text: a.range ? `متاح: ${a.range.min}–${a.range.max}` : "حسب الحجم",
        hint: "الكمية بتختلف حسب الحجم",
        tone: a.range && a.range.max === 0 ? "out" : "ok",
      };
    case "EXACT": {
      const units = a.units ?? 0;
      if (units === 0) {
        // A shortage the owner has agreed to sell through is still a
        // shortage. Saying so, and putting the permission underneath it, is
        // the difference between an informed override and a surprise.
        return opts.mode === "STRICT"
          ? { text: "نفد", hint: null, tone: "out" }
          : {
              text: "متاح فعليًا: 0",
              hint: opts.mode === "ALLOW_NEGATIVE_STOCK" ? "السالب مسموح" : "تجاوز مسموح",
              tone: "out",
            };
      }
      return {
        text: `${opts.afterCart ? "متاح بعد الطلب" : "متاح"}: ${units}`,
        hint: a.limiting && units <= LOW_STOCK_THRESHOLD ? `أقل خامة: ${a.limiting}` : null,
        tone: units <= LOW_STOCK_THRESHOLD ? "low" : "ok",
      };
    }
  }
}
