// Real client helper; only HTTP and browser storage are replaced. No server/DB.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/lib/client";
const fetchOriginal = globalThis.fetch;
const storageOriginal = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const saved = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) } });
after(() => { globalThis.fetch = fetchOriginal; if (storageOriginal) Object.defineProperty(globalThis, "sessionStorage", storageOriginal); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
const paths = ["/api/expenses", "/api/expenses/original/returns"];
for (const path of paths) test(path + " retains the key after response loss and gives the next confirmed action a new key", async () => {
  const keys: string[] = [];
  let lost = true;
  globalThis.fetch = async (_url, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? ""); if (lost) { lost = false; throw new Error("response lost"); } return Response.json({ id: "committed" }); };
  const body = { amount: 120, description: path };
  await assert.rejects(api(path, { method: "POST", body }), /response lost/);
  assert.deepEqual(await api(path, { method: "POST", body }), { id: "committed" });
  await api(path, { method: "POST", body });
  assert.ok(keys[0].length >= 8); assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
});
test("malformed successful responses and 409s keep an expense key until a parseable result", async () => {
  const keys: string[] = []; let call = 0;
  globalThis.fetch = async (_url, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? ""); call++; return call === 1 ? new Response("invalid", { status: 201 }) : call === 2 ? Response.json({ error: "pending" }, { status: 409 }) : Response.json({ id: "once" }); };
  const body = { amount: 20, reason: "cash received" };
  await assert.rejects(api(paths[1], { method: "POST", body }));
  await assert.rejects(api(paths[1], { method: "POST", body }));
  await api(paths[1], { method: "POST", body });
  assert.equal(new Set(keys).size, 1); assert.ok(keys[0]);
});
