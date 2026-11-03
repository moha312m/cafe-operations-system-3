import {decimal,money,sumMoney} from './money';
import {dateStrInTz} from './date-range';
import type {SalesReportRow} from './sales-report-contract';
export type ReportLine={id:string;productId:string|null;variantId:string|null;name:string;variant:string|null;sku:string|null;skuSource:string;categoryId:string|null;category:string|null;quantity:number;returned?:number;gross:string;discount:string;net:string};
export type SaleEvent={id:string;orderId:string;at:string;businessDate?:string;branchId:string;creatorId:string|null;serverId:string|null;saleShiftId:string|null;servedShiftId:string|null;postingShiftId:string|null;sessionId:string|null;revenue:string;tax:string;service:string;lines:ReportLine[]};
export type MoneyLeg={sourceId?:string;legacy?:boolean;id:string;orderId:string;at:string;branchId:string;actorId:string|null;actor:string|null;shiftId:string|null;method:string;type:'COLLECTION'|'REFUND';amount:string;sessionId:string|null};
const amount=(rows:string[])=>money(sumMoney(rows)).toFixed(2);
export function productRows(events:SaleEvent[],view='product'):SalesReportRow[]{
 const groups=new Map<string,{line:ReportLine;net:string[];gross:string[];discount:string[];quantity:number;returned:number[];orders:Set<string>;at:string}>();
 for(const event of events)for(const line of event.lines){
  const identity=line.productId?JSON.stringify([line.productId,line.variantId]):'unmapped:'+line.id;
  const key=view==='lines'?event.id+':'+line.id:view==='date'?event.businessDate??dateStrInTz(new Date(event.at)):view==='category'?line.categoryId??'unmapped-category':identity;
  const current=groups.get(key)??{line,net:[],gross:[],discount:[],quantity:0,returned:[],orders:new Set<string>(),at:event.at};
  current.net.push(line.net);current.gross.push(line.gross);current.discount.push(line.discount);current.quantity+=line.quantity;if(line.returned!==undefined)current.returned.push(line.returned);current.orders.add(event.orderId);groups.set(key,current);
 }
 const denominator=sumMoney([...groups.values()].map(g=>amount(g.net)));
 return [...groups].map(([id,g])=>{const net=amount(g.net),firstOrder=[...g.orders][0];return {id,cells:{
  name:view==='date'?id:view==='category'?g.line.category??'تصنيف غير مرتبط':g.line.name,
  sku:view==='date'||view==='category'?null:g.line.sku,skuSource:view==='date'||view==='category'?'mixed':!g.line.productId?'unmapped':g.line.skuSource,variant:view==='date'||view==='category'?null:g.line.variant,category:view==='date'?null:g.line.category,
  quantity:String(g.quantity),returned:g.returned.length?String(g.returned.reduce((a,b)=>a+b,0)):null,gross:amount(g.gross),discount:amount(g.discount),allocatedRefund:null,net,
  share:denominator.gt(0)?decimal(net).div(denominator).times(100).toFixed(2):null,
 },href:view==='lines'?'/sales?invoice='+encodeURIComponent(firstOrder):undefined,
 links:[...g.orders].map(orderId=>({label:'فاتورة '+orderId,href:'/sales?invoice='+encodeURIComponent(orderId)})),
 details:{productId:g.line.productId,variantId:g.line.variantId,identity:id,quantityBasis:'تغير كمية الفاتورة؛ لا يثبت استلام مرتجع مخزون',refundBasis:'الاسترداد غير المرتبط بسطر يبقى في جسر المصالحة'}};});
}
export function paymentRows(legs:MoneyLeg[]):SalesReportRow[]{return [...new Map(legs.map(l=>[l.id,l])).values()].map(p=>({id:p.id,cells:{reference:p.sourceId??p.id,evidence:p.legacy?'تمثيل قديم؛ الوقت والوردية دليل السجل الأصلي لا حدث رد مستقل':'حركة مستقلة',date:p.at,invoice:p.orderId,branch:p.branchId,actor:p.actor??p.actorId,shift:p.shiftId,method:p.method,direction:p.type,amount:money(p.amount).toFixed(2)},href:'/sales?invoice='+encodeURIComponent(p.orderId)}));}
export function staffRows(events:SaleEvent[],legs:MoneyLeg[],basis:'creator'|'collector'|'server'):SalesReportRow[]{
 const groups=new Map<string,{values:string[];orders:Set<string>}>();
 const add=(id:string|null,value:string,orderId:string)=>{const key=id??'unattributed',g=groups.get(key)??{values:[],orders:new Set<string>()};g.values.push(value);g.orders.add(orderId);groups.set(key,g);};
 if(basis==='collector')for(const p of new Map(legs.map(p=>[p.id,p])).values())add(p.actorId,decimal(p.amount).times(p.type==='REFUND'?-1:1).toFixed(2),p.orderId);
 else for(const e of events)add(basis==='creator'?e.creatorId:e.serverId,e.revenue,e.orderId);
 return [...groups].map(([id,g])=>({id,cells:{name:id==='unattributed'?'غير منسوب':id,basis,orders:String(g.orders.size),net:amount(g.values)},links:[...g.orders].map(id=>({label:'الفاتورة '+id,href:'/sales?invoice='+encodeURIComponent(id)}))}));
}
export type ReportSession={id:string;table:string;branch:string;startedAt:string;closedAt:string|null;status:string;remaining:string};
export function tableRows(sessions:ReportSession[],events:SaleEvent[],legs:MoneyLeg[]):SalesReportRow[]{
 const unique=[...new Map(legs.map(p=>[p.id,p])).values()];
 return sessions.map(s=>{const sales=events.filter(e=>e.sessionId===s.id),payments=unique.filter(p=>p.sessionId===s.id);return {id:s.id,cells:{name:s.table,session:s.id,branch:s.branch,start:s.startedAt,end:s.closedAt,status:s.status,durationMinutes:s.closedAt?String(Math.round((Date.parse(s.closedAt)-Date.parse(s.startedAt))/60000)):null,orders:String(new Set(sales.map(e=>e.orderId)).size),net:amount(sales.map(e=>e.revenue)),collections:amount(payments.filter(p=>p.type==='COLLECTION').map(p=>p.amount)),refunds:amount(payments.filter(p=>p.type==='REFUND').map(p=>p.amount)),remaining:money(s.remaining).toFixed(2)},links:[...new Set(sales.map(e=>e.orderId))].map(id=>({label:'الفاتورة '+id,href:'/sales?invoice='+encodeURIComponent(id)}))};});
}
export function pageRows(rows:SalesReportRow[],query:{q?:string;page:number;pageSize:number;sort:string;all?:boolean}){
 const needle=query.q?.trim().toLocaleLowerCase(),filtered=rows.filter(r=>!needle||Object.values(r.cells).some(v=>v?.toLocaleLowerCase().includes(needle)));
 filtered.sort((a,b)=>query.sort==='revenue_desc'||query.sort==='revenue_asc'?(decimal(a.cells.net??a.cells.amount??0).comparedTo(b.cells.net??b.cells.amount??0)*(query.sort==='revenue_desc'?-1:1)||a.id.localeCompare(b.id)):(String(a.cells.name??a.cells.date??a.id).localeCompare(String(b.cells.name??b.cells.date??b.id),'ar')||a.id.localeCompare(b.id)));
 return {total:filtered.length,rows:query.all?filtered:filtered.slice((query.page-1)*query.pageSize,query.page*query.pageSize)};
}
export function assertOutputScope(saved:string,current:string){if(saved!==current)throw new Error('تغير نطاق الحساب أو الصلاحيات؛ أعد إنشاء التقرير');}

