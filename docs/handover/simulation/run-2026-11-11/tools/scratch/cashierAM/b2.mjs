import fs from 'fs';
const B='cmwc33qgt0012hlng6f0q8uz6',T='cmwc33r6d002yhlngeip3rlir';
const o=(q,m,s,tag)=>({method:"POST",path:"/api/orders",tag,idem:"d1am-s2a-tea-"+tag.split(' ')[0],body:{branchId:B,type:"TAKEAWAY",items:[{productId:T,variantId:null,quantity:q}],collectionMode:"NOW",method:m,...(s?{splits:s}:{}),discountAmount:0}});
fs.writeFileSync(process.argv[2],JSON.stringify([o(2,"CASH",0,"2 CASH tea x2 exp57"),o(3,"CASH",0,"3 CASH tea x3 exp85.5"),o(4,"CARD",0,"4 CARD tea x4 exp114"),o(1,"WALLET",0,"5 WALLET tea x1 exp28.5"),o(5,"MIXED",[{method:"CASH",amount:100},{method:"CARD",amount:42.5}],"6 MIXED tea x5 exp142.5")]));
