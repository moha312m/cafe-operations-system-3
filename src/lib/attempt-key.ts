import { ApiError } from "@/lib/api";

/**
 * The per-attempt key of an idempotent route: the `Idempotency-Key` header that `withIdempotency`
 * fences on. Older clients sent it in the body as `idempotencyKey`; that is still accepted, but only
 * when it is the same value, so one request can never carry two different intents.
 */
export function attemptKey(request: Request, bodyKey?: string | null): string {
  const header = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!header) throw new ApiError(400, "مفتاح العملية مطلوب، من ٨ إلى ١٢٨ حرف");
  if (bodyKey && bodyKey !== header) throw new ApiError(400, "مفتاح العملية في الطلب مختلف عن المرسل في العنوان");
  return header;
}
