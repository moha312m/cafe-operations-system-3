import fs from 'fs';
const B='cmwc33qgt0012hlng6f0q8uz6';
const prods=JSON.parse(fs.readFileSync('C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/products.json','utf8'));
const a=[];let i=0;
for(const p of prods){const v=p.variants[0];a.push({method:"POST",path:"/api/orders",tag:"probe "+p.name+(v?" "+v.name:"")+" "+(v?v.price:p.price),idem:"d1am-probe-"+(++i)+"-x",body:{branchId:B,type:"TAKEAWAY",items:[{productId:p.id,variantId:v?v.id:null,quantity:1}],collectionMode:"PENDING",method:"CASH",discountAmount:0}});}
fs.writeFileSync('C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/scratch/cashierAM/probe.json',JSON.stringify(a));
