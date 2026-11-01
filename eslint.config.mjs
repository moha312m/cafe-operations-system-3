import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The override also applies to CommonJS tooling, outside Next's file glob.
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Our data pages fetch on mount via `useEffect(() => { load(); })`
      // where every setState happens AFTER an await — the compiler rule
      // can't see through the async boundary and flags them all.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Immutable historical evidence, preserved byte-identical. Each path is a
    // narrowly bounded archive; everything else under artifacts/ stays linted.
    // - The Stage 1 session's evidence helper, documented in
    //   artifacts/commercial-readiness/2026-10-06-stage1/ as captured evidence:
    "artifacts/commercial-readiness/2026-10-06-stage1/evidence.cjs",
    // - Completed Phase-2 archive (plan.md/implementation.md): one-off edit,
    //   patch and chunked-suite helpers bound to that phase's baselines/logs:
    "artifacts/phase2/**/*.cjs",
    // - Dated baseline-cleanup session archive: one-off manifest/chunk helpers
    //   bound to its own historical suite logs:
    "artifacts/baseline-cleanup-2026-10-06/**/*.cjs",
  ]),
]);

export default eslintConfig;
