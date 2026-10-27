/* eslint-disable @typescript-eslint/no-explicit-any -- controlled source-path API/component test boundaries */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
function load(file: string, mocks: Record<string, any>, globals: Record<string, any> = {}) {
  const code = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(code, { exports, require: (id: string) => id in mocks ? mocks[id] : id.startsWith("@/") ? require(path.join(root, "src", id.slice(2))) : require(id), Date, console, ...globals });
  return exports;
}
function route(initial: Record<string, any> | null = { id: "policy", staleOrderAlertHours: 2, carryOpenOrdersOnHandover: false }, allowed = true) {
  let stored = initial;
  const writes: any[] = [], audits: any[] = [];
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  const tx: any = { cafeSettings: { findUnique: async () => stored, upsert: async (q: any) => { writes.push(q); stored = { id: "policy", staleOrderAlertHours: 2, ...stored, ...q.update }; return stored; } } };
  tx.$transaction = async (fn: any) => fn(tx);
  const session = { id: "owner", name: "Test owner", cafeId: "cafe-A", role: "CAFE_OWNER" };
  const loadedModule = load("src/app/api/cafe/handover-policy/route.ts", {
    "@/lib/db": { db: tx },
    "@/lib/api": { ApiError, requirePermission: async () => session, requireKey: async () => { if (!allowed) throw new ApiError(403, "Forbidden"); return session; }, handleApiError: (e: any) => Response.json({ error: e.message }, { status: e.status ?? 400 }) },
    "@/lib/audit": { auditInTransaction: async (_tx: any, event: any) => audits.push(event) },
    "@/lib/open-orders": { DEFAULT_STALE_ORDER_ALERT_HOURS: 2, MAX_STALE_ORDER_ALERT_HOURS: 48 },
  });
  return { get: () => loadedModule.GET(), patch: (body: unknown) => loadedModule.PATCH({ json: async () => body }), writes, audits };
}

for (const [settings, expected] of [
  [{ staleOrderAlertHours: 2 }, 120], [{ staleOrderAlertHours: 48 }, 2880],
  [{ staleOrderAlertHours: 2, staleOrderAlertMinutes: 15 }, 15],
  [{ staleOrderAlertHours: 2, staleOrderAlertMinutes: 0 }, 0], [null, 120],
] as const) {
  test(`GET resolves ${JSON.stringify(settings)} to ${expected} minutes without writes`, async () => {
    const h = route(settings); const response = await h.get();
    assert.equal(response.status, 200); assert.equal((await response.json()).staleOrderAlertMinutes, expected);
    assert.equal(h.writes.length, 0);
  });
}

for (const minutes of [0, 1, 10, 15, 120, 2880]) {
  test(`PATCH saves exact ${minutes} minutes in caller cafe and audits minute units`, async () => {
    const h = route(); const response = await h.patch({ staleOrderAlertMinutes: minutes });
    assert.equal(response.status, 200); assert.equal((await response.json()).staleOrderAlertMinutes, minutes);
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].where.cafeId, "cafe-A");
    assert.equal(h.writes[0].update.staleOrderAlertMinutes, minutes);
    assert.equal(h.writes[0].update.staleOrderAlertHours, undefined, "new minute saves preserve legacy field");
    assert.equal(h.audits.length, 1); assert.equal(h.audits[0].action, "STALE_ORDER_ALERT_MINUTES_CHANGED");
    assert.equal(h.audits[0].details.oldValue, 120); assert.equal(h.audits[0].details.newValue, minutes);
  });
}

for (const bad of [-1, 2881, 1.5, "15", null]) {
  test(`rejects invalid minute input ${JSON.stringify(bad)} without writing`, async () => {
    const h = route(); assert.equal((await h.patch({ staleOrderAlertMinutes: bad })).status, 400); assert.equal(h.writes.length, 0);
  });
}

test("retains legacy hour PATCH contract by converting 5h to 300m", async () => {
  const h = route(); const r = await h.patch({ staleOrderAlertHours: 5 });
  assert.equal(r.status, 200); assert.equal((await r.json()).staleOrderAlertMinutes, 300);
  assert.equal(h.writes[0].update.staleOrderAlertHours, 5); assert.equal(h.writes[0].update.staleOrderAlertMinutes, 300);
});
test("rejects conflicting units, cross-cafe payload, and missing settings permission", async () => {
  for (const body of [{ staleOrderAlertHours: 2, staleOrderAlertMinutes: 15 }, { staleOrderAlertMinutes: 15, cafeId: "other" }]) {
    const h = route(); assert.equal((await h.patch(body)).status, 400); assert.equal(h.writes.length, 0);
  }
  const denied = route(undefined, false); assert.equal((await denied.patch({ staleOrderAlertMinutes: 15 })).status, 403); assert.equal(denied.writes.length, 0);
});
test("changing carry policy alone does not overwrite the minute setting", async () => {
  const h = route({ id: "policy", staleOrderAlertHours: 2, staleOrderAlertMinutes: 15 });
  assert.equal((await h.patch({ carryOpenOrdersOnHandover: true })).status, 200);
  assert.equal(h.writes[0].update.staleOrderAlertMinutes, undefined);
});

