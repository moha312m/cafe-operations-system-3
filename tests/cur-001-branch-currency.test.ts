// CUR-001 - branch currency (v1: one currency per cafe, 2-decimal currencies only).
//
// Three layers: the formatter and the source guard (pure), the database guards of the
// `branch_currency` migration (disposable DB only), and the owner-only service over HTTP.
// Fixtures are tagged `CUR001...` and removed with their cafe.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import {
  CURRENCIES, CURRENCY_LOCK_TABLES, SUPPORTED_CURRENCY_CODES, assertSameCurrency, currencyMeta, formatMoney,
  isSupportedCurrency, moneyHeader, platformCurrency, receiptMoney,
} from "@/lib/currency";
import { auditActionLabel } from "@/lib/audit-action-labels";

const cleanup: string[] = [];
after(async () => {
  for (const id of cleanup) await teardownTaggedCafe(id).catch(() => {});
  await db.$disconnect();
});

async function fixture(label: string): Promise<CountCafe> {
  const fx = await countCafe(label);
  cleanup.push(fx.cafeId);
  return fx;
}

// ── formatter ────────────────────────────────────────────────────────────────
describe("CUR-001 formatter", () => {
  test("every supported currency: Western digits, Arabic symbol after the number, negatives, zero, large values", () => {
    assert.deepEqual(SUPPORTED_CURRENCY_CODES, ["EGP", "SAR", "AED", "QAR", "MAD", "TRY", "LBP", "USD", "EUR", "GBP"]);
    for (const code of SUPPORTED_CURRENCY_CODES) {
      const symbol = currencyMeta(code)!.symbol;
      assert.equal(formatMoney(95, code), `95 ${symbol}`, code);
      assert.equal(formatMoney(1234.5, code), `1,234.50 ${symbol}`, code);
      assert.equal(formatMoney(0, code), `0 ${symbol}`, code);
      assert.equal(formatMoney(-12.5, code), `-12.50 ${symbol}`, code);
      assert.equal(formatMoney(1234567.891, code), `1,234,567.89 ${symbol}`, code);
      assert.equal(formatMoney(1234.5, code, { fixed: true }), `1,234.50 ${symbol}`, code);
      assert.equal(formatMoney(95, code, { fixed: true }), `95.00 ${symbol}`, code);
      assert.equal(formatMoney(95, code, { iso: true }), `95 ${code}`, code);
      assert.match(formatMoney(1234567.891, code), /^-?[0-9,.]+ \S+$/, "Western digits only before the symbol");
    }
    assert.equal(formatMoney("42.1", "SAR"), "42.10 ر.س");
  });

  test("EGP output is exactly what the app printed before currencies existed", () => {
    const legacy = (value: number) => `${new Intl.NumberFormat("en-EG", { minimumFractionDigits: value % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(value)} ج.م`;
    for (const v of [0, 1, 95, 95.5, 1234.5, 1000000, -3, -3.25, 0.05, 12345678.9]) assert.equal(formatMoney(v, "EGP"), legacy(v), String(v));
    assert.equal(formatMoney(95), "95 ج.م", "EGP is still the default");
  });

  test("the 80mm receipt style is byte-identical for EGP", () => {
    const legacy = (v: number | string) => { const n = Number(v); return `${Number.isInteger(n) ? String(n) : n.toFixed(2)} ج.م`; };
    const egp = receiptMoney("EGP");
    for (const v of [0, 5, 12.5, 12.345, 1234, 1234.5, "7", "7.10"]) assert.equal(egp(v), legacy(v), String(v));
    assert.equal(receiptMoney("SAR")(12.5), "12.50 ر.س");
    assert.equal(receiptMoney("XYZ")(3), "3 XYZ", "an unknown code prints the code, never throws");
  });

  test("3-decimal and 0-decimal currencies are listed but unsupported; unknown codes never throw", () => {
    for (const code of ["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD", "JPY"]) {
      assert.equal(isSupportedCurrency(code), false, code);
      assert.ok(currencyMeta(code), `${code} is listed so the screen can say «غير مدعومة حالياً»`);
    }
    assert.equal(isSupportedCurrency("XYZ"), false);
    assert.equal(isSupportedCurrency(undefined), false);
    assert.doesNotThrow(() => formatMoney(5, "XYZ"));
    assert.ok(CURRENCIES.every(c => c.supported === (c.decimals === 2)), "only 2-decimal currencies are supported");
  });

  test("export headers: ISO code for new currencies, the existing «ج.م» header for EGP", () => {
    assert.equal(moneyHeader("المبلغ", "SAR"), "المبلغ (SAR)");
    assert.equal(moneyHeader("المبلغ", "EGP"), "المبلغ (ج.م)");
  });

  test("amounts of different currencies are never summed or shown as one total", () => {
    assert.equal(assertSameCurrency([{ currency: "EGP" }, { currency: "EGP" }]), "EGP");
    assert.throws(() => assertSameCurrency([{ currency: "EGP" }, { currency: "SAR" }]), /different currencies/);
    assert.throws(() => assertSameCurrency([{ currency: "SAR" }], "EGP"), /different currencies/);
    assert.equal(platformCurrency(["EGP", "EGP"]), "EGP");
    assert.equal(platformCurrency(["EGP", "SAR"]), null);
  });

  test("the audit log has its Arabic label", () => {
    assert.equal(auditActionLabel("BRANCH_CURRENCY_CHANGED"), "تغيير عملة الفرع");
  });
});

