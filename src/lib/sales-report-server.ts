import {NextResponse,type NextRequest} from 'next/server';
import type {Prisma} from '@prisma/client';
import {db} from './db';
import {ApiError,requireActiveSession,resolveCafeId,resolveReadScope,handleApiError} from './api';
import {resolvePermissions} from './perms/effective';
import {parseReportQuery} from './sales-report-query';
import {zonedDayStart,addDays,dateStrInTz} from './date-range';
import {decimal,money,sumMoney} from './money';
import {signReportOutput,verifyReportOutput,reportOutputFiles} from './report-output';
import {recognitionShift,eventShiftForBasis,activitySessionIds,normalizePaymentEvidence,reconcileProductSales,productRows,paymentRows,staffRows,tableRows,pageRows,assertOutputScope,type SaleEvent,type ReportLine,type MoneyLeg} from './sales-report-math';
import type {SalesReportKind,SalesReportRow,SalesReportResponse} from './sales-report-contract';
import {z} from 'zod';
import {drawerExpected} from './expense-rules';
import {windowsForDates,type ReportWindow} from './business-day';
import {reportEventWhere} from './report-window-scope';
const LIMIT=5000;
import {SALES_REPORT_CATALOG} from './sales-report-catalog';
const reportDefinition=(kind:SalesReportKind)=>SALES_REPORT_CATALOG.find(r=>r.id===kind)!;
const fixed=(v:Prisma.Decimal|string|number)=>money(v).toFixed(2);
const total=(values:string[])=>fixed(sumMoney(values));
const bounded=<T,>(rows:T[],label:string)=>{if(rows.length>LIMIT)throw new ApiError(422,'النطاق يتجاوز '+LIMIT+' '+label+'؛ ضيّق الفترة أو الفرع. لم تُعرض إجماليات جزئية.');return rows;};
async function authority(kind:SalesReportKind,cafeId?:string){
 const actor=await requireActiveSession(),scope={...resolveReadScope(actor),cafeId:resolveCafeId(actor,cafeId)};
 const configured=await db.cafeSettings.findUnique({where:{cafeId:scope.cafeId},select:{id:true}});
 if(!configured)throw new ApiError(409,'إعدادات الكافيه غير مهيأة؛ لا ينشئ التقرير إعدادات تلقائياً');
 const {keys}=await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return resolvePermissions(actor,tx);});
 if(!reportDefinition(kind).keys.every(k=>keys.has(k)))throw new ApiError(403,'ليس لديك صلاحيات هذا التقرير');
 if(kind==='purchase-sales'||kind==='shift-sales'||kind==='tables'){
  const settings=await db.cafeSettings.findUnique({where:{cafeId:scope.cafeId},select:{inventoryEnabled:true,purchasesEnabled:true,shiftManagementEnabled:true,enableTables:true}});
  if(kind==='purchase-sales'&&(!settings?.inventoryEnabled||!settings.purchasesEnabled)||kind==='shift-sales'&&!settings?.shiftManagementEnabled||kind==='tables'&&!settings?.enableTables)throw new ApiError(403,'التقرير غير مفعل لهذا الكافيه');
 }
 const fingerprint=JSON.stringify([actor.id,scope.cafeId,scope.branchId??null,actor.role,[...keys].sort()]);
 return {actor,keys,scope,fingerprint};
}
type SnapshotLine={id?:string;productId?:string|null;variantId?:string|null;stockProductIdSnapshot?:string|null;stockVariantIdSnapshot?:string|null;productName:string;variantName?:string|null;quantity:number;lineTotal:string;invoiceDiscountShare?:string;itemDiscountAmount?:string;voidedAt?:string|null};
type Snapshot={status?:string;total:string;taxAmount:string;serviceChargeAmount:string;items:SnapshotLine[]};
const snapshot=(s:unknown)=>s as Snapshot;
export async function loadSalesReport(kind:SalesReportKind,params:URLSearchParams):Promise<SalesReportResponse>{
 const q=parseReportQuery(params),access=await authority(kind,q.cafeId),{scope}=access;
 if(q.branchId&&scope.branchId&&q.branchId!==scope.branchId)throw new ApiError(403,'الفرع خارج نطاقك');
 if(q.actorId&&!['sales-staff','sales-payments','shift-sales'].includes(kind)||q.shiftId&&['tables','purchase-sales'].includes(kind)||q.method&&kind==='sales-staff'&&q.basis!=='collector'||q.categoryId&&kind!=='product-sales'||q.view!=='product'&&kind!=='product-sales'||q.basis!=='creator'&&kind!=='sales-staff'||q.sessionId&&kind!=='tables'||q.method&& !['sales-payments','sales-staff'].includes(kind))throw new ApiError(400,'فلتر غير مدعوم لهذا التقرير');
 const base={cafeId:scope.cafeId,...(scope.branchId||q.branchId?{branchId:scope.branchId??q.branchId}:{})},period={gte:zonedDayStart(q.from),lt:zonedDayStart(addDays(q.to,1))};
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '12s'");
  if(base.branchId&&!await tx.branch.findFirst({where:{id:base.branchId,cafeId:base.cafeId},select:{id:true}}))throw new ApiError(403,'الفرع خارج نطاق الكافيه');
  if(q.shiftId&&!await tx.shift.findFirst({where:{...base,id:q.shiftId},select:{id:true}}))throw new ApiError(404,'الوردية خارج النطاق');
  const branches=await tx.branch.findMany({where:{cafeId:base.cafeId,...(scope.branchId?{id:scope.branchId}:{})},select:{id:true,name:true},take:501});
  let windows:ReportWindow[]=[];
  if(q.dayMode==='business'){const versions=await tx.branch.findMany({where:{cafeId:base.cafeId,...(base.branchId?{id:base.branchId}:{})},select:{id:true,reportingVersions:{orderBy:{effectiveDate:'asc'}}}});try{windows=versions.flatMap(b=>windowsForDates(b.id,q.from,q.to,b.reportingVersions));}catch(error){throw new ApiError(400,(error as Error).message);}}
  const eventWhere=(field='createdAt',viaOrder=false)=>q.dayMode==='business'?{AND:[reportEventWhere(windows,field,viaOrder)]}:{[field]:period};
  const shifts=kind==='shift-sales'?bounded(await tx.shift.findMany({where:{...base,...(q.shiftId?{id:q.shiftId}:eventWhere('openedAt')),...(q.actorId?{cashierId:q.actorId}:{})},include:{cashier:{select:{name:true}},branch:{select:{name:true}},operatingExpenses:{where:access.keys.has('expenses.view')?{}:{id:{in:[]}},select:{id:true,description:true,amount:true,occurredAt:true},take:LIMIT+1},operatingExpenseReturns:{where:access.keys.has('expenses.view')?{}:{id:{in:[]}},select:{id:true,reason:true,amount:true,occurredAt:true},take:LIMIT+1}},orderBy:[{openedAt:'desc'},{id:'asc'}],take:LIMIT+1}),'وردية'):[];
  const shiftIds=shifts.map(s=>s.id),complete=kind==='shift-sales';
  const orders=bounded(await tx.order.findMany({where:{...base,status:'SERVED',...(complete?{OR:[{saleShiftId:{in:shiftIds}},{servedShiftId:{in:shiftIds}}]}:eventWhere(kind==='sales-staff'&&q.basis==='server'?'servedAt':'createdAt'))},include:{items:{where:{voidedAt:null},take:LIMIT+1},revisions:{orderBy:{number:'asc'},take:LIMIT+1},payments:{where:{type:'REFUND',status:'PAID',amendmentId:{not:null}},take:LIMIT+1}},take:LIMIT+1}),'فاتورة');
  const revisions=bounded(await tx.orderRevision.findMany({where:{...base,order:{cafeId:base.cafeId,...(base.branchId?{branchId:base.branchId}:{})},...(complete?{postingShiftId:{in:shiftIds}}:eventWhere())},include:{order:{select:{createdById:true,servedById:true,saleShiftId:true,servedShiftId:true,tableSessionId:true}}},take:LIMIT+1}),'مراجعة');
  for(const o of orders){bounded(o.items,'بند فاتورة');bounded(o.revisions,'مراجعة فاتورة');bounded(o.payments,'استرداد فاتورة');}
  if(orders.reduce((n,o)=>n+o.items.length+o.revisions.length+o.payments.length,0)>50000)throw new ApiError(422,'تفاصيل كثيرة؛ ضيّق نطاق التقرير');
  const physicalReturns=kind==='product-sales'&&!q.shiftId?bounded(await tx.finishedGoodsReturn.findMany({where:{...base,...eventWhere('receivedAt'),line:{order:{status:'SERVED'}}},include:{line:{select:{id:true,productId:true,variantId:true,stockProductIdSnapshot:true,stockVariantIdSnapshot:true,productName:true,variantName:true,order:{select:{id:true,createdById:true,servedById:true,saleShiftId:true,servedShiftId:true,tableSessionId:true}}}}},take:LIMIT+1}),'استلام مرتجع'):[];
  const productIds=new Set<string>();
  for(const o of orders){for(const l of o.items)if(l.productId)productIds.add(l.productId);for(const r of o.revisions)for(const l of [...(snapshot(r.before).items??[]),...(snapshot(r.after).items??[])])if(l.productId)productIds.add(l.productId);}
  for(const r of revisions)for(const l of [...(snapshot(r.before).items??[]),...(snapshot(r.after).items??[])])if(l.productId)productIds.add(l.productId);
  for(const r of physicalReturns){const id=r.line.productId??r.line.stockProductIdSnapshot;if(id)productIds.add(id);}
  if(productIds.size>LIMIT)throw new ApiError(422,'عدد الأصناف كبير؛ ضيّق النطاق');
  const catalog=await tx.product.findMany({where:{cafeId:base.cafeId,id:{in:[...productIds]}},select:{id:true,sku:true,categoryId:true,category:{select:{name:true}}}}),products=new Map(catalog.map(p=>[p.id,p]));
  function lines(s:Snapshot,prefix:string,direction=1):ReportLine[]{return (s.items??[]).filter(l=>!l.voidedAt).map((l,index)=>{const productId=l.productId??l.stockProductIdSnapshot??null,p=productId?products.get(productId):undefined,net=decimal(l.lineTotal).minus(l.invoiceDiscountShare??0),discount=decimal(l.itemDiscountAmount??0).plus(l.invoiceDiscountShare??0);return {id:l.id??prefix+':'+index,productId,variantId:l.variantId??l.stockVariantIdSnapshot??null,name:l.productName,variant:l.variantName??null,sku:p?.sku??null,skuSource:p?'current':'unmapped',categoryId:p?.categoryId??null,category:p?.category.name??null,quantity:l.quantity*direction,gross:fixed(decimal(l.lineTotal).plus(l.itemDiscountAmount??0).times(direction)),discount:fixed(discount.times(direction)),net:fixed(net.times(direction))};});}
  let events:SaleEvent[]=orders.map(o=>{const first=o.revisions.find(r=>snapshot(r.before).status==='SERVED'),s=first?snapshot(first.before):snapshot(o),preIds=new Set(o.revisions.filter(r=>snapshot(r.before).status!=='SERVED').map(r=>r.amendmentId)),preRefunds=total(o.payments.filter(p=>p.amendmentId&&preIds.has(p.amendmentId)).map(p=>fixed(p.amount)));return {id:'sale:'+o.id,orderId:o.id,at:(kind==='sales-staff'&&q.basis==='server'?o.servedAt??o.createdAt:o.createdAt).toISOString(),branchId:o.branchId,creatorId:o.createdById,serverId:o.servedById,saleShiftId:o.saleShiftId,servedShiftId:o.servedShiftId,postingShiftId:null,sessionId:o.tableSessionId,revenue:fixed(decimal(s.total).plus(preRefunds)),tax:fixed(s.taxAmount),service:fixed(s.serviceChargeAmount),lines:lines(s,o.id)};});
  for(const r of revisions){const before=snapshot(r.before),after=snapshot(r.after);events.push({id:'revision:'+r.id,orderId:r.orderId,at:r.createdAt.toISOString(),branchId:r.branchId,creatorId:r.order.createdById,serverId:r.order.servedById,saleShiftId:r.order.saleShiftId,servedShiftId:r.order.servedShiftId,postingShiftId:r.postingShiftId,sessionId:r.order.tableSessionId,revenue:fixed(r.recognizedDelta),tax:before.status==='SERVED'?fixed(decimal(after.taxAmount).minus(before.taxAmount)):'0.00',service:before.status==='SERVED'?fixed(decimal(after.serviceChargeAmount).minus(before.serviceChargeAmount)):'0.00',lines:before.status==='SERVED'?[...lines(before,r.id,-1),...lines(after,r.id)]:[]});}
  if(kind==='product-sales'&&!q.shiftId){

   for(const r of physicalReturns){const line=r.line,o=line.order,productId=line.productId??line.stockProductIdSnapshot,p=productId?products.get(productId):undefined;events.push({id:'physical:'+r.id,orderId:o.id,at:r.receivedAt.toISOString(),branchId:r.branchId,creatorId:o.createdById,serverId:o.servedById,saleShiftId:o.saleShiftId,servedShiftId:o.servedShiftId,postingShiftId:null,sessionId:o.tableSessionId,revenue:'0.00',tax:'0.00',service:'0.00',lines:[{id:line.id,productId,variantId:line.variantId??line.stockVariantIdSnapshot,name:line.productName,variant:line.variantName,sku:p?.sku??null,skuSource:p?'current':'unmapped',categoryId:p?.categoryId??null,category:p?.category.name??null,quantity:0,returned:r.quantity,gross:'0.00',discount:'0.00',net:'0.00'}]});}
  }
  if(q.dayMode==='business')events=events.map(e=>({...e,businessDate:windows.find(w=>w.branchId===e.branchId&&new Date(e.at)>=w.from&&new Date(e.at)<w.to)?.businessDate}));
  if(q.shiftId&&!complete)events=events.filter(e=>eventShiftForBasis(e,kind==='sales-staff'&&q.basis==='server'?'server':'creator')===q.shiftId);
  if(q.actorId&&kind!=='shift-sales')events=events.filter(e=>(q.basis==='server'?e.serverId:e.creatorId)===q.actorId);
  const rawPayments=bounded(await tx.payment.findMany({where:{cafeId:base.cafeId,order:{cafeId:base.cafeId,...(base.branchId?{branchId:base.branchId}:{})},...(complete?{shiftId:{in:shiftIds}}:eventWhere('paidAt',true)),...(q.shiftId?{shiftId:q.shiftId}:{}),...(q.method?{method:q.method}:{}),...(q.actorId&&q.basis==='collector'||q.actorId&&kind==='sales-payments'?{receivedById:q.actorId}:{}),OR:[{status:'PAID'},{type:'COLLECTION',status:'REFUNDED'}]},include:{order:{select:{branchId:true,tableSessionId:true,status:true,customerName:true}},receivedBy:{select:{name:true}}},take:LIMIT+1}),'حركة دفع');
  const legs:MoneyLeg[]=rawPayments.flatMap(p=>normalizePaymentEvidence({status:p.status,id:p.id,orderId:p.orderId,at:p.paidAt.toISOString(),branchId:p.order.branchId,actorId:p.receivedById,actor:p.receivedBy.name,shiftId:p.shiftId,method:p.method,type:p.type,amount:fixed(p.amount),sessionId:p.tableSessionId??p.order.tableSessionId})).filter(p=>!(q.actorId&&(kind==='sales-payments'||kind==='sales-staff'&&q.basis==='collector'))||p.actorId===q.actorId);
  // Canonical sales-refund timing remains createdAt, including the legacy reversal representation.
  const refundPayments=bounded(await tx.payment.findMany({where:{cafeId:base.cafeId,order:{cafeId:base.cafeId,status:'SERVED',...(base.branchId?{branchId:base.branchId}:{})},...(complete?{shiftId:{in:shiftIds}}:eventWhere('createdAt',true)),...(q.shiftId?{shiftId:q.shiftId}:{}),OR:[{type:'REFUND'},{type:'COLLECTION',status:'REFUNDED'}]},select:{id:true,amount:true,shiftId:true,orderId:true},take:LIMIT+1}),'استرداد');
  const recognized=total(events.map(e=>e.revenue)),salesRefunds=total(refundPayments.map(p=>fixed(p.amount))),canonicalNet=fixed(decimal(recognized).minus(salesRefunds)),tax=total(events.map(e=>e.tax)),service=total(events.map(e=>e.service));
  const collections=total(legs.filter(p=>p.type==='COLLECTION').map(p=>p.amount)),refunds=total(legs.filter(p=>p.type==='REFUND').map(p=>p.amount));
  const summaries:SalesReportResponse['summaries']=[],coverage:string[]=['قراءة تشغيلية فقط؛ المبيعات التاريخية المستوردة مستقلة.',q.dayMode==='business'?'الفترة وفق نسخ ساعات العمل لكل فرع؛ النوافذ محفوظة في لقطة التصدير.':'الفترة أيام القاهرة المدنية؛ اختر أيام العمل لاستخدام ساعات الفرع.','حد القراءة 5000 سجل لكل مصدر؛ تجاوز الحد يرفض التقرير دون إجماليات ناقصة.'];
  if(legs.some(p=>p.legacy))coverage.push('تمثيل قديم COLLECTION/REFUNDED يعرض تحصيلاً ورداً متوازنين من نفس دليل Payment، دون إنشاء حركات. تاريخ/وردية الدليل مسجلان، ولا يوجد تاريخ أو محصل رد مستقل؛ المحصل المرتجع غير منسوب.');
  let rows:SalesReportRow[]=[],metricBasis='';
  const summary=(key:string,label:string,value:string|null)=>summaries.push({key,label,value});
  if(kind==='product-sales'){
   const scoped=q.categoryId?events.map(e=>({...e,lines:e.lines.filter(l=>l.categoryId===q.categoryId)})):events;
   rows=['brand','cost'].includes(q.view)?[]:productRows(scoped,q.view);
   const itemNet=reconcileProductSales(scoped,salesRefunds).itemNet,bridge=fixed(decimal(canonicalNet).minus(itemNet).minus(tax).minus(service));
   summary('itemNet','مقام مساهمة الأصناف قبل البحث',itemNet);summary('canonicalNet','صافي المبيعات التشغيلي — كامل النطاق',canonicalNet);summary('tax','الضريبة',tax);summary('service','الخدمة',service);summary('bridge','تسويات / استردادات غير موزعة / فروق',bridge);
   metricBasis='الأصل في تاريخ إنشاء الفاتورة المخدومة؛ فروق المراجعات في تاريخها. صافي الصنف بعد خصمه ونصيب خصم الفاتورة، شامل الإضافات مرة واحدة. المقام لا يتغير بالبحث أو الصفحة.';
   coverage.push('SKU والتصنيف من الكتالوج الحالي مع وسم المصدر؛ الروابط المفقودة تبقى غير مرتبطة.','الكمية تغير بنود الفاتورة. المرتجع الموثق هو FinishedGoodsReturn المستلم بالفترة؛ غياب الدليل غير متاح وليس صفراً. هذا المصدر بلا وردية استلام، فلا يوزع على وردية بالتخمين. الاسترداد النقدي غير المنسوب يبقى في الجسر.','لا يوجد Brand أو تكلفة بيع تاريخية موثوقة؛ عرض العلامة والتكلفة غير متاح.','النسبة غير متاحة عندما يكون المقام صفراً أو سالباً.');
   if(q.categoryId)coverage.push('جسر التصنيف يتضمن بقية الأصناف والرسوم والتسويات غير القابلة لتوزيع موثوق؛ الإجمالي التشغيلي المعروض لكل النطاق لا لهذا التصنيف وحده.');
  }else if(kind==='sales-payments'){
   rows=paymentRows(legs);if(access.keys.has('customers.view'))for(const row of rows)row.cells.customer=rawPayments.find(p=>p.id===row.cells.reference)?.order.customerName??null;summary('collections','التحصيلات المكتملة',collections);summary('refunds','الاستردادات المكتملة',refunds);summary('net','صافي حركة الأموال',fixed(decimal(collections).minus(refunds)));
   metricBasis='Payment.status=PAID، مع إظهار التمثيل القديم REFUNDED منفصلاً عند وجوده؛ تاريخ paidAt ووردية الدفع والمحصّل الفعلي. المبالغ مقادير موجبة واتجاهها مستقل. لا تتكرر قيمة الفاتورة.';
   coverage.push('الدفع غير المؤكد أو غير المكتمل خارج التحصيلات. تاريخ كشف المبيعات القديم createdAt قد يختلف عن paidAt.');
  }else if(kind==='sales-staff'){
   rows=staffRows(events,legs,q.basis);const users=await tx.user.findMany({where:{cafeId:base.cafeId,id:{in:rows.map(r=>r.id)}},select:{id:true,name:true}});for(const row of rows)row.cells.name=users.find(u=>u.id===row.id)?.name??(row.id==='unattributed'?'غير منسوب':row.id);
   summary('net',q.basis==='collector'?'صافي تحصيلات الموظفين':'الاعتراف حسب الدور المحدد',total(rows.map(r=>r.cells.net??'0')));
   metricBasis=q.basis==='collector'?'المحصّل الفعلي receivedById، تاريخ paidAt، تحصيل ناقص استرداد':q.basis==='server'?'servedById؛ الأصل بتاريخ servedAt والتعديل بتاريخ المراجعة، وليس تاريخ التحصيل':'createdById؛ أصل البيع بتاريخ createdAt والتعديل بتاريخ المراجعة';
   coverage.push('لا تجمع نتائج الأدوار معاً كمبيعات إضافية. صافي الاعتراف هنا قبل الاستردادات غير المنسوبة للدور؛ التحصيل يعرضها تحت المحصل الفعلي. خدمة قديمة بلا servedAt لا تدخل فترة خدمة بتخمين تاريخها.');
  }else if(kind==='purchase-sales'){
   const purchases=bounded(await tx.purchaseInvoice.findMany({where:{...base,status:'CONFIRMED',...eventWhere('confirmedAt')},select:{id:true,invoiceNumber:true,confirmedAt:true,invoiceDate:true,totalAmount:true},take:LIMIT+1}),'فاتورة مشتريات');
   const supplierPayments=await tx.purchasePayment.aggregate({where:{...base,...eventWhere('paidAt')},_sum:{amount:true}});
   rows=[...events.map(e=>({id:e.id,cells:{section:'المبيعات المعترف بها',reference:e.orderId,date:e.at,net:e.revenue},href:'/sales?invoice='+encodeURIComponent(e.orderId)})),...purchases.map(p=>({id:p.id,cells:{section:'المشتريات المؤكدة',reference:p.invoiceNumber,date:p.confirmedAt!.toISOString(),net:fixed(p.totalAmount)},href:'/report-center/purchases?q='+encodeURIComponent(p.invoiceNumber)}))];
   summary('sales','صافي المبيعات المعترف بها',canonicalNet);summary('purchases','المشتريات المؤكدة',total(purchases.map(p=>fixed(p.totalAmount))));summary('collections','تحصيلات العملاء',collections);summary('supplierPayments','مدفوعات الموردين',fixed(supplierPayments._sum.amount??0));
   metricBasis='الاعتراف بالمبيعات وفق createdAt والمراجعات؛ المشتريات وفق confirmedAt، تاريخ الفاتورة محفوظ بالمصدر. التحصيل وسداد المورد بتاريخ paidAt منفصلان.';
   coverage.push('المبيعات ناقص المشتريات ليست ربحاً؛ المشتريات ليست COGS. اعتماد المحاسب وD7/D8 وخطوة P&L باقية.');
  }else if(kind==='tables'){
   const sessions=bounded(await tx.tableSession.findMany({where:{...base,...(q.sessionId?{id:q.sessionId}:{}),OR:[{id:{in:activitySessionIds(events,legs)}},eventWhere('startedAt'),eventWhere('closedAt'),{status:'OPEN'},{orders:{some:eventWhere()}},{payments:{some:eventWhere('paidAt')}}]},include:{orders:{where:{cafeId:base.cafeId,...(base.branchId?{branchId:base.branchId}:{})},select:{id:true},take:LIMIT+1}},take:LIMIT+1}),'جلسة');
   const ids=new Set(sessions.map(s=>s.id));
   rows=tableRows(sessions.map(s=>({id:s.id,table:s.tableNumber,branch:s.branchId,startedAt:s.startedAt.toISOString(),closedAt:s.closedAt?.toISOString()??null,status:s.status,remaining:fixed(s.remainingAmount)})),events.filter(e=>e.sessionId&&ids.has(e.sessionId)),legs.filter(p=>p.sessionId&&ids.has(p.sessionId)));
   for(const row of rows){const session=sessions.find(s=>s.id===row.id)!;bounded(session.orders,'طلب جلسة');row.cells.orders=String(session.orders.length);row.links=[...new Map([...(row.links??[]),...session.orders.map(o=>({label:'الفاتورة '+o.id,href:'/sales?invoice='+encodeURIComponent(o.id)}))].map(link=>[link.href,link])).values()];}
   summary('sessions','الجلسات المطابقة',String(rows.length));summary('sales','اعتراف الفترة للجلسات',total(rows.map(r=>r.cells.net??'0')));
   metricBasis='زيارات مستقلة بمعرف TableSession. أحداث المبيعات والتحصيل خلال الفترة؛ المتبقي حالة حالية وقت القراءة وليس رصيداً تاريخياً. لا يجمع المتبقي عبر الأيام.';
   coverage.push('كل Payment يعد مرة واحدة؛ جلسة الدفع الصريحة مقدمة على جلسة الطلب. الجلسات المفتوحة تظهر ولو بدأت قبل الفترة.');
  }else{
   rows=shifts.map(s=>{const ownEvents=events.filter(e=>recognitionShift(e)===s.id),ownLegs=legs.filter(p=>p.shiftId===s.id),ownRefund=refundPayments.filter(p=>p.shiftId===s.id),settled=['CLOSED','AWAITING_HANDOVER'].includes(s.status),cash=(type:'COLLECTION'|'REFUND')=>total(ownLegs.filter(p=>p.method==='CASH'&&p.type===type).map(p=>p.amount));
    const shiftFrom=dateStrInTz(s.openedAt),shiftTo=dateStrInTz(s.closedAt??new Date());
    bounded(s.operatingExpenses,'مصروف وردية');bounded(s.operatingExpenseReturns,'رد مصروف وردية');
    const expected=drawerExpected({opening:s.openingCashAmount,netCollections:decimal(cash('COLLECTION')).minus(cash('REFUND')),supplierPayouts:s.totalCashPayouts,expensePayouts:s.totalExpensePayouts,expenseReturns:s.totalExpenseReturns}).toFixed(2);
    return {id:s.id,cells:{name:String(s.shiftNumber),branch:s.branch.name,actor:s.cashier.name,start:s.openedAt.toISOString(),end:s.closedAt?.toISOString()??null,status:s.status,orders:String(ownEvents.filter(e=>e.id.startsWith('sale:')).length),net:fixed(decimal(total(ownEvents.map(e=>e.revenue))).minus(total(ownRefund.map(p=>fixed(p.amount))))),tax:total(ownEvents.map(e=>e.tax)),service:total(ownEvents.map(e=>e.service)),collections:total(ownLegs.filter(p=>p.type==='COLLECTION').map(p=>p.amount)),refunds:total(ownLegs.filter(p=>p.type==='REFUND').map(p=>p.amount)),cash:cash('COLLECTION'),card:total(ownLegs.filter(p=>p.method==='CARD'&&p.type==='COLLECTION').map(p=>p.amount)),wallet:total(ownLegs.filter(p=>p.method==='WALLET'&&p.type==='COLLECTION').map(p=>p.amount)),opening:fixed(s.openingCashAmount),supplierPayouts:fixed(s.totalCashPayouts),expenses:fixed(s.totalExpensePayouts),expenseReturns:fixed(s.totalExpenseReturns),expected:fixed(s.expectedCashAmount),counted:settled&&s.actualCashAmount!==null?fixed(s.actualCashAmount):null,variance:settled&&s.cashDifference!==null?fixed(s.cashDifference):null},details:{calculatedCashBridge:expected,cashBridgeDifference:fixed(decimal(s.expectedCashAmount).minus(expected)),expenseSources:JSON.stringify(s.operatingExpenses.map(e=>({id:e.id,description:e.description,amount:fixed(e.amount),at:e.occurredAt}))),expenseReturnSources:JSON.stringify(s.operatingExpenseReturns.map(e=>({id:e.id,reason:e.reason,amount:fixed(e.amount),at:e.occurredAt}))),saleShiftId:s.id,servedOrders:String(events.filter(e=>e.servedShiftId===s.id&&e.id.startsWith('sale:')).length),cashBasis:'افتتاح + تحصيل نقدي - رد نقدي - سداد مورد - مصروف + رد مصروف؛ المفتوح مؤقت'},links:[{label:'أصناف الوردية',href:'/reports/product-sales?shiftId='+encodeURIComponent(s.id)+'&from='+shiftFrom+'&to='+shiftTo},{label:'حركات الدفع',href:'/reports/sales-payments?shiftId='+encodeURIComponent(s.id)+'&from='+shiftFrom+'&to='+shiftTo},...(settled?[{label:'تقرير القفل المعتمد',href:'/reports/shift/'+encodeURIComponent(s.id)}]:[]),{label:'مسار الورديات الحالي',href:'/shifts'},...ownEvents.map(e=>({label:'الفاتورة '+e.orderId,href:'/sales?invoice='+encodeURIComponent(e.orderId)}))]};});
   summary('shifts','الورديات المطابقة',String(rows.length));summary('sales','صافي اعتراف الورديات',total(rows.map(r=>r.cells.net??'0')));
   metricBasis='اختيار الوردية بحسب openedAt ثم كامل دورة روابطها دون قطع عند منتصف الليل. الأصل saleShiftId؛ الخدمة servedShiftId منفصلة؛ التعديل postingShiftId والدفع shiftId.';
   coverage.push('المتوقع المسجل محفوظ دون إعادة كتابة؛ التفاصيل تعرض جسر النقد المحسوب والفرق عنه دون تسوية تلقائية. مصادر المصروف لا تظهر دون expenses.view. الورديات المفتوحة مؤقتة؛ المعدود والفرق النهائي غير متاحين حتى التسوية. روابط الأصناف والتحصيل تغطي أيام فتح وإغلاق الوردية كاملة دون قطع عند منتصف الليل.');
  }
  if(rows.length>50000)throw new ApiError(422,'التقرير يتجاوز 50000 صف؛ ضيّق نطاقه');
  const columns=[...new Set(rows.flatMap(r=>Object.keys(r.cells)))].map(key=>({key,label:columnLabels[key]??key}));
  if(q.q)for(const summary of summaries)summary.label+=' — النطاق قبل البحث النصي';
  const paged=pageRows(rows,{...q,all:q.export==='all'}),generatedAt=new Date().toISOString();
  if(q.export==='all'&&paged.total>5000)throw new ApiError(422,'كل النتائج المفلترة تتجاوز حد التصدير 5000 صف؛ ضيّق النطاق');
  const response:SalesReportResponse={kind,title:reportDefinition(kind).title,generatedAt,columns,rows:paged.rows,summaries,coverage,total:paged.total,page:q.page,pageSize:q.pageSize,pages:Math.ceil(paged.total/q.pageSize),metricBasis,filterOptions:{branches,categories:catalog.map(p=>({id:p.categoryId,name:p.category.name})).filter((p,i,a)=>a.findIndex(x=>x.id===p.id)===i)},selection:q};
  if(access.keys.has('reports.export')){
   const report={title:response.title,generatedAt,reporting:{...q,kind,scopeFingerprint:access.fingerprint,requestedCafeId:q.cafeId,exportScope:q.export==='all'?'كل النتائج المفلترة':'الصفحة المعروضة',metricBasis,coverage,windows},context:{'الفترة':q.from+' → '+q.to,'نوع الفترة':q.dayMode,'الفرع':base.branchId??'كل الفروع المسموحة','الوردية':q.shiftId??'الكل','التصنيف الحالي':q.categoryId??'الكل','بحث النتائج':q.q??'بدون','طريقة العرض':q.view,'أساس الموظف':q.basis,'الترتيب':q.sort,'الصفحة':String(q.page),'حجم الصفحة':String(q.pageSize),'نطاق التصدير':q.export==='all'?'كل النتائج المفلترة':'الصفحة المعروضة','أساس المقاييس':metricBasis,'التغطية':coverage.join(' · ')},metrics:Object.fromEntries(summaries.map(s=>[s.label,s.value])),rows:paged.rows.map(r=>Object.fromEntries(columns.map(c=>[c.label,r.cells[c.key]??null]))),preserveStrings:true};
   const token=signReportOutput(access.actor.id,report);if(token.length<=1800000)response.outputSnapshot=token;else coverage.push('اللقطة أكبر من حد التصدير 1.8MB؛ ضيّق النطاق.');
  }
  return response;
 },{isolationLevel:'RepeatableRead',timeout:20000,maxWait:3000});
 return result;
}
const columnLabels:Record<string,string>={name:'الاسم / الرقم',sku:'SKU',skuSource:'مصدر SKU',variant:'الحجم',category:'التصنيف',quantity:'تغير كمية الفاتورة',returned:'مرتجع مخزون موثق',gross:'مبيعات الأصناف',discount:'الخصومات',allocatedRefund:'رد موزع',net:'الصافي',share:'المساهمة %',customer:'العميل المأذون',reference:'المرجع',date:'تاريخ الحدث',invoice:'الفاتورة',branch:'الفرع',actor:'الموظف',shift:'وردية الدفع',method:'الوسيلة',direction:'الاتجاه',evidence:'مصدر دليل الحركة',amount:'المبلغ',basis:'أساس الإسناد',orders:'الطلبات',section:'القسم',session:'الجلسة',start:'الفتح',end:'الإغلاق',status:'الحالة',durationMinutes:'المدة بالدقائق',collections:'التحصيلات',refunds:'الاستردادات',remaining:'المتبقي الآن',tax:'الضريبة',service:'الخدمة',cash:'تحصيل نقدي',card:'تحصيل بطاقة',wallet:'تحصيل محفظة',opening:'افتتاح الدرج',supplierPayouts:'سداد المورد',expenses:'مصروفات الدرج',expenseReturns:'رد مصروفات',expected:'النقد المتوقع',counted:'النقد المعدود',variance:'الفرق النهائي'};
export function salesReportGET(kind:SalesReportKind){return async(request:NextRequest)=>{try{return NextResponse.json(await loadSalesReport(kind,request.nextUrl.searchParams),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return handleApiError(error);}};}
export function salesReportOutputPOST(kind:SalesReportKind){return async(request:NextRequest)=>{try{
 const {snapshot:token}=z.object({snapshot:z.string().min(1).max(1800000)}).strict().parse(await request.json());
 const actor=await requireActiveSession();let report;try{report=verifyReportOutput(actor.id,token);}catch(error){throw new ApiError(400,(error as Error).message);}
 const metadata=report.reporting as {kind:SalesReportKind;scopeFingerprint:string;requestedCafeId?:string};
 if(metadata.kind!==kind)throw new ApiError(400,'لقطة تقرير مختلفة');
 const access=await authority(kind,metadata.requestedCafeId);if(!access.keys.has('reports.export'))throw new ApiError(403,'ليس لديك صلاحية تصدير');
 try{assertOutputScope(metadata.scopeFingerprint,access.fingerprint);}catch(error){throw new ApiError(403,(error as Error).message);}
 return NextResponse.json(reportOutputFiles(report),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return handleApiError(error);}};}
