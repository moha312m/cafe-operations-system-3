import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CountEntryQueue } from "../src/components/stock-counts/count-entry-queue";

const line = (id: string, quantity: string | null = null, countedAt: string | null = null) => ({ id, countedQuantity: quantity, countedAt });
function deferred<T>() { let resolve!: (v:T)=>void; let reject!: (e:Error)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }

describe("handover quantity entry queue", () => {
  test("blank remains uncounted while explicitly entered zero saves", async () => {
    const writes: number[] = [];
    const q = new CountEntryQueue(async (_id, value) => { writes.push(value); return { countedAt: "v1", countedQuantity: String(value) }; });
    q.reconcile([line("a")]);
    assert.equal(q.canSubmit(true), false);
    await q.save("a");
    assert.deepEqual(writes, []);
    q.edit("a", "0");
    assert.equal(q.canSubmit(true), false);
    await q.save("a");
    assert.deepEqual(writes, [0]);
    assert.equal(q.get("a")!.value, "0");
    assert.equal(q.get("a")!.status, "saved");
    assert.equal(q.canSubmit(true), true);
  });

  test("saving one row and reconciling search results preserves other drafts", async () => {
    const q = new CountEntryQueue(async (_id, value) => ({ countedAt: "v1", countedQuantity: String(value) }));
    q.reconcile([line("a"), line("b")]);
    q.edit("a", "1.125"); q.edit("b", "7");
    await q.save("a");
    q.reconcile([line("a", "1.125", "v1"), line("b")]);
    assert.equal(q.get("b")!.value, "7");
    assert.equal(q.get("b")!.status, "dirty");
    assert.equal(q.canSubmit(), false);
  });

  test("rapid edits serialize and an older response never replaces the newer input", async () => {
    const first = deferred<{countedAt:string;countedQuantity:string}>();
    const writes: Array<[number,string|null]> = [];
    const q = new CountEntryQueue(async (_id,value,at) => { writes.push([value,at]); return writes.length === 1 ? first.promise : { countedAt: "v2", countedQuantity: String(value) }; });
    q.reconcile([line("a")]); q.edit("a", "2");
    const saving = q.save("a");
    assert.equal(q.get("a")!.status, "saving");
    await Promise.resolve();
    q.edit("a", "3"); void q.save("a");
    first.resolve({countedAt:"v1",countedQuantity:"2"});
    await saving;
    assert.deepEqual(writes, [[2,null],[3,"v1"]]);
    assert.equal(q.get("a")!.value, "3");
    assert.equal(q.get("a")!.status, "saved");
  });

  test("failed saves retain input and replay the same uncertain write before a newer edit", async () => {
    const writes: Array<[number,string|null]> = [];
    let fail = true;
    const q = new CountEntryQueue(async (_id,value,at) => { writes.push([value,at]); if(fail) { fail=false; throw new Error("lost response"); } return { countedAt: value===2?"v1":"v2", countedQuantity:String(value) }; });
    q.reconcile([line("a")]); q.edit("a","2"); await q.save("a");
    assert.equal(q.get("a")!.value,"2"); assert.equal(q.get("a")!.status,"failed"); assert.equal(q.canSubmit(),false);
    q.edit("a","4"); await q.save("a");
    assert.deepEqual(writes,[[2,null],[2,null],[4,"v1"]]);
    assert.equal(q.get("a")!.value,"4"); assert.equal(q.canSubmit(true),true);
  });

  test("duplicate requests do not issue duplicate writes and invalid input blocks submission", async () => {
    const first = deferred<{countedAt:string;countedQuantity:string}>(); let writes=0;
    const q = new CountEntryQueue(async () => { writes++; return first.promise; });
    q.reconcile([line("a")]); q.edit("a","5");
    const saving=q.save("a"); void q.save("a"); void q.save("a");
    first.resolve({countedAt:"v1",countedQuantity:"5"}); await saving;
    assert.equal(writes,1);
    for(const value of ["", "-1", "NaN", "Infinity"]) { q.edit("a",value); await q.save("a"); assert.equal(q.canSubmit(true),false); }
    assert.equal(writes,1);
  });
  test("a delayed refresh cannot replace a newer saved quantity", async () => {
    const q = new CountEntryQueue(async (_id,value) => ({countedAt:"2026-10-28T12:00:01.000Z",countedQuantity:String(value)}));
    q.reconcile([line("a","2","2026-10-28T12:00:00.000Z")]);
    q.edit("a","3"); await q.save("a");
    q.reconcile([line("a","2","2026-10-28T12:00:00.000Z")]);
    assert.equal(q.get("a")!.value,"3");
    assert.equal(q.canSubmit(true),true);
  });

  test("a known stale conflict refreshes evidence for review before retrying retained input", async () => {
    const writes: Array<[number,string|null]> = [];
    let remoteReads=0;
    const q = new CountEntryQueue(async (_id,value,at) => {
      writes.push([value,at]);
      if (at === "v1") throw Object.assign(new Error("stale evidence"),{status:409});
      return {countedAt:"v3",countedQuantity:String(value)};
    }, undefined, async () => { remoteReads++; return {countedAt:"v2",countedQuantity:"8"}; });
    q.reconcile([line("a","1","v1")]);q.edit("a","3");await q.save("a");
    assert.equal(q.get("a")!.status,"failed");
    assert.equal(q.get("a")!.conflict,true);
    q.edit("a","1");assert.equal(q.canSubmit(),false,"typing the stale prior value does not clear a conflict");
    q.edit("a","4");await q.save("a");
    assert.equal(remoteReads,1);
    assert.deepEqual(writes,[[3,"v1"]],"refresh must not silently overwrite the remote count");
    assert.equal(q.get("a")!.value,"4");assert.equal(q.canSubmit(),false);
    await q.save("a");
    assert.deepEqual(writes,[[3,"v1"],[4,"v2"]]);
    assert.equal(q.get("a")!.value,"4");assert.equal(q.canSubmit(true),true);
  });

});
