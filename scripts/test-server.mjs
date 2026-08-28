// The Next.js server automated tests drive.
//
// Separate from `npm run dev` on purpose. The developer's server on :3000
// stays pointed at their own database and keeps working while tests run; this
// one exists solely to serve the disposable test database on :3100.
//
// Both halves of the environment must agree, and `npm test` proves they do by
// writing a row here and asking this server to read it back. Launching the
// server with the right URL is necessary but not sufficient — the proof is
// what makes it trustworthy.

import { spawn } from "node:child_process";
import {
  TEST_DATABASE_URL,
  TEST_SERVER_PORT,
  clusterRunning,
} from "./test-db.mjs";

if (!clusterRunning()) {
  console.error(
    "\nThe disposable test database is not running.\n" +
      "  npm run testdb:up\n"
  );
  process.exit(1);
}

console.log(
  `Starting TEST app server on port ${TEST_SERVER_PORT}\n` +
    `  DATABASE_URL = ${TEST_DATABASE_URL}\n` +
    `  (your dev server on :3000 and database on :5433 are untouched)\n`
);

const child = spawn("npx", ["next", "dev", "--port", String(TEST_SERVER_PORT)], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    // Explicit, and NOT inherited from .env: this is the whole point.
    DATABASE_URL: TEST_DATABASE_URL,
    PORT: String(TEST_SERVER_PORT),
  },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
