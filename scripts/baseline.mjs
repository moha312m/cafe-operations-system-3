// Capture what is already broken, so new breakage stands out.
//
// This milestone lands on a repository that is not perfectly green. The lint
// baseline exits 1 on a known finding; environmental failures come and go
// with the machine. Two bad things happen if that is left implicit: cleaning
// them up inflates the diff with unreviewed changes, and ignoring them means
// "red" stops carrying information — a real regression hides in the noise.
//
// So completion is defined against a recorded baseline rather than against
// zero. A NEW regression is a suite that passed at base and fails at head.
// Nothing else blocks. That rule lives in `newRegressions`, which is pure and
// therefore testable on synthetic reports rather than on whatever the machine
// happened to produce today.
//
//   npm run baseline -- --out docs/superpowers/plans/baseline-<sha>.md
//
// Read-only with respect to the database and the working tree: it runs the
// project's own npm scripts and writes one markdown file.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * @typedef {Object} BaselineReport
 * @property {string} commit
 * @property {string[]} failingSuites
 * @property {boolean} lintClean
 * @property {boolean} buildClean
 * @property {boolean} typecheckClean
 * @property {string} capturedAt
 */

/**
 * Suites that pass in `base` and fail in `head`. Nothing else blocks.
 *
 * A suite absent from `base.failingSuites` counts as having passed there —
 * including a suite that did not exist yet. That is deliberate: treating
 * "absent" as "was already broken" would let a task ship its own red suite
 * and call the failure pre-existing.
 */
export function newRegressions(base, head) {
  const wasFailing = new Set(base.failingSuites ?? []);
  return (head.failingSuites ?? []).filter((s) => !wasFailing.has(s));
}

/** Run a command, capturing output; never throws on a non-zero exit. */
function attempt(command, args) {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

/**
 * Suite files the test runner reported as failing.
 *
 * Read from the `location:` field of each failing TAP entry rather than from
 * the `not ok` line itself. That is not a stylistic choice: the text after
 * `not ok N -` is the *describe* name, not the file, so a run of
 * `tests/ledger-002-single-writer.test.ts` reports `not ok 1 - LEDGER-002
 * single guarded writer` and a filename matcher silently finds nothing —
 * making every capture claim a clean slate. `location:` carries the real
 * path, at every nesting depth.
 *
 * The unit recorded is the file, because that is the unit a task's "affected
 * regression" step re-runs.
 */
export function failingSuitesFrom(tap) {
  const failing = new Set();
  const lines = tap.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*not ok \d+ /.test(lines[i])) continue;
    // The YAML diagnostic block follows immediately; `location:` is within
    // the first few lines of it. Bounded so a malformed block cannot make
    // this attribute a failure to the wrong file.
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const m = /location:\s*'(.+?\.test\.ts):\d+/.exec(lines[j]);
      if (m) {
        failing.add(m[1].replace(/\\\\/g, "/").replace(/\\/g, "/").split("/tests/").pop());
        break;
      }
      if (/^\s*not ok \d+ /.test(lines[j])) break;
    }
  }
  return [...failing].map((f) => `tests/${f}`).sort();
}

/**
 * Run every check and record what failed.
 *
 * `skipBuild` exists because of a real conflict, not squeamishness: the HTTP
 * suites need `next dev` running, and on Windows `next build` cannot replace
 * `query_engine-windows.dll.node` while a `next dev` process has it loaded —
 * `prisma generate` dies with EPERM. A capture that ran both in one pass
 * would record a build failure caused by the test server, which is precisely
 * the kind of false entry a baseline exists to keep out. So: capture with the
 * server up and `--skip-build`, then run `npm run build` with it stopped.
 */
export function capture({ skipBuild = false } = {}) {
  const commit = attempt("git", ["rev-parse", "HEAD"]).out.trim();

  const test = attempt("npm", ["test"]);
  const typecheck = attempt("npm", ["run", "typecheck"]);
  const lint = attempt("npm", ["run", "lint"]);
  const build = skipBuild ? null : attempt("npm", ["run", "build"]);

  return {
    report: {
      commit,
      failingSuites: failingSuitesFrom(test.out),
      lintClean: lint.ok,
      buildClean: build ? build.ok : null,
      typecheckClean: typecheck.ok,
      capturedAt: new Date().toISOString(),
    },
    raw: { test: test.out, lint: lint.out, build: build?.out ?? "", typecheck: typecheck.out },
  };
}

/** Markdown, because the record is read by people during review. */
export function render(report, raw) {
  const suites = report.failingSuites.length
    ? report.failingSuites.map((s) => `- \`${s}\``).join("\n")
    : "_none_";
  const lintSummary =
    /\n\s*✖?\s*\d+ problems?/.exec(raw?.lint ?? "")?.[0]?.trim() ?? "see raw output";

  return `# Baseline — ${report.commit}

Captured ${report.capturedAt}.

A **new regression** is a suite listed nowhere below that fails at head.
Everything recorded here was already broken and does not block completion.

| Check | Result |
| --- | --- |
| \`npm run typecheck\` | ${report.typecheckClean ? "PASS" : "FAIL"} |
| \`npm run build\` | ${report.buildClean === null ? "not run in this pass (see header)" : report.buildClean ? "PASS" : "FAIL"} |
| \`npm run lint\` | ${report.lintClean ? "PASS" : `FAIL — ${lintSummary}`} |

## Failing suites at this commit

${suites}
`;
}

function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : null;

  const { report, raw } = capture({ skipBuild: args.includes("--skip-build") });
  const markdown = render(report, raw);

  if (out) {
    writeFileSync(out, markdown, "utf8");
    console.log(`Baseline written to ${out}`);
  } else {
    console.log(markdown);
  }
}

// Only run when invoked directly, so importing `newRegressions` is free of
// side effects — the whole point of exporting the rule separately.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
