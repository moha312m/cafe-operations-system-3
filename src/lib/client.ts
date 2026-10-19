// Client-side fetch helper: JSON in/out, throws Error with the API's
// error message on non-2xx.
import { clientPayloadHash, clientRequestUuid } from "@/lib/client-request-key";

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
 * Accepts plain strings and the server's structured `HandoverBlocker`
 * objects (`{ count, messageAr, refs? }`), which are rendered as one Arabic
 * line each. Anything else is dropped — an unknown shape is not evidence, and
 * rendering half-parsed junk to the person trying to close their shift is
 * worse than rendering the message alone.
 */
export function blockersOf(error: unknown): string[] {
  if (!(error instanceof ApiRequestError)) return [];
  const blockers = (error.payload as { blockers?: unknown } | null)?.blockers;
  if (!Array.isArray(blockers)) return [];
  const plain = blockers.filter((b): b is string => typeof b === "string");
  const structured = blockers.filter(isStructuredBlocker).map(describeBlocker);
  return [...plain, ...structured];
}

type StructuredBlocker = { count: number; messageAr: string; refs?: string[] };

function isStructuredBlocker(b: unknown): b is StructuredBlocker {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return typeof o.messageAr === "string" && typeof o.count === "number"
    && (o.refs === undefined || (Array.isArray(o.refs) && o.refs.every((r) => typeof r === "string")));
}

function describeBlocker(b: StructuredBlocker): string {
  const refs = b.refs ?? [];
  const more = b.count > refs.length ? ` و${b.count - refs.length} غيرهم` : "";
  const named = refs.length > 0 ? `: ${refs.join("، ")}${more}` : "";
  return `${b.messageAr} (${b.count})${named}`;
}

const pendingRequestKeys = new Map<string, string>();

// Keep a key after an uncertain network/5xx failure. A retry of the same
// operation (including after reload) replays the committed response.
async function requestKey(path: string, body: string) {
  const hash = clientPayloadHash(body);
  const storageKey = `nextcup-request:${path}:${hash}`;
  let key = pendingRequestKeys.get(storageKey);
  try { key ??= sessionStorage.getItem(storageKey) ?? undefined; } catch {}
  key ??= clientRequestUuid();
  pendingRequestKeys.set(storageKey, key);
  try { sessionStorage.setItem(storageKey, key); } catch {}
  return { key, clear: () => {
    // A late response owns only its key, never a subsequent identical sale.
    if (pendingRequestKeys.get(storageKey) === key) pendingRequestKeys.delete(storageKey);
    try { if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey); } catch {}
  } };
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const method = options.method ?? "GET";
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const physicalReturn = /^\/api\/inventory\/[^/]+\/movement(?:\?.*)?$/.test(path) && (options.body as { type?: string; orderItemId?: string } | undefined)?.type === "RETURN" && !!(options.body as { orderItemId?: string } | undefined)?.orderItemId;
  const protectedPost = method.toUpperCase() === "POST" && (physicalReturn || /^\/api\/(orders\/?$|payments\/?$|tables\/[^/]+\/pay$|qr\/[^/]+\/orders$)/.test(path));
  const pending = protectedPost && !options.idempotencyKey ? await requestKey(path, body ?? "") : null;
  const key = options.idempotencyKey ?? pending?.key;
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    body,
  });
  const data = await res.json().catch((error) => {
    if (protectedPost && res.ok) throw error;
    return {};
  });
  if (res.ok || (res.status < 500 && res.status !== 409)) pending?.clear();
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
