import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

// Execute the actual application modules without opening a Prisma connection.
// Controlled boundaries prove application decisions only, never PostgreSQL behavior.
type OfflineExports<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? (...args: unknown[]) => ReturnType<T[K]> : T[K] };
export function loadResaleModule<T = Record<string, unknown>>(relative: string, boundaries: Record<string, unknown> = {}): OfflineExports<T> {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  function load(file: string): Record<string, unknown> {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved)!.exports;
    const sandboxModule = { exports: {} as Record<string, unknown> };
    cache.set(resolved, sandboxModule);
    const requireModule = (id: string) => {
      if (id in boundaries) return boundaries[id];
      if (id === "@/lib/db") throw new Error("Offline test attempted the real database boundary");
      if (id.startsWith("@/")) return load(path.join(process.cwd(), "src", id.slice(2) + ".ts"));
      if (id.startsWith(".")) {
        const sibling = path.resolve(path.dirname(resolved), id);
        if (fs.existsSync(sibling + ".ts")) return load(sibling + ".ts");
      }
      return nativeRequire(id);
    };
    const compiled = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: resolved,
    }).outputText;
    vm.runInNewContext(compiled, { require: requireModule, module: sandboxModule, exports: sandboxModule.exports, Date, Map, Set, Error, Number, console }, { filename: resolved });
    return sandboxModule.exports;
  }
  return load(path.join(process.cwd(), relative)) as OfflineExports<T>;
}
