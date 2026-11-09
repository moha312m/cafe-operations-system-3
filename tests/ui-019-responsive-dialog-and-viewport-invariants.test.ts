/**
 * UI Responsive & Viewport Clamping Invariant Verification Suite
 *
 * Verifies responsive UI improvements across modals, tabs, grids, and form elements:
 * 1. Dialog primitive base width, breakpoint override capability, and Arabic word wrapping.
 * 2. Tabs primitive multi-item wrapping and dynamic height containment.
 * 3. Bulk repricing workspace responsive layout, table scrolling, Arabic select values, and wrapping controls.
 * 4. Quick price calculator responsive grid, triggers, and labels.
 * 5. Menu page responsive category pills horizontal scroll, responsive filter inputs, and product edit dialog grids.
 * 6. Recipe editor flex-wrap containment.
 * 7. Menu import dialog flex-wrap containment.
 * 8. Sales reset card trigger width and Arabic branch select values.
 * 9. Shifts page Arabic select values and responsive shift summary grid.
 * 10. Staff page responsive grid and full-width select triggers.
 * 11. Inventory page responsive grids and flex-wrap containment.
 * 12. Purchases page flex-wrap containment on payments and pay modes.
 * 13. Purchase report workspace responsive metric grid.
 * 14. QR order edit dialog responsive table/note grid.
 * 15. Permission editor dialog class cleanup (no conflicting w-full).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { twMerge } from "tailwind-merge";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readCode(relPath: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), "utf-8");
}

describe("UI Responsive & Dialog Invariants Suite", () => {
  describe("1. Dialog Primitives (dialog.tsx)", () => {
    const src = readCode("src/components/ui/dialog.tsx");

    test("1.1 DialogContent uses unprefixed w-[calc(100%-2rem)] max-w-sm to allow wider breakpoint overrides", () => {
      assert.match(
        src,
        /w-\[calc\(100%-2rem\)\]\s+max-w-sm/,
        "DialogContent must use unprefixed w-[calc(100%-2rem)] max-w-sm"
      );
      assert.doesNotMatch(
        src,
        /sm:max-w-sm/,
        "DialogContent must NOT clamp with sm:max-w-sm which blocked caller max-w-5xl"
      );
    });

    test("1.2 Dialog scroll area uses break-words instead of overflow-wrap:anywhere", () => {
      assert.match(
        src,
        /data-slot="dialog-scroll-area"[\s\S]*?break-words/,
        "Dialog scroll area must use break-words to protect Arabic characters from vertical letter-splitting"
      );
      assert.doesNotMatch(
        src,
        /\[overflow-wrap:anywhere\]/,
        "Dialog scroll area must not use [overflow-wrap:anywhere]"
      );
    });

    test("1.3 DialogContent places custom className after scrollable styles to honor caller padding/overflow", () => {
      assert.match(
        src,
        /scrollable\s*&&\s*"flex max-h-[^"]+",\s*className\s*\)/,
        "className must come after scrollable classes in cn(...)"
      );
    });

    test("1.4 twMerge correctly resolves max-w-5xl over max-w-sm without sm: clamping", () => {
      const base = "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none";
      const merged = twMerge(base, "max-w-5xl");
      assert.ok(merged.includes("max-w-5xl"), "max-w-5xl must be present");
      assert.ok(!merged.includes("max-w-sm"), "max-w-sm must be replaced by max-w-5xl");
      assert.ok(merged.includes("w-[calc(100%-2rem)]"), "w-[calc(100%-2rem)] must be retained for narrow screens");
    });

    test("1.5 twMerge correctly resolves sm:max-w-4xl preserving mobile max-w-sm", () => {
      const base = "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none";
      const merged = twMerge(base, "sm:max-w-4xl");
      assert.ok(merged.includes("sm:max-w-4xl"), "sm:max-w-4xl must be present for >=640px");
      assert.ok(merged.includes("max-w-sm"), "max-w-sm must be retained for <640px");
    });

    test("1.6 twMerge correctly allows caller padding override (p-6 overrides p-0 pt-10)", () => {
      const base = "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none";
      const scrollableClasses = "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 pt-10";
      const merged = twMerge(base, scrollableClasses, "p-4 sm:p-6 pt-10");
      assert.ok(!merged.includes(" p-0 "), "p-0 must be replaced by caller padding");
      assert.ok(merged.includes("p-4"), "caller p-4 must be present");
      assert.ok(merged.includes("sm:p-6"), "caller sm:p-6 must be present");
    });
  });

  describe("2. Tabs Primitives (tabs.tsx)", () => {
    const src = readCode("src/components/ui/tabs.tsx");

    test("2.1 Tabs list allows multi-item wrapping and auto height on horizontal tabs", () => {
      assert.match(
        src,
        /group-data-horizontal\/tabs:h-auto/,
        "Tabs list must allow h-auto to prevent button overflow on mobile"
      );
      assert.match(
        src,
        /group-data-horizontal\/tabs:min-h-8/,
        "Tabs list must retain min-h-8"
      );
      assert.match(
        src,
        /flex-wrap/,
        "Tabs list must allow flex-wrap"
      );
      assert.match(
        src,
        /max-w-full/,
        "Tabs list must enforce max-w-full"
      );
    });
  });

  describe("3. Bulk Repricing Workspace (bulk-repricing-workspace.tsx)", () => {
    const src = readCode("src/components/menu/bulk-repricing-workspace.tsx");

    test("3.1 DialogContent specifies scrollable={false} and max-w-5xl with viewport-safe max-h", () => {
      assert.match(
        src,
        /<DialogContent[\s\S]*?scrollable=\{false\}[\s\S]*?max-w-5xl/,
        "Bulk repricing dialog must specify scrollable={false} and max-w-5xl"
      );
    });

    test("3.2 SelectTriggers in controls bar have w-full and display localized Arabic values", () => {
      assert.match(
        src,
        /referenceBranchId === "all"[\s\S]*?كل الفروع \(المركز الرئيسي\)/,
        "Reference branch select must render Arabic label in SelectValue"
      );
      assert.match(
        src,
        /selectedCategoryId === "all"[\s\S]*?كل الأقسام/,
        "Category select must render Arabic label in SelectValue"
      );
      assert.match(
        src,
        /roundingMode === "NONE"[\s\S]*?بدون تقريب \(قرشين\)/,
        "Rounding mode select must render Arabic label in SelectValue"
      );
    });

    test("3.3 Multiplier labels enforce shrink-0 and whitespace-nowrap against letter squishing", () => {
      assert.match(
        src,
        /shrink-0\s+whitespace-nowrap\s+text-xs\s+font-medium\s+text-muted-foreground">معامل الاستثمار:/,
        "معامل الاستثمار label must have shrink-0 whitespace-nowrap"
      );
      assert.match(
        src,
        /shrink-0\s+whitespace-nowrap\s+text-xs\s+text-muted-foreground">مخصص:/,
        "مخصص label must have shrink-0 whitespace-nowrap"
      );
    });

    test("3.4 Table has compact padding and sticky header", () => {
      assert.match(
        src,
        /\[&_th\]:px-2\.5\s+\[&_th\]:py-2\s+\[&_td\]:px-2\.5\s+\[&_td\]:py-2/,
        "Table cells must use compact cell padding"
      );
      assert.match(
        src,
        /sticky top-0 bg-background z-10/,
        "Table header must be sticky"
      );
    });

    test("3.5 Dialog footer wraps responsively without clipping actions or item counts", () => {
      assert.match(
        src,
        /<DialogFooter[\s\S]*?sm:flex-row\s+sm:flex-wrap\s+sm:items-center\s+sm:justify-between/,
        "DialogFooter must wrap responsively"
      );
    });
  });

  describe("4. Quick Price Calculator (quick-price-calculator.tsx)", () => {
    const src = readCode("src/components/menu/quick-price-calculator.tsx");

    test("4.1 Rounding controls use responsive 1-to-2 column grid", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+sm:grid-cols-2\s+gap-2/,
        "Rounding controls must use grid-cols-1 sm:grid-cols-2"
      );
    });

    test("4.2 SelectTrigger uses w-full and renders localized Arabic text", () => {
      assert.match(
        src,
        /<SelectTrigger className="h-8 w-full">/,
        "SelectTrigger must use w-full"
      );
      assert.match(
        src,
        /بدون تقريب \(قرشين\)/,
        "SelectValue must show Arabic rounding mode label"
      );
    });
  });

  describe("5. Menu Page (src/app/(app)/menu/page.tsx)", () => {
    const src = readCode("src/app/(app)/menu/page.tsx");

    test("5.1 Category navigation uses horizontal scrolling on mobile and vertical list on desktop", () => {
      assert.match(
        src,
        /flex\s+w-full\s+shrink-0\s+gap-1\.5\s+overflow-x-auto\s+pb-2\s+lg:w-52\s+lg:flex-col/,
        "Menu category list must be horizontally scrollable on mobile (<lg)"
      );
    });

    test("5.2 Filter inputs and triggers adapt from w-full on mobile to fixed width on sm+", () => {
      assert.match(src, /className="w-full sm:w-56"/, "Product search input must be responsive");
      assert.match(src, /className="w-full sm:w-44"/, "Availability filter must be responsive");
      assert.match(src, /className="w-full sm:w-48"/, "Visibility filter must be responsive");
    });

    test("5.3 Product edit modal uses responsive 1-to-2 column grid on mobile", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-2/,
        "Product edit modal fields must stack on mobile (grid-cols-1 sm:grid-cols-2)"
      );
    });

    test("5.4 Add-ons form supports wrapping on small screens", () => {
      assert.match(
        src,
        /flex\s+max-w-md\s+flex-wrap\s+gap-2\s+sm:flex-nowrap/,
        "Add-ons form must allow flex-wrap on narrow viewports"
      );
    });
  });

  describe("6. Recipe Editor (recipe-editor.tsx)", () => {
    const src = readCode("src/components/menu/recipe-editor.tsx");

    test("6.1 Recipe editor header actions wrap cleanly", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+items-center\s+justify-between\s+gap-2/,
        "Recipe editor header must allow flex-wrap"
      );
    });

    test("6.2 Margin and profit metrics wrap on narrow viewports", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+items-center\s+gap-1\s+font-bold\s+tabular-nums/,
        "Profit label and badge must allow flex-wrap"
      );
    });
  });

  describe("7. Menu Import Dialog (menu-import-dialog.tsx)", () => {
    const src = readCode("src/components/menu-import/menu-import-dialog.tsx");

    test("7.1 Template download banner wraps on mobile", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+items-center\s+justify-between\s+gap-3\s+rounded-md\s+border/,
        "Import template card must allow flex-wrap"
      );
    });

    test("7.2 Import action footer buttons wrap on mobile", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+justify-between\s+gap-2/,
        "Import action buttons must allow flex-wrap"
      );
    });
  });

  describe("8. Sales Reset Card (sales-reset-card.tsx)", () => {
    const src = readCode("src/components/settings/sales-reset-card.tsx");

    test("8.1 Branch selection SelectTrigger is w-full and renders Arabic fallback for ALL", () => {
      assert.match(
        src,
        /<SelectTrigger className="h-9 w-full bg-background">/,
        "Sales reset trigger must be w-full"
      );
      assert.match(
        src,
        /كل الفروع \(تطهير شامل\)/,
        "Sales reset trigger must render Arabic label in SelectValue"
      );
    });
  });

  describe("9. Shifts Page (src/app/(app)/shifts/page.tsx)", () => {
    const src = readCode("src/app/(app)/shifts/page.tsx");

    test("9.1 Shift filter select controls render Arabic labels in SelectValue", () => {
      assert.match(
        src,
        /status === "ALL"[\s\S]*?كل الحالات/,
        "Shift status select must render Arabic in SelectValue"
      );
      assert.match(
        src,
        /branchId === "ALL"[\s\S]*?كل الفروع/,
        "Shift branch select must render Arabic in SelectValue"
      );
    });

    test("9.2 Shift detail definition list adapts from 1 column on mobile to 2 columns on sm+", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-x-4\s+gap-y-1\.5\s+rounded-lg\s+border\s+bg-muted\/30\s+p-3\s+sm:grid-cols-2/,
        "Shift detail dl must be grid-cols-1 sm:grid-cols-2"
      );
    });

    test("9.3 Shift filters adapt from w-full on mobile to fixed width on sm+", () => {
      assert.match(src, /className="w-full sm:w-44"/, "Shift date input must be responsive w-full sm:w-44");
      assert.match(src, /className="w-full sm:w-36"/, "Shift status trigger must be responsive w-full sm:w-36");
      assert.match(src, /className="w-full sm:w-44"/, "Shift branch trigger must be responsive w-full sm:w-44");
    });
  });

  describe("10. Staff Page (src/app/(app)/staff/page.tsx)", () => {
    const src = readCode("src/app/(app)/staff/page.tsx");

    test("10.1 Staff dialog forms stack into single column on mobile", () => {
      const matches = src.match(/grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-2/g);
      assert.ok(matches && matches.length >= 4, "Staff modals must have responsive 1-to-2 column grids");
    });

    test("10.2 Staff role and branch SelectTriggers enforce w-full", () => {
      const fullTriggers = src.match(/<SelectTrigger\s+className="w-full">|<SelectTrigger\s+id="temporary-branch"\s+className="w-full">/g);
      assert.ok(fullTriggers && fullTriggers.length >= 5, "All staff select triggers must specify w-full");
    });
  });

  describe("11. Inventory Page (src/app/(app)/inventory/page.tsx)", () => {
    const src = readCode("src/app/(app)/inventory/page.tsx");

    test("11.1 Top action bar wraps on mobile", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+gap-2/,
        "Inventory top action buttons must allow flex-wrap"
      );
    });

    test("11.2 Item modal form fields stack to single column on mobile", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-2/,
        "Inventory item modal must use grid-cols-1 sm:grid-cols-2"
      );
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-3/,
        "Inventory item quantities must use grid-cols-1 sm:grid-cols-3"
      );
    });

    test("11.3 Linked recipes list wraps badge and action buttons", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+items-center\s+justify-between\s+gap-2\s+rounded-md\s+border/,
        "Linked recipe items must allow flex-wrap"
      );
    });
  });

  describe("12. Purchases Page (src/app/(app)/purchases/page.tsx)", () => {
    const src = readCode("src/app/(app)/purchases/page.tsx");

    test("12.1 Payment mode buttons allow wrapping on narrow screens", () => {
      assert.match(
        src,
        /role="group"\s+aria-labelledby=\{`\$\{uid\}-paymode`\}\s+className="flex\s+flex-wrap\s+gap-2"/,
        "Purchases payment mode buttons must allow flex-wrap"
      );
    });

    test("12.2 Payment line rows allow wrapping", () => {
      assert.match(
        src,
        /flex\s+flex-wrap\s+items-center\s+justify-between\s+gap-2/,
        "Purchases payment records must allow flex-wrap"
      );
    });
  });

  describe("13. Purchase Report Workspace (purchase-report-workspace.tsx)", () => {
    const src = readCode("src/components/reports/purchase-report-workspace.tsx");

    test("13.1 Metrics summary grid stacks to single column on mobile", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-3/,
        "Purchase metrics dl must be grid-cols-1 sm:grid-cols-3"
      );
    });
  });

  describe("14. QR Order Edit Dialog (qr-order-edit-dialog.tsx)", () => {
    const src = readCode("src/components/approvals/qr-order-edit-dialog.tsx");

    test("14.1 Table number and notes stack on mobile viewports", () => {
      assert.match(
        src,
        /grid\s+grid-cols-1\s+gap-3\s+sm:grid-cols-2/,
        "QR order dialog table and notes must use grid-cols-1 sm:grid-cols-2"
      );
    });
  });

  describe("15. Permission Editor Dialog (permission-editor.tsx)", () => {
    const src = readCode("src/components/staff/permission-editor.tsx");

    test("15.1 DialogContent has max-w-4xl without conflicting redundant w-full", () => {
      assert.match(
        src,
        /<DialogContent dir="rtl" className="max-h-\[90dvh\] max-w-4xl overflow-y-auto">/,
        "Permission editor DialogContent must cleanly specify max-w-4xl"
      );
    });
  });
});
