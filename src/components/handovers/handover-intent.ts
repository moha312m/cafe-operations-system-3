// A retry key that belongs to ONE intent: the same handover, the same action, the same payload.
//
// Why: conversion to branch custody and the exceptional acceptance complete a handover. If the
// response is lost and the manager presses again (or refreshes and reopens the screen), the server
// must see the SAME idempotency key, so the second press replays the first result instead of
// answering "already accepted" to a new key. An edited payload (a different reason or cash count)
// is a different intent and gets a new key on purpose. The key is kept in sessionStorage so a
// refresh keeps it; it is dropped once the action succeeds or the payload changes.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createIntentKeys(storage: Store | null, newKey: () => string) {
  const memory = new Map<string, string>();
  const name = (handoverId: string, action: string) => `handover-intent:${handoverId}:${action}`;
  const read = (key: string) => { try { return storage?.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } };
  const write = (key: string, value: string) => { memory.set(key, value); try { storage?.setItem(key, value); } catch { /* memory copy still holds it for this tab */ } };
  const drop = (key: string) => { memory.delete(key); try { storage?.removeItem(key); } catch { /* nothing to clean */ } };
  return {
    /** The key for this exact intent; a changed payload replaces the stored key with a new one. */
    keyFor(handoverId: string, action: string, payload: unknown): string {
      const slot = name(handoverId, action), fingerprint = JSON.stringify(payload);
      const stored = read(slot);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { fingerprint: string; key: string };
          if (parsed.fingerprint === fingerprint && parsed.key) return parsed.key;
        } catch { /* a corrupt entry is replaced below */ }
      }
      const key = newKey();
      write(slot, JSON.stringify({ fingerprint, key }));
      return key;
    },
    /** After a success the intent is finished: the next press is a new intent. */
    done(handoverId: string, action: string) { drop(name(handoverId, action)); },
  };
}

const sessionStore = (): Store | null => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };
export const handoverIntents = createIntentKeys(sessionStore(), () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`));
