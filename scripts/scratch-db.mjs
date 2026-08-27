// A `prisma migrate reset` that cannot point at anything real.
//
// Verifying a migration end-to-end means resetting a database: drop it,
// replay every migration from the beginning, seed it, and see whether the
// result is the schema the migration claimed. That is a genuinely useful
// thing to do and a genuinely dangerous command to have lying around, since
// the only database this repository configures is the live local one.
//
// The danger is not carelessness, it is proximity: `npx prisma migrate
// reset` reads DATABASE_URL, and DATABASE_URL is the café. So this script
// never lets that value reach Prisma. It requires a separate, differently
// named database, and overrides DATABASE_URL for the CHILD process only —
// the parent's environment is left exactly as it was, so nothing that runs
// afterwards inherits a redirected database.
//
// The guard is exported so it can be tested without ever executing a reset.
//
//   SCRATCH_DATABASE_URL=postgresql://…/cafe_ops_scratch \
//     npm run db:scratch -- --i-understand-this-erases

import { spawnSync } from "node:child_process";

export const ERASE_FLAG = "--i-understand-this-erases";

/**
 * The database name from a Postgres connection URL.
 *
 * Parsed rather than pattern-matched because a connection string carries
 * query parameters (`?schema=public`) that a naive `endsWith` on the whole
 * URL would trip over — and a guard that fails open on a URL shape it did
 * not expect is worse than no guard.
 */
function databaseName(url) {
  try {
    // The postgres:// scheme is not special-cased by WHATWG URL, so the
    // pathname is available the same way it is for http.
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}

/**
 * Throw unless every one of the four conditions holds:
 *
 *   1. SCRATCH_DATABASE_URL is set
 *   2. its database name ends with "_scratch"
 *   3. it differs from DATABASE_URL
 *   4. the explicit erase flag was passed
 *
 * Conditions 1–3 are properties of the environment; condition 4 is the only
 * one that requires a person to have decided, at the moment of running, that
 * erasure is what they meant.
 */
export function assertScratchUrl(scratch, primary, flags) {
  if (!scratch) {
    throw new Error(
      "SCRATCH_DATABASE_URL is not set. This script will not fall back to " +
        "DATABASE_URL — point it at a throwaway database whose name ends in " +
        "`_scratch` and try again."
    );
  }

  const name = databaseName(scratch);
  if (!name) {
    throw new Error(
      `SCRATCH_DATABASE_URL is not a parseable connection URL: ${scratch}`
    );
  }
  if (!name.endsWith("_scratch")) {
    throw new Error(
      `Refusing to reset "${name}": a scratch database must be named with a ` +
        "`_scratch` suffix. That suffix is the whole safety margin — it is " +
        "what makes an accidental copy of the live URL impossible to mistake " +
        "for a throwaway one."
    );
  }

  if (primary && scratch === primary) {
    throw new Error(
      `Refusing to reset "${name}": SCRATCH_DATABASE_URL is identical to ` +
        "DATABASE_URL. The scratch target must be a different database, not " +
        "the configured primary under another name."
    );
  }

  if (!flags.includes(ERASE_FLAG)) {
    throw new Error(
      `Refusing to reset "${name}": pass ${ERASE_FLAG} to confirm. Every ` +
        "table in that database will be dropped."
    );
  }
}

/** `npx <args>` against the scratch database, inheriting stdio. */
function run(args, scratch) {
  const r = spawnSync("npx", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    // The override is scoped to this child. The parent process — and
    // anything the operator runs next — keeps the real DATABASE_URL.
    env: { ...process.env, DATABASE_URL: scratch },
  });
  if (r.status !== 0) {
    throw new Error(`\`npx ${args.join(" ")}\` exited with ${r.status}`);
  }
}

function main() {
  const scratch = process.env.SCRATCH_DATABASE_URL;
  assertScratchUrl(scratch, process.env.DATABASE_URL, process.argv.slice(2));

  console.log(`Resetting scratch database "${databaseName(scratch)}"…`);
  run(["prisma", "migrate", "reset", "--force", "--skip-seed"], scratch);
  run(["prisma", "migrate", "deploy"], scratch);
  // `prisma db seed` is not usable here: it requires a `prisma.seed` entry in
  // package.json, and this repository has none — it seeds through its own
  // `db:seed` script. Calling the seed file directly keeps the scratch
  // rebuild identical to what a developer runs by hand.
  run(["tsx", "prisma/seed.ts"], scratch);
  console.log("Scratch database rebuilt from migrations.");
}

// Only run when invoked directly, so importing the guard is side-effect free.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
