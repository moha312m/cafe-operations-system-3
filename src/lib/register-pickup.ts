import type { Prisma } from "@prisma/client";

export type PickupOrderState = { status: string; paymentStatus: string; remainingAmount: string | number };
type PickupCandidate = Pick<PickupOrderState, "status" | "paymentStatus"> & {
  type: string; source: string; tableSessionId: string | null; tableNumber: string | null; approvalStatus: string;
};

export function isRegisterPickup(order: PickupCandidate, allowServedReplay = false): boolean {
  return (order.status === "READY" || (allowServedReplay && order.status === "SERVED"))
    && hasPickupTicket(order);
}

export function hasPickupTicket(order: PickupCandidate): boolean {
  return ["CONFIRMED", "PREPARING", "READY", "SERVED"].includes(order.status)
    && order.type === "TAKEAWAY" && order.tableSessionId === null && order.tableNumber === null
    && (order.source !== "QR_MENU" || ["APPROVED", "NOT_REQUIRED"].includes(order.approvalStatus))
    && order.paymentStatus !== "CANCELLED" && order.paymentStatus !== "REFUNDED";
}

export const registerPickupFilter = {
  status: "READY", type: "TAKEAWAY", tableSessionId: null, tableNumber: null,
  paymentStatus: { notIn: ["CANCELLED", "REFUNDED"] },
  OR: [{ source: { not: "QR_MENU" } }, { approvalStatus: { in: ["APPROVED", "NOT_REQUIRED"] } }],
} satisfies Prisma.OrderWhereInput;

export function pickupSearchFilter(raw: string): Prisma.OrderWhereInput {
  const query = raw.trim();
  if (!query) return {};
  const normalized = query.replace(/^#\s*/, "").replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15));
  if (/^\d+$/.test(normalized)) {
    const number = Number(normalized);
    return number <= 2_147_483_647 ? { orderNumber: number } : { orderNumber: { in: [] } };
  }
  // Prisma parameterizes contains natively; avoid manual LIKE escaping.
  const name = { contains: query, mode: "insensitive" as const };
  return { OR: [{ customerName: name }, { customer: { is: { name } } }] };
}

export function pickupSettled(order: Pick<PickupOrderState, "paymentStatus" | "remainingAmount">): boolean {
  return !["CANCELLED", "REFUNDED"].includes(order.paymentStatus) && Number(order.remainingAmount) === 0;
}

export function pickupAction(order: Pick<PickupOrderState, "paymentStatus" | "remainingAmount">, permissions: { collect: boolean; serve: boolean }) {
  if (pickupSettled(order)) return permissions.serve ? "handoff" : null;
  if (!(Number(order.remainingAmount) > 0) || !permissions.collect) return null;
  return permissions.serve ? "collect-and-handoff" : "collect";
}

export type PickupCollectionAttempt = {
  key: string;
  body: { orderId: string; amount?: number; method?: string; loyaltyPointsToRedeem?: number; customerPhone?: string; pickupExpectedRemaining?: string };
  handoff: boolean;
  reference?: { branchId: string; orderNumber: number };
};

const pendingPrefix = (userId: string) => `nextcup:pickup-payment:${encodeURIComponent(userId)}:`;
export const pickupAttemptStorageKey = (userId: string, orderId: string) => pendingPrefix(userId) + encodeURIComponent(orderId);
export function readPickupAttempt(storage: Pick<Storage, "getItem">, userId: string, orderId: string): PickupCollectionAttempt | null {
  const raw = storage.getItem(pickupAttemptStorageKey(userId, orderId));
  if (!raw) return null;
  const attempt = JSON.parse(raw) as PickupCollectionAttempt;
  if (!attempt?.key || attempt.body?.orderId !== orderId || typeof attempt.handoff !== "boolean") throw new Error("تعذر التحقق من محاولة التحصيل السابقة");
  return attempt;
}
export function listPickupAttempts(storage: Pick<Storage, "getItem" | "key" | "length">, userId: string) {
  const pending: PickupCollectionAttempt[] = [];
  const prefix = pendingPrefix(userId);
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const attempt = readPickupAttempt(storage, userId, decodeURIComponent(key.slice(prefix.length)));
      if (attempt) pending.push(attempt);
    } catch { /* skip corrupt key so other recovery attempts still appear */ }
  }
  return pending;
}

export async function awaitPickupResponse<T>(
  operationOrFactory: Promise<T> | ((signal: AbortSignal) => Promise<T>),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = typeof operationOrFactory === "function" ? new AbortController() : undefined;
  try {
    const operation = typeof operationOrFactory === "function"
      ? operationOrFactory(controller!.signal)
      : operationOrFactory;
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error("انتهت مهلة انتظار التأكيد"));
        }, 20_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export const PAID_AWAITING_HANDOFF = "تم التحصيل — الطلب بانتظار التسليم";

// A rejected payment write is unresolved here. Its caller must retry this
// exact attempt, never assume a subsequent balance read proves who paid.
export async function resolvePickupCollection(attempt: PickupCollectionAttempt, ports: {
  pay: (attempt: PickupCollectionAttempt) => Promise<{ payments: { id: string }[]; remainingAmount: string }>;
  handoff: (id: string) => Promise<unknown>;
  read: (id: string) => Promise<PickupOrderState>;
}) {
  const result = await ports.pay(attempt);
  const paymentId = result.payments[0]?.id ?? null;
  if (!attempt.handoff || Number(result.remainingAmount) !== 0) return { kind: "collected" as const, paymentId };
  const id = attempt.body.orderId;
  try {
    await ports.handoff(id);
    return { kind: "handed-off" as const, paymentId };
  } catch (error) {
    const current = await ports.read(id).catch(() => null);
    const kind = current?.status === "SERVED" ? "handed-off"
      : current?.status === "READY" && pickupSettled(current) ? "paid-awaiting-handoff"
      : "handoff-unconfirmed";
    return { kind, paymentId, current, error };
  }
}
