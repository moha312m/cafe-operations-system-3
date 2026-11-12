import fs from 'fs';
const B='cmwc33qgt0012hlng6f0q8uz6';
const o=(items,method,splits)=>({method:"POST",path:"/api/orders",body:{branchId:B,type:"TAKEAWAY",items,collectionMode:"NOW",method,...(splits?{splits}:{}),discountAmount:0}});
const it=(p,v,q)=>({productId:p,variantId:v,quantity:q});
const a0=[
{...o([it("cmwc33r6d002yhlngeip3rlir",null,2),it("cmwc33r6x003ehlngvvzyqm9g",null,1)],"CASH"),tag:"1 CASH exp110"},
{...o([it("cmwc33r5q002ehlng1n5wov7l","cmwc33r5q002ghlngfm6tyz3m",1),it("cmwc33r74003ihlng7bb0k47a",null,1)],"CASH"),tag:"2 CASH exp140"},
{...o([it("cmwc33r4s0020hlngdofgvi0q","cmwc33r4s0021hlngqxpr5tte",2),it("cmwc33r71003ghlngm1hh6296",null,1)],"CASH"),tag:"3 CASH exp145"},
{...o([it("cmwc33r77003mhlngmwe0p5sf",null,1),it("cmwc33r6q0038hlng6d0fu4vz",null,1)],"CARD"),tag:"4 CARD exp190"},
{...o([it("cmwc33r5l0029hlngzw7i0rng","cmwc33r5l002chlngz5dk5i2c",1),it("cmwc33r5f0024hlngjqtoixe6","cmwc33r5f0025hlng5aug5u72",1)],"WALLET"),tag:"5 WALLET exp125"},
{...o([it("cmwc33r7a003ohlngo8iwj0ld",null,1),it("cmwc33r6f0030hlng2xon9ntr",null,1)],"MIXED",[{method:"CASH",amount:100},{method:"CARD",amount:65}]),tag:"6 MIXED exp165"},
];
const a=a0.map((x,i)=>({...x,idem:"d1am-s2a-order-"+(i+1)}));fs.writeFileSync('C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/scratch/cashierAM/orders.json',JSON.stringify(a));
