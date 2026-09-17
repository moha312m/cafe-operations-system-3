// UI-002 — the new screens must call the routes they claim to call.
//
// A functional UI is only reachability if the buttons land on the right
// endpoint with the right key. Two mistakes are cheap to make here and
// expensive to find later: guarding the recount control with the accept key
// (the thing SH-23 spent a whole stage separating), and gating a variance
// transition on one permission when the route charges another depending on
// the target status.
//
// Asserted by reading source, in the style of CONFIG-003: the property under
// test is textual — which path a fetch names, and which key a control is
// drawn behind — and no database or browser is needed to see it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const PAGES = [
  "src/app/(app)/handovers/page.tsx",
  "src/app/(app)/stock-counts/page.tsx",
  "src/app/(app)/variances/page.tsx",
];

const COMPONENTS = [
  "src/components/handovers/handover-list.tsx",
  "src/components/handovers/handover-detail.tsx",
  "src/components/handovers/handover-action-bar.tsx",
  "src/components/handovers/opening-verification-panel.tsx",
  "src/components/stock-counts/stock-count-list.tsx",
  "src/components/stock-counts/stock-count-detail.tsx",
  "src/components/stock-counts/count-line-row.tsx",
  "src/components/variances/variance-list.tsx",
  "src/components/variances/variance-detail.tsx",
];

describe("UI-002 the custody screens are wired to the existing API", () => {
  test("every page and component this stage added exists", () => {
    for (const file of [...PAGES, ...COMPONENTS]) {
      assert.ok(existsSync(path.join(root, file)), `${file} must exist`);
    }
  });

  test("the handover screens call the handover routes, recount by its own key", () => {
    const detail = read("src/components/handovers/handover-detail.tsx");
    const bar = read("src/components/handovers/handover-action-bar.tsx");

    assert.match(detail, /\/api\/handovers\/\$\{handoverId\}/);
    assert.match(detail, /\/api\/handovers\/\$\{view\.handoverId\}\/acknowledge/);
    assert.match(detail, /body: \{ action, handoverId: view\.handoverId \}/);

    assert.match(bar, /\/api\/handovers\/\$\{handoverId\}\/accept/);
    assert.match(bar, /\/api\/handovers\/\$\{handoverId\}\/request-recount/);
    assert.match(bar, /\/api\/handovers\/\$\{handoverId\}\/override-accept/);
    assert.match(bar, /\/api\/handovers\/\$\{handoverId\}\/to-branch-custody/);
  });

  test("SH-23 survives in the UI: recount is drawn behind request_recount, not accept", () => {
    const bar = read("src/components/handovers/handover-action-bar.tsx");

    // The control that sends a count back is gated on the key SH-23 created.
    assert.match(
      bar,
      /canKey\("handover\.request_recount"\)/,
      "the recount control must be gated on handover.request_recount"
    );

    // And the recount request must not be issued against the accept route —
    // the two acts are separate endpoints as well as separate keys.
    assert.doesNotMatch(
      bar,
      /request-recount[\s\S]{0,200}handover\.accept/,
      "the recount path must not be guarded by the accept key"
    );

    // Accepting custody keeps its own key, so the split is visible from both
    // sides rather than one key silently covering both acts.
    assert.match(bar, /canKey\("handover\.accept"\)/);
    assert.match(bar, /canKey\("handover\.exception"\)/);
  });

  test("variance transitions are gated per TARGET status, the way the route charges them", () => {
    const labels = read("src/components/variances/variance-labels.ts");
    const detail = read("src/components/variances/variance-detail.tsx");

    // The mirror of the route's own CLOSING list. If these two ever drift,
    // the screen offers a button the server will refuse.
    assert.match(labels, /CLOSING_STATUSES[\s\S]{0,80}"RESOLVED",\s*"WAIVED"/);
    assert.match(labels, /variance\.resolve/);
    assert.match(labels, /variance\.investigate/);

    // The button asks for the key its own target costs — not one key for the
    // whole route.
    assert.match(detail, /canKey\(keyForTarget\(to\)\)/);
    assert.match(detail, /\/api\/variances\/\$\{detail\.id\}\/advance/);
  });

  test("the stock-count screen calls every count route it offers", () => {
    const detail = read("src/components/stock-counts/stock-count-detail.tsx");
    const page = read("src/app/(app)/stock-counts/page.tsx");

    assert.match(page, /"\/api\/stock-counts"/);
    assert.match(detail, /\/api\/stock-counts\/\$\{sessionId\}/);
    assert.match(detail, /\/api\/stock-counts\/\$\{detail\.id\}\/lines\/\$\{lineId\}/);
    assert.match(detail, /\/api\/stock-counts\/\$\{detail\.id\}\/submit/);
    assert.match(detail, /\/api\/stock-counts\/\$\{detail\.id\}\/confirm/);
    assert.match(detail, /\$\{base\}\/recount/);
    assert.match(detail, /\$\{base\}\/accept-variance/);
    assert.match(detail, /\$\{base\}\/correction/);

    // Capturing a counted quantity is a PATCH; the other line acts are POSTs.
    assert.match(detail, /method: "PATCH"/);
  });

  test("the opening-verification door offers both halves, each behind its own key", () => {
    const panel = read("src/components/handovers/opening-verification-panel.tsx");
    assert.match(panel, /"\/api\/custody\/opening-verification"/);
    assert.match(panel, /action: "start_count"/);
    assert.match(panel, /action: "verify"/);
    // One route, two powers: starting the count is a counting permission,
    // verifying against the boundary is an accepting one.
    assert.match(panel, /canKey\("stock_count\.start"\)/);
    assert.match(panel, /canKey\("handover\.accept"\)/);
  });

  test("no screen reaches past the API into the database", () => {
    // The UI is a client of the API and never an authority. A component that
    // imported the Prisma client would be able to read what a route would
    // have refused to disclose.
    for (const file of [...PAGES, ...COMPONENTS]) {
      const code = read(file);
      assert.doesNotMatch(code, /@\/lib\/db|PrismaClient|from "@\/lib\/perms/, `${file} must not reach past the API`);
    }
  });

  test("the pages gate on the same keys their nav entries declare", () => {
    // PERM-001 pins the nav entry for each route to a granular key. The page
    // behind it must gate on that same key, or the door and the room
    // disagree about who may enter.
    const pairs: Array<[string, string]> = [
      ["src/app/(app)/handovers/page.tsx", "handover.view"],
      ["src/app/(app)/stock-counts/page.tsx", "stock_count.view"],
      ["src/app/(app)/variances/page.tsx", "variance.view"],
    ];
    for (const [file, key] of pairs) {
      assert.match(read(file), new RegExp(`canKey\\("${key.replace(".", "\\.")}"\\)`), `${file} must gate on ${key}`);
    }
  });
});
