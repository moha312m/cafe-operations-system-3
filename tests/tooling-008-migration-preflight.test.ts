import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateTimestamps,
  upstreamVerdict,
} from "../scripts/migration-preflight.mjs";

const PLAN_BASE = "d2dc14ddb149727fe38414db23fde244e1c1956f";
const NOW = new Date("2026-08-30T10:00:00.000Z");
const SCRIPT = fileURLToPath(
  new URL("../scripts/migration-preflight.mjs", import.meta.url)
);
const SOURCE_REPO = fileURLToPath(new URL("..", import.meta.url));

const CONCEPTS = [
  ["M12", "custody_holder_and_ledger_attribution"],
  ["M13", "shift_custody_gate"],
  ["M14", "order_served_attribution"],
  ["M15", "handover_branch_configuration"],
  ["M16", "inventory_freeze"],
  ["M17", "count_unit_cost_snapshot"],
  ["M18", "handover_evidence_binding_and_required_items"],
  ["M19", "handover_stock_boundary"],
  ["M20", "shift_status_awaiting_handover"],
  ["M21", "shift_two_stage_close"],
  ["M22", "variance_attribution_and_span"],
] as const;

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout.trim();
}

function createGitFixture(): {
  root: string;
  repo: string;
  origin: string;
  base: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "migration-preflight-"));
  temporaryRoots.push(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");

  git(root, "clone", "--bare", SOURCE_REPO, origin);
  git(origin, "update-ref", "refs/heads/seif-work", PLAN_BASE);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/seif-work");
  git(root, "clone", "--branch", "seif-work", origin, repo);
  git(repo, "config", "user.name", "Migration Preflight Test");
  git(repo, "config", "user.email", "migration-preflight@example.test");
  copyFileSync(path.join(SOURCE_REPO, ".gitignore"), path.join(repo, ".gitignore"));
  const base = git(repo, "rev-parse", "HEAD");
  assert.equal(base, PLAN_BASE, "the fixture must preserve the real R4 plan base");

  return { root, repo, origin, base };
}

function runCli(repo: string, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, ...extraArgs],
    { cwd: repo, encoding: "utf8", windowsHide: true }
  );
}

function readAllocation(output: string): {
  floor: string;
  generatedAt: string;
  names: string[];
  allocations: { concept: string; slug: string; name: string }[];
} {
  return JSON.parse(readFileSync(output, "utf8"));
}

describe("TOOLING-008 migration timestamp allocation", () => {
  test("an empty existing list uses now as the allocation floor", () => {
    const result = allocateTimestamps({ existing: [], count: 1, now: NOW });

    assert.equal(result.floor, "20260830100000");
    assert.deepEqual(result.names, [
      "20260830101000_custody_holder_and_ledger_attribution",
    ]);
  });

  test("a migration floor later than now wins", () => {
    const result = allocateTimestamps({
      existing: ["20990101000000_far_future"],
      count: 1,
      now: NOW,
    });

    assert.equal(result.floor, "20990101000000");
  });

  test("the first allocation is strictly greater than the floor", () => {
    const result = allocateTimestamps({
      existing: ["20990101000000_far_future"],
      count: 1,
      now: NOW,
    });

    assert.ok(result.names[0].slice(0, 14) > result.floor);
    assert.equal(
      result.names[0],
      "20990101001000_custody_holder_and_ledger_attribution"
    );
  });

  test("generated timestamps strictly ascend", () => {
    const { names } = allocateTimestamps({
      existing: [],
      count: 3,
      now: NOW,
    });
    const stamps = names.map((name) => name.slice(0, 14));

    assert.deepEqual(stamps, [
      "20260830101000",
      "20260830102000",
      "20260830103000",
    ]);
  });

  test("spacingMinutes is respected", () => {
    const { names } = allocateTimestamps({
      existing: [],
      count: 3,
      now: NOW,
      spacingMinutes: 3,
    });

    assert.deepEqual(
      names.map((name) => name.slice(0, 14)),
      ["20260830100300", "20260830100600", "20260830100900"]
    );
  });

  test("count 11 yields exactly the eleven M12 through M22 allocations", () => {
    const { names } = allocateTimestamps({
      existing: [],
      count: 11,
      now: NOW,
    });

    assert.equal(names.length, 11);
    assert.match(names[0], /_custody_holder_and_ledger_attribution$/);
    assert.match(names[10], /_variance_attribution_and_span$/);
  });

  test("a far-future existing migration cannot collide", () => {
    const existing = [
      "20990101000000_custody_holder_and_ledger_attribution",
      "20260830090000_shift_closed_by",
    ];
    const { names } = allocateTimestamps({
      existing,
      count: 11,
      now: NOW,
    });

    assert.equal(names.some((name) => existing.includes(name)), false);
    assert.equal(new Set(names).size, 11);
    assert.ok(names.every((name) => name.slice(0, 14) > "20990101000000"));
  });
});

