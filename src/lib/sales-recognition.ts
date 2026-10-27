import {db} from '@/lib/db';
import {decimal,money,sumMoney} from '@/lib/money';
import {salesWhere,preServiceRefundBasis,financialEventWhere,type FinancialScope} from '@/lib/reporting';

type Snapshot={subtotal:string;discountAmount:string;taxAmount:string;serviceChargeAmount:string;total:string;items:{productName:string;variantName:string|null;quantity:number;lineTotal:string;invoiceDiscountShare?:string;voidedAt?:string|null}[]};
export type SaleContribution={at:Date;branchId:string;orderId:string;orders:number;subtotal:number;discount:number;tax:number;service:number;revenue:number;items:{product:string;variant:string|null;quantity:number;revenue:number}[]};
const lineValues=(s:Snapshot)=>s.items.filter(i=>!i.voidedAt).map(i=>({product:i.productName,variant:i.variantName,quantity:i.quantity,revenue:money(decimal(i.lineTotal).minus(i.invoiceDiscountShare??0)).toNumber()}));
const values=(s:Snapshot)=>({subtotal:Number(s.subtotal),discount:Number(s.discountAmount),tax:Number(s.taxAmount),service:Number(s.serviceChargeAmount),revenue:Number(s.total)});

/** One contribution per original sale; revisions contribute only their differences
 * in their own period. Latest invoice values remain available in Sales separately. */
export async function recognizedSales(scope:FinancialScope):Promise<SaleContribution[]>{
 const [orders,revisions]=await Promise.all([
  db.order.findMany({where:salesWhere(scope),select:{id:true,branchId:true,createdAt:true,subtotal:true,discountAmount:true,taxAmount:true,serviceChargeAmount:true,total:true,items:{where:{voidedAt:null},select:{productName:true,variantName:true,quantity:true,lineTotal:true,invoiceDiscountShare:true}},revisions:{where:{before:{path:['status'],equals:'SERVED'}},orderBy:{number:'asc'},take:1,select:{before:true}}}}),
  db.orderRevision.findMany({where:{cafeId:scope.cafeId,...(scope.branchId?{branchId:scope.branchId}:{}),...financialEventWhere(scope),before:{path:['status'],equals:'SERVED'}},select:{orderId:true,branchId:true,createdAt:true,before:true,after:true,recognizedDelta:true}}),
 ]);
 const basis=await preServiceRefundBasis(scope);
 const result:SaleContribution[]=orders.map(o=>{const snap=(o.revisions[0]?.before??o) as unknown as Snapshot;return {at:o.createdAt,orderId:o.id,branchId:o.branchId,orders:1,...values(snap),revenue:money(decimal(snap.total).plus(sumMoney(basis.filter(r=>r.orderId===o.id).map(r=>r.amount)))).toNumber(),items:lineValues(snap)};});
 for(const r of revisions){const before=r.before as unknown as Snapshot,after=r.after as unknown as Snapshot,b=values(before),a=values(after),items=new Map<string,{product:string;variant:string|null;quantity:number;revenue:number}>();
  for(const [snap,direction] of [[before,-1],[after,1]] as const)for(const line of lineValues(snap)){const key=JSON.stringify([line.product,line.variant]);const current=items.get(key)??{product:line.product,variant:line.variant,quantity:0,revenue:0};current.quantity+=direction*line.quantity;current.revenue=money(decimal(current.revenue).plus(decimal(line.revenue).times(direction))).toNumber();items.set(key,current);}
  result.push({at:r.createdAt,orderId:r.orderId,branchId:r.branchId,orders:0,subtotal:money(decimal(a.subtotal).minus(b.subtotal)).toNumber(),discount:money(decimal(a.discount).minus(b.discount)).toNumber(),tax:money(decimal(a.tax).minus(b.tax)).toNumber(),service:money(decimal(a.service).minus(b.service)).toNumber(),revenue:Number(r.recognizedDelta),items:[...items.values()]});
 }
 return result;
}
export function contributionTotals(rows:SaleContribution[]){return {orders:rows.reduce((s,r)=>s+r.orders,0),gross:money(sumMoney(rows.map(r=>r.subtotal))).toNumber(),discounts:money(sumMoney(rows.map(r=>r.discount))).toNumber(),tax:money(sumMoney(rows.map(r=>r.tax))).toNumber(),service:money(sumMoney(rows.map(r=>r.service))).toNumber(),revenue:money(sumMoney(rows.map(r=>r.revenue))).toNumber()};}
export function contributionItems(rows:SaleContribution[]){const items=new Map<string,{product:string;variant:string|null;quantity:number;revenue:number}>();for(const row of rows)for(const line of row.items){const key=JSON.stringify([line.product,line.variant]),current=items.get(key)??{product:line.product,variant:line.variant,quantity:0,revenue:0};current.quantity+=line.quantity;current.revenue=money(decimal(current.revenue).plus(line.revenue)).toNumber();items.set(key,current);}return [...items.values()].filter(i=>i.quantity||i.revenue).sort((a,b)=>b.revenue-a.revenue);}
