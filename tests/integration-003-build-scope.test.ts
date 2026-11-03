import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import nextConfig from "../next.config";

test("integration production build typechecks all native code without consuming archived source copies", () => {
  assert.equal(process.env.NEXTCUP_INTEGRATION_VERIFY, "1", "explicit task build mode required");
  assert.notEqual(nextConfig.typescript?.ignoreBuildErrors, true, "build typechecking must stay enabled");
  const configPath = path.resolve(nextConfig.typescript?.tsconfigPath ?? "tsconfig.json");
  const json = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(json.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(json.config, ts.sys, path.dirname(configPath));
  assert.equal(parsed.errors.length, 0);
  const files = parsed.fileNames.map(f => path.resolve(f).replaceAll("\\", "/"));
  const sourceRoot = path.resolve("src").replaceAll("\\", "/") + "/";
  const nativeRoots = ["src", "tests", "scripts", "prisma"];
  for (const root of nativeRoots) {
    const native = ts.sys.readDirectory(path.resolve(root), [".ts", ".tsx", ".mts"], ["**/node_modules/**"], ["**/*"]);
    for (const file of native) assert.ok(files.includes(path.resolve(file).replaceAll("\\", "/")), `Native file excluded: ${file}`);
  }
  assert.ok(files.some(f => f.startsWith(sourceRoot)), "application sources must be included");
  const artifactRoot = path.resolve("artifacts").replaceAll("\\", "/") + "/";
  assert.deepEqual(files.filter(f => f.startsWith(artifactRoot)), [], "historical evidence copies must not become application build inputs");
  assert.equal(nextConfig.distDir, ".next-integration", "owned verification output must stay separate");
});
