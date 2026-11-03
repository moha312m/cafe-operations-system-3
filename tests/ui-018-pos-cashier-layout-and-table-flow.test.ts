import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UI-018: the cashier (/pos) layout. A picked table folds its grid into a one-line bar,
// table invoices stop crowding the cart, how to collect is chosen from the sticky dock,
// and the POS panels use the eye-comfort tones. Text only: no price, payment or
// stock rule is read or changed here, and the payment-summary / receipt contracts stay.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const RAW_COLOUR = /\b(?:bg|text|border|ring|from|to)-(?:emerald|blue|amber|violet|red|sky|green|purple)-\d{2,3}\b/;

describe("UI-018 table selection folds into a bar", () => {
  const selector = source("src/components/pos/order-type-selector.tsx");

  test("a chosen table shows a one-line bar with a change button, the grid is compact and closes on pick", () => {
    assert.match(selector, /const \[pickerOpen, setPickerOpen\] = useState\(false\)/);
    assert.match(selector, /const showBar = Boolean\(selected\) && !pickerOpen && !manual && tables !== null/);
    assert.match(selector, /data-testid="pos-selected-table-bar"/);
    assert.match(selector, /data-testid="pos-change-table-btn"/);
    assert.match(selector, /onClick=\{\(\) => setPickerOpen\(true\)\}/);
    assert.match(selector, /data-testid="pos-table-grid"/);
    assert.match(selector, /onClick=\{\(\) => \{ set\(\{ tableNumber: tbl\.tableNumber \}\); setPickerOpen\(false\); \}\}/);
    assert.match(selector, /min-h-14 flex-col/);
    assert.match(selector, /max-h-48/);
  });

  test("no square tiles and no fixed tall grid any more", () => {
    assert.doesNotMatch(selector, /aspect-square/);
    assert.doesNotMatch(selector, /max-h-64/);
  });

  test("the account note is not said twice: the bar carries it while the grid is folded", () => {
    assert.match(selector, /سيتم فتح حساب جديد على الترابيزة رقم/);
    assert.match(selector, /\{!showBar && \(selectedSession \? \(/);
    assert.match(selector, /الطلب الجديد يُضاف على نفس الحساب/);
  });

  test("a table is still reachable by hand when the café allows custom numbers", () => {
    assert.match(selector, /إدخال رقم يدوي/);
    assert.match(selector, /\) : manual \? \(\s*<Input placeholder=\{t\.pos\.tableNumber\}/);
  });
});

describe("UI-018 table invoices", () => {
  const invoices = source("src/components/pos/table-invoices.tsx");

  test("a bar with count, remaining and a fold toggle; the summary and its actions stay above the list", () => {
    assert.match(invoices, /data-testid="pos-table-invoices-bar"/);
    assert.match(invoices, /const \[listCollapsed, setListCollapsed\] = useState\(false\)/);
    assert.match(invoices, /عرض الفواتير ▾/);
    assert.match(invoices, /إخفاء الفواتير ▴/);
    assert.ok(invoices.indexOf('data-testid="pos-table-session-summary"') < invoices.indexOf("invoices.map("), "summary is above the invoice list");
    for (const label of ["تحصيل كامل حساب الترابيزة", "تحصيل جزئي من حساب الترابيزة", "🔒 قفل الترابيزة"]) assert.ok(invoices.includes(label), label);
  });

  test("collecting one invoice needs no expanding, and the list is shorter", () => {
    const header = invoices.slice(invoices.indexOf("{/* One click, even with the item details folded away. */}"));
    assert.ok(header.indexOf("تحصيل الفاتورة") < header.indexOf("{open && ("), "the button sits in the header row, before the folded details");
    assert.equal(invoices.match(/>\s*تحصيل الفاتورة\s*</g)?.length, 1, "exactly one collect-invoice button per card");
    assert.match(invoices, /max-h-52/);
    assert.doesNotMatch(invoices, /max-h-72/);
    assert.match(invoices, /setExpanded\(new Set\(\[latest\]\)\)/, "the newest invoice still opens by itself");
  });

  test("collection dialog keeps its three tenders and its confirm button", () => {
    for (const label of ["كاش", "فيزا", "محفظة", "تأكيد التحصيل"]) assert.ok(invoices.includes(label), label);
  });
});

describe("UI-018 sticky checkout dock", () => {
  const summary = source("src/components/pos/payment-summary.tsx");
  const dock = summary.slice(summary.indexOf("if (checkoutOnly)"), summary.indexOf("return (\n    <div className=\"space-y-3\">"));

  test("collection mode and tender are chosen in the dock, wired to the same handlers", () => {
    assert.match(dock, /data-testid="cashier-checkout"/);
    assert.match(dock, /data-testid="cashier-collection-mode"/);
    assert.match(dock, /data-testid="cashier-payment-method"/);
    assert.match(dock, /aria-pressed=\{collectionMode === c\.value\}/);
    assert.match(dock, /onCollectionModeChange\(c\.value\)/);
    assert.match(dock, /aria-pressed=\{method === m\.value\}/);
    assert.match(dock, /onMethodChange\(m\.value\)/);
    assert.match(dock, /\(collectNow \|\| partial\) && \(/, "no tender while posting to the table account");
    assert.match(dock, /filter\(\(m\) => !partial \|\| m\.value !== "MIXED"\)/, "no mixed tender on a partial payment");
  });

  test("the part-payment amount moved with it, and each control exists once", () => {
    assert.match(dock, /t\.collection\.collectAmount/);
    assert.equal(summary.match(/onCollectionModeChange\(c\.value\)/g)?.length, 1);
    assert.equal(summary.match(/onMethodChange\(m\.value\)/g)?.length, 1);
    assert.equal(summary.match(/onValueChange=\{touchValue => onPaidChange\(touchValue\)\}/g)?.length, 1);
  });

  test("pos-totals-layout contract still holds: three min-h-7 row inputs, none with a fixed height", () => {
    assert.equal([...summary.matchAll(/min-h-7 w-2[48] text-end text-sm/g)].length, 3);
    for (const usage of summary.matchAll(/<TouchNumberInput[\s\S]*?\/>/g)) assert.doesNotMatch(usage[0], /className="(?:[^"]*\s)?h-\d/);
  });

  test("the submit button and its guards are unchanged", () => {
    assert.match(dock, /disabled=\{placeDisabled \|\| submitting \|\| mixedMismatch \|\| partialInvalid\} onClick=\{onPlaceOrder\}/);
  });
});

describe("UI-018 cart", () => {
  test("a line is one stepper row with its labels intact, in the wider desktop column", () => {
    const item = source("src/components/pos/cart-item.tsx");
    for (const label of ["تقليل كمية ${line.product.name}", "كمية ${line.product.name}", "زيادة كمية ${line.product.name}", "t.common.remove"]) assert.ok(item.includes(label), label);
    assert.doesNotMatch(item, /min-h-14 min-w-14/);
    assert.doesNotMatch(item, /mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-2/, "no separate note/remove row");
    assert.match(item, /min-h-12 min-w-12/, "touch targets stay at 48px");
    assert.match(item, /TONE_SIDE\.sage/);
    const css = source("src/app/globals.css");
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(400px, 460px\)/);
    assert.doesNotMatch(css, /minmax\(370px, 420px\)/);
  });

  test("the cart keeps a real scroll window above its dock: a floor on wide screens and on the compact cart view", () => {
    // Seen live twice: with alerts above the till the workspace measured 220px and the scrolling part of the cart
    // shrank to 24px; at a 480px floor it was still ~210px, so the cashier scrolled a postage stamp to find the items
    // and the total. The dock is ~250px, the header ~50px: 40rem leaves ~340px. A taller dock needs a taller floor.
    const css = source("src/app/globals.css");
    assert.match(css, /\.cashier-lead, \.cashier-catalog \{ grid-column: 1; \}/);
    assert.match(css, /\.cashier-cart \{ grid-column: 2; grid-row: 1 \/ span 2; position: sticky; top: 1rem; \}/);
    assert.match(css, /\.cashier-catalog, \.cashier-cart \{ height: var\(--cashier-workspace-height, calc\(100dvh - 6rem\)\); min-height: 40rem; \}/);
    assert.match(css, /\.cashier-workspace\[data-compact-view="cart"\] \{ min-height: 36rem; \}/);
    assert.match(css, /min-height: 48px;\s*\n\s*min-width: 48px;/, "the 48px touch size is not lowered to make room");
    const pos = source("src/app/(app)/pos/page.tsx");
    assert.ok(pos.indexOf("cashier-workspace") < pos.indexOf("cashier-lead") && pos.indexOf("cashier-lead") < pos.indexOf("<ShiftControls"), "shift controls and banners sit in the catalog column so the cart extends to the top of the POS workspace");
  });

  test("the final total is always in the dock, in every collection mode, so it never needs the scroll region", () => {
    const summary = source("src/components/pos/payment-summary.tsx");
    const dock = summary.slice(summary.indexOf("if (checkoutOnly)"), summary.indexOf("return (\n    <div className=\"space-y-3\">"));
    assert.match(dock, /<div className="flex items-center justify-between gap-2 text-base font-bold" data-testid="cashier-dock-total"><span>\{t\.finance\.finalTotal\}<\/span><span className="tabular-nums">\{money\(total,currency\)\}<\/span><\/div>/);
    assert.doesNotMatch(dock, /\{partial && <div className="flex items-center justify-between gap-2 text-/, "not gated on a part payment any more");
    assert.ok(dock.indexOf('data-testid="cashier-dock-total"') < dock.indexOf("<Button"), "the total sits above the submit button");
    assert.match(dock, /collectNow \? `\$\{t\.pos\.charge\} \$\{money\(total,currency\)\}`/);
    assert.match(dock, /`\$\{t\.pos\.placeOrder\} · \$\{money\(total,currency\)\}`/);
  });
});

describe("UI-018 eye-comfort tones in the POS panels", () => {
  const files = [
    "src/components/pos/order-type-selector.tsx",
    "src/components/pos/table-invoices.tsx",
    "src/components/pos/customer-loyalty.tsx",
    "src/components/pos/quick-actions.tsx",
    "src/components/pos/payment-summary.tsx",
    "src/components/pos/cart-item.tsx",
  ];

  test("no raw Tailwind palette colour and no hex literal in those panels", () => {
    for (const file of files) {
      const text = source(file);
      assert.doesNotMatch(text, RAW_COLOUR, `${file} uses a raw palette colour`);
      assert.doesNotMatch(text, /#[0-9a-f]{6}\b/i, `${file} hard-codes a hex`);
    }
  });

  test("table status maps to a tone: free sage, occupied tide, money due caramel", () => {
    const selector = source("src/components/pos/order-type-selector.tsx");
    assert.match(selector, /AVAILABLE: +\{ tone: "sage"/);
    assert.match(selector, /OCCUPIED: +\{ tone: "tide"/);
    assert.match(selector, /PENDING_COLLECTION: \{ tone: "caramel"/);
    assert.match(selector, /PARTIAL: +\{ tone: "caramel"/);
    assert.match(selector, /READY_TO_CLOSE: +\{ tone: "sage"/);
    assert.match(selector, /TONE_SURFACE\[selectedStatus\.tone\]/);
  });

  test("receipt and category contracts are not touched by this change", () => {
    const tabs = source("src/components/pos/category-tabs.tsx");
    for (const label of ["كل المنتجات", "كل التصنيفات"]) assert.ok(tabs.includes(label), label);
    assert.doesNotMatch(tabs, /overflow-x-auto/);
  });
});
