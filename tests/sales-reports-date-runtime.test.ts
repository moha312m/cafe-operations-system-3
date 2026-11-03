import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PrismaClient} from '@prisma/client';
import {zonedDayStart,addDays} from '../src/lib/date-range';

test('confirmed purchases follow invoiceDate while supplier settlements follow paidAt', {skip:!process.env.NEXTCUP_WORKSPACE_CONFIG,timeout:120000},async()=>{
 const {verifyWorkspace}=await import(pathToFileURL(path.resolve('artifacts/workspace-redesign-20261102/workspace-guard.mjs')).href);
 const {config,proof}=await verifyWorkspace({requireCorrespondence:true});
 const f=config.fixtures;assert.ok(f?.cafeId&&f?.ownerUserId);assert.equal(config.database.port,5434);
 const db=new PrismaClient({datasourceUrl:config.databaseUrl});
 const id='wr_step2c_purchase_date_20261103';
 try{
  const actor=await db.user.findUniqueOrThrow({where:{id:f.ownerUserId},select:{email:true,cafeId:true}});assert.equal(actor.cafeId,f.cafeId);
  const login=await fetch(config.baseUrl+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:actor.email,password:'workspace-retained-synthetic-only-20261102'})});assert.equal(login.status,200,await login.clone().text());
  const cookie=login.headers.getSetCookie().map((v:string)=>v.split(';')[0]).join('; ');assert.ok(cookie);
  const existing=await db.purchaseInvoice.findUnique({where:{id}});
  if(existing){assert.equal(existing.cafeId,f.cafeId);assert.equal(existing.notes,'Step2C retained synthetic date-basis regression');}
  else await db.purchaseInvoice.create({data:{id,cafeId:f.cafeId,branchId:f.branchId,invoiceNumber:'STEP2C-DATE-20261103',invoiceDate:new Date('2026-11-01T10:00:00Z'),confirmedAt:new Date('2026-11-03T10:00:00Z'),status:'CONFIRMED',subtotalAmount:'100.00',totalAmount:'100.00',paidAmount:'17.35',remainingAmount:'82.65',paymentStatus:'PARTIAL',createdByUserId:f.ownerUserId,notes:'Step2C retained synthetic date-basis regression',payments:{create:{id:id+'_payment',cafeId:f.cafeId,branchId:f.branchId,amount:'17.35',method:'BANK_TRANSFER',fundingSource:'BANK',paidAt:new Date('2026-11-02T10:00:00Z'),createdByUserId:f.ownerUserId}}}});
  const observations=[];
  for(const date of ['2026-11-01','2026-11-02','2026-11-03']){
   const params=new URLSearchParams({branchId:f.branchId,from:date,to:date,q:'STEP2C-DATE-20261103'});
   const response=await fetch(config.baseUrl+'/api/reports/purchase-sales?'+params,{headers:{cookie},signal:AbortSignal.timeout(30000)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
   const row=body.rows.find((r:{id:string})=>r.id===id);observations.push({date,purchasePresent:!!row,displayedDate:row?.cells.date,supplierPaid:body.summaries.find((s:{key:string})=>s.key==='supplierPayments')?.value});
   if(date==='2026-11-01'){assert.ok(row,'Confirmed invoice belongs to invoiceDate period even when confirmation is later');assert.equal(row.cells.date,'2026-11-01T10:00:00.000Z');assert.ok(body.metricBasis.includes('invoiceDate'));
    const output=await fetch(config.baseUrl+'/api/reports/purchase-sales/output',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({snapshot:body.outputSnapshot})});assert.equal(output.status,200);const files=await output.json();assert.ok(files.csv.includes('2026-11-01T10:00:00.000Z'));assert.ok(files.html.includes('invoiceDate'));
   }else assert.equal(row,undefined,'Invoice must not migrate into settlement/confirmation periods');
   const settlement=await db.purchasePayment.aggregate({where:{cafeId:f.cafeId,branchId:f.branchId,paidAt:{gte:zonedDayStart(date),lt:zonedDayStart(addDays(date,1))}},_sum:{amount:true}});
   assert.equal(body.summaries.find((s:{key:string})=>s.key==='supplierPayments')?.value,settlement._sum.amount?.toFixed(2)??'0.00','Supplier settlement retains its own paidAt basis');
  }
  fs.writeFileSync('artifacts/erp-experience-20261102/step2-closeout/date-regression.json',JSON.stringify({at:new Date().toISOString(),proof,invoiceId:id,observations,passed:true},null,2));
 }finally{await db.$disconnect();}
});
