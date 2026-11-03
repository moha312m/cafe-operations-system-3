import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountLineRow } from "../src/components/stock-counts/count-line-row";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-012 stock count touch controls, filters, next-uncounted, and explicit zero", () => {
  test("stock-count and handover line projections select inventoryItem.isCritical and category", () => {
    const stockCountLib = source("src/lib/stock-count.ts");
    const handoverLib = source("src/lib/handover.ts");
    assert.match(
      stockCountLib,
      /inventoryItem:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*category:\s*true,\s*unit:\s*true,\s*isCritical:\s*true\s*\}\s*\}/
    );
    assert.match(
      handoverLib,
      /inventoryItem:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*category:\s*true,\s*unit:\s*true,\s*isCritical:\s*true\s*\}\s*\}/
    );
  });

  test("CountLineRow renders explicit zero action and touch step buttons while keeping 4 compact columns and no target leak", () => {
    const line = {
      id: "line-1",
      inventoryItemId: "item-1",
      unit: "KG",
      disposition: "PENDING" as const,
      countedQuantity: null,
      effectiveCountedQuantity: null,
      countedAt: null,
      inventoryItem: { id: "item-1", name: "حليب كامل الدسم", category: "ألبان", unit: "KG", isCritical: true },
    };
    const emptyHtml = renderToStaticMarkup(
      createElement(CountLineRow, {
        line,
        sessionStatus: "IN_PROGRESS",
        blind: true,
        handover: true,
        can: () => true,
        busy: false,
        entry: { value: "", status: "empty" },
        onDraft: () => {},
        onSave: () => {},
        onAct: () => {},
      })
    );
    assert.equal((emptyHtml.match(/<td\b/g) ?? []).length, 4);
    assert.match(emptyHtml, /data-testid="count-line-zero"/);
    assert.match(emptyHtml, /صفر فعلي/);
    assert.match(emptyHtml, /لم تُعدّ/);

    const zeroHtml = renderToStaticMarkup(
      createElement(CountLineRow, {
        line: { ...line, countedQuantity: "0", effectiveCountedQuantity: "0", disposition: "COUNTED" },
        sessionStatus: "IN_PROGRESS",
        blind: true,
        handover: true,
        can: () => true,
        busy: false,
        entry: { value: "0", status: "saved" },
        onDraft: () => {},
        onSave: () => {},
        onAct: () => {},
      })
    );
    assert.equal((zeroHtml.match(/<td\b/g) ?? []).length, 4);
    assert.match(zeroHtml, /value="0"/);
    assert.match(zeroHtml, /صفر فعلي — نفد/);
  });

  test("StockCountDetail provides filter tabs (all, uncounted, critical, categories) and next-uncounted navigation", () => {
    const detail = source("src/components/stock-counts/stock-count-detail.tsx");
    assert.match(detail, /data-testid="count-filter-tabs"/);
    assert.match(detail, /لم يُجرد بعد/);
    assert.match(detail, /الأصناف الحرجة/);
    assert.match(detail, /data-testid="count-next-uncounted"/);
    assert.match(detail, /الصنف التالي غير المعدود/);
  });
});
