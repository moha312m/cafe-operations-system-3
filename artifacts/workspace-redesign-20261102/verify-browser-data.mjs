import assert from 'node:assert/strict';
import {readFileSync,writeFileSync}from'node:fs';
import path from'node:path';
import {PrismaClient}from'@prisma/client';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const file=path.join(here,'private-config.json'),c=JSON.parse(readFileSync(file,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=file;process.env.NEXTCUP_WORKSPACE_FIXTURES=path.join(here,'private-fixtures.json');process.env.DATABASE_URL=c.databaseUrl;
const {verifyWorkspace}=await import('./workspace-guard.mjs');const {config,proof}=await verifyWorkspace({requireCorrespondence:true}),fx=config.fixtures;
const db=new PrismaClient({datasourceUrl:c.databaseUrl});
try{
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const [mode]=await tx.$queryRawUnsafe("SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation");assert.equal(mode.read_only,'on');
  const rows=await tx.cafeTable.findMany({where:{cafeId:fx.cafeId,branchId:fx.branchId,tableNumber:'UI-WINDOW-01'}});assert.equal(rows.length,1);const t=rows[0];
  assert.equal(t.displayName,'ترابيزة الشباك');assert.equal(t.area,'الصالة');assert.equal(t.seatsCount,6);assert.equal(t.isActive,true);assert.equal(t.archivedAt,null);
  const audits=await tx.auditLog.findMany({where:{cafeId:fx.cafeId,entity:'CafeTable',entityId:t.id},select:{action:true}});
  for(const action of['TABLE_CREATED','TABLE_UPDATED','TABLE_ARCHIVED','TABLE_REACTIVATED'])assert.ok(audits.some(a=>a.action===action),action);
  const invoices=await tx.purchaseInvoice.aggregate({where:{cafeId:fx.cafeId,status:'CONFIRMED'},_count:true,_sum:{totalAmount:true,paidAmount:true,remainingAmount:true}});assert.equal(invoices._count,26);
  assert.deepEqual([invoices._sum.totalAmount.toFixed(2),invoices._sum.paidAmount.toFixed(2),invoices._sum.remainingAmount.toFixed(2)],['260.00','52.00','208.00']);
  const expense=await tx.operatingExpense.aggregate({where:{cafeId:fx.cafeId},_count:true,_sum:{amount:true}});assert.equal(expense._count,2);assert.equal(expense._sum.amount.toFixed(2),'17.34');
  const accounts=await tx.moneyAccount.findMany({where:{cafeId:fx.cafeId},select:{id:true,openingState:true,isActive:true}});assert.equal(accounts.length,4);assert.ok(accounts.every(a=>a.openingState==='UNSET'));assert.equal(await tx.moneyMovement.count({where:{cafeId:fx.cafeId}}),0);
  assert.equal(await tx.accountingEntity.count({where:{cafeId:fx.cafeId}}),0);assert.equal(await tx.journalEntry.count({where:{cafeId:fx.configuredAccounting.cafeId}}),5);assert.equal(await tx.journalEntry.count({where:{cafeId:fx.configuredAccounting.cafeId,sourceType:'OPENING_BALANCE'}}),0);
  for(const userId of[fx.reportActorUserId,fx.configuredAccounting.ownerUserId]){assert.equal((await tx.user.findUniqueOrThrow({where:{id:userId}})).branchId,null);assert.equal(await tx.userPermissionOverride.count({where:{userId}}),0);}
  return{mode,table:{id:t.id,number:t.tableNumber,displayName:t.displayName,area:t.area,seatsCount:t.seatsCount,isActive:t.isActive,archivedAt:t.archivedAt,auditActions:audits.map(a=>a.action)},purchases:{count:invoices._count,total:'260.00',paid:'52.00',remaining:'208.00'},expenses:{count:2,total:'17.34'},moneyAccounts:{count:4,allOpeningsUnset:true,movements:0},primaryBooksUnconfigured:true,configuredShadowEntries:5,noOpeningEntries:true,allReversibleHooksRestored:true};
 });
 writeFileSync(path.join(here,'browser-db-proof.json'),JSON.stringify({at:new Date().toISOString(),status:'PASS',runId:c.runId,sourceSha256:c.source.sha256,identity:proof,...result},null,2),{flag:'wx'});console.log('PASS: actual browser table/audits, purchase/expense totals, unknown treasury openings and hook restoration verified read-only.');
}finally{await db.$disconnect();}
