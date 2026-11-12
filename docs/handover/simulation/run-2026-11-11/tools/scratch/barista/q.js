const s=require('fs').readFileSync(0,'utf8');const j=JSON.parse(s.slice(s.indexOf('{')));
console.log(j.orders.sort((a,b)=>a.createdAt<b.createdAt?-1:1).map(o=>o.id+':'+o.orderNumber+':'+o.status).join('\n'));
