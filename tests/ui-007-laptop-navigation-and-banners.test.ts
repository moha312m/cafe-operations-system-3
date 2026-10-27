import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UI-007: on a short laptop screen (e.g. 1080p at 150% scaling inside a browser
// window, about 1280x560) the flat 25-link sidebar hid "Settings", "Roles" and
// the reports behind a small inner scroll, and two alert banners took ~38% of
// the viewport height on every page. These checks read the source because NAV
// is module-private to a client component, as perm-001 does.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const SHORT = "[@media(max-height:760px)]";

describe("UI-007 grouped sidebar and compact banners", () => {
  const shell = source("src/components/app-shell.tsx");
  const navLines = shell.split("\n").filter((line) => /^\s*\{ href: "\//.test(line));
  const groupIds = [...shell.matchAll(/\{ id: "([a-z]+)", label: "[^"]+" \}/g)].map((m) => m[1]);

  test("every navigation entry stays on one line and belongs to a declared group (the dashboard is the only pinned item)", () => {
    assert.ok(groupIds.length >= 4, "sections are declared");
    assert.ok(navLines.length >= 20, "navigation entries are still declared one per line");
    const ungrouped = navLines.filter((line) => !/group: "/.test(line));
    assert.equal(ungrouped.length, 1);
    assert.match(ungrouped[0], /href: "\/dashboard"/);
    for (const line of navLines.filter((l) => /group: "/.test(l))) {
      const id = /group: "([a-z]+)"/.exec(line)![1];
      assert.ok(groupIds.includes(id), `unknown group ${id}`);
    }
  });

  test("the pages that were hidden on laptops are reachable inside a visible section", () => {
    const groupOf = (href: string) => {
      const line = navLines.find((l) => l.includes(`href: "${href}"`));
      assert.ok(line, `no NAV entry for ${href}`);
      return /group: "([a-z]+)"/.exec(line)?.[1];
    };
    assert.equal(groupOf("/settings"), "admin");
    assert.equal(groupOf("/roles-permissions"), "admin");
    assert.equal(groupOf("/reports"), "reports");
    assert.equal(groupOf("/pos"), "daily");
  });

  test("sections are real disclosure buttons, the current section is always open and a collapsed one still shows a waiting QR approval", () => {
    assert.match(shell, /aria-expanded=\{open\}/);
    assert.match(shell, /aria-controls=\{`nav-group-\$\{group\.id\}`\}/);
    assert.match(shell, /const open = isCurrent \|\| !collapsedGroups\.includes\(group\.id\)/);
    assert.match(shell, /items\.some\(\(item\) => item\.href === "\/approvals"\) \? pendingQr : 0/);
    assert.match(shell, /hidden=\{!open\}/);
  });

  test("the saved choice is read defensively and short screens start collapsed only when nothing is saved", () => {
    assert.match(shell, /try \{[\s\S]*window\.localStorage\.getItem\(NAV_COLLAPSED_KEY\)[\s\S]*\} catch/);
    assert.match(shell, /if \(saved\) setCollapsedGroups\(saved\);\s*else if \(window\.matchMedia\(SHORT_SCREEN\)\.matches\)/);
    assert.match(shell, /const SHORT_SCREEN = "\(max-height: 760px\)"/);
  });

  test("the sidebar and both banners tighten only on short screens", () => {
    assert.ok(shell.includes(`${SHORT}:py-1.5`), "links are denser");
    assert.ok(shell.includes(`${SHORT}:py-3`), "brand header is shorter");
    assert.ok(shell.includes(`${SHORT}:p-2.5`), "footer is tighter");
    const stock = source("src/components/low-stock-banner.tsx");
    assert.ok(stock.includes(`${SHORT}:p-2.5`) && stock.includes(`${SHORT}:mb-3`));
    assert.ok(stock.includes(`${SHORT}:hidden`), "the item list is hidden on short screens");
    assert.match(stock, /افتح المخزون/, "the way to the details remains");
    const stale = source("src/components/stale-orders-banner.tsx");
    assert.ok(stale.includes(`${SHORT}:p-2.5`) && stale.includes(`${SHORT}:mb-3`));
    assert.match(stale, /data-testid="stale-orders-banner"/);
  });

  test("the banner visibility rules and routes are unchanged", () => {
    assert.match(shell, /<StaleOrdersBanner/);
    assert.match(shell, /user\.role === "CAFE_OWNER" \|\| user\.role === "BRANCH_MANAGER"\) && can\("orders:read"\)/);
    assert.match(shell, /\{showStockBanner && <LowStockBanner/);
  });
});
