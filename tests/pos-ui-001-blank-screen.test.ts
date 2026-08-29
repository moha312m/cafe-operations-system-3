// POS-UI-001 — the cashier's POS screen must actually paint.
//
// The POS page reads search params (collection-mode deep links), which forces
// a Suspense boundary. When that boundary wrapped the whole POS tree, React
// streamed it on a full page load in the "queued" state — the <!--$~-->
// marker — and parked the rendered POS in a hidden <div hidden id="S:…">
// container attached to <body>. That subtree never hydrated and React never
// revealed it, so a cashier opening /pos directly, refreshing, or restoring a
// tab got a blank screen. Soft navigation masked it, because a client-side
// transition renders the page without a dehydrated boundary.
//
// The fix keeps the boundary around only the tiny param reader, so the POS
// tree renders in the document shell and can never be parked. That makes this
// test deterministic: <main> must contain the real POS markup, not a
// placeholder for a boundary that may or may not have flushed yet.
//
// Asserted against the rendered HTML because the defect is in what the server
// hands the browser and how it is marked up.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { requireServer, login, as } from "./helpers/http";

const CASHIER = "cashier@demo.com";

before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
});

/** The routed page's own output. */
function mainOf(html: string): string {
  const m = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
  assert.ok(m, "response had no <main> element");
  return m[1];
}

// React's Suspense markers. "$?" is pending, "$~" is queued-for-reveal; either
// one around the POS tree means the cashier is looking at a placeholder.
const PENDING = "<!--$?-->";
const QUEUED = "<!--$~-->";

describe("POS-UI-001 POS screen paints", () => {
  test("control: /dashboard paints its content", async () => {
    const r = await as<unknown>(CASHIER, "/dashboard");
    assert.equal(r.status, 200);
    const main = mainOf(r.text);
    assert.ok(
      main.replace(/<[^>]+>/g, "").trim().length > 0,
      "/dashboard painted nothing — the assertion method is wrong, not the POS page"
    );
  });

  test("/pos serves the POS itself, not a parked Suspense boundary", async () => {
    const r = await as<unknown>(CASHIER, "/pos");
    assert.equal(r.status, 200, "cashier must be able to load the POS screen");
    const main = mainOf(r.text);

    assert.ok(
      !main.includes(QUEUED),
      `POS tree was streamed as a queued Suspense boundary — React parks it in a ` +
        `hidden container and never reveals it, so the cashier sees a blank screen. ` +
        `<main> was: ${main.slice(0, 200)}`
    );
    assert.ok(
      !main.includes(PENDING),
      `POS tree was streamed as a pending Suspense boundary. <main> was: ${main.slice(0, 200)}`
    );
  });

  test("/pos paints the controls a cashier needs to take an order", async () => {
    const r = await as<unknown>(CASHIER, "/pos");
    const main = mainOf(r.text);

    // Each of these lives in a different part of the POS tree, so together
    // they prove the whole screen rendered rather than a fragment of it.
    const required: [string, string][] = [
      ["product search", "دوّر على منتج"],
      ["order type picker", "نوع الطلب"],
      ["order cart", "الطلب الحالي"],
    ];
    for (const [what, needle] of required) {
      assert.ok(
        main.includes(needle),
        `POS did not paint the ${what}. <main> was ${main.length} bytes.`
      );
    }
  });
});
