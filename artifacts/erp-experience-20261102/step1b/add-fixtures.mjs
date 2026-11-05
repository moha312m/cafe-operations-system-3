import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
const configFile=path.resolve('artifacts/workspace-redesign-20261102/private-step1-config.json');
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=configFile;
process.env.NEXTCUP_WORKSPACE_FIXTURES=path.resolve('artifacts/workspace-redesign-20261102/private-fixtures.json');
process.env.DATABASE_URL=config.databaseUrl;
const {verifyWorkspace}=await import('../../workspace-redesign-20261102/workspace-guard.mjs');
const {config:verified,proof}=await verifyWorkspace({requireCorrespondence:true});
const fx=verified.fixtures;assert.ok(fx.cafeId.startsWith('wr_'));assert.equal(fx.runId,config.runId);
const receiptFile=path.resolve('artifacts/erp-experience-20261102/step1b/fixture-receipt.json');
const id=()=> 'wr_'+randomUUID().replaceAll('-','');
let receipt;
if(fs.existsSync(receiptFile)){receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));assert.equal(receipt.runId,fx.runId);assert.equal(receipt.cafeId,fx.cafeId);}
else{
 const categories=['القهوة · تجريبي','مشروبات باردة · تجريبي','مخبوزات · تجريبي'].map(name=>({id:id(),name}));
 const rows=[['إسبريسو','ESP',25,0],['كابتشينو','CAP',35,0],['لاتيه مثلج','ICED-LATTE',45,1],['ليمون بالنعناع','LEMON',30,1],['كرواسون بالزبدة','CROISSANT',18,2],['ساندوتش جبنة باسم عربي طويل لاختبار القراءة','LONG-ARABIC-SKU-20261102',40,2]];
 receipt={state:'PLANNED',at:new Date().toISOString(),runId:fx.runId,cafeId:fx.cafeId,proof,categories,products:rows.map(([name,sku,price,category])=>({id:id(),name:name+' · تجريبي',sku:'S1B-'+sku,price,categoryId:categories[category].id})),variantIds:[id(),id()],retained:true,syntheticOnly:true};
 fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2),{flag:'wx'});
}
assert.equal(receipt.categories.length,3);assert.equal(receipt.products.length,6);
const db=new PrismaClient({datasourceUrl:config.databaseUrl});
try{
 await db.$transaction(async tx=>{
  const cafe=await tx.cafe.findUniqueOrThrow({where:{id:fx.cafeId},select:{name:true}});assert.ok(cafe.name.startsWith(fx.runId));
  for(const c of receipt.categories){const old=await tx.menuCategory.findUnique({where:{id:c.id}});if(old){assert.equal(old.cafeId,fx.cafeId);assert.equal(old.name,c.name);}else await tx.menuCategory.create({data:{...c,cafeId:fx.cafeId}});}
  for(const [i,p] of receipt.products.entries()){
   const old=await tx.product.findUnique({where:{id:p.id}});
   if(old){assert.equal(old.cafeId,fx.cafeId);assert.equal(old.sku,p.sku);continue;}
   await tx.product.create({data:{id:p.id,cafeId:fx.cafeId,categoryId:p.categoryId,name:p.name,sku:p.sku,basePrice:p.price,description:'Retained synthetic Step1B fixture '+fx.runId,...i===0?{variants:{create:[{id:receipt.variantIds[0],name:'عادي',price:25},{id:receipt.variantIds[1],name:'كبير',price:30}]}}:{}}});
  }
 },{timeout:15000});
 receipt.state='RETAINED';receipt.completedAt=new Date().toISOString();fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));console.log(JSON.stringify({state:receipt.state,categories:3,products:6,variants:2,receiptFile}));
}finally{await db.$disconnect();}