for (const minutes of [0, 1, 15, 120]) {
  test(`open-order cutoff uses ${minutes} minute precision and preserves scope`, async () => {
    const queries: any[] = [];
    const db = { order: { groupBy: async () => [], findMany: async (q: any) => { queries.push(q); return []; }, count: async (q: any) => { queries.push(q); return 0; } } };
    const loadedModule = load("src/lib/open-orders.ts", { "@/lib/db": { db } });
    const now = new Date("2026-10-24T12:00:00.000Z");
    await loadedModule.openOrdersSummary({ cafeId: "cafe-A", branchId: "branch-A", staleMinutes: minutes, now });
    const stale = queries.find(q => q.where.OR);
    if (minutes === 0) assert.equal(stale, undefined);
    else {
      assert.ok(stale, "missing minute-based stale query");
      assert.equal(stale.where.cafeId, "cafe-A"); assert.equal(stale.where.branchId, "branch-A");
      assert.equal(stale.where.OR[0].createdAt.lt.toISOString(), new Date(now.getTime() - minutes * 60000).toISOString());
    }
  });
}

test("settings UI accepts arbitrary whole minutes and sends the minute field", () => {
  const code = source("src/components/settings/handover-policy-card.tsx");
  assert.match(code, /دقائق تنبيه الأوردرات المنسية/); assert.match(code, /staleOrderAlertMinutes: minutesValue/);
  assert.match(code, /max=\{2880\}/); assert.match(code, /من 0 لـ 2880/); assert.doesNotMatch(code, /عدد الساعات دي/);
});
test("banner labels the configured threshold in minutes", () => {
  const code = source("src/components/stale-orders-banner.tsx"); assert.match(code, /summary.staleMinutes\} دقيقة/);
});
test("open-summary response and calculation consume the resolved minute value", () => {
  const code = source("src/app/api/orders/open-summary/route.ts");
  assert.match(code, /staleOrderAlertMinutes: true/); assert.match(code, /resolveStaleOrderAlertMinutes\(settings\)/);
  assert.match(code, /openOrdersSummary\(\{ cafeId, branchId, staleMinutes \}\)/);
});

for (const value of [15, 0]) {
  test(`actual settings component displays 120m and saves/reloads ${value}m`, async () => {
    const values: any[] = [], dependencies: any[][] = [], effects: Array<() => void> = [], writes: any[] = [];
    let cursor = 0, tree: any;
    const hooks = {
      useState: (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (v: any) => { values[i] = v; }]; },
      useEffect: (fn: () => void, deps: any[]) => { const i = cursor++; if (!dependencies[i]) { dependencies[i] = deps; effects.push(fn); } },
    };
    const loadedModule = load("src/components/settings/handover-policy-card.tsx", {
      react: hooks, "@/lib/client": { api: async (_url: string, opts?: any) => { if (opts) writes.push(opts.body); return { carryOpenOrdersOnHandover: false, staleOrderAlertMinutes: opts ? opts.body.staleOrderAlertMinutes : 120 }; } },
      sonner: { toast: { success() {}, error() {} } },
      "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" },
      "@/components/ui/card": { Card: "Card", CardContent: "CardContent", CardHeader: "CardHeader", CardTitle: "CardTitle" },
    });
    const render = () => { cursor = 0; tree = loadedModule.HandoverPolicyCard(); while (effects.length) effects.shift()!(); };
    const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" && "props" in v ? [v, ...nodes(v.props.children)] : [];
    render(); await new Promise(r => setImmediate(r)); render();
    const input = () => nodes(tree).find(n => n.type === "input");
    assert.equal(input().props.value, "120"); assert.equal(input().props.max, 2880);
    input().props.onChange({ target: { value: String(value) } }); render();
    const save = nodes(tree).find(n => n.type === "button" && n.props.children === "حفظ"); assert.ok(save); assert.equal(save.props.disabled, false);
    await save.props.onClick(); render();
    assert.equal(writes.length, 1); assert.equal(writes[0].staleOrderAlertMinutes, value); assert.equal(writes[0].staleOrderAlertHours, undefined);
    assert.equal(input().props.value, String(value));
  });
}
