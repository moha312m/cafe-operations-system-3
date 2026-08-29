"use client";

import {
  availabilityLabel,
  cartAdjusted,
  type BranchAvailability,
  type CartDemandLine,
  type Selection,
} from "@/lib/available-to-sell";

// The count for the EXACT thing about to be added: this size, with these
// add-ons, after everything already in the cart.
//
// It is a separate line rather than another badge because it answers a
// different question from the ones above it. The size buttons say what each
// size supports on its own; this says what the configuration the cashier has
// actually assembled supports. They differ whenever an add-on draws stock —
// a drink that supports ten and a caramel shot that supports three make a
// configured line that supports three, and three is the number about to be
// promised to a customer.
export function ConfiguredAvailability({
  availability,
  selection,
  cartDemand,
}: {
  availability: BranchAvailability | null;
  selection: Selection;
  cartDemand: CartDemandLine[];
}) {
  if (!availability) return null;

  const ats = cartAdjusted(availability, selection, cartDemand);
  // Deferring to the size buttons: with no size chosen there is nothing to
  // report here that is not already on them, and a range repeated in two
  // places reads as two different facts.
  if (ats.state === "PER_VARIANT") return null;

  const label = availabilityLabel(ats, {
    mode: availability.mode,
    afterCart: cartDemand.length > 0,
  });

  const tone =
    label.tone === "out"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : label.tone === "low"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
        : label.tone === "unknown"
          ? "border-dashed border-muted-foreground/40 text-muted-foreground"
          : "bg-muted/50 text-muted-foreground";

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${tone}`}>
      <p className="font-semibold tabular-nums">{label.text}</p>
      {label.hint && <p className="mt-0.5 opacity-80">{label.hint}</p>}
      {/* Disclosed, never folded into the number. An order accepted before
          this ledger existed has an unrecorded draw on the same shelf, so the
          count above can only be an upper bound until it finalises. */}
      {availability.uncertainOpenOrders > 0 && (
        <p className="mt-0.5 opacity-80">
          تقديري — في {availability.uncertainOpenOrders} طلب مفتوح قبل تفعيل حساب
          المتاح
        </p>
      )}
    </div>
  );
}
