import {z} from 'zod';
import type {Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {ApiError,resolveReadScope} from '@/lib/api';
import type {SessionUser} from '@/lib/auth';
import {salesAuthority,json} from '@/lib/order-amendments';
import {addDays,zonedBusinessDayStart,zonedDayStart} from '@/lib/date-range';
import {collectedAmountExact} from '@/lib/order-payments';
import {protectedTransaction} from '@/lib/protected-transaction';
import {auditInTransaction} from '@/lib/audit';
import {decimal,money} from '@/lib/money';
import {resolveReportingSelection} from './reporting-hours';
import {reportEventWhere} from './report-window-scope';
import {signReportOutput} from './report-output';

const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const filters=z.object({q:z.string().max(100).optional(),branchId:z.string().max(100).optional(),userId:z.string().max(100).optional(),from:day.optional(),to:day.optional(),business:z.enum(['0','1']).default('0'),status:z.enum(['UNPAID','PARTIAL','PAID','PENDING_COLLECTION','REFUNDED']).optional(),action:z.string().max(80).optional(),page:z.coerce.number().int().min(1).max(10000).default(1)});
export function salesFilters(params:URLSearchParams,actor:SessionUser){
 const f=filters.parse(Object.fromEntries(params));const scope=resolveReadScope(actor);
 if(f.branchId&&scope.branchId&&f.branchId!==scope.branchId)throw new ApiError(403,'الفرع خارج نطاقك');
 const dateStart=f.business==='1'?zonedBusinessDayStart:zonedDayStart;
 if(f.from&&f.to&&f.from>f.to)throw new ApiError(400,'نطاق تاريخ غير صالح');
 const period=f.from||f.to?{...(f.from?{gte:dateStart(f.from)}:{}),...(f.to?{lt:dateStart(addDays(f.to,1))}:{})}:undefined;
 return {f,scope:{...scope,...(f.branchId?{branchId:f.branchId}:{})},period};
}
export async function listSales(actor:SessionUser,params:URLSearchParams){
 await salesAuthority(actor,'sales.view');const {f,scope,period}=salesFilters(params,actor);
 const reporting=await resolveReportingSelection(actor,params,{optional:true});
 const where:Prisma.OrderWhereInput={...scope,...(reporting?{AND:[reportEventWhere(reporting.windows)]}:period?{createdAt:period}:{}),...(f.status?{paymentStatus:f.status}:{}),...(f.userId?{createdById:f.userId}:{}),...(f.q?{OR:[{id:{contains:f.q}},...(/^\d+$/.test(f.q)&&Number(f.q)<2147483647?[{orderNumber:Number(f.q)}]:[])]}:{})};
 const [orders,count,totals,branches,users]=await Promise.all([
  db.order.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(f.page-1)*30,take:30,include:{items:{where:{voidedAt:null},include:{addOns:true}},payments:true,createdBy:{select:{id:true,name:true}},branch:{select:{id:true,name:true}},revisions:{orderBy:{number:'desc'},take:1,select:{originalShiftId:true,postingShiftId:true}}}}),
  db.order.count({where}),db.order.aggregate({where,_sum:{subtotal:true,discountAmount:true,taxAmount:true,serviceChargeAmount:true,total:true,paidAmount:true,remainingAmount:true}}),
  db.branch.findMany({where:{...(scope.cafeId?{cafeId:scope.cafeId}:{}),...(scope.branchId?{id:scope.branchId}:{})},select:{id:true,name:true,reportingVersions:{orderBy:{effectiveDate:'asc'}}}}),
  db.user.findMany({where:{...(scope.cafeId?{cafeId:scope.cafeId}:{}),...(scope.branchId?{branchId:scope.branchId}:{})},select:{id:true,name:true},take:500}),
 ]);
 const reportingMetadata=reporting??{mode:'legacy',windows:[],branches:branches.map(b=>({id:b.id,name:b.name,versions:b.reportingVersions})),outsideCounts:[],coverageNote:'سجل الفواتير بحسب فلاتر التاريخ السابقة. اختر أيام العمل لاستخدام ساعات تقارير الفروع.'};
 const outputSnapshot=signReportOutput(actor.id,{title:'المبيعات — أحدث قيم الفواتير؛ صفحة '+f.page,reporting:reporting?{mode:reporting.mode,windows:reporting.windows,branches:reporting.branches.map(b=>({id:b.id,name:b.name}))}: {mode:'legacy',from:period?.gte??null,to:period?.lt??null,boundary:'[start,end)',label:period?'فترة الفلاتر السابقة':'جميع التواريخ'},metrics:{latestInvoices:totals._sum,count,page:f.page,pageSize:30},rows:orders.map(o=>({orderNumber:o.orderNumber,id:o.id,createdAt:o.createdAt,branchId:o.branchId,total:o.total,paidAmount:o.paidAmount,remainingAmount:o.remainingAmount})),generatedAt:new Date().toISOString()});
 return {orders:orders.map(o=>({...o,netCollected:collectedAmountExact(o.payments).toFixed(2)})),count,page:f.page,pageSize:30,totals:totals._sum,branches,users,reporting:reportingMetadata,outputSnapshot};
}
export async function saleDetail(actor:SessionUser,id:string){
 await salesAuthority(actor,'sales.view');const order=await db.order.findFirst({where:{id,...resolveReadScope(actor)},include:{items:{where:{voidedAt:null},include:{addOns:true}},payments:{include:{receivedBy:{select:{name:true}}}},createdBy:{select:{id:true,name:true}},branch:{select:{id:true,name:true}},revisions:{orderBy:{number:'asc'}}}});
 if(!order)throw new ApiError(404,'الطلب غير موجود');
 const [amendments,products]=await Promise.all([db.orderAmendment.findMany({where:{orderId:id,...resolveReadScope(actor)},orderBy:{createdAt:'desc'},take:30}),db.product.findMany({where:{cafeId:order.cafeId,isActive:true,isAvailable:true},select:{id:true,name:true,basePrice:true,variants:{where:{isActive:true},select:{id:true,name:true,price:true}},addOns:{select:{addOn:{select:{id:true,name:true,price:true,isActive:true}}}},branchPrices:{where:{branchId:order.branchId},select:{branchId:true,price:true}}},take:500})]);
 const attempts=await db.amendmentSettlement.findMany({where:{amendmentId:{in:amendments.map(a=>a.id)}},orderBy:{createdAt:'asc'}});
 const requests=await db.ownerActionRequest.findMany({where:{id:{in:amendments.flatMap(a=>[a.ownerRequestId,a.ownerVoidRequestId].filter((x):x is string=>!!x))}},select:{id:true,action:true,status:true,mode:true,ownerId:true}});
 return {order,amendments,attempts,requests,products};
}
export async function listTracing(actor:SessionUser,params:URLSearchParams){
 await salesAuthority(actor,'audit.view');const {f,scope,period}=salesFilters(params,actor);
 const where:Prisma.OrderTraceWhereInput={...scope,...(period?{createdAt:period}:{}),...(f.q?{orderId:{contains:f.q}}:{}),...(f.userId?{actorId:f.userId}:{}),...(f.action?{action:f.action}:{})};
 const [records,count]=await Promise.all([db.orderTrace.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(f.page-1)*50,take:50}),db.orderTrace.count({where})]);
 const users=await db.user.findMany({where:{id:{in:[...new Set(records.flatMap(r=>[r.actorId,r.approverId,r.originalCashierId].filter((x):x is string=>!!x)))]}},select:{id:true,name:true}});
 return {records,count,page:f.page,pageSize:50,users};
}
const limitSchema=z.object({userId:z.string(),maxPercent:z.string().regex(/^\d+(\.\d{1,2})?$/),maxAmount:z.string().regex(/^\d+(\.\d{1,2})?$/)}).strict();
export async function setDiscountLimit(actor:SessionUser,raw:unknown){
 await salesAuthority(actor,'sales.configure_limits');const input=limitSchema.parse(raw);if(decimal(input.maxPercent).gt(100)||decimal(input.maxAmount).gt('99999999.99'))throw new ApiError(400,'حد غير صالح');
 return protectedTransaction(async tx=>{const user=await tx.user.findFirst({where:{id:input.userId,...resolveReadScope(actor)},select:{id:true,cafeId:true}});if(!user?.cafeId)throw new ApiError(404,'المستخدم خارج نطاقك');
  const before=await tx.salesDiscountLimit.findUnique({where:{userId:user.id}});
  const after=await tx.salesDiscountLimit.upsert({where:{userId:user.id},create:{userId:user.id,cafeId:user.cafeId,updatedById:actor.id,maxPercent:money(input.maxPercent),maxAmount:money(input.maxAmount)},update:{updatedById:actor.id,maxPercent:money(input.maxPercent),maxAmount:money(input.maxAmount)}});
  await auditInTransaction(tx,{cafeId:user.cafeId,userId:actor.id,action:'SALES_DISCOUNT_LIMIT_CHANGED',entity:'User',entityId:user.id,details:json({before,after})});return after;
 },resolveReadScope(actor));
}
