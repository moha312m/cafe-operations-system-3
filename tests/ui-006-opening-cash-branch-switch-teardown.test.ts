// Teardown for the UI-006 browser interaction fixture: removes exactly the
// café the setup file created, identified by the recorded café id, and the
// fixture record itself. Runs after the externally driven browser steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownTaggedCafe } from "./helpers/db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_FILE = path.join(
  root,
  "artifacts/commercial-readiness/2026-10-06-stage1-gates/takeover-ui006-fixture.json"
);

test("UI-006 teardown: remove the browser-interaction café", async () => {
  assert.ok(existsSync(FIXTURE_FILE), "fixture record missing — was setup run?");
  const { cafeId } = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as { cafeId: string };
  await teardownTaggedCafe(cafeId);
  rmSync(FIXTURE_FILE);
});
