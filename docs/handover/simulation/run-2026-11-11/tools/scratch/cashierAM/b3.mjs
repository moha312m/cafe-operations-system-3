import fs from 'fs';
const B='cmwc33qgt0012hlng6f0q8uz6';
const P={tea:"cmwc33r6d002yhlngeip3rlir",cro:"cmwc33r6x003ehlngvvzyqm9g",oj:"cmwc33r6o0036hlng26cwienr",esp:"cmwc33r4s0020hlngdofgvi0q",cap:"cmwc33r5l0029hlngzw7i0rng",lat:"cmwc33r5q002ehlng1n5wov7l"};
const V={espD:"cmwc33r4s0022hlngglbjekgz",capS:"cmwc33r5l002ahlngb5dqwdd6",capM:"cmwc33r5l002bhlngg50pzf6x",capL:"cmwc33r5l002chlngz5dk5i2c",latS:"cmwc33r5q002fhlngtatthmwu",latM:"cmwc33r5q002ghlngfm6tyz3m",latL:"cmwc33r5q002hhlngr0wryghr"};
const it=(p,v,q)=>({productId:p,variantId:v,quantity:q});
const o=(n,items,m,tag,extra={})=>({method:"POST",path:"/api/orders",tag,idem:"d1am-s2b-order-"+n,body:{branchId:B,type:"TAKEAWAY",items,collectionMode:"NOW",method:m,discountAmount:0,...extra}});
const which=process.argv[3];
const all=[
o(1,[it(P.cap,V.capM,1),it(P.cro,null,1)],"CASH","1 CASH exp148.2"),
o(2,[it(P.esp,V.espD,2),it(P.tea,null,1)],"CASH","2 CASH exp165.3"),
o(3,[it(P.lat,V.latM,1),it(P.oj,null,1)],"CASH","3 CASH exp153.9"),
o(4,[it(P.cap,V.capL,2),it(P.cro,null,1)],"CARD","4 CARD exp273.6"),
o(5,[it(P.cap,V.capS,1),it(P.lat,V.latS,1)],"WALLET","5 WALLET exp119.7"),
o(6,[it(P.lat,V.latL,1),it(P.tea,null,2),it(P.oj,null,1)],"MIXED","6 MIXED disc10 exp210.33",{invoiceDiscount:{type:"PERCENT",value:"10"},splits:[{method:"CASH",amount:110.33},{method:"CARD",amount:100}]}),
];
fs.writeFileSync(process.argv[2],JSON.stringify(which==="a"?all.slice(0,5):all.slice(5)));
