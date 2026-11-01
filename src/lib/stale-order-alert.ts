export const DEFAULT_STALE_ORDER_ALERT_MINUTES = 120;
export const MAX_STALE_ORDER_ALERT_MINUTES = 2880;

// NULL preserves the original duration without rewriting existing settings.
// Nullish coalescing deliberately retains an explicit 0 (reminder disabled).
export function resolveStaleOrderAlertMinutes(settings: {
  staleOrderAlertMinutes?: number | null;
  staleOrderAlertHours?: number | null;
} | null | undefined): number {
  return settings?.staleOrderAlertMinutes
    ?? (settings?.staleOrderAlertHours !== undefined && settings.staleOrderAlertHours !== null
      ? settings.staleOrderAlertHours * 60
      : DEFAULT_STALE_ORDER_ALERT_MINUTES);
}
