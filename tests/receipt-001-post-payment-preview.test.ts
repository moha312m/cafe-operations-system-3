/* eslint-disable @typescript-eslint/no-explicit-any -- controlled React/HTTP boundary test host */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = process.env.RECEIPT_TEST_SOURCE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Element = { type: unknown; props: Record<string, any> };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
const product = { id: "drink", name: "Test drink", basePrice: "40", category: { id: "drinks" }, variants: [], addOns: [], isActive: true };
const target = { orderId: "order-1", orderNumber: 1, total: 40, paidAmount: 0, remainingAmount: 40, status: "CONFIRMED", payments: [], customer: null };

// Execute actual product TSX; replace only React's host and external boundaries.
function host(relative: string, name: string, props: Record<string, any> = {}) {
  const slots: Slot[] = [], effects: Array<() => void> = [], calls: Array<{ url: string; options?: any }> = [];
  const printed: string[] = [], timers = new Map<number, () => void>();
  let cursor = 0, tree: any, failPayment = false, closed = 0, timerId = 0;
  const state = (initial: any) => {
    const i = cursor++;
    slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
    return [slots[i].value, (v: any) => { slots[i].value = typeof v === "function" ? v(slots[i].value) : v; }];
  };
  const memo = (fn: () => any, deps: unknown[]) => {
    const i = cursor++;
    if (!slots[i] || deps.some((d, j) => !Object.is(d, slots[i].deps?.[j]))) slots[i] = { value: fn(), deps };
    return slots[i].value;
  };
  const hooks = {
    useState: state,
    // The POS page labels fields with useId (cashier touch work); a stable per-slot id suffices here.
    useId: () => { const i = cursor++; slots[i] ??= { value: `:r${i}:` }; return slots[i].value; },
    useRef: (value: any) => { const i = cursor++; slots[i] ??= { value: { current: value } }; return slots[i].value; },
    useMemo: memo, useCallback: (fn: any, deps: unknown[]) => memo(() => fn, deps),
    useEffect: (fn: () => any, deps: unknown[]) => {
      const i = cursor++;
      if (!slots[i] || deps.some((d, j) => !Object.is(d, slots[i].deps?.[j]))) {
        const old = slots[i]; slots[i] = { deps, cleanup: old?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
    Suspense: "Suspense",
  };
  const api = async (url: string, options?: any) => {
    calls.push({ url, options });
    if (options?.method === "POST" && failPayment) throw new Error("Payment refused");
    if (url === "/api/orders") return { order: { ...target, id: target.orderId, total: "40", payments: options.body.collectionMode === "PENDING" ? [] : [{ id: "payment-1" }] } };
    if (url === "/api/payments") return { payments: [{ id: "payment-2" }] };
    if (url.includes("/pay") && options?.method === "POST") return { paymentIds: ["payment-table"] };
    if (url.includes("collect-info")) return { target, loyalty: { enabled: false } };
    if (url.includes("/session")) return { session: { id: "table-1", tableNumber: "101", remainingAmount: 40, totalAmount: 40, paidAmount: 0, invoiceCount: 1 }, invoices: [{ ...target, id: target.orderId, remainingAmount: 40, items: [] }] };
    if (url === "/api/products") return { products: [product] };
    if (url === "/api/categories") return { categories: [] };
    if (url === "/api/branches") return { branches: [] };
    if (url.includes("financial-settings")) return { settings: { taxEnabled: false, serviceChargeEnabled: false } };
    if (url.includes("loyalty")) return { settings: { enabled: false } };
    return {};
  };
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mockedRequire = (id: string): any => {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return require(id);
    if (id === "@/components/app-shell") return { useApp: () => ({ cafe: { currency: "EGP", taxRate: 0, features: {} }, user: { id: "cashier", role: "CAFE_OWNER", branchId: "branch-1" }, canKey: () => true, can: () => true, features: {} }) };
    if (id === "@/lib/client") return { api, money: (n: unknown) => `${n} EGP` };
    if (id === "sonner") return { toast: { success() {}, error() {}, warning() {} } };
    if (id === "next/navigation") return { useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() };
    if (id.startsWith("@/lib/") || id === "@/components/pos/types") return require(path.join(root, "src", id.slice(2)));
    return new Proxy({}, { get: (_, key) => String(key) });
  };
  vm.runInNewContext(code, { exports, require: mockedRequire, URLSearchParams, Intl, Date, console,
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    window: { open: () => { throw new Error("Unexpected popup"); }, print: () => printed.push("outer") },
  });
  function render() {
    cursor = 0;
    tree = exports[name]({ paymentId: "payment-1", scope: "order", onClose: () => closed++, onDone: () => closed++, ...props });
    if (typeof tree?.type === "function") tree = tree.type(tree.props);
    while (effects.length) effects.shift()!();
    return tree;
  }
  const nodes = (v: any): Element[] => Array.isArray(v) ? v.flatMap(x => nodes(x)) : v && typeof v === "object" && "props" in v ? [v, ...nodes(v.props.children)] : [];
  const text = (v: any): string => Array.isArray(v) ? v.map(text).join("") : v && typeof v === "object" && "props" in v ? text(v.props.children) : v == null || typeof v === "boolean" ? "" : String(v);
  const find = (type: string) => { const n = nodes(tree).find(n => n.type === type); assert.ok(n, `Missing ${type}`); return n; };
  const button = (label: string) => { const n = nodes(tree).find(n => ["Button", "button"].includes(n.type as string) && text(n).includes(label)); assert.ok(n, `Missing button ${label}`); return n; };
  const flush = async () => { for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); render(); } };
  render();
  return { render, flush, nodes: () => nodes(tree), find, button, calls, printed, text: () => text(tree), fail: () => { failPayment = true; }, closed: () => closed, timeout: () => { for (const fn of timers.values()) fn(); render(); } };
}

test("a stray touch outside a committed receipt cannot dismiss it", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview");
  h.find("Dialog").props.onOpenChange(false, { reason: "outside-press" });
  assert.equal(h.closed(), 0);
  assert.equal(h.calls.length, 0);
});