/** A revision with missing postingShiftId remains unattributed; never move it into the original drawer. */
export function recognitionShift(event:SaleEvent){return event.id.startsWith('revision:')?event.postingShiftId:event.saleShiftId;}
export function reconcileProductSales(events:SaleEvent[],salesRefunds:string){
 const itemNet=amount(events.flatMap(e=>e.lines.map(l=>l.net))),canonicalNet=money(sumMoney(events.map(e=>e.revenue)).minus(salesRefunds)).toFixed(2),tax=amount(events.map(e=>e.tax)),service=amount(events.map(e=>e.service));
 return {itemNet,canonicalNet,tax,service,bridge:money(decimal(canonicalNet).minus(itemNet).minus(tax).minus(service)).toFixed(2)};
}

export function eventShiftForBasis(event:SaleEvent,basis:'creator'|'server'){
 return basis==='server'&&!event.id.startsWith('revision:')?event.servedShiftId:recognitionShift(event);
}
export function activitySessionIds(events:SaleEvent[],legs:MoneyLeg[]):string[]{return [...new Set([...events.map(e=>e.sessionId),...legs.map(p=>p.sessionId)].filter((id):id is string=>!!id))];}
/** A completed legacy reversal has no independent refund row/date/actor.
 * Preserve the canonical gross pair, tagged as evidence rather than fabricated transactions. */
export function normalizePaymentEvidence(payment:MoneyLeg&{status:string}):MoneyLeg[]{
 if(payment.status==='PAID')return [{...payment,sourceId:payment.id}];
 if(payment.type==='COLLECTION'&&payment.status==='REFUNDED')return [
  {...payment,sourceId:payment.id,legacy:true},
  {...payment,id:'legacy-refund:'+payment.id,sourceId:payment.id,type:'REFUND',actorId:null,actor:null,legacy:true},
 ];
 return [];
}
