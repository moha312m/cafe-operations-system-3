import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {PrismaClient}from'@prisma/client';
const file=path.resolve('artifacts/workspace-redesign-20261102/private-step1-config.json'),c=JSON.parse(fs.readFileSync(file,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=file;process.env.NEXTCUP_WORKSPACE_FIXTURES=path.resolve('artifacts/workspace-redesign-20261102/private-fixtures.json');process.env.DATABASE_URL=c.databaseUrl;
const {verifyWorkspace}=await import('../../workspace-redesign-20261102/workspace-guard.mjs');const {config,proof}=await verifyWorkspace({requireCorrespondence:true}),fx=config.fixtures;
const receipt=JSON.parse(fs.readFileSync('artifacts/erp-experience-20261102/step1b/fixture-receipt.json','utf8'));assert.equal(receipt.cafeId,fx.cafeId);const product=receipt.products[0],variantId=receipt.variantIds[1];
const db=new PrismaClient({datasourceUrl:c.databaseUrl});
async function request(url,method,body){const r=await fetch(c.baseUrl+url,{method,headers:{Cookie:fx.ownerCookie,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const result=await r.json();assert.ok(r.ok,JSON.stringify({status:r.status,result}));return result;}
try{
 const inv=await db.inventoryItem.findUniqueOrThrow({where:{id:fx.itemId}});assert.equal(inv.cafeId,fx.cafeId);assert.equal(inv.unit,'KG');
 const owned=await db.product.findUniqueOrThrow({where:{id:product.id}});assert.equal(owned.cafeId,fx.cafeId);assert.equal(owned.sku,'S1B-ESP');
 let recipe=await db.recipe.findFirst({where:{cafeId:fx.cafeId,productId:product.id,variantId},include:{items:true}});
 if(!recipe){await request('/api/products/'+product.id+'/recipe?variantId='+variantId,'PUT',{items:[{inventoryItemId:fx.itemId,quantity:0.1,unit:'KG',wastePercentage:0}]});recipe=await db.recipe.findFirstOrThrow({where:{cafeId:fx.cafeId,productId:product.id,variantId},include:{items:true}});}
 assert.equal(recipe.items.length,1);assert.equal(recipe.items[0].inventoryItemId,fx.itemId);assert.equal(recipe.items[0].quantity.toString(),'0.1');
 if(!recipe.verifiedAt)await request('/api/recipes/'+recipe.id+'/verify','POST',{});
 assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:fx.itemId}})).currentStock.toString(),inv.currentStock.toString());
 const result={at:new Date().toISOString(),proof,runId:fx.runId,recipeId:recipe.id,productId:product.id,variantId,syntheticOperationalConfirmationOnly:true,quantity:'0.100',unit:'KG',inventoryBefore:inv.currentStock.toString(),inventoryAfter:inv.currentStock.toString(),retained:true};
 fs.writeFileSync('artifacts/erp-experience-20261102/step1b/recipe-fixture-receipt.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await db.$disconnect();}
