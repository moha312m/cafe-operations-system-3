import assert from 'node:assert/strict';import fs from'node:fs';import path from'node:path';import{PrismaClient}from'@prisma/client';
const file=path.resolve('artifacts/workspace-redesign-20261102/private-step1-config.json'),c=JSON.parse(fs.readFileSync(file,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=file;process.env.NEXTCUP_WORKSPACE_FIXTURES=path.resolve('artifacts/workspace-redesign-20261102/private-fixtures.json');process.env.DATABASE_URL=c.databaseUrl;
const{verifyWorkspace}=await import('../../workspace-redesign-20261102/workspace-guard.mjs');const{config,proof}=await verifyWorkspace({requireCorrespondence:true});const fx=config.fixtures,fixture=JSON.parse(fs.readFileSync('artifacts/erp-experience-20261102/step1b/fixture-receipt.json','utf8'));
const db=new PrismaClient({datasourceUrl:c.databaseUrl});try{
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const rows=await tx.order.findMany({where:{cafeId:fx.cafeId,items:{some:{productId:fixture.products[0].id,notes:'Step1B · اختبار اصطناعي — بدون سكر'}}},include:{items:true,payments:true}});
  assert.equal(rows.length,1,'Exactly one synthetic invoice');const o=rows[0];assert.equal(o.total.toFixed(2),'60.00');assert.equal(o.status,'CONFIRMED');assert.equal(o.items.length,1);assert.equal(o.items[0].quantity,2);assert.equal(o.items[0].variantId,fixture.variantIds[1]);assert.equal(o.payments.length,1);const p=o.payments[0];assert.equal(p.type,'COLLECTION');assert.equal(p.status,'PAID');assert.equal(p.method,'CASH');assert.equal(p.amount.toFixed(2),'60.00');assert.equal(o.total.minus(p.amount).toFixed(2),'0.00');assert.equal((await tx.inventoryItem.findUniqueOrThrow({where:{id:fx.itemId}})).currentStock.toString(),'26');
  return {orderId:o.id,invoiceNumber:o.orderNumber,status:o.status,total:'60.00',quantity:2,variantId:o.items[0].variantId,note:o.items[0].notes,paymentId:p.id,paymentCount:1,method:p.method,collected:'60.00',remaining:'0.00',shiftId:p.shiftId,stockBefore:'26',stockAfter:'26',served:false};
 });fs.writeFileSync('artifacts/erp-experience-20261102/step1b/pos-collection-receipt.json',JSON.stringify({at:new Date().toISOString(),proof,...result},null,2));console.log(JSON.stringify(result));
}finally{await db.$disconnect();}
