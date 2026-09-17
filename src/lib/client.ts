// Client-side fetch helper: JSON in/out, throws Error with the API's
// error message on non-2xx.

/**
 * A refusal that kept the body it came with.
 *
 * Almost every route in the application refuses with `{ error }` and nothing
 * else, and a caller that reads `message` has the whole story. Two do not:
 * closing a shift can refuse with `{ error, blockers }`, naming each thing
 * still standing in the way, and a message alone would tell a custodian they
 * cannot close without telling them what to fix.
 *
 * So the refusal carries the parsed body rather than discarding it. This
 * extends `Error` and leaves `message` exactly as it was, because sixty
 * modules already catch what `api` throws and read that one property — the
 * payload is available to the few callers that ask for it and invisible to
 * everyone else.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * The refusal's extra field, when it carried one.
 *
 * Returns `[]` for anything that is not a list of strings — an unknown shape
 * is not evidence, and rendering half-parsed junk to the person trying to
 * close their shift is worse than rendering the message alone.
 */
export function blockersOf(error: unknown): string[] {
  if (!(error instanceof ApiRequestError)) return [];
  const blockers = (error.payload as { blockers?: unknown } | null)?.blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.filter((b): b is string => typeof b === "string");
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiRequestError(
      (data as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status,
      data
    );
  }
  return data as T;
}

export { formatMoney as money } from "@/lib/i18n";
