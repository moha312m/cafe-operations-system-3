"use client";

import { money } from "@/lib/client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  availabilityLabel,
  cartAdjusted,
  type BranchAvailability,
  type CartDemandLine,
} from "@/lib/available-to-sell";
import { AvailabilityBadge } from "./availability-badge";
import { categoryIcon, type Product } from "./types";

export function ProductCard({
  product,
  currency,
  availability,
  cartDemand,
  onSelect,
}: {
  product: Product;
  currency: string;
  /** The branch's availability board. Null while it loads, or if it failed. */
  availability?: BranchAvailability | null;
  cartDemand?: CartDemandLine[];
  onSelect: (product: Product) => void;
}) {
  const disabled = !product.isActive || product.isAvailable === false;
  const hasOptions =
    product.variants.some((v) => v.isActive) ||
    product.addOns.some((a) => a.addOn.isActive);

  // How many more of this the branch can make, with this cart's demand
  // already taken out of it.
  //
  // The card asks for the PRODUCT-level answer, and for a product whose sizes
  // draw differently that answer is deliberately not a single number: the
  // board returns PER_VARIANT with the spread, and the size picker carries the
  // exact count for each size. Printing either size's figure here would be
  // wrong for the other one.
  //
  // Nothing at all is shown while the board is loading. A blank card is
  // honest; a placeholder zero would empty the menu in the cashier's eyes.
  const ats = availability
    ? cartAdjusted(
        availability,
        { productId: product.id, variantId: null, addOnIds: [] },
        cartDemand ?? []
      )
    : null;
  const inCart = (cartDemand ?? []).some((l) => l.productId === product.id);

  // Emptiness is a fact about the shelf, not a reason to grey the button out.
  // Whether a sale may proceed is the café's policy, enforced by the order
  // endpoint — under ALLOW_NEGATIVE_STOCK or OVERRIDE_ALL it may, and a card
  // that disabled itself would override the owner's decision from the UI. The
  // border marks it; the button still works.
  const out = ats?.state === "EXACT" && ats.units === 0;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(product)}
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border bg-card text-start shadow-sm transition-all",
        disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:scale-[0.98] active:shadow-sm",
        !disabled && out && "border-destructive/40"
      )}
    >
      {/* Image placeholder tile */}
      <div className="flex h-20 items-center justify-center bg-muted/60 text-3xl transition-colors group-hover:bg-muted">
        {categoryIcon(product.category.name)}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <p className="text-sm font-semibold leading-tight">{product.name}</p>
        <p className="text-xs text-muted-foreground">{product.category.name}</p>
        <p className="mt-auto pt-1.5 text-sm font-bold tabular-nums">
          {money(product.basePrice, currency)}
          {hasOptions && (
            <span className="ms-1 text-xs font-normal text-muted-foreground">
              {t.pos.plusOptions}
            </span>
          )}
        </p>
        {disabled ? (
          <p className="text-xs font-medium text-destructive">{t.pos.unavailable}</p>
        ) : (
          <AvailabilityBadge
            className="mt-1 self-start"
            availability={ats}
            mode={availability?.mode ?? "STRICT"}
            afterCart={inCart}
          />
        )}
      </div>
    </button>
  );
}

/**
 * The same fact as plain text, for places a badge does not fit — the size
 * picker's radio labels and the add-on checkboxes.
 *
 * Routed through `availabilityLabel` like everything else so the dialog and
 * the card cannot word the same state differently.
 */
export function availabilityText(
  availability: BranchAvailability | null | undefined,
  selection: { productId: string; variantId: string | null; addOnIds?: string[] },
  cartDemand: CartDemandLine[]
): ReturnType<typeof availabilityLabel> | null {
  if (!availability) return null;
  return availabilityLabel(cartAdjusted(availability, selection, cartDemand), {
    mode: availability.mode,
    afterCart: cartDemand.length > 0,
  });
}
