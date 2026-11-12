let t=require("fs").readFileSync(0,"utf8");const i=t.indexOf("{");let j;try{j=JSON.parse(t.slice(i))}catch(e){console.log("parse fail",t.length);process.exit()}
for(const o of j.orders.filter(o=>o.tableNumber&&o.createdAt>"2026-11-11T15:40"))console.log(o.id,"#"+o.orderNumber,"T"+o.tableNumber,o.status,o.total,o.tableSessionId,o.paymentStatus)
console.log("total orders",j.orders.length)
