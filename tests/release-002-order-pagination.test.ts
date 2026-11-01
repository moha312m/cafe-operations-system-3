// Removing pageInfo/keyset predicates must lose rows or repeat timestamp ties.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
let fx: CountCafe;
const stamp=new Date("2026-10-01T12:00:00Z");
type Page={orders:{id:string,branchId:string,source:string}[],pageInfo:{hasMore:boolean,nextCursor:string|null}};
before(async()=>{
  await requireServer(); fx=await countCafe("REL002");
  await db.order.createMany({data:Array.from({length:137},(_,i)=>({
    id:`${fx.marker}-${String(i).padStart(3,"0")}`,cafeId:fx.cafeId,branchId:fx.branchId,orderNumber:i+1,
    type:"TAKEAWAY" as const,status:"CONFIRMED" as const,source:"WAITER" as const,createdById:fx.waiter.id,
    subtotal:90,total:90,createdAt:stamp}))});
  await db.order.create({data:{cafeId:fx.cafeId,branchId:fx.otherBranchId,orderNumber:1,type:"TAKEAWAY",status:"READY",source:"QR_MENU",subtotal:90,total:90,createdAt:stamp}});
  await db.order.createMany({data:Array.from({length:137},(_,i)=>({
    id:`${fx.marker}-QR-${String(i).padStart(3,"0")}`,cafeId:fx.cafeId,branchId:fx.branchId,orderNumber:200+i,
    type:"TAKEAWAY" as const,status:"PENDING_WAITER_APPROVAL" as const,source:"QR_MENU" as const,
    approvalStatus:"PENDING_APPROVAL" as const,subtotal:90,total:90,createdAt:stamp}))});
});
after(()=>teardownTaggedCafe(fx?[fx.cafeId]:[],[],{disconnect:true}));
async function page(query="",email=fx.manager.email) { return as<Page>(email,"/api/orders?"+query); }
test("fixed dataset traversal returns all 137 tied orders exactly once with bounded responses",async()=>{
  const seen:string[]=[];let cursor:string|null=null;
  do {
    const r=await page("pageSize=23"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
    assert.equal(r.status,200);
    assert.ok(r.body.pageInfo,"truncation must be explicit");
    assert.ok(r.body.orders.length<=23);
    seen.push(...r.body.orders.map(o=>o.id));
    cursor=r.body.pageInfo.nextCursor;
    assert.equal(r.body.pageInfo.hasMore,!!cursor);
  } while(cursor);
  assert.equal(seen.length,137);assert.equal(new Set(seen).size,137);
  assert.deepEqual(seen,[...seen].sort().reverse());
});
test("default page exposes continuation and invalid sizes/cursors return 400",async()=>{
  const first=await page();assert.equal(first.body.orders.length,100);assert.equal(first.body.pageInfo?.hasMore,true);
  for(const query of ["pageSize=0","pageSize=101","pageSize=1.5","pageSize=abc","cursor=garbage","from=invalid","from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z"]) {
    assert.equal((await page(query)).status,400,query);
  }
});
test("cursor is filter and scope bound; branch status source actor and date filters remain effective",async()=>{
  const first=await page("pageSize=10&source=WAITER");
  const cursor=encodeURIComponent(first.body.pageInfo.nextCursor!);
  assert.equal((await page("pageSize=10&source=QR_MENU&cursor="+cursor)).status,400);
  assert.equal((await page("pageSize=10&source=WAITER&branchId="+fx.otherBranchId+"&cursor="+cursor,fx.owner.email)).status,400);
  const r=await page(`branchId=${fx.otherBranchId}&status=READY&source=QR_MENU&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`,fx.owner.email);
  assert.equal(r.status,200);assert.equal(r.body.orders.length,1);assert.equal(r.body.orders[0].branchId,fx.otherBranchId);
  assert.equal((await page("createdById="+fx.owner.id)).body.orders.length,0);
  assert.equal((await page("from=2026-10-02T00:00:00Z")).body.orders.length,0);
});
test("newer concurrent insertion does not move the continuing traversal and appears on refresh",async()=>{
  const first=await page("pageSize=100");
  const inserted=await db.order.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,orderNumber:999,
    type:"TAKEAWAY",status:"CONFIRMED",source:"WAITER",subtotal:90,total:90,createdAt:new Date("2026-10-02T12:00:00Z")}});
  const second=await page("pageSize=100&cursor="+encodeURIComponent(first.body.pageInfo.nextCursor!));
  assert.equal(second.body.orders.length,37);assert.equal(second.body.pageInfo.hasMore,false);
  const ids=[...first.body.orders,...second.body.orders].map(o=>o.id);
  assert.equal(new Set(ids).size,137);assert.ok(!ids.includes(inserted.id));
  assert.equal((await page("pageSize=1")).body.orders[0].id,inserted.id);
});
test("QR approval queue exposes its full count and every row through bounded pages",async()=>{
  const first=await as<Page & {count:number}>(fx.manager.email,"/api/qr-orders/pending?pageSize=100");
  assert.equal(first.status,200);assert.equal(first.body.count,137);
  assert.equal(first.body.orders.length,100);assert.equal(first.body.pageInfo.hasMore,true);
  const second=await as<Page & {count:number}>(fx.manager.email,"/api/qr-orders/pending?pageSize=100&cursor="+encodeURIComponent(first.body.pageInfo.nextCursor!));
  assert.equal(second.body.orders.length,37);assert.equal(second.body.pageInfo.hasMore,false);
  assert.equal(new Set([...first.body.orders,...second.body.orders].map(o=>o.id)).size,137);
});
