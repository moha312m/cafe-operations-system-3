import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const RESALE_CLONE = {
  host: "127.0.0.1", port: "5434", database: "cafe_ops_test",
  systemIdentifier: "7693368256609479860",
};
export const APPROVED_RESALE_MIGRATION = "20261011210000_finished_goods_sales";
export const sha256 = value => createHash("sha256").update(value).digest("hex");

/** Additional acceptance fence; never launches a host or replaces its native guard. */
export function assertResaleHandoff(record, env = process.env, now = Date.now()) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error("BLOCKED: exact clone URL required (credentials omitted)"); }
  assert.equal(url.protocol, "postgresql:", "Only the approved PostgreSQL clone is eligible");
  assert.equal(url.hostname, RESALE_CLONE.host);
  assert.equal(url.port, RESALE_CLONE.port);
  assert.equal(decodeURIComponent(url.pathname), "/" + RESALE_CLONE.database);
  assert.notEqual(env.NODE_ENV, "production");
  assert.equal(record.issue, "OWNER-UAT-RESALE-001");
  assert.ok(Number.isInteger(record.nativeHost.hostPid) && record.nativeHost.hostPid > 0);
  assert.equal(record.nativeHost.jobMembership.pid, record.nativeHost.hostPid);
  assert.ok(now - Date.parse(record.nativeHost.at) >= 0 && now - Date.parse(record.nativeHost.at) < 30 * 60_000, "Fresh native self-membership evidence required");
  assert.equal(record.nativeHost.jobMembership.available, true);
  assert.equal(record.nativeHost.jobMembership.inJob, false);
  assert.ok(["OWNER HOST VERIFIED", "STARTING GUARDED APP", "REUSED EXISTING RUNTIME"].includes(record.nativeHost.status));
  assert.equal(record.lifecycle.provenAfterDispatch, true, "Persistent host lifecycle proof required");
  assert.ok(Number.isFinite(Date.parse(record.lifecycle.verifiedAt)));
  assert.ok(now - Date.parse(record.lifecycle.verifiedAt) >= 0 && now - Date.parse(record.lifecycle.verifiedAt) < 30 * 60_000, "Fresh provider lifecycle evidence required");
  assert.ok(Date.parse(record.runtimeExpiresAt) > now, "Runtime retention expired");
  assert.equal(record.clone.systemIdentifier, RESALE_CLONE.systemIdentifier);
  assert.equal(record.clone.database, RESALE_CLONE.database);
  assert.equal(record.clone.port, 5434);
  assert.equal(record.clone.host, RESALE_CLONE.host);
  assert.match(record.clone.markerSha256, /^[a-f0-9]{64}$/);
  assert.ok(record.build.manifestPath && record.build.id);
  const base = new URL(env.TEST_BASE_URL);
  assert.equal(base.protocol, "http:");
  assert.equal(base.hostname, "127.0.0.1");
  assert.equal(base.port, String(record.application.port));
  assert.equal(record.application.port, 3104);
  assert.equal(record.application.cloneConnectionVerified, true, "Retained app connection guards must prove clone configuration before HTTP");
  assert.equal(base.pathname, "/");
  assert.equal(record.mainDatabaseAccess, false);
  return record;
}

export function readResaleHandoff(env = process.env) {
  if (!env.RESALE_RUNTIME_HANDOFF) throw new Error("BLOCKED: provider handoff for persistent job-free host has not been supplied");
  return assertResaleHandoff(JSON.parse(fs.readFileSync(env.RESALE_RUNTIME_HANDOFF, "utf8")), env);
}

export function assertMatchedResaleBuild(record, projectRoot) {
  const manifest = JSON.parse(fs.readFileSync(record.build.manifestPath, "utf8"));
  const isolated = path.resolve(manifest.isolated);
  assert.ok(isolated.startsWith(path.resolve(projectRoot) + path.sep), "Isolated copy must be inside the authorized workspace");
  assert.equal(manifest.buildId, record.build.id);
  assert.equal(fs.readFileSync(path.join(manifest.isolated, ".next/BUILD_ID"), "utf8").trim(), record.build.id);
  assert.equal(manifest.clientMatchesRoot, true);
  assert.equal(manifest.generatedSchemaMatchesActive, true);
  assert.ok(manifest.inputs.length >= 695 && manifest.clientFiles.length >= 4);
  for (const input of manifest.inputs) {
    assert.ok(!path.isAbsolute(input.path) && !input.path.split(/[\\/]/).includes(".."));
    assert.equal(sha256(fs.readFileSync(path.join(projectRoot, input.path))), input.sha256, "Source drift: " + input.path);
    assert.equal(sha256(fs.readFileSync(path.join(manifest.isolated, input.path))), input.isolatedSha256, "Isolated drift: " + input.path);
    assert.equal(input.sha256, input.isolatedSha256, "Root and isolated input differ: " + input.path);
  }
  for (const file of manifest.clientFiles) {
    assert.ok(file.path.startsWith("node_modules/.prisma/client/") && !file.path.split(/[\\/]/).includes(".."));
    assert.equal(sha256(fs.readFileSync(path.join(projectRoot, file.path))), file.rootSha256, "Root generated client drift");
    assert.equal(sha256(fs.readFileSync(path.join(isolated, file.path))), file.isolatedSha256, "Isolated generated client drift");
  }
  const ownRequire = createRequire(path.join(isolated, "package.json"));
  assert.equal(ownRequire.resolve("@prisma/client"), manifest.clientResolution);
  return manifest;
}
