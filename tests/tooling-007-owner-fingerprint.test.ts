import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fingerprint,
  fingerprintDelta,
  snapshotShape,
  tableDigestSql,
} from "../scripts/owner-fingerprint.mjs";
import {
  TEST_DATABASE_URL,
  assertTestDatabaseMarker,
} from "../scripts/test-db.mjs";
import { db } from "./helpers/db";

const SCRIPT = fileURLToPath(
  new URL("../scripts/owner-fingerprint.mjs", import.meta.url)
);
const temporaryRoots: string[] = [];

before(async () => {
  await assertTestDatabaseMarker(db);
});

after(async () => {
  await db.$disconnect();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shapedSnapshot() {
  return snapshotShape({
    capturedAt: new Date("2026-08-31T00:00:00.000Z"),
    database: "cafe_ops_test",
    tables: [{ table: "Cafe", rows: 1, digest: "aa" }],
    audit: { rows: 0, latestCreatedAt: null },
    timestamps: {
      userMaxUpdatedAt: null,
      userMaxLastLoginAt: null,
      shiftMaxUpdatedAt: null,
      shiftMaxClosedAt: null,
      orderMaxUpdatedAt: null,
      inventoryItemMaxUpdatedAt: null,
    },
    migrations: { rows: 43, digest: "bb" },
  });
}

describe("TOOLING-007 pure fingerprint boundaries", () => {
  test("table digest SQL safely quotes identifiers and hashes whole rows", () => {
    const sql = tableDigestSql('strange"table');

    assert.match(sql, /FROM "public"\."strange""table" x/);
    assert.match(sql, /md5\(x::text\)/);
    assert.match(sql, /string_agg\(t\.row_md5, '' ORDER BY t\.row_md5\)/);
  });

  test("snapshotShape emits the stable credential-free contract", () => {
    assert.deepEqual(shapedSnapshot(), {
      capturedAt: "2026-08-31T00:00:00.000Z",
      database: "cafe_ops_test",
      tables: { Cafe: { rows: 1, digest: "aa" } },
      audit: { rows: 0, latestCreatedAt: null },
      timestamps: {
        userMaxUpdatedAt: null,
        userMaxLastLoginAt: null,
        shiftMaxUpdatedAt: null,
        shiftMaxClosedAt: null,
        orderMaxUpdatedAt: null,
        inventoryItemMaxUpdatedAt: null,
      },
      migrations: { rows: 43, digest: "bb" },
    });
  });

  test("marker-bearing disposable database refuses without --allow-disposable", async () => {
    await assert.rejects(
      fingerprint(TEST_DATABASE_URL),
      /--allow-disposable/
    );
  });

  test("--allow-disposable refuses a target that cannot carry the marker", async () => {
    await assert.rejects(
      fingerprint("postgresql://postgres@127.0.0.1:5434/postgres", {
        allowDisposable: true,
      }),
      /disposable|marker/i
    );
  });
});

describe("TOOLING-007 disposable database fingerprint", () => {
  test("CLI accepts a bounded fingerprint filename in the repository root", () => {
    const repo = path.resolve(path.dirname(SCRIPT), "..");
    const basename = `.owner-fingerprint-cli-${process.pid}.json`;
    const output = path.join(repo, basename);

    try {
      const result = spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--url",
          TEST_DATABASE_URL,
          "--allow-disposable",
          "--out",
          basename,
        ],
        { cwd: repo, encoding: "utf8", windowsHide: true }
      );

      assert.equal(result.status, 0, errorMessage(result.stderr));
      assert.doesNotThrow(() => JSON.parse(readFileSync(output, "utf8")));
    } finally {
      rmSync(output, { force: true });
    }
  });

  test("fingerprinting succeeds with server-enforced read-only sessions", async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set("options", "-c default_transaction_read_only=on");

    const result = await fingerprint(url.href, { allowDisposable: true });

    assert.equal(result.database, "cafe_ops_test");
  });

  test("every public table discovered through information_schema is covered", async () => {
    const discovered = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `;

    const result = await fingerprint(TEST_DATABASE_URL, {
      allowDisposable: true,
    });

    assert.deepEqual(
      Object.keys(result.tables).sort(),
      discovered.map((row) => row.table_name).sort()
    );
  });

  test("an UPDATE changes the Cafe digest without changing its row count", async () => {
    const cafe = await db.cafe.findFirstOrThrow({ orderBy: { id: "asc" } });
    const before = await fingerprint(TEST_DATABASE_URL, {
      allowDisposable: true,
    });

    try {
      await db.cafe.update({
        where: { id: cafe.id },
        data: { name: `${cafe.name} [TOOLING-007 update]` },
      });
      const after = await fingerprint(TEST_DATABASE_URL, {
        allowDisposable: true,
      });

      assert.equal(after.tables.Cafe.rows, before.tables.Cafe.rows);
      assert.notEqual(after.tables.Cafe.digest, before.tables.Cafe.digest);
      assert.deepEqual(
        fingerprintDelta(before, after).changed
          .map((change: { path: string }) => change.path)
          .filter((value: string) => value === "tables.Cafe"),
        ["tables.Cafe"]
      );
    } finally {
      await db.cafe.update({
        where: { id: cafe.id },
        data: { name: cafe.name, updatedAt: cafe.updatedAt },
      });
    }

    const restored = await db.cafe.findUniqueOrThrow({ where: { id: cafe.id } });
    assert.equal(restored.name, cafe.name);
    assert.equal(restored.updatedAt.toISOString(), cafe.updatedAt.toISOString());
  });

  test("two captures with no intervening change have a zero delta", async () => {
    const before = await fingerprint(TEST_DATABASE_URL, {
      allowDisposable: true,
    });
    const after = await fingerprint(TEST_DATABASE_URL, {
      allowDisposable: true,
    });

    assert.deepEqual(fingerprintDelta(before, after), {
      zero: true,
      changed: [],
    });
  });

  test("CLI --assert-zero exits zero for equal snapshots and non-zero for changes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fingerprint-delta-"));
    temporaryRoots.push(root);
    const beforePath = path.join(root, "before.json");
    const equalPath = path.join(root, "equal.json");
    const changedPath = path.join(root, "changed.json");
    const before = shapedSnapshot();
    const changed = structuredClone(before);
    changed.tables.Cafe.digest = "changed";
    writeFileSync(beforePath, JSON.stringify(before), "utf8");
    writeFileSync(equalPath, JSON.stringify(before), "utf8");
    writeFileSync(changedPath, JSON.stringify(changed), "utf8");

    const equal = spawnSync(
      process.execPath,
      [SCRIPT, "--before", beforePath, "--after", equalPath, "--assert-zero"],
      { encoding: "utf8", windowsHide: true }
    );
    const different = spawnSync(
      process.execPath,
      [SCRIPT, "--before", beforePath, "--after", changedPath, "--assert-zero"],
      { encoding: "utf8", windowsHide: true }
    );

    assert.equal(equal.status, 0, errorMessage(equal.stderr));
    assert.notEqual(different.status, 0);
    assert.doesNotThrow(() => JSON.parse(readFileSync(beforePath, "utf8")));
  });
});
