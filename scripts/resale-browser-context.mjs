import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readResaleHandoff, assertMatchedResaleBuild, sha256, RESALE_CLONE, APPROVED_RESALE_MIGRATION } from "./resale-acceptance-guard.mjs";

/** Call only after guarded DB acceptance and --browser-prepare succeed.
 * No startup, cookie injection, browser HTTP bypass or credential output.
 */
export async function openResaleBrowserContext({ emitImage } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = path.join(root, "artifacts/commercial-readiness/2026-10-10-owner-uat/resale-real-acceptance");
  const proof = readResaleHandoff(); const manifest = assertMatchedResaleBuild(proof, root);
  const nativeBytes = fs.readFileSync(proof.nativeEvidencePath); const native = JSON.parse(nativeBytes.toString("utf8"));
  assert.equal(sha256(nativeBytes), proof.nativeEvidenceSha256);
  for (const key of ["jobMembership", "hostPid", "at", "status"]) assert.deepEqual(native[key], proof.nativeHost[key]);
  assert.equal(sha256(fs.readFileSync(path.join(root, "artifacts/commercial-readiness/2026-10-10-owner-uat/native-guard.ps1"))), "d9fc767e5eb884269ade0382e759bdcca3c7754ae86c101ab2bb4697ed4a4bf3");
  const database = JSON.parse(fs.readFileSync(path.join(out, "database.json"), "utf8"));
  assert.equal(database.status, "PASS"); assert.equal(database.buildId, manifest.buildId);
  const scope = JSON.parse(fs.readFileSync(path.join(out, "browser-scope.json"), "utf8"));
  assert.equal(scope.buildId, manifest.buildId); assert.equal(scope.clone.systemIdentifier, RESALE_CLONE.systemIdentifier);
  const fixtures = JSON.parse(fs.readFileSync(scope.fixturesFile, "utf8"));
  assert.equal(fixtures.buildId, manifest.buildId);
  const ownRequire = createRequire(path.join(manifest.isolated, "package.json"));
  const { PrismaClient } = ownRequire("@prisma/client"); const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const [identity] = await db.$queryRawUnsafe(`SELECT current_database() AS database,current_setting('port') AS port,current_setting('data_directory') AS data_directory,system_identifier::text FROM pg_control_system()`);
    assert.equal(identity.database, RESALE_CLONE.database); assert.equal(identity.port, RESALE_CLONE.port); assert.equal(identity.system_identifier, RESALE_CLONE.systemIdentifier);
    assert.equal(identity.data_directory.replaceAll("\\", "/").toLowerCase(), path.join(root, "artifacts/commercial-readiness/2026-10-07-ui006-pg-diagnosis/runtime/pgdata").replaceAll("\\", "/").toLowerCase());
    assert.equal(sha256(JSON.stringify(await db.$queryRawUnsafe(`SELECT * FROM "_disposable_test_database"`))), proof.clone.markerSha256);
    const [migration] = await db.$queryRawUnsafe(`SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1`, APPROVED_RESALE_MIGRATION);
    assert.ok(migration?.finished_at && !migration.rolled_back_at); assert.equal(migration.checksum, sha256(fs.readFileSync(path.join(root, "prisma/migrations", APPROVED_RESALE_MIGRATION, "migration.sql"))));
    for (const f of [fixtures.config, fixtures.sales, fixtures.returns, fixtures.receiving]) {
      assert.ok(scope.cafeIds.includes(f.cafeId)); assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: f.cafeId } })).name, f.marker + " cafe");
    }
  } catch (error) { await db.$disconnect(); throw error; }
  const credentialMatch = fs.readFileSync(path.join(root, "tests/helpers/count.ts"), "utf8").match(/export const COUNT_PASSWORD\s*=\s*("(?:[^"\\]|\\.)*")/);
  assert.ok(credentialMatch, "Existing fixture credential must be available in memory");
  const password = JSON.parse(credentialMatch[1]); // Never included in records, DOM dumps or messages.
  let lastActor;
  const results = { buildId: manifest.buildId, database: "VERIFIED_CLONE", scenarios: {}, ownerAcceptance: "PENDING", deployment: "NOT AUTHORIZED / NOT READY" };
  return {
    db, fixtures, base: process.env.TEST_BASE_URL,
    async login(tab, fixture, role) {
      readResaleHandoff();
      await tab.goto(process.env.TEST_BASE_URL + "/login");
      await tab.playwright.domSnapshot();
      if (await tab.playwright.getByLabel("الإيميل", { exact: true }).count() === 0) {
        assert.ok(lastActor && await tab.playwright.getByText(lastActor.name, { exact: true }).count() > 0, "BLOCKED: unknown existing browser session; preserve owner session");
        await tab.playwright.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
        await tab.playwright.getByLabel("الإيميل", { exact: true }).waitFor({ state: "visible", timeoutMs: 15_000 });
      }
      await tab.playwright.getByLabel("الإيميل", { exact: true }).fill(fixture[role].email);
      await tab.playwright.getByLabel("الباسورد", { exact: true }).fill(password);
      await tab.playwright.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
      await tab.playwright.getByRole("button", { name: "تسجيل الخروج", exact: true }).waitFor({ state: "visible", timeoutMs: 15_000 });
      lastActor = fixture[role];
    },
    async poll(read, condition) {
      for (let i = 0; i < 60; i++) { const value = await read(); if (condition(value)) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new Error("Actual database postcondition did not become true");
    },
    async balance(id) { return Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock); },
    async receiptEvidence(fixture) {
      const rows = await db.finishedGoodsReturn.findMany({ where: { cafeId: fixture.cafeId }, include: { inventoryTransaction: true } });
      const audits = await db.auditLog.findMany({ where: { cafeId: fixture.cafeId, action: { in: ["FINISHED_GOODS_RETURN_SEGREGATED", "FINISHED_GOODS_RETURN_POSTED"] } } });
      for (const row of rows) {
        const audit = audits.find(a => a.details?.receiptId === row.id && a.action === (row.appliedAt ? "FINISHED_GOODS_RETURN_POSTED" : "FINISHED_GOODS_RETURN_SEGREGATED")); assert.ok(audit);
        if (row.appliedAt) { assert.equal(row.inventoryTransaction.type, "RETURN"); assert.equal(Number(row.inventoryTransaction.quantity), row.quantity); assert.equal(audit.details.returnTransactionId, row.inventoryTransactionId); assert.equal(audit.details.stockAfter - audit.details.stockBefore, row.quantity); }
        else { assert.equal(row.inventoryTransactionId, null); assert.equal(audit.details.instruction, "HOLD_SEPARATELY_EXCLUDE_SALEABLE_AND_COUNT"); }
      }
      return rows.map(r => ({ id: r.id, orderItemId: r.orderItemId, quantity: r.quantity, appliedAt: r.appliedAt, movementId: r.inventoryTransactionId, unitCost: r.inventoryTransaction?.unitCost ?? null, totalCost: r.inventoryTransaction?.totalCost ?? null }));
    },
    async capture(tab, name) {
      const snapshot = await tab.playwright.domSnapshot(); fs.writeFileSync(path.join(out, name + ".dom.txt"), typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot, null, 2));
      const screenshot = await tab.screenshot({ fullPage: false }); fs.writeFileSync(path.join(out, name + ".png"), screenshot);
      if (emitImage) await emitImage(screenshot);
      return typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
    },
    pass(name, evidence) { results.scenarios[name] = { status: "PASS", at: new Date().toISOString(), evidence }; fs.writeFileSync(scope.browserResultsFile, JSON.stringify(results, null, 2)); },
    async close() { await db.$disconnect(); },
  };
}
