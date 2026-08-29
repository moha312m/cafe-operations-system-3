"use client";

import { cn } from "@/lib/utils";
import {
  availabilityLabel,
  type ConfigurationAvailability,
} from "@/lib/available-to-sell";
import type { InventoryEnforcementMode } from "@prisma/client";

// How many more of this the branch can make, in one line.
//
// The wording comes from `availabilityLabel` and is not written here: the
// product card, the size picker and the cart line all show the same fact, and
// three components each phrasing it in their own Arabic is how "نفد" and
// "غير محسوب" end up looking like the same thing to the person reading them.
//
// Only the colour is decided here, and it is decided from the tone the label
// already carries rather than from the number — so a count that is low for a
// reason other than stock (a cart that has taken everything, say) still reads
// as the same kind of warning.

const TONE: Record<string, string> = {
  ok: "border-transparent bg-muted text-muted-foreground",
  // Deliberately the same amber the POS already uses for its collection-mode
  // banner: on this screen amber means "look at this before you promise it".
  low: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  out: "border-destructive/40 bg-destructive/10 text-destructive",
  // A gap in the data, not a shortage. Muted and outlined so it reads as
  // "unknown" rather than as a warning about stock.
  unknown: "border-dashed border-muted-foreground/40 text-muted-foreground",
};

export function AvailabilityBadge({
  availability,
  mode,
  afterCart,
  className,
}: {
  availability: ConfigurationAvailability | null;
  mode: InventoryEnforcementMode;
  /** The count already has this cart's demand taken out of it. */
  afterCart?: boolean;
  className?: string;
}) {
  // The board has not loaded, or this branch has no answer for this
  // configuration. Nothing is shown at all — an empty badge would be read as
  // a zero, and guessing is the one thing this feature exists not to do.
  if (!availability) return null;

  const label = availabilityLabel(availability, { mode, afterCart });

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight tabular-nums",
        TONE[label.tone],
        className
      )}
      title={label.hint ?? undefined}
    >
      {label.text}
    </span>
  );
}
