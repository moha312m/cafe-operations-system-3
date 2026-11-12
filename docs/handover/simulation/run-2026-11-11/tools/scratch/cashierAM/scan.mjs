import fs from 'fs';import {execSync} from 'child_process';
const D='C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/scratch/cashierAM';
const p=JSON.parse(fs.readFileSync('C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/products.json','utf8'));
let n=0;
for(const x of p){ if(['شاي','مافن'].includes(x.name))continue; for(const v of (x.variants.length?x.variants:[null])){
 const b={branchId:"cmwc33qgt0012hlng6f0q8uz6",type:"TAKEAWAY",items:[{productId:x.id,variantId:v?v.id:null,quantity:1}],collectionMode:"NOW",method:"CASH",discountAmount:0};
 fs.writeFileSync(D+'/pr.json',JSON.stringify(b));
 const out=execSync(`node C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/sim.mjs call sara.am@sim.test POST /api/orders @${D}/pr.json --idem d1am-scan-${++n}`,{encoding:'utf8'});
 console.log(x.name,v?v.name:'',out.slice(0,60).replace(/\n/g,' '));
 if(out.startsWith('201')){console.log(out.slice(0,1500));process.exit()}
}}
