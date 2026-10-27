import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// This runs the actual helper against an isolated SQL boundary. It opens no DB.
function harness(failDelete = false, failRestore = false) {
  const initial = { order: "O", revision: "R", report: "A", disabled: "D" };
  let states = { ...initial };
  let rows = new Set(["Parent", "Child", "Cafe"]);
  const statements: string[] = [];
  let inTransaction = false, aborted = false, savepoint = false;
  const execute = async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("SAVEPOINT")) { savepoint = true; return 0; }
    if (sql.startsWith("ROLLBACK TO SAVEPOINT")) { aborted = false; return 0; }
    if (aborted) throw new Error("current transaction is aborted");
    if (sql.startsWith("RELEASE SAVEPOINT")) { savepoint = false; return 0; }
    if (sql.startsWith("ALTER TABLE")) {
      assert.equal(inTransaction, true, "trigger changes must be inside the purge transaction");
      assert.match(sql, /^ALTER TABLE "public"\./, "only the discovered schema is altered");
      const name = sql.match(/TRIGGER "([^"]+)"$/)![1] as keyof typeof states;
      if (failRestore && !sql.includes("DISABLE")) throw new Error("simulated trigger restore failure");
      states[name] = sql.includes("DISABLE") ? "D" : sql.includes("REPLICA") ? "R" : sql.includes("ALWAYS") ? "A" : "O";
      return 0;
    }
    if (sql.startsWith("DELETE")) {
      assert.equal(inTransaction, true, "all deletes belong to the purge transaction");
      const table = sql.match(/(?:"public"\.)?"(Parent|Child|Cafe)"/)![1];
      if ((failDelete && table === "Parent") || (table === "Parent" && rows.has("Child")) || (table === "Cafe" && rows.size > 1)) {
        aborted = true;
        assert.equal(savepoint, true, "each retryable delete needs a savepoint");
        throw new Error(failDelete ? "simulated persistent delete failure" : "foreign key constraint");
      }
      rows.delete(table);
    }
    return 0;
  };
  const query = async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (sql.includes("SELECT current_schema()")) return [{ schema: "public" }];
    if (sql.includes("information_schema.columns")) return [{ table_name: "Parent" }, { table_name: "Child" }];
    if (sql.includes("pg_trigger")) {
      statements.push(sql);

      return Object.entries(initial).filter(([, enabled]) => enabled !== "D").map(([tg, enabled]) => ({ schema: "public", tbl: "Parent", tg, enabled }));
    }
    return [];
  };
  const client = {
    cafe: { findUnique: async () => ({ id: "fixture", name: "fixture", slug: "ph1-fixture" }), count: async () => rows.has("Cafe") ? 1 : 0 },
    $queryRaw: query, $executeRawUnsafe: execute,
    $transaction: async (body: (tx: unknown) => unknown) => {
      const beforeStates = { ...states }, beforeRows = new Set(rows);
      inTransaction = true;
      try { return await body(client); }
      catch (error) { states = beforeStates; rows = beforeRows; throw error; }
      finally { inTransaction = false; }
    },
  };
  let markerChecks = 0;
  const sandboxModule = { exports: {} as { purgeCafe: (id: string) => Promise<void> } };
  const source = ts.transpileModule(fs.readFileSync("tests/helpers/db.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, {
    module: sandboxModule, exports: sandboxModule.exports, process: { env: { NODE_TEST_CONTEXT: "test", NODE_ENV: "test" } }, console,
    require: (name: string) => {
      if (name === "@prisma/client") return { PrismaClient: function () { return client; } };
      if (name === "../../scripts/test-db.mjs") return { assertTestDatabaseUrl: () => {}, assertTestDatabaseMarker: async () => { markerChecks++; } };
      throw new Error("Unexpected real boundary: " + name);
    },
  });
  return { purge: () => sandboxModule.exports.purgeCafe("fixture"), state: () => ({ ...states }), rows: () => [...rows], initial, statements, markerChecks: () => markerChecks };
}

test("offline purge retries FK deletes inside one transaction and preserves trigger modes", async () => {
  const h = harness();
  await h.purge();
  assert.deepEqual(h.state(), h.initial);
  assert.deepEqual(h.rows(), []);
  assert.equal(h.markerChecks(), 1);
  assert.ok(h.statements.some(sql => /n\.nspname\s*=\s*current_schema\(\)/.test(sql) && /t\.tgenabled/.test(sql)), "trigger discovery is schema scoped and captures original modes");
  assert.ok(h.statements.some(sql => sql.startsWith("ROLLBACK TO SAVEPOINT")), "FK retry recovers the transaction");
});

test("offline purge failure rolls back trigger changes and deleted rows", async () => {
  const h = harness(true);
  await assert.rejects(h.purge());
  assert.ok(h.statements.some(sql => sql.startsWith("DELETE")), "the injected failure was reached");
  assert.deepEqual(h.state(), h.initial);
  assert.deepEqual(h.rows(), ["Parent", "Child", "Cafe"]);
});

test("offline purge restore failure rolls back all deletes and trigger modes", async () => {
  const h = harness(false, true);
  await assert.rejects(h.purge(), /simulated trigger restore failure/);
  assert.ok(h.statements.some(sql => sql.startsWith("DELETE")), "restoration follows successful deletes");
  assert.deepEqual(h.state(), h.initial);
  assert.deepEqual(h.rows(), ["Parent", "Child", "Cafe"]);
});