test("receipt escape and explicit Close remain available without new money movement", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview");
  h.find("Dialog").props.onOpenChange(false, { reason: "escape-key" });
  assert.equal(h.closed(), 1);
  h.button("إغلاق بدون طباعة").props.onClick();
  assert.equal(h.closed(), 2);
  assert.equal(h.calls.length, 0);
});

for (const method of ["CASH", "CARD", "WALLET", "MIXED"]) {
  for (const mode of ["NOW", "PARTIAL"]) {
    test(`new POS order opens receipt after ${method} ${mode} collection`, async () => {
      const h = host("src/app/(app)/pos/page.tsx", "default"); await h.flush();
      h.find("ProductGrid").props.onSelect(product); h.render();
      h.find("OrderCart").props.onTypeChange("TAKEAWAY"); h.render();
      h.find("OrderCart").props.onMethodChange(method); h.find("OrderCart").props.onCollectionModeChange(mode); h.find("OrderCart").props.onPaidChange("15"); h.render();
      await h.find("OrderCart").props.onPlaceOrder(); h.render();
      assert.equal(h.find("PaymentReceiptPreview").props.paymentId, "payment-1");
      assert.equal(h.find("PaymentReceiptPreview").props.scope, "order");
      h.find("PaymentReceiptPreview").props.onClose(); h.render();
      assert.equal(h.calls.filter(c => c.options?.method === "POST").length, 1);
      assert.equal(h.nodes().some(n => n.type === "PaymentReceiptPreview"), false);
    });
  }
}

test("pending orders and refused payments never open a receipt", async () => {
  for (const pending of [true, false]) {
    const h = host("src/app/(app)/pos/page.tsx", "default"); await h.flush();
    h.find("ProductGrid").props.onSelect(product); h.render();
    h.find("OrderCart").props.onTypeChange("TAKEAWAY");
    h.find("OrderCart").props.onCollectionModeChange(pending ? "PENDING" : "NOW");
    if (!pending) h.fail(); h.render();
    await h.find("OrderCart").props.onPlaceOrder(); h.render();
    assert.equal(h.nodes().some(n => n.type === "PaymentReceiptPreview"), false);
  }
});

for (const method of ["كاش", "فيزا", "محفظة"]) {
  test(`existing-order partial ${method} payment opens shared preview once`, async () => {
    const h = host("src/components/pos/collect-payment-panel.tsx", "CollectPaymentPanel", { orderId: "order-1", currency: "EGP", needsShift: false, shiftActive: true }); await h.flush();
    h.button(method).props.onClick();
    const input = h.nodes().find(n => n.type === "TouchNumberInput" && n.props.type === "number"); assert.ok(input);
    input.props.onValueChange("15"); h.render();
    await h.button("تحصيل الدفع").props.onClick(); h.render();
    assert.equal(h.find("PaymentReceiptPreview").props.paymentId, "payment-2");
    h.find("PaymentReceiptPreview").props.onClose();
    assert.equal(h.closed(), 1);
    assert.equal(h.calls.filter(c => c.options?.method === "POST").length, 1);
  });
}

