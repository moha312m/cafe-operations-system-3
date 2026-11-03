// Eye-comfort status tones (tokens live in globals.css). One place decides which
// colour means what, so a screen never picks a hex of its own:
//   sage    = counted / confirmed / balanced
//   caramel = waiting for a decision, or an explicit zero
//   tide    = information (expected figures, card/network, pending count)
//   clay    = shortage / critical / open investigation
// Class strings are written out in full so Tailwind can see them.
export type Tone = "sage" | "caramel" | "tide" | "clay";

/** Soft fill + line + ink: for cards, badges and callouts. */
export const TONE_SURFACE: Record<Tone, string> = {
  sage: "border-sage-line bg-sage-soft text-sage-ink",
  caramel: "border-caramel-line bg-caramel-soft text-caramel-ink",
  tide: "border-tide-line bg-tide-soft text-tide-ink",
  clay: "border-clay-line bg-clay-soft text-clay-ink",
};

/** Thick bar on the reading-start side (right in RTL) of a row or card. */
export const TONE_SIDE: Record<Tone, string> = {
  sage: "border-s-4 border-s-sage",
  caramel: "border-s-4 border-s-caramel",
  tide: "border-s-4 border-s-tide",
  clay: "border-s-4 border-s-clay",
};

/** Thick bar on the top edge: for KPI cards. */
export const TONE_TOP: Record<Tone, string> = {
  sage: "border-t-4 border-t-sage",
  caramel: "border-t-4 border-t-caramel",
  tide: "border-t-4 border-t-tide",
  clay: "border-t-4 border-t-clay",
};