describe("TOOLING-008 upstream verdict", () => {
  test("originHead equal to planBase is IN_SYNC", () => {
    assert.deepEqual(
      upstreamVerdict({
        planBase: PLAN_BASE,
        localHead: PLAN_BASE,
        originHead: PLAN_BASE,
        newCommits: [],
      }),
      {
        ok: true,
        reason: "IN_SYNC",
        message: `local seif-work and origin/seif-work match ${PLAN_BASE}`,
      }
    );
  });

  test("origin movement returns ORIGIN_MOVED and names the new commits", () => {
    const result = upstreamVerdict({
      planBase: PLAN_BASE,
      localHead: PLAN_BASE,
      originHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      newCommits: ["aaaaaaa feat: concurrent migration", "bbbbbbb fix: follow-up"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "ORIGIN_MOVED");
    assert.match(result.message, /aaaaaaa feat: concurrent migration/);
    assert.match(result.message, /bbbbbbb fix: follow-up/);
  });

  test("local divergence returns LOCAL_DIVERGED", () => {
    const result = upstreamVerdict({
      planBase: PLAN_BASE,
      localHead: "cccccccccccccccccccccccccccccccccccccccc",
      originHead: PLAN_BASE,
      newCommits: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "LOCAL_DIVERGED");
    assert.match(result.message, /local seif-work/i);
  });
});

describe("TOOLING-008 command-line preflight", () => {
  test("the CLI writes .migration-allocation.json", () => {
    const fixture = createGitFixture();
    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);

    assert.equal(result.status, 0, result.stderr);
    const allocation = readAllocation(output);
    assert.equal(allocation.allocations.length, 11);
  });

  test("the CLI resolves the repository root from a nested working directory", () => {
    const fixture = createGitFixture();
    const nested = path.join(fixture.repo, "scripts");
    const result = runCli(nested);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(path.join(fixture.repo, ".migration-allocation.json")),
      true
    );
    assert.equal(existsSync(path.join(nested, ".migration-allocation.json")), false);
  });

  test("CLI names match the pure allocator and hand-derived timestamps", () => {
    const fixture = createGitFixture();
    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);
    assert.equal(result.status, 0, result.stderr);

    const allocation = readAllocation(output);
    const pure = allocateTimestamps({
      existing: readdirSync(path.join(fixture.repo, "prisma", "migrations")),
      count: 11,
      now: new Date(allocation.generatedAt),
    });
    assert.deepEqual(allocation.names, pure.names);
    assert.match(allocation.names[0], /_custody_holder_and_ledger_attribution$/);
    assert.match(allocation.names[10], /_variance_attribution_and_span$/);
  });

  test("CLI concept slugs correspond exactly to R4 M12 through M22", () => {
    const fixture = createGitFixture();
    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);
    assert.equal(result.status, 0, result.stderr);

    const allocation = readAllocation(output);
    assert.deepEqual(
      allocation.allocations.map(({ concept, slug }) => [concept, slug]),
      CONCEPTS
    );
  });

  test("origin movement exits non-zero without creating an allocation", () => {
    const fixture = createGitFixture();
    const writer = path.join(fixture.root, "writer");
    git(fixture.root, "clone", fixture.origin, writer);
    git(writer, "config", "user.name", "Concurrent Developer");
    git(writer, "config", "user.email", "concurrent@example.test");
    writeFileSync(path.join(writer, "origin-moved.txt"), "new upstream commit\n");
    git(writer, "add", "origin-moved.txt");
    git(writer, "commit", "-m", "feat: concurrent upstream work");
    const movedCommit = git(writer, "rev-parse", "--short", "HEAD");
    git(writer, "push", "origin", "seif-work");

    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);

    assert.notEqual(result.status, 0);
    const message = `${result.stdout}\n${result.stderr}`;
    assert.match(message, /ORIGIN_MOVED/);
    assert.match(message, new RegExp(movedCommit));
    assert.match(message, /feat: concurrent upstream work/);
    assert.throws(() => readFileSync(output, "utf8"), /ENOENT/);
  });

  test("local seif-work divergence exits non-zero without an allocation", () => {
    const fixture = createGitFixture();
    writeFileSync(path.join(fixture.repo, "local-divergence.txt"), "local\n");
    git(fixture.repo, "add", "local-divergence.txt");
    git(fixture.repo, "commit", "-m", "test: local divergence");

    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /LOCAL_DIVERGED/);
    assert.equal(existsSync(output), false);
  });

  test("an untracked local future migration controls the allocation floor", () => {
    const fixture = createGitFixture();
    const future = path.join(
      fixture.repo,
      "prisma",
      "migrations",
      "20990101000000_parallel_work"
    );
    mkdirSync(future);
    writeFileSync(path.join(future, "migration.sql"), "-- parallel work\n");

    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);
    assert.equal(result.status, 0, result.stderr);

    const allocation = readAllocation(output);
    assert.equal(allocation.floor, "20990101000000");
    assert.ok(allocation.names[0].startsWith("20990101001000_"));
  });

  test("the CLI creates no migration directory and its allocation is ignored", () => {
    const fixture = createGitFixture();
    const migrations = path.join(fixture.repo, "prisma", "migrations");
    const before = readdirSync(migrations).sort();

    const result = runCli(fixture.repo);
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(readdirSync(migrations).sort(), before);
    git(fixture.repo, "check-ignore", ".migration-allocation.json");
  });

  test("CLI arguments cannot redirect or overwrite the fixed allocation output", () => {
    const fixture = createGitFixture();
    const protectedFile = path.join(fixture.root, "important.json");
    writeFileSync(protectedFile, "preserve me\n");

    const result = runCli(fixture.repo, ["--output", protectedFile]);

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(protectedFile, "utf8"), "preserve me\n");
    assert.equal(
      existsSync(path.join(fixture.repo, ".migration-allocation.json")),
      false
    );
  });

  test("CLI arguments cannot override the fixed plan base or real clock", () => {
    const fixture = createGitFixture();

    const baseOverride = runCli(fixture.repo, ["--plan-base", fixture.base]);
    const clockOverride = runCli(fixture.repo, ["--now", NOW.toISOString()]);

    assert.notEqual(baseOverride.status, 0);
    assert.notEqual(clockOverride.status, 0);
    assert.equal(
      existsSync(path.join(fixture.repo, ".migration-allocation.json")),
      false
    );
  });

  test("deleting origin seif-work cannot be accepted through a stale tracking ref", () => {
    const fixture = createGitFixture();
    git(fixture.origin, "update-ref", "-d", "refs/heads/seif-work");

    const output = path.join(fixture.repo, ".migration-allocation.json");
    const result = runCli(fixture.repo);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
  });
});
