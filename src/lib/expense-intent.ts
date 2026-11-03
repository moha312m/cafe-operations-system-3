// A pending cash action survives reload as ONE identity + exact payload.
// Do not infer a new physical movement merely from identical form contents.
import { z } from "zod";
import { clientRequestUuid } from "@/lib/client-request-key";
import { expenseInput, returnInput } from "@/lib/expense-rules";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ExpenseIntent = { version: 1; path: string; key: string; body: z.infer<typeof expenseInput> | z.infer<typeof returnInput> };
const envelope = z.object({ version: z.literal(1), path: z.string(), key: z.uuid(), body: z.unknown() }).strict();
const storageKey = (owner: string, path: string) => "nextcup-expense-intent:" + encodeURIComponent(owner) + ":" + path;
function payload(path: string, body: unknown): ExpenseIntent["body"] {
  if (path === "/api/expenses") return expenseInput.parse(body);
  if (/^\/api\/expenses\/[^/]+\/returns$/.test(path)) return returnInput.parse(body);
  throw new Error("مسار الطلب النقدي غير صالح");
}
export function loadExpenseIntent(store: Store, owner: string, path: string): ExpenseIntent | null {
  const raw = store.getItem(storageKey(owner, path));
  if (raw === null) return null;
  try {
    const row = envelope.parse(JSON.parse(raw));
    if (row.path !== path) throw new Error("path mismatch");
    return { ...row, body: payload(path, row.body) };
  } catch { throw new Error("تعذر استعادة الطلب النقدي السابق بأمان؛ لا تبدأ حركة نقد جديدة قبل مراجعة نتيجته"); }
}
export function beginExpenseIntent(store: Store, owner: string, path: string, body: unknown): ExpenseIntent {
  if (loadExpenseIntent(store, owner, path)) throw new Error("استعد نتيجة الطلب السابق قبل بدء حركة نقد جديدة");
  const intent: ExpenseIntent = { version: 1, path, key: clientRequestUuid(), body: payload(path, body) };
  store.setItem(storageKey(owner, path), JSON.stringify(intent));
  if (loadExpenseIntent(store, owner, path)?.key !== intent.key) throw new Error("تعذر حفظ الطلب بأمان في هذه الجلسة");
  return intent;
}
export function completeExpenseIntent(store: Store, owner: string, intent: ExpenseIntent): boolean {
  const key = storageKey(owner, intent.path);
  if (loadExpenseIntent(store, owner, intent.path)?.key !== intent.key) return false;
  store.removeItem(key);
  return true;
}
