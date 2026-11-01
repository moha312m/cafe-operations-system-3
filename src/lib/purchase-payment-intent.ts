// A pending supplier payment survives reload as ONE identity + exact payload,
// the same pattern as expense-intent. Do not infer a new payment from identical
// form contents; resolve the earlier one with its own key first.
import { z } from "zod";
import { clientRequestUuid } from "@/lib/client-request-key";
import { Decimal } from "@/lib/money";
import { FUNDING_SOURCES } from "@/lib/purchases";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MAX_MONEY = "9999999999.99"; // Decimal(12,2)
const decimalPlaces = (value: number) => new Decimal(value.toString()).decimalPlaces();

// Numeric JSON, as the route has always accepted. Precision and capacity are
// checked on the decimal text, never by floating-point multiplication.
export const purchasePaymentAmount = z.number({ error: "مبلغ الدفعة يجب أن يكون رقمًا محدودًا" })
  .positive("مبلغ الدفعة يجب أن يكون أكبر من صفر")
  .refine((value) => decimalPlaces(value) <= 2, "مبلغ الدفعة يجب ألا يتجاوز منزلتين عشريتين")
  .refine((value) => new Decimal(value.toString()).lte(MAX_MONEY), "مبلغ الدفعة خارج النطاق المسموح");

export const purchasePaymentBody = z.object({
  amount: purchasePaymentAmount,
  method: z.enum(["CASH", "CARD", "WALLET", "BANK_TRANSFER"]),
  note: z.string().max(300).optional(),
  // Optional for older clients, which record an unspecified source.
  fundingSource: z.enum(FUNDING_SOURCES).optional(),
}).strict();

export type PaymentIntent = { version: 1; path: string; key: string; body: z.infer<typeof purchasePaymentBody> };

const envelope = z.object({ version: z.literal(1), path: z.string(), key: z.uuid(), body: z.unknown() }).strict();
const PATH = /^\/api\/purchases\/[A-Za-z0-9_-]+\/payments$/;
const storageKey = (owner: string, path: string) => "nextcup-purchase-payment-intent:" + encodeURIComponent(owner) + ":" + path;

/** The stable identity a pending payment belongs to: actor, café and branch. */
export function paymentIntentOwner(user: { id: string; cafeId?: string | null; branchId?: string | null }): string {
  return [user.cafeId ?? "", user.branchId ?? "*", user.id].join(":");
}

export function paymentIntentPath(invoiceId: string): string {
  const path = "/api/purchases/" + invoiceId + "/payments";
  if (!PATH.test(path)) throw new Error("مسار الدفعة غير صالح");
  return path;
}

function payload(path: string, body: unknown): PaymentIntent["body"] {
  if (!PATH.test(path)) throw new Error("مسار الدفعة غير صالح");
  return purchasePaymentBody.parse(body);
}

const STORAGE_READ = "تعذر قراءة الدفعات المعلّقة في هذه الجلسة؛ لم تُرسل أي دفعة. أعد تحميل الصفحة أو استخدم متصفحًا يسمح بالتخزين.";
const STORAGE_WRITE = "تعذر حفظ الدفعة بأمان في هذه الجلسة؛ لم تُرسل أي دفعة. أعد تحميل الصفحة أو استخدم متصفحًا يسمح بالتخزين.";

export function loadPaymentIntent(store: Store, owner: string, path: string): PaymentIntent | null {
  let raw: string | null;
  try { raw = store.getItem(storageKey(owner, path)); } catch { throw new Error(STORAGE_READ); }
  if (raw === null) return null;
  try {
    const row = envelope.parse(JSON.parse(raw));
    if (row.path !== path) throw new Error("path mismatch");
    return { ...row, body: payload(path, row.body) };
  } catch { throw new Error("تعذر استعادة الدفعة السابقة بأمان؛ لا تسجل دفعة جديدة قبل مراجعة نتيجتها"); }
}

export function beginPaymentIntent(store: Store, owner: string, path: string, body: unknown): PaymentIntent {
  if (loadPaymentIntent(store, owner, path)) throw new Error("استعد نتيجة الدفعة السابقة قبل تسجيل دفعة جديدة");
  const intent: PaymentIntent = { version: 1, path, key: clientRequestUuid(), body: payload(path, body) };
  try { store.setItem(storageKey(owner, path), JSON.stringify(intent)); } catch { throw new Error(STORAGE_WRITE); }
  if (loadPaymentIntent(store, owner, path)?.key !== intent.key) throw new Error(STORAGE_WRITE);
  return intent;
}

/**
 * Whether a failed attempt leaves its pending payment in place. No HTTP status
 * (network, unreadable reply), 5xx and 409 are uncertain; 401/403/404 mean this
 * actor cannot see the outcome now. Any other answer to this exact key is the
 * server refusing it: a committed key would have replayed its saved response.
 */
export function paymentIntentSurvives(status: number | null): boolean {
  return status === null || status >= 500 || [401, 403, 404, 409].includes(status);
}

export function completePaymentIntent(store: Store, owner: string, intent: PaymentIntent): boolean {
  const key = storageKey(owner, intent.path);
  if (loadPaymentIntent(store, owner, intent.path)?.key !== intent.key) return false;
  store.removeItem(key);
  return true;
}