test("preview loads without auto-print, prints only the receipt frame and closes without collection", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview");
  const frame = h.find("iframe");
  assert.match(frame.props.src, /scope=order/); assert.match(frame.props.src, /embedded=1/); assert.doesNotMatch(frame.props.src, /print=1/);
  assert.equal(h.printed.length, 0); assert.equal(h.button("طباعة").props.disabled, true);
  const fakeFrame = { contentDocument: { querySelector: () => ({}), readyState: "complete" }, contentWindow: { focus() {}, print: () => h.printed.push("receipt") } };
  frame.props.ref.current = fakeFrame; frame.props.onLoad({ currentTarget: fakeFrame }); h.render();
  h.button("طباعة").props.onClick(); h.render();
  assert.match(h.find("iframe").props.src, /[?&]print=1(?:&|$)/, "explicit print must retain the existing RECEIPT_PRINTED audit request");
  assert.equal(h.printed.length, 0, "wait for the authorized print receipt response");
  h.find("iframe").props.ref.current = fakeFrame;
  h.find("iframe").props.onLoad({ currentTarget: fakeFrame }); h.render();
  assert.deepEqual(h.printed, ["receipt"]);
  h.find("iframe").props.onLoad({ currentTarget: fakeFrame }); h.render();
  assert.equal(h.printed.length, 1, "duplicate load events must not print twice");
  h.button("بدون طباعة").props.onClick(); assert.equal(h.closed(), 1); assert.equal(h.calls.length, 0);
});

test("receipt denial/load failure and timeout retain success and only retry the receipt", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview", { scope: "table" });
  assert.match(h.find("iframe").props.src, /scope=table/);
  const denied = { contentDocument: { querySelector: () => null } };
  h.find("iframe").props.ref.current = denied;
  h.find("iframe").props.onLoad({ currentTarget: denied }); h.render();
  assert.equal(h.button("طباعة").props.disabled, true); assert.match(h.text(), /تم تحصيل الدفع/);
  const oldKey = h.find("iframe").props.src;
  h.button("إعادة تحميل").props.onClick(); h.render();
  assert.equal(h.find("iframe").props.src, oldKey); assert.equal(h.calls.length, 0);
  h.timeout(); assert.match(h.text(), /تعذّر/);
  h.button("بدون طباعة").props.onClick(); assert.equal(h.closed(), 1);
});

test("loyalty-only settlement does not fabricate a receipt or print action", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview", { paymentId: null });
  assert.equal(h.nodes().some(n => n.type === "iframe"), false);
  assert.equal(h.nodes().some(n => n.type === "Button" && n.props.onClick && h.text().includes("إعادة تحميل")), false);
  assert.equal(h.printed.length, 0); assert.equal(h.calls.length, 0);
});

for (const method of ["كاش", "فيزا", "محفظة"]) {
  for (const kind of ["invoice", "table-full", "table-partial"]) {
    test(`table collection ${kind} ${method} preserves receipt scope`, async () => {
      const h = host("src/components/pos/table-invoices.tsx", "TableInvoices", { branchId: "branch-1", tableNumber: "101", reloadKey: 0 }); await h.flush();
      h.button(kind === "invoice" ? "تحصيل الفاتورة" : kind === "table-full" ? "تحصيل كامل حساب" : "تحصيل جزئي من حساب").props.onClick(); h.render();
      h.button(method).props.onClick();
      if (kind !== "table-full") {
        const input = h.nodes().find(n => n.type === "TouchNumberInput" && n.props.type === "number"); assert.ok(input);
        input.props.onValueChange("15");
      }
      h.render(); await h.button("تأكيد التحصيل").props.onClick(); await h.flush();
      const preview = h.find("PaymentReceiptPreview");
      assert.equal(preview.props.scope, kind === "invoice" ? "order" : "table");
      assert.equal(preview.props.paymentId, kind === "invoice" ? "payment-2" : "payment-table");
      preview.props.onClose(); h.render();
      assert.equal(h.calls.filter(c => c.options?.method === "POST").length, 1);
      assert.equal(h.nodes().some(n => n.type === "PaymentReceiptPreview"), false);
    });
  }
}

test("failed later collection keeps the payment form and never shows the preview", async () => {
  const h = host("src/components/pos/collect-payment-panel.tsx", "CollectPaymentPanel", { orderId: "order-1", currency: "EGP", needsShift: false, shiftActive: true }); await h.flush();
  h.fail(); await h.button("تحصيل الدفع").props.onClick(); await h.flush();
  assert.equal(h.nodes().some(n => n.type === "PaymentReceiptPreview"), false);
  assert.equal(h.calls.filter(c => c.options?.method === "POST").length, 1);
});

test("a detached receipt frame cannot enable printing during a retry", () => {
  const h = host("src/components/receipts/payment-receipt-preview.tsx", "PaymentReceiptPreview");
  const old = { contentDocument: { querySelector: () => ({}) } };
  h.find("iframe").props.ref.current = {};
  h.find("iframe").props.onLoad({ currentTarget: old }); h.render();
  assert.equal(h.button("طباعة").props.disabled, true);
});
