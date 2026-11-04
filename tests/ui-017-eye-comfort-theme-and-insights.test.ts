import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UI-017: the warm, low-glare palette (oat canvas, ivory cards, sage / caramel /
// tide / clay tones). Colours live as tokens in globals.css and as tone class
// strings in components/ui/tone.ts; screens use those, never a hex of their own.
// Text only: no behaviour, permission or quantity rule is read or changed here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const lightBlock = (css: string) => css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));

describe("UI-017 eye-comfort theme", () => {
  test("light theme: no pure white canvas, sage primary, tone tokens mapped for Tailwind", () => {
    const css = source("src/app/globals.css");
    const light = lightBlock(css);
    assert.match(light, /--background:\s*#f3efea/i);
    assert.match(light, /--card:\s*#faf8f5/i);
    assert.match(light, /--border:\s*#e2dbd0/i);
    assert.match(light, /--primary:\s*#3b7a6c/i);
    assert.doesNotMatch(light, /--(background|card|popover):\s*(#fff\b|#ffffff|oklch\(1 0 0\))/i, "no pure white surfaces");
    for (const tone of ["sage", "caramel", "tide", "clay"]) {
      for (const part of ["", "-soft", "-line", "-ink"]) {
        assert.match(light, new RegExp(`--${tone}${part}:`), `--${tone}${part} defined for light`);
        assert.match(css, new RegExp(`--color-${tone}${part}: var\\(--${tone}${part}\\)`), `--color-${tone}${part} mapped`);
      }
    }
    assert.match(css, /@utility surface-espresso/);
  });

  test("earlier tokens and the dark theme are untouched", () => {
    const css = source("src/app/globals.css");
    assert.match(css, /--success:\s*#10b981/i);
    assert.match(css, /--warning:\s*#f59e0b/i);
    const dark = css.slice(css.indexOf(".dark {"));
    assert.match(dark, /--background:\s*oklch\(0\.145 0 0\)/);
    assert.match(dark, /--sage:/, "dark has its own tone values");
  });

  test("default button is sage with a visible but gentle press, other variants intact", () => {
    const button = source("src/components/ui/button.tsx");
    assert.match(button, /default: "bg-primary text-primary-foreground shadow-sm hover:bg-sage-hover"/);
    assert.match(button, /font-semibold/);
    assert.match(button, /duration-150/);
    for (const variant of ["outline", "secondary", "ghost", "destructive", "link"]) assert.match(button, new RegExp(`\\b${variant}:`));
  });

  test("tone helper keeps one meaning per colour and writes class names out in full", () => {
    const tone = source("src/components/ui/tone.ts");
    for (const name of ["sage", "caramel", "tide", "clay"]) {
      assert.match(tone, new RegExp(`${name}: "border-${name}-line bg-${name}-soft text-${name}-ink"`));
      assert.match(tone, new RegExp(`${name}: "border-s-4 border-s-${name}"`));
      assert.match(tone, new RegExp(`${name}: "border-t-4 border-t-${name}"`));
    }
  });
});

describe("UI-017 modules use the tones, and no screen hard-codes a hex", () => {
  const files = [
    "src/components/handovers/handover-detail.tsx",
    "src/components/handovers/handover-overview.tsx",
    "src/components/handovers/receiving-sheet.tsx",
    "src/components/stock-counts/stock-count-detail.tsx",
    "src/components/stock-counts/count-line-row.tsx",
    "src/components/pos/cash-denomination-calculator.tsx",
    "src/components/variances/variance-list.tsx",
  ];

  test("no hex colour literal in the themed components", () => {
    for (const file of files) assert.doesNotMatch(source(file), /#[0-9a-f]{6}\b/i, `${file} must use tokens`);
  });

  test("handover: money cards, stepper and the missing-shift callout", () => {
    const overview = source("src/components/handovers/handover-overview.tsx");
    assert.match(overview, /\["صافي المبيعات", m\.sales, "caramel"\]/);
    assert.match(overview, /\["الدرج المتوقع", m\.expectedDrawer, "tide"\]/);
    assert.match(overview, /\["المعدود عند الإقفال", m\.closingCount, "sage"\]/);
    assert.match(overview, /nonZero\(m\.closingDifference\) \? "clay" : "sage"/);
    assert.match(overview, /<dl className="grid grid-cols-2 gap-2" data-testid=\{testId\}>/, "figures stay two per row inside the narrow side column");
    assert.doesNotMatch(overview, /<dl className="grid[^"]*lg:grid-cols-4/);
    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(source("src/components/handovers/handover-workspace-parts.tsx"), /done: "sage"/);
    assert.match(detail, /data-testid="handover-receive-blocker-callout" className=\{`[^`]*\$\{TONE_SURFACE\.caramel\} \$\{TONE_SIDE\.caramel\}`\}/);
  });

  test("receiving sheet: line tone follows the decision, summary bar is espresso, confirm and filters kept", () => {
    const sheet = source("src/components/handovers/receiving-sheet.tsx");
    assert.match(sheet, /draft\.withoutCount \? "tide" : .* \? "sage" : "caramel"/);
    assert.match(sheet, /data-testid="receiving-summary-bar"/);
    assert.match(sheet, /surface-espresso sticky bottom-0/);
    assert.match(sheet, /data-testid="handover-receiving-confirm"/);
    assert.match(sheet, /data-testid="receiving-filter-tabs"/);
    assert.doesNotMatch(sheet, /receiving-accept-all-without-count/);
  });

  test("stock count: zero is caramel, counted is sage, waiting is tide, progress banner shows saved / total", () => {
    const row = source("src/components/stock-counts/count-line-row.tsx");
    assert.match(row, /"tide" : Number\(draftValue\) === 0 \? "caramel" : "sage"/);
    assert.match(row, /line\.countedQuantity === null \? "tide" : Number\(line\.countedQuantity\) === 0 \? "caramel" : "sage"/);
    assert.doesNotMatch(row, /expectedQuantity[^;\n]*TONE|TONE[^;\n]*expectedQuantity/, "colour never reads the expected figure");
    const detail = source("src/components/stock-counts/stock-count-detail.tsx");
    assert.match(detail, /data-testid="stock-count-progress-bar"/);
    assert.match(detail, /role="progressbar"/);
    assert.match(detail, /المحفوظ: \{savedCount\} \/ \{total\} صنف/);
  });

  test("cash calculator: a tone per note, espresso total bar, expected cash still never mentioned", () => {
    const calc = source("src/components/pos/cash-denomination-calculator.tsx");
    assert.match(calc, /200: TONE_SURFACE\.caramel/);
    assert.match(calc, /100: TONE_SURFACE\.sage/);
    assert.match(calc, /50: TONE_SURFACE\.clay/);
    assert.match(calc, /20: TONE_SURFACE\.tide/);
    assert.match(calc, /data-testid="denom-total-bar"/);
    assert.match(calc, /data-testid="denom-apply"/);
    assert.doesNotMatch(calc, /expectedCash|expectedDrawer|variance/i);
  });

  test("variances: four counters over the loaded cases, open ones marked clay, closed ones sage", () => {
    const list = source("src/components/variances/variance-list.tsx");
    assert.match(list, /data-testid="variance-summary"/);
    for (const tone of ["tide", "clay", "caramel", "sage"]) assert.match(list, new RegExp(`tone: "${tone}"`));
    assert.match(list, /c\.status === "OPEN" \? `\$\{TONE_SIDE\.clay\}/);
    assert.doesNotMatch(list, /amountVariance[^;\n]*reduce|financialImpact[^;\n]*reduce/, "no money total over cases that may be unvalued");
    const page = source("src/app/(app)/variances/page.tsx");
    assert.match(page, /\{!loading && <VarianceSummary cases=\{cases\} \/>\}/);
  });
});
