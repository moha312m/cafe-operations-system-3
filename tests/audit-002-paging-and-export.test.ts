// AUDIT-002 — the activity log no longer stops at the newest 200 rows.
//
// The list pages backwards with a row cursor (ties on createdAt included, so a page boundary never
// repeats or skips a row), can be bounded by café day, and exports CSV with the spreadsheet formula
// guard. Scope is unchanged: one café's rows only, and only for holders of `audit:read`.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;
type Page = { logs: { id: string; action: string; createdAt: string }[]; hasMore: boolean };

before(async () => {
  await requireServer();
  fx = await countCafe("AUDIT002");
  other = await countCafe("AUDIT002X");
  await db.auditLog.deleteMany({ where: { cafeId: { in: [fx.cafeId, other.cafeId] } } });
  const base = Date.parse("2026-03-10T10:00:00Z");
  // 205 rows a minute apart, plus three sharing one instant to sit across the page boundary.
  const rows = Array.from({ length: 205 }, (_, i) => ({ cafeId: fx.cafeId, userId: fx.owner.id, action: `AUDIT002_${i}`, entity: "Test", createdAt: new Date(base - i * 60_000) }));
  const tie = new Date(base - 199 * 60_000);
  for (let i = 0; i < 3; i++) rows.push({ cafeId: fx.cafeId, userId: fx.owner.id, action: `AUDIT002_TIE_${i}`, entity: "Test", createdAt: tie });
  rows.push({ cafeId: fx.cafeId, userId: fx.owner.id, action: "=HYPERLINK(1)", entity: "Test", createdAt: new Date("2026-02-01T09:00:00Z") });
  await db.auditLog.createMany({ data: rows });
  await db.auditLog.create({ data: { cafeId: other.cafeId, userId: other.owner.id, action: "AUDIT002_OTHER", entity: "Test" } });
});

after(() => teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], { disconnect: true }));

describe("AUDIT-002 paging and export", () => {
  test("every row is listed exactly once across pages, newest first, own café only", async () => {
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    for (;;) {
      const r = await as<Page>(fx.owner.email, `/api/audit${cursor ? `?cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200, r.text);
      pages++;
      if (pages === 1) assert.equal(r.body.logs.length, 200);
      seen.push(...r.body.logs.map((l) => l.id));
      for (let i = 1; i < r.body.logs.length; i++) assert.ok(Date.parse(r.body.logs[i - 1].createdAt) >= Date.parse(r.body.logs[i].createdAt));
      if (!r.body.hasMore) break;
      cursor = r.body.logs[r.body.logs.length - 1].id;
      assert.ok(pages < 5);
    }
    const total = await db.auditLog.count({ where: { cafeId: fx.cafeId } });
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, "no row repeats across a page boundary");
    assert.equal(pages, 2);
  });

  test("a café day bounds the list", async () => {
    const r = await as<Page>(fx.owner.email, "/api/audit?from=2026-02-01&to=2026-02-01");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.logs.map((l) => l.action), ["=HYPERLINK(1)"]);
    assert.equal(r.body.hasMore, false);
    const bad = await as(fx.owner.email, "/api/audit?from=01-02-2026");
    assert.equal(bad.status, 400);
  });

  test("CSV export carries the rows with the formula guard and never another café's", async () => {
    const r = await as(fx.owner.email, "/api/audit?format=csv&from=2026-02-01&to=2026-03-31");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(r.text, /"'=HYPERLINK\(1\)"/, "a leading = is neutralised");
    assert.match(r.text, /AUDIT002_TIE_2/);
    assert.doesNotMatch(r.text, /AUDIT002_OTHER/);
    assert.equal(r.text.trim().split("\r\n").length, 1 + (await db.auditLog.count({ where: { cafeId: fx.cafeId } })));
  });

  test("still refused without audit:read", async () => {
    const r = await as(fx.cashier.email, "/api/audit");
    assert.equal(r.status, 403);
  });
});