// ── source guards ────────────────────────────────────────────────────────────
describe("CUR-001 source guards", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

  // Files that may name the Egyptian pound on purpose, with the reason (drawer expenses and the treasury now follow
  // the cafe currency and are no longer listed). Everything else must go through
  // lib/currency.ts and the cafe's currency.
  const ALLOWED: Record<string, string> = {
    "lib/currency.ts": "the symbol table",
    "lib/i18n.ts": "documentation of the formatter default",
    "lib/reports/handover-accountability-format.ts": "formatter default and documentation",
    "components/pos/cash-denomination-calculator.tsx": "Egyptian banknote helper; hidden for other currencies",
    "components/pos/shift-close-flow.tsx": "shows the banknote helper for EGP only",
    "app/(super)/admin/settings/page.tsx": "platform default shown to the platform owner",
    "components/admin/create-cafe-dialog.tsx": "the platform's default for a new cafe",
  };
  // `?? "EGP"` / `= "EGP"` are fallbacks for a missing currency, not a currency choice.
  const FALLBACK = /(\?\?\s*|=\s*|:\s*)["']EGP["']/g;

  test("no new hard-coded «ج.م» / «جنيه» / \"EGP\" outside the symbol table and the reviewed EGP-only modules", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, "src"))) {
      const rel = file.slice(path.join(root, "src").length + 1).replaceAll("\\", "/");
      if (ALLOWED[rel]) continue;
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        const stripped = line.replace(FALLBACK, "");
        if (/ج\.م|جنيه|["']EGP["']/.test(stripped)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(offenders, [], "use formatMoney(value, currency) / currencySymbol(currency) with the cafe currency");
  });

  test("the migration's lock table list is exactly CURRENCY_LOCK_TABLES", () => {
    const sql = readFileSync(path.join(root, "prisma/migrations/20261106130000_branch_currency/migration.sql"), "utf8");
    const array = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/.exec(sql)![1];
    const fromSql = [...array.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
    assert.deepEqual(fromSql, [...CURRENCY_LOCK_TABLES]);
  });

  test("the receipt prints through the cafe currency, not a literal", () => {
    const receipt = readFileSync(path.join(root, "src/app/receipts/payment/[paymentId]/page.tsx"), "utf8");
    assert.match(receipt, /receiptMoney\(payment\.branch\?\.currencyCode/);
    assert.ok(!receipt.includes("ج.م"));
  });
});

// ── database guards ──────────────────────────────────────────────────────────
describe("CUR-001 database guards (disposable DB)", () => {
  test("the deployed lock function lists exactly the lock tables", async () => {
    const [{ def }] = await db.$queryRaw<{ def: string }[]>`SELECT pg_get_functiondef('currency_lock_has_records(text)'::regprocedure) AS def`;
    const listed = [...(/ARRAY\[([\s\S]*?)\]/.exec(def)![1]).matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
    assert.deepEqual(listed, [...CURRENCY_LOCK_TABLES]);
  });

  test("a branch starts in its cafe's currency; a cafe change cascades; a mismatching branch change is refused (C2)", async () => {
    const fx = await fixture("CUR001DB");
    await db.cafe.update({ where: { id: fx.cafeId }, data: { currency: "SAR" } });
    const afterCafe = await db.branch.findMany({ where: { cafeId: fx.cafeId }, select: { currencyCode: true } });
    assert.deepEqual(afterCafe.map(b => b.currencyCode), ["SAR", "SAR"], "cascaded to both branches");
    const added = await db.branch.create({ data: { cafeId: fx.cafeId, name: "CUR001DB third" } });
    assert.equal(added.currencyCode, "SAR", "a new branch copies the cafe currency, not the column default");
    await assert.rejects(db.branch.update({ where: { id: fx.branchId }, data: { currencyCode: "EUR" } }), /CURRENCY_MISMATCH/);
    await assert.rejects(db.branch.update({ where: { id: fx.branchId }, data: { currencyCode: "KWD" } }), /two_decimals|CURRENCY_MISMATCH/);
  });

  test("shape and decimals are enforced by CHECK constraints", async () => {
    const fx = await fixture("CUR001CHK");
    for (const bad of ["sar", "SA", "KWD", "JPY", "BHD"]) {
      await assert.rejects(db.cafe.update({ where: { id: fx.cafeId }, data: { currency: bad } }), /check|constraint/i, bad);
    }
    assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } })).currency, "USD", "unchanged after the refusals");
  });

  test("the currency locks once the cafe has a financial record, at cafe and branch level (C4)", async () => {
    const fx = await fixture("CUR001LOCK");
    await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 1, openingCashAmount: 0, expectedCashAmount: 0 } });
    await assert.rejects(db.cafe.update({ where: { id: fx.cafeId }, data: { currency: "SAR" } }), /CURRENCY_LOCKED/);
    await assert.rejects(db.branch.update({ where: { id: fx.otherBranchId }, data: { currencyCode: "SAR" } }), /CURRENCY_LOCKED/);
    const [{ locked }] = await db.$queryRaw<{ locked: boolean }[]>`SELECT "currency_lock_has_records"(${fx.cafeId}) AS locked`;
    assert.equal(locked, true);
  });

  test("backfill rule: an existing branch carries its cafe's currency", async () => {
    const mismatched = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM "Branch" b JOIN "Cafe" c ON c.id=b."cafeId" WHERE b."currencyCode" <> c.currency`;
    assert.equal(mismatched[0].n, 0);
  });
});

// ── the owner-only service over HTTP ─────────────────────────────────────────
describe("CUR-001 change service", { timeout: 240_000 }, () => {
  const patch = (email: string, branchId: string, body: unknown, key: string | null = crypto.randomUUID()) =>
    as<{ error?: string; changed?: boolean; currencyCode?: string }>(email, `/api/branches/${branchId}/currency`, {
      method: "PATCH", body: JSON.stringify(body), headers: key ? { "Idempotency-Key": key } : {},
    });

  test("permissions, validation, success, audit, replay, then locked after a shift", async () => {
    await requireServer();
    const fx = await fixture("CUR001API");
    const other = await fixture("CUR001OTHER");

    const state = await as<{ cafeCurrency: string; locked: boolean; branches: unknown[] }>(fx.owner.email, `/api/branches/${fx.branchId}/currency`);
    assert.equal(state.status, 200, state.text);
    assert.equal(state.body.cafeCurrency, "USD");
    assert.equal(state.body.locked, false);
    assert.equal(state.body.branches.length, 2);

    for (const who of [fx.manager, fx.cashier]) {
      const denied = await patch(who.email, fx.branchId, { currencyCode: "SAR", reason: "test" });
      assert.equal(denied.status, 403, `${who.email}: ${denied.text}`);
    }
    assert.equal((await patch(other.owner.email, fx.branchId, { currencyCode: "SAR", reason: "test" })).status, 404, "another cafe's owner sees nothing");
    assert.equal((await patch(fx.owner.email, fx.branchId, { currencyCode: "SAR", reason: "test" }, null)).status, 400, "an idempotency key is required");
    for (const bad of ["KWD", "JPY", "XYZ", "sa", ""]) {
      const refused = await patch(fx.owner.email, fx.branchId, { currencyCode: bad, reason: "test" });
      assert.equal(refused.status, 400, `${bad}: ${refused.text}`);
    }
    assert.equal((await patch(fx.owner.email, fx.branchId, { currencyCode: "SAR", reason: "x" })).status, 400, "a reason is required");
    assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } })).currency, "USD", "nothing changed so far");

    const key = crypto.randomUUID();
    const ok = await patch(fx.owner.email, fx.branchId, { currencyCode: "sar", reason: "كافيه في السعودية" }, key);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.changed, true);
    const branches = await db.branch.findMany({ where: { cafeId: fx.cafeId }, select: { currencyCode: true } });
    assert.deepEqual(branches.map(b => b.currencyCode), ["SAR", "SAR"]);
    assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } })).currency, "SAR");

    const rows = await db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: "BRANCH_CURRENCY_CHANGED" } });
    assert.equal(rows.length, 2, "one audit row per branch");
    for (const row of rows) {
      const d = row.details as { branchId: string; from: string; to: string; reason: string };
      assert.equal(row.userId, fx.owner.id);
      assert.equal(row.entityId, d.branchId);
      assert.deepEqual([d.from, d.to, d.reason], ["USD", "SAR", "كافيه في السعودية"]);
    }

    const replay = await patch(fx.owner.email, fx.branchId, { currencyCode: "sar", reason: "كافيه في السعودية" }, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal((await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "BRANCH_CURRENCY_CHANGED" } })), 2, "a replay writes nothing");
    const again = await patch(fx.owner.email, fx.branchId, { currencyCode: "SAR", reason: "نفس العملة" });
    assert.equal(again.body.changed, false, "setting the current currency is a no-op");

    const shift = await as(fx.manager.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 100 }) });
    assert.ok(shift.status === 200 || shift.status === 201, shift.text);
    const locked = await patch(fx.owner.email, fx.branchId, { currencyCode: "EUR", reason: "بعد الشيفت" });
    assert.equal(locked.status, 409, locked.text);
    assert.match(locked.body.error ?? "", /العملة مقفلة لوجود حركات مالية/);
    assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } })).currency, "SAR", "history keeps its meaning");
    const after = await as<{ locked: boolean; history: unknown[] }>(fx.owner.email, `/api/branches/${fx.branchId}/currency`);
    assert.equal(after.body.locked, true);
    assert.ok(after.body.history.length >= 1);
  });

  test("a currency change racing the first shift-open has exactly one outcome", async () => {
    await requireServer();
    for (let round = 0; round < 3; round++) {
      const fx = await fixture(`CUR001RACE${round}`);
      const [change, open] = await Promise.all([
        patch(fx.owner.email, fx.branchId, { currencyCode: "EUR", reason: "سباق" }),
        as(fx.manager.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 50 }) }),
      ]);
      assert.ok(open.status === 200 || open.status === 201, `the shift opens either way: ${open.text}`);
      const cafe = await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } });
      const branches = await db.branch.findMany({ where: { cafeId: fx.cafeId }, select: { currencyCode: true } });
      assert.ok(branches.every(b => b.currencyCode === cafe.currency), "branches always mirror the cafe");
      if (change.status === 200) {
        assert.equal(cafe.currency, "EUR", "the change landed, so it landed before any record existed");
        const audit = await db.auditLog.findFirstOrThrow({ where: { cafeId: fx.cafeId, action: "BRANCH_CURRENCY_CHANGED" } });
        const shift = await db.shift.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
        assert.ok(audit.createdAt <= shift.createdAt, "the shift was created after the change committed");
      } else {
        assert.equal(change.status, 409, change.text);
        assert.equal(cafe.currency, "USD", "the shift won, so the currency stayed");
      }
    }
  });
});

