// Guard for integration suites that use src/lib/db directly. They were pinned to one
// historical clone URL; this keeps the same fail-closed shape for whichever disposable
// database the runner provisioned: the runner's own URL, the name convention, and the
// marker the database carries about itself.
import assert from "node:assert/strict";
import { TEST_DATABASE_URL, assertTestDatabaseUrl, assertTestDatabaseMarker } from "../../scripts/test-db.mjs";

export async function assertIntegrationDatabase(client: { $queryRawUnsafe: (sql: string) => Promise<unknown> }) {
  assert.equal(process.env.DATABASE_URL, TEST_DATABASE_URL);
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  await assertTestDatabaseMarker(client);
}
