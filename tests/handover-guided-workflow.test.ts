import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

test("guided handover resumes the server's first incomplete stage without inventing counts", async () => {
  const flow = await import("../src/components/handovers/workflow-state").catch(() => null);
  assert.ok(flow, "guided workflow state is missing");
  assert.equal(flow.handoverStep("DRAFT", null), "count");
  assert.equal(flow.handoverStep("DRAFT", "IN_PROGRESS"), "count");
  assert.equal(flow.handoverStep("DRAFT", "SUBMITTED"), "review");
  assert.equal(flow.handoverStep("DRAFT", "RECOUNT_REQUIRED"), "review");
  assert.equal(flow.handoverStep("DRAFT", "CONFIRMED"), "submit");
  assert.equal(flow.handoverStep("OUTGOING_SUBMITTED", "CONFIRMED"), "receive");
  assert.equal(flow.handoverStep("INCOMING_REVIEW", "CONFIRMED"), "receive");
  assert.equal(flow.handoverStep("REJECTED", "DRAFT"), "count");
  assert.equal(flow.handoverStep("REJECTED", "CONFIRMED"), "count");
  assert.equal(flow.handoverStep("COMPLETED", "LOCKED"), "complete");
  assert.equal(flow.handoverStep("UNKNOWN", null), "unknown");
});

test("an explicit handover variance reason is reachable without rewriting counts or dispositions", () => {
  assert.ok(existsSync("src/app/api/stock-counts/[id]/lines/[lineId]/variance-reason/route.ts"), "missing audited reason-only operation");
});

test("count detail carries the context required by the guided reason action", () => {
  const source=readFileSync("src/lib/stock-count.ts","utf8");
  const detail=source.split("const COUNT_SESSION_DETAIL = {")[1].split("} satisfies")[0];
  assert.match(detail,/accountabilityContext: true/,"reason action cannot be reached without detail context");
});

test("pending selection refuses ambiguity and never chooses another branch", async () => {
  const flow = await import("../src/components/handovers/workflow-state").catch(() => null);
  assert.ok(flow);
  const rows = [{id:"a",branchId:"A",status:"DRAFT"},{id:"b",branchId:"B",status:"DRAFT"}];
  assert.equal(flow.pendingHandover(rows, "A")?.id, "a");
  assert.equal(flow.pendingHandover([...rows,{id:"c",branchId:"A",status:"INCOMING_REVIEW"}], "A"), null);
  assert.equal(flow.pendingHandover([{id:"x",branchId:"A",status:"COMPLETED"}], "A"), null);
});
