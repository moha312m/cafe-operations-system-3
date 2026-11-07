// Browser-side helpers for the owner override code. The header name matches
// OWNER_OVERRIDE_HEADER in src/lib/owner-override.ts (a server module).
const OWNER_OVERRIDE_HEADER = "x-owner-override-code";

/** Request headers carrying the code, or none when it is empty. */
export function ownerOverrideHeaders(code: string): Record<string, string> | undefined {
  const trimmed = code.trim();
  return trimmed ? { [OWNER_OVERRIDE_HEADER]: trimmed } : undefined;
}

/** The Arabic message for a refusal of a request that carried a code. */
export function ownerOverrideErrorMessage(error: unknown, codeSent: boolean, fallback: string) {
  const status = (error as { status?: unknown } | null)?.status;
  if (codeSent && status === 403) return "كود تخويل المالك غير صحيح أو الصلاحية غير كافية";
  if (codeSent && status === 429) return "محاولات خاطئة كثيرة لكود المالك؛ حاول بعد ربع ساعة";
  return error instanceof Error ? error.message : fallback;
}
