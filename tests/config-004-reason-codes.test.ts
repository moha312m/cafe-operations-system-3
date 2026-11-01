import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, BASE, requireServer } from "./helpers/http";
let fx: CountCafe;
let other: CountCafe;
before(async () => { await requireServer(); fx = await countCafe("REASONS004"); other = await countCafe("REASONS004OTHER"); });
after(async () => { await teardownTaggedCafe([fx.cafeId, other.cafeId]); await db.$disconnect(); });
test("owner creates a stock reason and staff select its label within their cafe", async () => {
 const r = await as<{reason:{id:string;label:string}}>(fx.owner.email, "/api/reason-codes", {method:"POST",body:JSON.stringify({domain:"STOCK",code:"SHORT_TEST",label:"Test shortage"})});
 assert.equal(r.status,201,r.text);
 const list = await as<{reasons:{id:string;label:string}[]}>(fx.cashier.email,"/api/reason-codes?domain=STOCK");
 assert.equal(list.status,200,list.text);assert.ok(list.body.reasons.some(x=>x.id===r.body.reason.id&&x.label==="Test shortage"));
 const foreign = await as<{reasons:{id:string}[]}>(other.owner.email,"/api/reason-codes?domain=STOCK");
 assert.equal(foreign.status,200);assert.ok(!foreign.body.reasons.some(x=>x.id===r.body.reason.id));
});
test("a cashier cannot create the owner's reason vocabulary", async()=>{const r=await as(fx.cashier.email,"/api/reason-codes",{method:"POST",body:JSON.stringify({domain:"STOCK",code:"CASHIER",label:"No"})});assert.equal(r.status,403,r.text);});
test("reason reads require an active session and a valid domain",async()=>{const anon=await fetch(BASE+"/api/reason-codes?domain=STOCK");assert.equal(anon.status,401);const invalid=await as(fx.owner.email,"/api/reason-codes?domain=UNKNOWN");assert.equal(invalid.status,400,invalid.text);});
test("inactive reasons and other domains are excluded from the selection list",async()=>{await db.reasonCode.createMany({data:[{cafeId:fx.cafeId,domain:"STOCK",code:"INACTIVE",label:"Inactive",isActive:false},{cafeId:fx.cafeId,domain:"HANDOVER",code:"HANDOVER",label:"Handover"}]});const r=await as<{reasons:{code:string}[]}>(fx.owner.email,"/api/reason-codes?domain=STOCK");assert.equal(r.status,200);assert.ok(r.body.reasons.every(x=>!['INACTIVE','HANDOVER'].includes(x.code)));});

test("owner can add a labelled reason without a browser-generated code", async () => { const r=await as<{reason:{id:string;code:string}}>(fx.owner.email,"/api/reason-codes",{method:"POST",body:JSON.stringify({domain:"STOCK",label:"LAN shortage"})}); assert.equal(r.status,201,r.text); assert.match(r.body.reason.code,/^OWNER_/); });
