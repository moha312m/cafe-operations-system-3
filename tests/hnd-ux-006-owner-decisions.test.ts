import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CountEntryQueue } from "../src/components/stock-counts/count-entry-queue";

// HND-UX-006 — the owner's answers of 2026-11-06:
//   1. a manager's branch-custody close is saved to branch custody on the Done screen (R1);
//   2. counts save each quantity on its own; «تسليم الجرد» saves what is left first (no per-line «تسجيل»);
//   3. the audit log pages back past 200, filters by day, and exports CSV (it has no branch column);
//   4. «الشيفت الحالي» lets an owner without a branch pick the branch.
// Unchanged and pinned: per-line signatures, the server's omission rule, the blind count.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const saved = (value: string) => ({ countedQuantity: value, countedAt: new Date().toISOString() });

describe("1. automatic branch custody at a manager's close", () => {
  test("runs once on arrival, signs first, converts only when every line is signed, and never sends an omission reason by itself", () => {
    const close = source("src/components/pos/shift-close-flow.tsx");
    const auto = close.slice(close.indexOf("function AutoBranchSave"), close.indexOf("function DoneStep"));
    assert.match(auto, /if \(started\.current\) return;\n\s*started\.current = true;/);
    assert.ok(auto.indexOf("signPendingLines(handoverId)") < auto.indexOf("convertToBranchCustody(handoverId)"));
    assert.match(auto, /if \(signed\.failed\.length\) \{[\s\S]*?return;\n\s*\}/, "a half-signed batch stops before the conversion");
    assert.match(auto, /convertToBranchCustody\(handoverId\);/, "no reason or note is made up for an uncounted required item");
    assert.match(auto, /data-testid="close-save-to-branch"/, "when it cannot finish, the handover screen finishes it");
    assert.match(close, /\{branchNight && maySaveToBranch && handover && handoverHref && <AutoBranchSave /);
  });

  test("the omission pair is all-or-nothing in the shared conversion", () => {
    const save = source("src/components/handovers/branch-custody-save.ts");
    assert.match(save, /const authorised = !!omission && omission\.reasonCodeId\.trim\(\) !== "" && omission\.note\.trim\(\) !== "";/);
  });
});

describe("2. counts: no per-line save button", () => {
  test("Enter and leaving the box save the line in every count, and the «تسجيل» button is gone", () => {
    const row = source("src/components/stock-counts/count-line-row.tsx");
    assert.doesNotMatch(row, /count-line-capture/);
    assert.match(row, /onBlur=\{\(\) => \{ if \(entry\.status !== "saved" && entry\.status !== "empty"\) onSave\(line\.id\); \}\}/);
    assert.match(row, /if \(e\.key === "Enter"\) \{/);
    assert.match(row, /\{blind \? "مخفي" : \(line\.expectedQuantity \?\? "—"\)\}/, "the blind count still hides the expected quantity");
  });

  test("submit saves what is typed first and goes on only when every save landed", () => {
    const detail = source("src/components/stock-counts/stock-count-detail.tsx");
    assert.match(detail, /await queue\.saveAll\(\);\n\s*if \(!queue\.canSubmit\(!!isHandover\)\) \{/);
    assert.match(detail, /onClick=\{\(\) => void saveThenSubmit\(\)\}/);
  });

  test("saveAll writes every unsaved line and leaves a conflict for review", async () => {
    const writes: string[] = [];
    const queue = new CountEntryQueue(async (id, value) => { writes.push(`${id}=${value}`); return saved(String(value)); });
    queue.reconcile([{ id: "a", countedQuantity: null, countedAt: null }, { id: "b", countedQuantity: null, countedAt: null }, { id: "c", countedQuantity: "4", countedAt: new Date().toISOString() }]);
    queue.edit("a", "2");
    queue.edit("b", "0");
    assert.deepEqual(queue.unsaved().sort(), ["a", "b"]);
    assert.equal(queue.canSubmit(), false);
    await queue.saveAll();
    assert.deepEqual(writes.sort(), ["a=2", "b=0"]);
    assert.deepEqual(queue.unsaved(), []);
    assert.equal(queue.canSubmit(true), true);
  });

  test("saveAll writes one line at a time, never two at once", async () => {
    let active = 0, peak = 0;
    const queue = new CountEntryQueue(async (_id, value) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return saved(String(value));
    });
    queue.reconcile(["a", "b", "c"].map((id) => ({ id, countedQuantity: null, countedAt: null })));
    for (const id of ["a", "b", "c"]) queue.edit(id, "1");
    await queue.saveAll();
    assert.equal(peak, 1);
    assert.deepEqual(queue.unsaved(), []);
  });

  test("a failed write stays unsaved and blocks the submit", async () => {
    const queue = new CountEntryQueue(async () => { throw new Error("offline"); });
    queue.reconcile([{ id: "a", countedQuantity: null, countedAt: null }]);
    queue.edit("a", "3");
    await queue.saveAll();
    assert.equal(queue.get("a")?.status, "failed");
    assert.deepEqual(queue.unsaved(), ["a"]);
    assert.equal(queue.canSubmit(), false);
  });
});

describe("3. audit log", () => {
  test("pages with a cursor, bounds by café day, exports CSV with the formula guard", () => {
    const route = source("src/app/api/audit/route.ts");
    assert.match(route, /cursor: \{ id: cursor \}, skip: 1/);
    assert.match(route, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/, "a stable order so pages never repeat or skip a row");
    assert.match(route, /zonedDayStart\(end \? addDays\(value, 1\) : value\)/);
    assert.match(route, /map\(csvCell\)/);
    assert.match(route, /requirePermission\("audit:read"\)/);
    const page = source("src/app/(app)/audit/page.tsx");
    assert.match(page, /data-testid="audit-more"/);
    assert.match(page, /data-testid="audit-export"/);
    assert.doesNotMatch(page, /آخر ٢٠٠ حركة/);
  });
});

describe("4. current shift", () => {
  test("an owner without a branch picks it; employees keep their own branch", () => {
    const page = source("src/app/(app)/current-shift/page.tsx");
    assert.match(page, /\{canChooseBranch && <div className="mb-3" data-testid="current-shift-branch"><BranchScopeSelect /);
    assert.match(page, /const branchId = canChooseBranch \? selectedBranchId : \(user\.branchId \?\? ""\);/);
    assert.doesNotMatch(page, /r\.branches\[0\]/, "no silent first-branch pick");
  });
});
