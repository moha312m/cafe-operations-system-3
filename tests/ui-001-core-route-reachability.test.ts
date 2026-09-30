// UI-001 — the three core custody screens must actually be reachable.
//
// Until SH-24 the navigation offered /handovers, /stock-counts and
// /variances — each gated on its own granular key, each pinned by PERM-001 —
// and every one of them answered 404. The services behind them had been
// built and tested for eleven stages; what did not exist was a door. This
// suite is the regression that would have caught that: it asks the running
// server for each route as a real signed-in user and insists on rendered
// markup rather than a not-found page.
//
// Asserted over HTTP for the same reason POS-UI-001 is: the defect being
// guarded against lives in what the server hands the browser. No browser is
// driven — the response body is the evidence.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BASE, requireServer, login, as } from "./helpers/http";

// Seed accounts from prisma/seed.ts. The owner holds every key; the waiter
// holds no handover, stock-count or variance key at all.
const OWNER = { email: "owner@demo.com", password: "owner1234" };
const WAITER = { email: "waiter@demo.com", password: "waiter123" };

const ROUTES = ["/handovers", "/stock-counts", "/variances"] as const;

before(async () => {
  await requireServer();
  await login(OWNER.email, OWNER.password);
  await login(WAITER.email, WAITER.password);
});

describe("UI-001 core custody screens are reachable", () => {
  for (const route of ROUTES) {
    test(`${route} is served to a permitted user, not 404`, async () => {
      const res = await as(OWNER.email, route);

      assert.notEqual(res.status, 404, `${route} must exist`);
      assert.equal(res.status, 200, `${route} returned ${res.status}`);

      // `<main>` is the discriminator, not the words "not found": the App
      // Router ships its not-found component inside the flight payload of
      // EVERY page, so that string appears in a perfectly healthy response
      // and proves nothing. A real page renders a <main>; the not-found page
      // does not. The control case below keeps that claim honest.
      assert.match(res.text, /<main/, `${route} rendered no <main> element`);
    });
  }

  test("the control: a route that really is missing still 404s", async () => {
    // Without this, every assertion above could be passing for the wrong
    // reason — a test that cannot fail on a genuine 404 is not evidence that
    // the three routes exist.
    const res = await as(OWNER.email, "/definitely-not-a-real-page");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.text, /<main/, "the not-found page must not render a <main>");
  });

  test("each screen paints its own heading rather than an empty shell", async () => {
    const expected: Record<string, RegExp> = {
      "/handovers": /التسليم والاستلام/,
      "/stock-counts": /جرد المخزون/,
      "/variances": /الفروقات/,
    };
    for (const route of ROUTES) {
      const res = await as(OWNER.email, route);
      assert.match(res.text, expected[route], `${route} is missing its heading`);
    }
  });

  test("a user without the key is refused in words, not with a crash", async () => {
    // The page gates its body on the same granular key the nav entry
    // declares. The server remains the authority — this is only about the
    // screen being honest instead of blank or broken.
    for (const route of ROUTES) {
      const res = await as(WAITER.email, route);
      assert.notEqual(res.status, 500, `${route} crashed for an unpermitted user`);
      assert.equal(res.status, 200, `${route} returned ${res.status}`);
      assert.match(
        res.text,
        /ليس لديك صلاحية/,
        `${route} must say why it is empty for an unpermitted user`
      );
    }
  });

  test("the routes are signed-in territory", async () => {
    // No cookie at all: the middleware must send them to login rather than
    // render custody data. Redirects are not followed, so the status is the
    // answer.
    for (const route of ROUTES) {
      const r = await fetch(`${BASE}${route}`, { redirect: "manual" });
      assert.ok(
        r.status === 307 || r.status === 302,
        `${route} answered ${r.status} to an anonymous caller`
      );
    }
  });
});
