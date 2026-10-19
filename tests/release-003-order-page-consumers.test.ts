import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPages } from "@/lib/order-pages-client";

test("live queue returns orders beyond the first page",async()=>{
  const result=await collectOrderPages(async cursor=>cursor
    ? {orders:[{id:"old"}],pageInfo:{hasMore:false,nextCursor:null}}
    : {orders:[{id:"new"}],pageInfo:{hasMore:true,nextCursor:"next"}});
  assert.deepEqual(result.orders.map(o=>o.id),["new","old"]);
  assert.equal(result.pageInfo.hasMore,false);
});
test("history deliberately stops at its visible page budget with continuation",async()=>{
  const result=await collectOrderPages(async()=>({orders:[{id:"one"}],pageInfo:{hasMore:true,nextCursor:"next"}}),1,true);
  assert.deepEqual(result.orders,[{id:"one"}]);assert.equal(result.pageInfo.nextCursor,"next");
});
test("live queue refuses truncation and malformed or repeating continuations",async()=>{
  await assert.rejects(collectOrderPages(async()=>({orders:[{id:"one"}],pageInfo:{hasMore:true,nextCursor:"next"}}),1),/limit/i);
  await assert.rejects(collectOrderPages(async()=>({orders:[{id:"one"}],pageInfo:{hasMore:true,nextCursor:null}})),/pagination/i);
  await assert.rejects(collectOrderPages(async()=>({orders:[{id:"one"}],pageInfo:{hasMore:true,nextCursor:"same"}})),/pagination/i);
});
test("failed later page never returns a partial queue as success",async()=>{
  await assert.rejects(collectOrderPages(async cursor=>{
    if(cursor) throw Error("backend unavailable");
    return {orders:[{id:"one"}],pageInfo:{hasMore:true,nextCursor:"next"}};
  }),/backend unavailable/);
});
