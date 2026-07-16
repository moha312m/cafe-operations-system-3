"use client";

import { useApp } from "@/components/app-shell";
import { FEATURE_DISABLED_MESSAGE, type CafeFeatures } from "@/lib/cafe-settings";

// Client-side route guard. Renders the page only when the cafe has the
// module enabled; otherwise shows the Arabic "feature not enabled" notice.
// Server-side API guards (requireFeature) are the real enforcement — this
// is the UX layer so a direct visit shows a clear message instead of empty
// data or an error toast.
export function FeatureGate({
  feature,
  enabled,
  children,
}: {
  // Either a settings key, or a precomputed boolean (for composite rules).
  feature?: keyof CafeFeatures;
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const { features } = useApp();
  const allowed =
    enabled !== undefined
      ? enabled
      : !features || feature === undefined
        ? true
        : Boolean(features[feature]);

  if (allowed) return <>{children}</>;

  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
      <p className="mb-2 text-4xl">🔒</p>
      <p className="text-sm font-medium text-muted-foreground">{FEATURE_DISABLED_MESSAGE}</p>
    </div>
  );
}
