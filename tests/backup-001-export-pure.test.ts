import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "../src/lib/money";
import {
  escapeSqlString,
  formatSqlLiteral,
  generateSqlInserts,
  sanitizeUserRow,
  sanitizeOwnerPasscodeRow,
  sanitizeWhatsAppIntegrationRow,
  serializeBackupToSql,
  serializeBackupToJson,
  REDACTED_PASSWORD_HASH,
  type BackupData,
} from "../src/lib/backup/export";

test("escapeSqlString properly escapes quotes and removes null bytes", () => {
  assert.equal(escapeSqlString("Cafe Latte"), "'Cafe Latte'");
  assert.equal(escapeSqlString("O'Reilly's Pub"), "'O''Reilly''s Pub'");
  assert.equal(escapeSqlString("Test\0Null"), "'TestNull'");
  assert.equal(escapeSqlString("Multiple ''' Quotes"), "'Multiple '''''' Quotes'");
});

test("formatSqlLiteral handles primitive types, dates, decimals, and JSON", () => {
  assert.equal(formatSqlLiteral(null), "NULL");
  assert.equal(formatSqlLiteral(undefined), "NULL");
  assert.equal(formatSqlLiteral(true), "TRUE");
  assert.equal(formatSqlLiteral(false), "FALSE");
  assert.equal(formatSqlLiteral(42), "42");
  assert.equal(formatSqlLiteral(99.95), "99.95");
  assert.equal(formatSqlLiteral(NaN), "NULL");
  assert.equal(formatSqlLiteral(Infinity), "NULL");
  assert.equal(formatSqlLiteral(BigInt(1000)), "1000");

  const dec = new Decimal("123.456");
  assert.equal(formatSqlLiteral(dec), "123.456");

  const date = new Date("2026-11-08T12:30:00.000Z");
  assert.equal(formatSqlLiteral(date), "'2026-11-08T12:30:00.000Z'::timestamptz");

  assert.equal(formatSqlLiteral("Next Cup"), "'Next Cup'");
  assert.equal(formatSqlLiteral({ role: "ADMIN", active: true }), "'{\"role\":\"ADMIN\",\"active\":true}'::jsonb");
  assert.equal(formatSqlLiteral(["tag1", "tag2"]), "'[\"tag1\",\"tag2\"]'::jsonb");
});

test("generateSqlInserts creates formatted batch inserts with id conflict clause", () => {
  const rows = [
    { id: "br_1", name: "Main Branch", active: true },
    { id: "br_2", name: "Second Branch", active: false },
  ];
  const sql = generateSqlInserts("Branch", rows);

  assert.match(sql, /-- Table: "Branch" \(2 rows\)/);
  assert.match(sql, /INSERT INTO "Branch" \("id", "name", "active"\)/);
  assert.match(sql, /\('br_1', 'Main Branch', TRUE\)/);
  assert.match(sql, /\('br_2', 'Second Branch', FALSE\)/);
  assert.match(sql, /ON CONFLICT \("id"\) DO NOTHING;/);
});

test("generateSqlInserts omits ON CONFLICT for tables without an id column", () => {
  const rows = [
    { productId: "prod_1", addOnId: "addon_1" },
    { productId: "prod_1", addOnId: "addon_2" },
  ];
  const sql = generateSqlInserts("ProductAddOn", rows);

  assert.match(sql, /-- Table: "ProductAddOn" \(2 rows\)/);
  assert.match(sql, /INSERT INTO "ProductAddOn" \("productId", "addOnId"\)/);
  assert.doesNotMatch(sql, /ON CONFLICT \("id"\)/);
});

test("generateSqlInserts handles empty tables cleanly", () => {
  const sql = generateSqlInserts("Customer", []);
  assert.equal(sql, '-- Table: "Customer" (0 rows)\n\n');
});

