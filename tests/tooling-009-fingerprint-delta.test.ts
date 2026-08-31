import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintDelta } from "../scripts/owner-fingerprint.mjs";

type FingerprintSnapshot = {
  capturedAt: string;
  database: string;
  tables: Record<string, { rows: number; digest: string | null }>;
  audit: { rows: number; latestCreatedAt: string | null };
  timestamps: Record<string, string | null>;
  migrations: { rows: number; digest: string | null };
};

function snapshot(): FingerprintSnapshot {
  return {
    capturedAt: "2026-08-31T00:00:00.000Z",
    database: "postgres",
    tables: {
      AuditLog: { rows: 2, digest: "aa" },
      Cafe: { rows: 1, digest: "bb" },
    },
    audit: {
      rows: 2,
      latestCreatedAt: "2026-08-30T23:00:00.000Z",
    },
    timestamps: {
      userMaxUpdatedAt: "2026-08-30T20:00:00.000Z",
      userMaxLastLoginAt: null,
      shiftMaxUpdatedAt: "2026-08-30T21:00:00.000Z",
      shiftMaxClosedAt: null,
      orderMaxUpdatedAt: "2026-08-30T22:00:00.000Z",
      inventoryItemMaxUpdatedAt: "2026-08-30T23:00:00.000Z",
    },
    migrations: { rows: 43, digest: "cc" },
  };
}

function paths(delta: ReturnType<typeof fingerprintDelta>) {
  return delta.changed.map((change: { path: string }) => change.path);
}

describe("TOOLING-009 fingerprint delta", () => {
  test("identical snapshots have a zero delta", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.capturedAt = "2026-08-31T00:01:00.000Z";

    assert.deepEqual(fingerprintDelta(before, after), {
      zero: true,
      changed: [],
    });
  });

  test("a table digest change is detected when its row count is unchanged", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.tables.Cafe.digest = "changed";

    const delta = fingerprintDelta(before, after);

    assert.equal(delta.zero, false);
    assert.deepEqual(paths(delta), ["tables.Cafe"]);
  });

  test("a table row-count change reports the table by name", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.tables.Cafe.rows = 2;

    assert.deepEqual(paths(fingerprintDelta(before, after)), ["tables.Cafe"]);
  });

  test("a table present only after the capture is ADDED", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.tables.NewTable = { rows: 0, digest: null };

    const [change] = fingerprintDelta(before, after).changed;

    assert.equal(change.path, "tables.NewTable");
    assert.equal(change.type, "ADDED");
  });

  test("a table present only before the capture is REMOVED", () => {
    const before = snapshot();
    const after = structuredClone(before);
    delete after.tables.Cafe;

    const [change] = fingerprintDelta(before, after).changed;

    assert.equal(change.path, "tables.Cafe");
    assert.equal(change.type, "REMOVED");
  });

  test("an AuditLog row-count change is reported", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.audit.rows = 3;

    assert.deepEqual(paths(fingerprintDelta(before, after)), ["audit.rows"]);
  });

  test("the latest AuditLog timestamp is checked even when count is unchanged", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.audit.latestCreatedAt = "2026-08-31T00:00:00.000Z";

    assert.deepEqual(paths(fingerprintDelta(before, after)), [
      "audit.latestCreatedAt",
    ]);
  });

  test("userMaxUpdatedAt is independently compared", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.timestamps.userMaxUpdatedAt = "2026-08-31T00:00:00.000Z";

    assert.deepEqual(paths(fingerprintDelta(before, after)), [
      "timestamps.userMaxUpdatedAt",
    ]);
  });

  test("the migration digest is independently compared", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.migrations.digest = "changed";

    assert.deepEqual(paths(fingerprintDelta(before, after)), [
      "migrations.digest",
    ]);
  });

  test("two null digests are equal", () => {
    const before = snapshot();
    const after = structuredClone(before);
    before.tables.Cafe.digest = null;
    after.tables.Cafe.digest = null;

    assert.equal(fingerprintDelta(before, after).zero, true);
  });

  test("a null digest and a real digest are different", () => {
    const before = snapshot();
    const after = structuredClone(before);
    before.tables.Cafe.digest = null;

    assert.deepEqual(paths(fingerprintDelta(before, after)), ["tables.Cafe"]);
  });

  test("changes have deterministic ordering independent of object insertion order", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.tables = {
      Zebra: { rows: 1, digest: "z" },
      AuditLog: { rows: 4, digest: "changed" },
      Cafe: { rows: 1, digest: "changed" },
      Alpha: { rows: 1, digest: "a" },
    };
    after.audit.rows = 4;
    after.migrations.digest = "changed";

    assert.deepEqual(paths(fingerprintDelta(before, after)), [
      "tables.Alpha",
      "tables.AuditLog",
      "tables.Cafe",
      "tables.Zebra",
      "audit.rows",
      "migrations.digest",
    ]);
  });
});
