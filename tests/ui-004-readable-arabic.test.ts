import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("Arabic UI and API copy contains no misdecoded UTF-8 text", () => {
  const corrupted = sourceFiles(root)
    .filter((path) => /[ØÙÃ]|â€|Â[·«»]/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path));
  assert.deepEqual(corrupted, []);
});
