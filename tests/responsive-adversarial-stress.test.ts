/**
 * Adversarial Responsive & Viewport Stress Test Suite
 * 
 * Conducted by Challenger 1 (teamwork_challenger)
 * Evaluates:
 * 1. Mobile viewport constraints (375px, 390px, 1024px, desktop)
 * 2. Horizontal overflow risks (fixed widths, tables, pre tags, overflow-x-hidden)
 * 3. Interactive touch target sizing (>= 44x44px general, >= 48x48px POS cashier)
 * 4. Dialog clamping (no modal clamped to 384px / max-w-sm on >=640px)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CODE_FILES = {
  layout: path.join(ROOT_DIR, "src/app/prototypes/layout.tsx"),
  shell: path.join(ROOT_DIR, "src/components/prototypes/prototype-shell.tsx"),
  statusChip: path.join(ROOT_DIR, "src/components/prototypes/status-chip.tsx"),
  pos: path.join(ROOT_DIR, "src/app/prototypes/pos/page.tsx"),
  expenses: path.join(ROOT_DIR, "src/app/prototypes/expenses/page.tsx"),
  dashboard: path.join(ROOT_DIR, "src/app/prototypes/dashboard/page.tsx"),
  tasks: path.join(ROOT_DIR, "src/app/prototypes/tasks/page.tsx"),
};

describe("Adversarial Responsive & Touch Target Stress Suite", () => {
  const contents = Object.fromEntries(
    Object.entries(CODE_FILES).map(([k, p]) => [k, fs.readFileSync(p, "utf-8")])
  );

  describe("Section 1: Horizontal Overflow & Viewport Width Containment", () => {
    test("1.1: Root layout enforces page-wide overflow-x-hidden containment", () => {
      const layoutSrc = contents.layout;
      assert.match(
        layoutSrc,
        /overflow-x-hidden/,
        "PrototypesLayout must include 'overflow-x-hidden' to prevent root viewport scroll"
      );
      assert.match(
        layoutSrc,
        /w-full/,
        "PrototypesLayout must specify 'w-full'"
      );
    });

    test("1.2: PrototypeShell content viewport container enforces min-w-0 to prevent flex blowout", () => {
      const shellSrc = contents.shell;
      assert.match(
        shellSrc,
        /<main[\s\S]*?min-w-0/,
        "Main viewport container in shell must specify min-w-0 to prevent flex expansion overflow"
      );
    });

    test("1.3: Expenses table is explicitly hidden on mobile (<lg) to prevent table-width overflow", () => {
      const expSrc = contents.expenses;
      assert.match(
        expSrc,
        /hidden\s+lg:block[\s\S]*?<table/,
        "Expenses table must be hidden on mobile (< lg) and only visible on lg screens"
      );
      assert.match(
        expSrc,
        /lg:hidden\s+flex\s+flex-col/,
        "Expenses mobile view must use stacked vertical card rows (lg:hidden)"
      );
    });

    test("1.4: POS Category tabs contain overflow with overflow-x-auto without breaking page layout", () => {
      const posSrc = contents.pos;
      assert.match(
        posSrc,
        /overflow-x-auto/,
        "POS Category tabs must use internal overflow-x-auto for horizontal scroll containment"
      );
    });

    test("1.5: Tablet 1024px rail specification is respected (hidden lg:flex w-64)", () => {
      const shellSrc = contents.shell;
      assert.match(
        shellSrc,
        /hidden\s+lg:flex\s+w-64/,
        "Navigation rail must be w-64 and hidden below lg (>=1024px)"
      );
    });

    test("1.6: POS Product grid column definition adapts safely across viewports (2-col mobile, 3-col tablet, 4-col desktop)", () => {
      const posSrc = contents.pos;
      assert.match(
        posSrc,
        /grid-cols-2\s+md:grid-cols-3\s+xl:grid-cols-4/,
        "POS product grid must safely specify 2 columns on 375/390px, 3 on tablet, 4 on desktop"
      );
    });

    test("1.7: No dangerous unconstrained fixed pixel widths exceeding 375px exist in any prototype file", () => {
      const fixedWidthRegex = /(?:min-)?w-\[(\d+)px\]/g;
      const violations: { file: string; match: string; px: number }[] = [];

      for (const [name, src] of Object.entries(contents)) {
        let m;
        while ((m = fixedWidthRegex.exec(src)) !== null) {
          const px = parseInt(m[1], 10);
          if (px > 375) {
            violations.push({ file: name, match: m[0], px });
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Found fixed pixel widths exceeding 375px: ${JSON.stringify(violations)}`
      );
    });
  });

  describe("Section 2: Dialog & Modal Clamping Probe", () => {
    test("2.1: No modal dialog or drawer is clamped to max-w-sm (384px) on screens >= 640px", () => {
      const clampedRegex = /sm:max-w-sm|max-w-sm\b/g;
      const clampedFindings: { file: string; match: string }[] = [];

      for (const [name, src] of Object.entries(contents)) {
        let m;
        while ((m = clampedRegex.exec(src)) !== null) {
          clampedFindings.push({ file: name, match: m[0] });
        }
      }

      assert.deepEqual(
        clampedFindings,
        [],
        `Found dialogs clamped to 384px (max-w-sm): ${JSON.stringify(clampedFindings)}`
      );
    });

    test("2.2: Fast Expense Entry Modal uses wide dialog token (sm:max-w-2xl)", () => {
      assert.match(
        contents.expenses,
        /sm:max-w-2xl/,
        "Expense Fast Entry Modal must use sm:max-w-2xl (672px)"
      );
    });

    test("2.3: Task Detail Drawer uses wide dialog token (sm:max-w-2xl)", () => {
      assert.match(
        contents.tasks,
        /sm:max-w-2xl/,
        "Task Detail Drawer must use sm:max-w-2xl (672px)"
      );
    });

    test("2.4: POS Checkout Modal uses at least sm:max-w-lg (512px)", () => {
      assert.match(
        contents.pos,
        /sm:max-w-lg/,
        "POS Checkout modal must use at least sm:max-w-lg (512px)"
      );
    });
  });

  describe("Section 3: Interactive Touch Target Sizing Remediation Verification", () => {
    test("3.1: Verify zero 'size-10' (sub-44px) close buttons remain across modal dialogs", () => {
      const size10Matches: { file: string; line: number; snippet: string }[] = [];

      for (const [name, src] of Object.entries(contents)) {
        const lines = src.split("\n");
        lines.forEach((line, idx) => {
          if (line.includes("size-10") && (line.includes("button") || lines[Math.max(0, idx - 5)].includes("<button") || lines[Math.max(0, idx - 4)].includes("<button") || lines[Math.max(0, idx - 3)].includes("<button") || lines[Math.max(0, idx - 2)].includes("<button") || lines[Math.max(0, idx - 1)].includes("<button"))) {
            size10Matches.push({ file: name, line: idx + 1, snippet: line.trim() });
          }
        });
      }

      assert.strictEqual(
        size10Matches.length,
        0,
        `Expected 0 size-10 buttons remaining after remediation, found: ${JSON.stringify(size10Matches)}`
      );
    });

    test("3.2: Verify POS search clear button upgraded to size-11 (44x44px)", () => {
      assert.doesNotMatch(
        contents.pos,
        /size-7[\s\S]{1,150}<X/,
        "POS search clear button must not use sub-standard size-7"
      );
      assert.match(
        contents.pos,
        /size-11[\s\S]{1,150}<X/,
        "POS search clear button must use size-11 (44x44px)"
      );
    });

    test("3.3: Verify POS cart steppers and delete buttons upgraded to size-12 (48x48px cashier standard)", () => {
      const stepperMatches = contents.pos.match(/size-12/g);
      assert.ok(
        stepperMatches && stepperMatches.length >= 6,
        "POS cart controls (desktop and mobile steppers + delete) must use size-12 (48x48px)"
      );
    });

    test("3.4: Verify POS checkout Quick Cash tender chips use min-h-[44px]", () => {
      assert.doesNotMatch(
        contents.pos,
        /px-2\.5\s+py-1\s+text-xs/,
        "POS quick cash chips must not use compact py-1 height"
      );
      assert.match(
        contents.pos,
        /min-h-\[44px\][\s\S]*?المبلغ بالضبط/,
        "POS quick cash chips must specify min-h-[44px]"
      );
    });

    test("3.5: Confirm core navigation and primary action controls achieve >= 44px / 48px standard", () => {
      // Desktop nav rail
      assert.match(contents.shell, /min-h-\[48px\]/, "Desktop rail uses min-h-[48px]");
      // Mobile bottom nav
      assert.match(contents.shell, /min-h-\[48px\]\s+min-w-\[56px\]/, "Mobile bottom nav uses min-h-[48px]");
      // Hamburger button
      assert.match(contents.shell, /h-11\s+w-11/, "Hamburger uses h-11 w-11 (44x44px)");

      // POS checkout trigger
      assert.match(contents.pos, /min-h-\[48px\][\s\S]*?إتمام الطلب/, "POS checkout action is min-h-[48px]");
      // POS category buttons
      assert.match(contents.pos, /min-h-\[48px\][\s\S]*?جميع الأصناف/, "POS category tabs are min-h-[48px]");
      // Expenses action button
      assert.match(contents.expenses, /min-h-\[48px\][\s\S]*?تسجيل مصروف جديد/, "Expenses button is min-h-[48px]");
      // Dashboard period switcher
      assert.match(contents.dashboard, /min-h-\[44px\]/, "Dashboard switcher is min-h-[44px]");
      // Task checklist items
      assert.match(contents.tasks, /min-h-\[48px\]/, "Task checklist items are min-h-[48px]");
    });
  });

  describe("Section 4: Synthetic Data & Long Arabic String Stress", () => {
    test("4.1: Long Arabic strings in product cards do not break container boundaries", () => {
      assert.match(contents.pos, /line-clamp-2/, "POS product cards use line-clamp-2 for descriptions");
      assert.match(contents.tasks, /line-clamp-2/, "Task cards use line-clamp-2 for descriptions");
    });

    test("4.2: StatusChip handles multi-word Arabic status strings with whitespace-nowrap and inline-flex", () => {
      assert.match(
        contents.statusChip,
        /whitespace-nowrap/,
        "StatusChip enforces whitespace-nowrap"
      );
    });

    test("4.3: Financial amounts format correctly with 6-digit Egyptian Pound figures", async () => {
      const { formatMoney } = await import("../src/lib/currency.js");
      const highAmount = formatMoney(1250450.75, "EGP");
      assert.ok(highAmount.includes("1,250,450.75"), "Formatted 6-digit amount correctly");
      assert.ok(highAmount.includes("ج.م"), "Formatted currency in Egyptian Pounds");
    });
  });
});
