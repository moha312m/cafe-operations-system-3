import { execFileSync } from "node:child_process";
import {
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLAN_BASE = "d2dc14ddb149727fe38414db23fde244e1c1956f";

export const MIGRATION_CONCEPTS = Object.freeze([
  Object.freeze({ concept: "M12", slug: "custody_holder_and_ledger_attribution" }),
  Object.freeze({ concept: "M13", slug: "shift_custody_gate" }),
  Object.freeze({ concept: "M14", slug: "order_served_attribution" }),
  Object.freeze({ concept: "M15", slug: "handover_branch_configuration" }),
  Object.freeze({ concept: "M16", slug: "inventory_freeze" }),
  Object.freeze({ concept: "M17", slug: "count_unit_cost_snapshot" }),
  Object.freeze({ concept: "M18", slug: "handover_evidence_binding_and_required_items" }),
  Object.freeze({ concept: "M19", slug: "handover_stock_boundary" }),
  Object.freeze({ concept: "M20", slug: "shift_status_awaiting_handover" }),
  Object.freeze({ concept: "M21", slug: "shift_two_stage_close" }),
  Object.freeze({ concept: "M22", slug: "variance_attribution_and_span" }),
]);

const TIMESTAMP_PREFIX = /^(\d{14})(?:_|$)/;

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  return (
    String(value.getUTCFullYear()).padStart(4, "0") +
    twoDigits(value.getUTCMonth() + 1) +
    twoDigits(value.getUTCDate()) +
    twoDigits(value.getUTCHours()) +
    twoDigits(value.getUTCMinutes()) +
    twoDigits(value.getUTCSeconds())
  );
}

function timestampToDate(timestamp) {
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(4, 6));
  const day = Number(timestamp.slice(6, 8));
  const hour = Number(timestamp.slice(8, 10));
  const minute = Number(timestamp.slice(10, 12));
  const second = Number(timestamp.slice(12, 14));
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (formatTimestamp(value) !== timestamp) {
    throw new Error(`Invalid migration timestamp: ${timestamp}`);
  }
  return value;
}

/**
 * Allocate ordered migration names above both the current clock and every
 * migration directory already visible locally or on origin/seif-work.
 */
export function allocateTimestamps({
  existing,
  count,
  now,
  spacingMinutes = 10,
}) {
  if (!Array.isArray(existing)) {
    throw new TypeError("existing must be an array of migration directory names");
  }
  if (!Number.isInteger(count) || count < 1 || count > MIGRATION_CONCEPTS.length) {
    throw new RangeError(`count must be an integer from 1 to ${MIGRATION_CONCEPTS.length}`);
  }
  if (!Number.isInteger(spacingMinutes) || spacingMinutes < 1) {
    throw new RangeError("spacingMinutes must be a positive integer");
  }

  const visibleTimestamps = existing
    .map((name) => TIMESTAMP_PREFIX.exec(name)?.[1] ?? null)
    .filter(Boolean);
  const floor = [formatTimestamp(now), ...visibleTimestamps].sort().at(-1);
  const floorDate = timestampToDate(floor);
  const spacingMs = spacingMinutes * 60_000;
  const names = MIGRATION_CONCEPTS.slice(0, count).map(({ slug }, index) => {
    const timestamp = formatTimestamp(
      new Date(floorDate.getTime() + spacingMs * (index + 1))
    );
    return `${timestamp}_${slug}`;
  });

  return { names, floor };
}

/** Decide whether the two seif-work refs still match the plan's base. */
export function upstreamVerdict({
  planBase,
  localHead,
  originHead,
  newCommits,
}) {
  if (localHead !== planBase) {
    return {
      ok: false,
      reason: "LOCAL_DIVERGED",
      message:
        `local seif-work is ${localHead}, but the plan base is ${planBase}. ` +
        "STOP and review the local divergence before allocating migrations.",
    };
  }

  if (originHead !== planBase) {
    const commits = newCommits.length
      ? `\nNew commits:\n${newCommits.map((commit) => `  ${commit}`).join("\n")}`
      : "\nNew commits could not be enumerated.";
    return {
      ok: false,
      reason: "ORIGIN_MOVED",
      message:
        `origin/seif-work moved from ${planBase} to ${originHead}.` + commits,
    };
  }

  return {
    ok: true,
    reason: "IN_SYNC",
    message: `local seif-work and origin/seif-work match ${planBase}`,
  };
}

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function localMigrationNames(repo) {
  const directory = path.join(repo, "prisma", "migrations");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function originMigrationNames(repo) {
  const output = git(repo, [
    "ls-tree",
    "--name-only",
    "refs/remotes/origin/seif-work:prisma/migrations",
  ]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    throw new Error("migration-preflight accepts no arguments");
  }
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const planBase = PLAN_BASE;
  const output = path.join(repo, ".migration-allocation.json");
  const temporaryOutput = path.join(
    repo,
    `.migration-allocation.json.tmp-${process.pid}`
  );
  const now = new Date();

  rmSync(output, { force: true });
  rmSync(temporaryOutput, { force: true });
  git(repo, [
    "fetch",
    "--prune",
    "origin",
    "+refs/heads/seif-work:refs/remotes/origin/seif-work",
  ]);
  const localHead = git(repo, ["rev-parse", "refs/heads/seif-work"]);
  const originHead = git(repo, [
    "rev-parse",
    "refs/remotes/origin/seif-work",
  ]);
  const newCommitOutput = git(repo, [
    "log",
    "--oneline",
    `${planBase}..${originHead}`,
  ]);
  const verdict = upstreamVerdict({
    planBase,
    localHead,
    originHead,
    newCommits: newCommitOutput
      ? newCommitOutput.split(/\r?\n/).filter(Boolean)
      : [],
  });

  if (!verdict.ok) {
    const error = new Error(`${verdict.reason}: ${verdict.message}`);
    error.code = verdict.reason;
    throw error;
  }

  const existing = [...new Set([
    ...originMigrationNames(repo),
    ...localMigrationNames(repo),
  ])].sort();
  const { names, floor } = allocateTimestamps({
    existing,
    count: MIGRATION_CONCEPTS.length,
    now,
  });
  const allocations = MIGRATION_CONCEPTS.map(({ concept, slug }, index) => ({
    concept,
    slug,
    timestamp: names[index].slice(0, 14),
    name: names[index],
  }));
  const document = {
    version: 1,
    planBase,
    localHead,
    originHead,
    generatedAt: now.toISOString(),
    spacingMinutes: 10,
    floor,
    names,
    allocations,
  };

  writeFileSync(
    temporaryOutput,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8"
  );
  renameSync(temporaryOutput, output);
  console.log(`IN_SYNC: ${verdict.message}`);
  for (const allocation of allocations) {
    console.log(`${allocation.concept} ${allocation.name}`);
  }
  console.log(`Wrote ${path.relative(repo, output) || path.basename(output)}`);
  return document;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
