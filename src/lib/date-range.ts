// Shared reporting-window resolver — timezone-correct day boundaries.
//
// All dashboard/report filters resolve through here so every consumer
// agrees on what "اليوم" or "5 أغسطس" means. Day boundaries are computed
// in the cafe's timezone (default Africa/Cairo — which observes DST, so
// offsets are derived via Intl per-instant, never hardcoded), then
// converted to UTC instants for Prisma queries.

export const DEFAULT_TZ = "Africa/Cairo";

export type RangeKey =
  | "today"
  | "yesterday"
  | "last_3_days"
  | "last_7_days"
  | "last_30_days"
  | "month"
  | "custom_day"
  | "custom_range";

// Legacy aliases still accepted in URLs (?range=7d …).
const ALIASES: Record<string, RangeKey> = {
  "7d": "last_7_days",
  "30d": "last_30_days",
  custom: "custom_range",
};

export function normalizeRangeKey(raw: string | null): RangeKey {
  if (!raw) return "today";
  if (ALIASES[raw]) return ALIASES[raw];
  const keys: RangeKey[] = [
    "today", "yesterday", "last_3_days", "last_7_days", "last_30_days",
    "month", "custom_day", "custom_range",
  ];
  return (keys as string[]).includes(raw) ? (raw as RangeKey) : "today";
}

// Milliseconds the zone is ahead of UTC at a given instant.
function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUTC - at.getTime();
}

// "YYYY-MM-DD" of an instant, in the zone's calendar.
export function dateStrInTz(at: Date, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

// UTC instant of local midnight for a "YYYY-MM-DD" calendar date in tz.
// Two-pass offset lookup handles DST transitions on the day itself.
export function zonedDayStart(dateStr: string, tz: string = DEFAULT_TZ): Date {
  const utcGuess = new Date(`${dateStr}T00:00:00Z`);
  let offset = tzOffsetMs(tz, utcGuess);
  offset = tzOffsetMs(tz, new Date(utcGuess.getTime() - offset));
  return new Date(utcGuess.getTime() - offset);
}

// Shift a "YYYY-MM-DD" string by n calendar days (pure date math).
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return shifted.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ResolvedRange = {
  range: RangeKey;
  from: Date; // inclusive UTC instant (local day start)
  to: Date; // inclusive UTC instant (last ms of the local day / now)
  fromDateStr: string; // local calendar dates for labels & bucketing
  toDateStr: string;
  // Previous window of the same length, for "vs previous" deltas.
  prevFrom: Date;
  prevTo: Date;
  error?: string; // Arabic validation error (range falls back to today)
};

// The one range resolver. `date`/`from`/`to` are local "YYYY-MM-DD"
// strings (from the pickers); everything returns UTC instants.
export function getDateRangeFromFilter(
  rawRange: string | null,
  opts: { date?: string | null; from?: string | null; to?: string | null } = {},
  tz: string = DEFAULT_TZ,
  now: Date = new Date()
): ResolvedRange {
  const range = normalizeRangeKey(rawRange);
  const todayStr = dateStrInTz(now, tz);

  let fromStr = todayStr;
  let toStr = todayStr;
  let error: string | undefined;

  switch (range) {
    case "today":
      break;
    case "yesterday":
      fromStr = toStr = addDays(todayStr, -1);
      break;
    case "last_3_days":
      fromStr = addDays(todayStr, -2);
      break;
    case "last_7_days":
      fromStr = addDays(todayStr, -6);
      break;
    case "last_30_days":
      fromStr = addDays(todayStr, -29);
      break;
    case "month":
      fromStr = `${todayStr.slice(0, 8)}01`;
      break;
    case "custom_day":
      if (opts.date && DATE_RE.test(opts.date)) {
        fromStr = toStr = opts.date;
      } else {
        error = "من فضلك اختر اليوم";
      }
      break;
    case "custom_range": {
      const f = opts.from && DATE_RE.test(opts.from) ? opts.from : null;
      const t = opts.to && DATE_RE.test(opts.to) ? opts.to : null;
      if (!f) error = "من فضلك اختر تاريخ البداية";
      else if (!t) error = "من فضلك اختر تاريخ النهاية";
      else if (f > t) error = "تاريخ البداية لا يمكن أن يكون بعد تاريخ النهاية";
      else { fromStr = f; toStr = t; }
      break;
    }
  }

  const from = zonedDayStart(fromStr, tz);
  // Inclusive end: last millisecond of the local end day, capped at now
  // for open-ended presets so "vs previous" compares equal elapsed time.
  const endOfToDay = new Date(zonedDayStart(addDays(toStr, 1), tz).getTime() - 1);
  const openEnded = toStr === todayStr && range !== "custom_day" && range !== "custom_range";
  const to = openEnded && now < endOfToDay ? now : endOfToDay;

  const len = to.getTime() - from.getTime();
  return {
    range,
    from,
    to,
    fromDateStr: fromStr,
    toDateStr: toStr,
    prevFrom: new Date(from.getTime() - len),
    prevTo: from,
    error,
  };
}

// Local calendar days covered by the range (for day-bucketed charts),
// capped so absurdly long custom ranges don't explode the payload.
export function dayListForRange(fromStr: string, toStr: string, cap = 62): string[] {
  const days: string[] = [];
  let cur = fromStr;
  while (cur <= toStr && days.length < cap) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}
