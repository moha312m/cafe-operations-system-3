import fs from 'fs';
const t=fs.readFileSync(process.argv[2],'utf8');const j=JSON.parse(t.slice(t.indexOf('{')));
for(const o of j.orders)console.log(o.orderNumber,o.id,o.type,o.status,o.approvalStatus,o.source,o.tableNumber,o.total,o.paymentStatus,o.tableSessionId||'');