test("security sanitization redacts passwordHash, passcodeHash, and tokens", () => {
  const user = {
    id: "usr_1",
    email: "owner@nextcup.com",
    name: "Cafe Owner",
    passwordHash: "$2a$10$realSuperSecretUserPasswordHashGoesHere1234567890",
    role: "CAFE_OWNER",
  };
  const sanitizedUser = sanitizeUserRow(user);
  assert.equal(sanitizedUser.id, "usr_1");
  assert.equal(sanitizedUser.email, "owner@nextcup.com");
  assert.equal(sanitizedUser.passwordHash, REDACTED_PASSWORD_HASH);
  assert.notEqual(sanitizedUser.passwordHash, user.passwordHash);

  const passcode = {
    id: "pass_1",
    cafeId: "cafe_1",
    passcodeHash: "$2a$12$realOwnerOverridePasscodeHashGoesHere1234567890",
    version: 1,
  };
  const sanitizedPasscode = sanitizeOwnerPasscodeRow(passcode);
  assert.equal(sanitizedPasscode.id, "pass_1");
  assert.equal(sanitizedPasscode.passcodeHash, REDACTED_PASSWORD_HASH);
  assert.notEqual(sanitizedPasscode.passcodeHash, passcode.passcodeHash);

  const wa = {
    id: "wa_1",
    cafeId: "cafe_1",
    enabled: true,
    phoneNumberId: "123456789",
    accessTokenCipher: "enc:ultra_secret_facebook_token_abc_xyz",
  };
  const sanitizedWA = sanitizeWhatsAppIntegrationRow(wa);
  assert.equal(sanitizedWA.id, "wa_1");
  assert.equal(sanitizedWA.accessTokenCipher, null);
});

test("serializeBackupToSql creates a complete PostgreSQL transaction script", () => {
  const backup: BackupData = {
    manifest: {
      version: "1.0.0",
      generator: "NextCup-ERP-Backup-Engine-v1",
      cafeId: "cafe_test",
      cafeName: "Next Cup Roastery",
      cafeSlug: "next-cup",
      exportedAt: "2026-11-08T12:00:00.000Z",
      exportedBy: {
        userId: "usr_owner",
        name: "Owner User",
        role: "CAFE_OWNER",
      },
      totalRows: 3,
      tableCounts: {
        Cafe: 1,
        Branch: 2,
      },
      omissions: ["User.passwordHash"],
    },
    tables: {
      Cafe: [{ id: "cafe_test", name: "Next Cup Roastery", slug: "next-cup" }],
      Branch: [
        { id: "br_1", cafeId: "cafe_test", name: "Branch 1" },
        { id: "br_2", cafeId: "cafe_test", name: "Branch 2" },
      ],
    },
  };

  const sql = serializeBackupToSql(backup);

  assert.match(sql, /-- NEXT CUP ERP — TENANT DATABASE BACKUP/);
  assert.match(sql, /-- Cafe: Next Cup Roastery \(next-cup\)/);
  assert.match(sql, /-- METADATA_JSON_START/);
  assert.match(sql, /"generator": "NextCup-ERP-Backup-Engine-v1"/);
  assert.match(sql, /-- METADATA_JSON_END/);
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /SET CONSTRAINTS ALL DEFERRED;/);
  assert.match(sql, /INSERT INTO "Cafe"/);
  assert.match(sql, /INSERT INTO "Branch"/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /-- END OF BACKUP/);
});

test("serializeBackupToJson creates structured JSON containing manifest and tables", () => {
  const backup: BackupData = {
    manifest: {
      version: "1.0.0",
      generator: "NextCup-ERP-Backup-Engine-v1",
      cafeId: "cafe_test",
      cafeName: "Next Cup",
      cafeSlug: "next-cup",
      exportedAt: "2026-11-08T12:00:00.000Z",
      exportedBy: {
        userId: "usr_owner",
        name: "Owner",
        role: "CAFE_OWNER",
      },
      totalRows: 1,
      tableCounts: { Cafe: 1 },
      omissions: [],
    },
    tables: {
      Cafe: [{ id: "cafe_test", name: "Next Cup" }],
    },
  };

  const json = serializeBackupToJson(backup);
  const parsed = JSON.parse(json);

  assert.equal(parsed.manifest.cafeId, "cafe_test");
  assert.equal(parsed.manifest.totalRows, 1);
  assert.equal(parsed.tables.Cafe[0].name, "Next Cup");
});
