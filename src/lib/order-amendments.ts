import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Prisma, type PaymentMethod, type OrderAmendment} from '@prisma/client';
import {ApiError,resolveReadScope} from '@/lib/api';
import type {SessionUser} from '@/lib/auth';
import {resolvePermissions} from '@/lib/perms/effective';
import {protectedTransaction} from '@/lib/protected-transaction';
import {lockShifts,lockOrders,lockOrderPayments,lockTableSessions,validateOpenPostingShift} from '@/lib/transaction-locks';
import {decimal,money,sumMoney} from '@/lib/money';
import {collectedAmountExact} from '@/lib/order-payments';
import {priceAmendment,settlementRequired,allocateRefund} from '@/lib/order-amendment-math';
import {unitPriceExact} from '@/lib/pricing';
import {applyOrderPaymentInTx} from '@/lib/payments';
import {recomputeShiftTotals} from '@/lib/shifts';
import {recomputeSessionTotals} from '@/lib/table-sessions';
import {checkCartAvailability} from '@/lib/stock-availability';
import {auditInTransaction} from '@/lib/audit';
import {requestOwnerAction,fingerprint,targetFor} from '@/lib/owner-action-approvals';
import {acquireInventorySharedLocks} from '@/lib/inventory-freeze';
import {lockItemForUpdate,applyStockMutation} from '@/lib/ledger';
import {allowsKnownShortage} from '@/lib/inventory-policy';
import {assertOpeningReceiptEvidence} from '@/lib/opening-readiness';

const discount=z.object({type:z.enum(['NONE','PERCENT','FIXED']),value:z.string().regex(/^\d+(\.\d{1,2})?$/)}).strict();
export const amendmentSchema=z.object({
 baseRevision:z.number().int().min(0),reason:z.string().trim().min(3).max(500),
 invoiceDiscount:discount,
 items:z.array(z.object({id:z.string().min(1).max(80),quantity:z.number().int().min(0).max(100000),unitPrice:z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),discount,
 productId:z.string().optional(),variantId:z.string().nullable().optional(),addOnIds:z.array(z.string()).max(30).optional()}).strict()).min(1).max(200),
}).strict();
export type AmendmentInput=z.infer<typeof amendmentSchema>;
const include={items:{include:{addOns:true},orderBy:{id:'asc' as const}},payments:{orderBy:{id:'asc' as const}},createdBy:{select:{id:true,name:true}},branch:{select:{id:true,name:true}}} satisfies Prisma.OrderInclude;
type SavedOrder=Prisma.OrderGetPayload<{include:typeof include}>;
type Line={id:string;productId:string|null;variantId:string|null;productName:string;variantName:string|null;unitPrice:string;addOnTotal:string;quantity:number;discount:{type:string;value:string};notes:string|null;addOns:{addOnId:string|null;addOnName:string;price:string}[];lineTotal?:string;gross?:string;itemDiscount?:string;invoiceShare?:string};
export type Proposed={requiredPermissions?:string[];lines:Line[];subtotal:string;discountAmount:string;itemDiscountAmount:string;invoiceDiscountAmount:string;invoiceDiscount:{type:string;value:string};total:string;taxAmount:string;serviceChargeAmount:string;removed:string[];quantityRemoved:{id:string;quantity:number;prepared:boolean}[];positiveLines:Line[];stockPlan:{inventoryItemId:string;required:number;name:string}[];wastePlan:{inventoryItemId:string;required:number;name:string}[];settlement:ReturnType<typeof settlementRequired>};
export const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item)) as Prisma.InputJsonValue;
export const stateHash=(order:SavedOrder)=>createHash('sha256').update(JSON.stringify({revision:order.revision,status:order.status,approvalStatus:order.approvalStatus,total:order.total,discount:order.discountAmount,paid:order.paidAmount,remaining:order.remainingAmount,paymentStatus:order.paymentStatus,stock:order.stockDeductedAt,session:order.tableSessionId,items:order.items,payments:order.payments})).digest('hex');
export async function salesAuthority(actor:SessionUser,key:string){
 const {keys}=await resolvePermissions(actor); if(!keys.has(key))throw new ApiError(403,'ليس لديك صلاحية '+key);return keys;
}
const isManager=(actor:SessionUser)=>['CAFE_OWNER','BRANCH_MANAGER'].includes(actor.role);
async function readOrder(tx:Prisma.TransactionClient,id:string,actor:SessionUser){const order=await tx.order.findFirst({where:{id,...resolveReadScope(actor)},include});if(!order)throw new ApiError(404,'الطلب غير موجود');return order;}
function originalLine(item:SavedOrder['items'][number]):Line{return {id:item.id,productId:item.productId,variantId:item.variantId,productName:item.productName,variantName:item.variantName,unitPrice:item.unitPrice.toFixed(2),addOnTotal:money(sumMoney(item.addOns.map(a=>a.price))).toFixed(2),quantity:item.quantity,discount:{type:item.itemDiscountType,value:item.itemDiscountValue.toFixed(2)},notes:item.notes,addOns:item.addOns.map(a=>({addOnId:a.addOnId,addOnName:a.addOnName,price:a.price.toFixed(2)}))};}
export function savedInvoiceDiscount(order:SavedOrder){return {type:order.invoiceDiscountType??(decimal(order.discountAmount).gt(0)?'FIXED':'NONE'),value:(order.invoiceDiscountValue??order.discountAmount).toFixed(2)};}
export function receiptSnapshot(order:SavedOrder){return json({...order,items:order.items.filter(i=>!i.voidedAt),invoiceDiscount:savedInvoiceDiscount(order)});}
const FINISHED_AMENDMENT_REFUSED='تعديل كمية منتج جاهز أو إضافته غير متاح في مراجعة الفاتورة؛ استخدم الإلغاء/المرتجع الحالي أو سجّل فاتورة جديدة';
async function proposal(tx:Prisma.TransactionClient,order:SavedOrder,input:AmendmentInput,keys:Set<string>):Promise<Proposed>{
 if((order.taxAmount.gt(0)&&order.taxRateSnapshot===null)||(order.serviceChargeAmount.gt(0)&&order.serviceRateSnapshot===null))throw new ApiError(409,'الفاتورة التاريخية لا تحتوي لقطة كافية لقواعد الضريبة أو الخدمة؛ استخدم مسار الإلغاء/المرتجع');
 if(order.revision!==input.baseRevision)throw new ApiError(409,'الطلب اتعدل — حدّث الصفحة');
 if(['CANCELLED','REJECTED','PENDING_WAITER_APPROVAL'].includes(order.status)||order.paymentStatus==='REFUNDED')throw new ApiError(409,'استخدم مسار الموافقة أو الإلغاء الحالي لهذه الحالة');
 if(order.loyaltyPointsAwardedAt||order.loyaltyPointsRedeemed||order.loyaltyDiscountAmount.gt(0))throw new ApiError(409,'طلب ولاء: استخدم مسار الإلغاء/المرتجع الحالي طبقًا لقرار المالك');
 if(await tx.orderAmendment.findFirst({where:{orderId:order.id,kitchenStatus:'PENDING'}}))throw new ApiError(409,'أكمل تحضير إضافات المراجعة السابقة قبل تعديل آخر');
 if(await tx.deferredStockDeduction.findUnique({where:{orderId:order.id},select:{appliedAt:true}}).then(r=>r&&!r.appliedAt))throw new ApiError(409,'أكمل تسوية مخزون التسليم أولًا');
 const ids=new Set(input.items.map(i=>i.id));if(ids.size!==input.items.length)throw new ApiError(400,'صنف مكرر');
 const existing=order.items.filter(i=>!i.voidedAt);if(existing.some(i=>!ids.has(i.id)))throw new ApiError(400,'أرسل جميع الأصناف الحالية');
 const lines:Line[]=[],requiredPermissions=new Set<string>();
 for(const row of input.items){
  const saved=existing.find(i=>i.id===row.id);
  if(saved){
   if(row.productId||row.variantId||row.addOnIds)throw new ApiError(400,'لا يمكن تبديل هوية الصنف المحفوظ');
   // Accepted finished-goods stock is immutable per line (DB trigger); refuse here, before approval or settlement.
   if(saved.stockModeSnapshot==='FINISHED_GOOD'&&row.quantity!==saved.quantity)throw new ApiError(409,FINISHED_AMENDMENT_REFUSED);
   if(row.quantity===0)continue;
   const base=originalLine(saved);
   if(row.unitPrice!==undefined&&!money(row.unitPrice).eq(saved.unitPrice))requiredPermissions.add('sales.override_price');
   if(row.unitPrice!==undefined&&!money(row.unitPrice).eq(saved.unitPrice)&&!keys.has('sales.override_price'))throw new ApiError(403,'تعديل السعر يحتاج صلاحية مستقلة');
   lines.push({...base,quantity:row.quantity,unitPrice:row.unitPrice??base.unitPrice,discount:row.discount});
  }else{
   if(!row.id.startsWith('new-')||!row.productId||row.quantity<1)throw new ApiError(400,'صنف جديد غير صالح');
   const p=await tx.product.findFirst({where:{id:row.productId,cafeId:order.cafeId,isActive:true,isAvailable:true},include:{variants:true,branchPrices:{where:{branchId:order.branchId}},addOns:{include:{addOn:true}}}});
   if(!p)throw new ApiError(400,'المنتج غير متاح');
   if(p.stockMode==='FINISHED_GOOD')throw new ApiError(409,FINISHED_AMENDMENT_REFUSED);
   const variant=row.variantId?p.variants.find(v=>v.id===row.variantId&&v.isActive):null;
   if((row.variantId&&!variant)||(!row.variantId&&p.variants.some(v=>v.isActive)))throw new ApiError(400,'اختر حجمًا متاحًا');
   const addIds=row.addOnIds??[];if(new Set(addIds).size!==addIds.length)throw new ApiError(400,'إضافة مكررة');
   const adds=addIds.map(id=>{const a=p.addOns.find(a=>a.addOn.id===id&&a.addOn.isActive)?.addOn;if(!a)throw new ApiError(400,'إضافة غير متاحة');return {addOnId:a.id,addOnName:a.name,price:a.price.toFixed(2)};});
   const price=unitPriceExact({basePrice:p.basePrice.toString(),branchPrices:p.branchPrices.map(b=>({branchId:b.branchId,price:b.price.toString()}))},variant?{price:variant.price.toString()}:null,order.branchId);
   if(row.unitPrice!==undefined&&!money(row.unitPrice).eq(price))requiredPermissions.add('sales.override_price');
   if(row.unitPrice!==undefined&&!money(row.unitPrice).eq(price)&&!keys.has('sales.override_price'))throw new ApiError(403,'تعديل السعر يحتاج صلاحية مستقلة');
   lines.push({id:row.id,productId:p.id,variantId:variant?.id??null,productName:p.name,variantName:variant?.name??null,quantity:row.quantity,unitPrice:row.unitPrice??price.toFixed(2),discount:row.discount,addOnTotal:money(sumMoney(adds.map(a=>a.price))).toFixed(2),addOns:adds,notes:null});
  }
 }
 const oldDiscount=savedInvoiceDiscount(order), changedDiscount=JSON.stringify(oldDiscount)!==JSON.stringify(input.invoiceDiscount)||input.items.some(r=>{const i=existing.find(i=>i.id===r.id);return i?i.itemDiscountType!==r.discount.type||!i.itemDiscountValue.eq(r.discount.value):r.discount.type!=='NONE';});
 if(changedDiscount&&!keys.has('pos.apply_discount'))throw new ApiError(403,'ليس لديك صلاحية الخصم');
 if(changedDiscount)requiredPermissions.add('pos.apply_discount');
 const priced=priceAmendment(lines,input.invoiceDiscount,{taxRate:order.taxRateSnapshot?.toString()??'0',serviceRate:order.serviceRateSnapshot?.toString()??'0',fixedService:!order.serviceRateSnapshot||order.serviceRateSnapshot.isZero()?order.serviceChargeAmount.toString():'0'});
 const positiveLines=lines.flatMap(l=>{const old=existing.find(i=>i.id===l.id);const delta=l.quantity-(old?.quantity??0);return delta>0?[{...l,quantity:delta}]:[];});
 const quantityRemoved=existing.flatMap(i=>{const after=lines.find(l=>l.id===i.id)?.quantity??0;return after<i.quantity?[{id:i.id,quantity:i.quantity-after,prepared:i.kitchenStatus!=='NEW'||!!order.stockDeductedAt}]:[];});
 const availability=await checkCartAvailability({cafeId:order.cafeId,branchId:order.branchId,mode:order.inventoryEnforcementMode,lines:(order.stockDeductedAt||order.status==='SERVED'?positiveLines:lines).filter(l=>l.productId).map(l=>({productId:l.productId!,label:l.productName,variantId:l.variantId,addOnIds:l.addOns.map(a=>a.addOnId).filter((a):a is string=>!!a),quantity:l.quantity}))},tx);
 if(!availability.ok)throw new ApiError(409,availability.message??'المخزون أو الوصفة لا يسمحان بهذا التعديل');
 const wasteLines=order.stockDeductedAt||order.status==='SERVED'?[]:quantityRemoved.filter(r=>r.prepared).map(r=>({...originalLine(existing.find(i=>i.id===r.id)!),quantity:r.quantity}));
 const waste=await checkCartAvailability({cafeId:order.cafeId,branchId:order.branchId,mode:order.inventoryEnforcementMode,lines:wasteLines.filter(l=>l.productId).map(l=>({productId:l.productId!,label:l.productName,variantId:l.variantId,addOnIds:l.addOns.map(a=>a.addOnId).filter((a):a is string=>!!a),quantity:l.quantity}))},tx);
 if(!waste.ok)throw new ApiError(409,waste.message??"تعذر تسجيل هالك الأصناف المحضرة");
 return {...priced,requiredPermissions:[...requiredPermissions],wastePlan:waste.knownConsumption.map(d=>({inventoryItemId:d.inventoryItemId,required:d.required,name:d.name})),lines:priced.lines.map(l=>({...lines.find(x=>x.id===l.id)!,...l,unitPrice:String(l.unitPrice),addOnTotal:String(l.addOnTotal),discount:{type:l.discount.type,value:String(l.discount.value)}})),invoiceDiscount:input.invoiceDiscount,removed:quantityRemoved.filter(x=>!lines.some(l=>l.id===x.id)).map(x=>x.id),quantityRemoved,positiveLines,stockPlan:availability.knownConsumption.map(d=>({inventoryItemId:d.inventoryItemId,required:d.required,name:d.name})),settlement:settlementRequired(order.total,collectedAmountExact(order.payments),priced.total)};
}

async function trace(tx:Prisma.TransactionClient,actor:SessionUser,order:SavedOrder,action:string,reason:string,details:unknown,amendment?:OrderAmendment,shiftId?:string){
 await tx.orderTrace.create({data:{cafeId:order.cafeId,branchId:order.branchId,orderId:order.id,revision:order.revision,amendmentId:amendment?.id,actorId:actor.id,originalCashierId:order.createdById,approverId:amendment?.approverId,shiftId,action,reason,details:json(details)}});
 await auditInTransaction(tx,{cafeId:order.cafeId,userId:actor.id,action,entity:'Order',entityId:order.id,details:{branchId:order.branchId,amendmentId:amendment?.id,reason}});
}
async function originalShift(tx:Prisma.TransactionClient,order:SavedOrder){
 const id=order.saleShiftId??order.payments.find(p=>p.type==='COLLECTION')?.shiftId??order.servedShiftId;
 if(id)return tx.shift.findUnique({where:{id}});
 return order.createdById?tx.shift.findFirst({where:{cafeId:order.cafeId,branchId:order.branchId,cashierId:order.createdById,openedAt:{lte:order.createdAt},OR:[{closedAt:null},{closedAt:{gte:order.createdAt}}]},orderBy:{openedAt:'desc'}}):null;
}
export async function previewAmendment(actor:SessionUser,orderId:string,raw:unknown){
 const keys=await salesAuthority(actor,'sales.edit');const input=amendmentSchema.parse(raw);
 return protectedTransaction(async tx=>{const order=await readOrder(tx,orderId,actor);const proposed=await proposal(tx,order,input,keys);return {before:receiptSnapshot(order),proposed};},resolveReadScope(actor));
}
export async function stageAmendment(actor:SessionUser,orderId:string,raw:unknown,requestKey:string){
 const keys=await salesAuthority(actor,'sales.edit');const input=amendmentSchema.parse(raw);if(requestKey.length<16||requestKey.length>64)throw new ApiError(400,'مفتاح طلب غير صالح');
 const requestHash=fingerprint({orderId,input});
 return protectedTransaction(async tx=>{
  const previous=await tx.orderAmendment.findFirst({where:{requesterId:actor.id,requestKey,...resolveReadScope(actor)}});
  if(previous){if(previous.requestHash!==requestHash)throw new ApiError(409,'المفتاح مستخدم لتعديل مختلف');return previous;}
  await lockOrders(tx,[orderId]);await lockOrderPayments(tx,[orderId]);
  const order=await readOrder(tx,orderId,actor),proposed=await proposal(tx,order,input,keys),shift=await originalShift(tx,order);
  const limits=await tx.salesDiscountLimit.findUnique({where:{userId:actor.id}});
  const discountPercent=decimal(proposed.subtotal).isZero()?decimal(0):decimal(proposed.discountAmount).times(100).div(proposed.subtotal);
  const exceeds=decimal(proposed.discountAmount).gt(limits?.maxAmount??0)||discountPercent.gt(limits?.maxPercent??0);
  const closed=shift?shift.status!=='OPEN':true;
  const approvalRequired=closed||(!isManager(actor)&&exceeds);
  const ownerApprovalRequired=proposed.settlement.direction==='REFUND'||proposed.quantityRemoved.length>0;
  if(ownerApprovalRequired&&!keys.has('orders.request_owner_action'))throw new ApiError(403,'صلاحية طلب موافقة المالك مطلوبة للمرتجع أو إزالة الأصناف');
  const amendment=await tx.orderAmendment.create({data:{cafeId:order.cafeId,branchId:order.branchId,orderId,requesterId:actor.id,requestKey,requestHash,baseRevision:order.revision,fingerprint:stateHash(order),before:receiptSnapshot(order),proposed:json(proposed),reason:input.reason,approvalRequired,ownerApprovalRequired,originalShiftId:shift?.id,originalShiftClosed:closed,status:approvalRequired||ownerApprovalRequired?'PENDING_APPROVAL':'READY'}});
  // Reuse the configured owner's request/passcode policy for refunds AND removals.
  const settings=ownerApprovalRequired?await tx.ownerActionSettings.findUnique({where:{cafeId:order.cafeId}}):null;
  if(ownerApprovalRequired&&!settings)throw new ApiError(409,'اضبط موافقات المالك أولًا');
  if(ownerApprovalRequired&&settings!.ownerId===actor.id){
   await tx.orderAmendment.update({where:{id:amendment.id},data:{approverId:actor.id,approvalSettingsVersion:settings!.version,status:approvalRequired&&!isManager(actor)?'PENDING_APPROVAL':'READY'}});
  }else if(ownerApprovalRequired){
   const refund=proposed.settlement.direction==='REFUND'?await requestOwnerAction({actor,action:'AMEND_ORDER_REFUND',amendmentId:amendment.id,reason:input.reason,idempotencyKey:requestKey.slice(0,56)+'-refund'},tx):null;
   const voiding=proposed.quantityRemoved.length?await requestOwnerAction({actor,action:'AMEND_ORDER_VOID',amendmentId:amendment.id,reason:input.reason,idempotencyKey:requestKey.slice(0,56)+'-void'},tx):null;
   await tx.orderAmendment.update({where:{id:amendment.id},data:{ownerRequestId:refund?.requestId,ownerVoidRequestId:voiding?.requestId,approvalSettingsVersion:settings!.version}});
  }
  await trace(tx,actor,order,'AMENDMENT_STAGED',input.reason,{before:receiptSnapshot(order),after:proposed,approvalRequired,ownerApprovalRequired},amendment);
  return tx.orderAmendment.findUniqueOrThrow({where:{id:amendment.id}});
 },resolveReadScope(actor));
}

async function getAmendment(tx:Prisma.TransactionClient,id:string,actor:SessionUser){const a=await tx.orderAmendment.findFirst({where:{id,...resolveReadScope(actor)}});if(!a)throw new ApiError(404,'التعديل غير موجود');return a;}
export async function approveAmendment(actor:SessionUser,id:string){
 await salesAuthority(actor,'sales.approve');if(!isManager(actor))throw new ApiError(403,'اعتماد المدير مطلوب');
 return protectedTransaction(async tx=>{const a=await getAmendment(tx,id,actor);await lockOrders(tx,[a.orderId]);const order=await readOrder(tx,a.orderId,actor);if(stateHash(order)!==a.fingerprint)throw new ApiError(409,'التعديل قديم');if(a.status==='COMMITTED')return a;
  await tx.orderAmendment.update({where:{id},data:{approverId:actor.id}});await trace(tx,actor,order,'AMENDMENT_MANAGER_APPROVED',a.reason,{approverId:actor.id},a);return {approved:true};
 },resolveReadScope(actor));
}
async function approvals(tx:Prisma.TransactionClient,a:OrderAmendment,actor:SessionUser){
 if(a.approvalRequired&&!a.approverId)throw new ApiError(409,'التعديل يحتاج موافقة المدير');
 if(a.approverId){const approver=await tx.user.findFirst({where:{id:a.approverId,cafeId:a.cafeId,isActive:true,archivedAt:null,role:{in:['CAFE_OWNER','BRANCH_MANAGER']},OR:[{branchId:null,role:'CAFE_OWNER'},{branchId:a.branchId}]}});if(!approver||!(await resolvePermissions({id:approver.id,cafeId:approver.cafeId,branchId:approver.branchId,role:approver.role,email:approver.email,name:approver.name})).keys.has('sales.approve'))throw new ApiError(409,'موافقة المدير لم تعد صالحة');}
 if(!a.ownerApprovalRequired)return;
 const settings=await tx.ownerActionSettings.findUnique({where:{cafeId:a.cafeId}});if(!settings||settings.version!==a.approvalSettingsVersion)throw new ApiError(409,'إعدادات موافقة المالك اتغيرت');
 if(!await tx.user.findFirst({where:{id:settings.ownerId,cafeId:a.cafeId,role:'CAFE_OWNER',isActive:true,archivedAt:null},select:{id:true}}))throw new ApiError(409,'المالك المعتمد غير متاح');
 if(settings.ownerId===a.requesterId&&a.approverId===a.requesterId)return;
 for(const id of [a.ownerRequestId,a.ownerVoidRequestId].filter((x):x is string=>!!x)){
  const r=await tx.ownerActionRequest.findUnique({where:{id}});
  if(!r||r.status!=='APPROVED'||r.ownerId!==settings.ownerId||r.requesterId!==a.requesterId||r.targetAmendmentId!==a.id||!r.executionExpiresAt||r.executionExpiresAt<=new Date())throw new ApiError(409,'موافقة المالك المطلوبة غير متاحة');
  if(r.decisionMethod==='OWNER_PASSCODE'){const credential=await tx.ownerPasscode.findUnique({where:{cafeId:a.cafeId},select:{ownerId:true,version:true}});if(!credential||credential.ownerId!==r.ownerId||credential.version!==r.credentialVersion)throw new ApiError(409,'رمز موافقة المالك اتغير؛ اطلب موافقة جديدة');}
  const current=await targetFor(tx,{actor,action:r.action,amendmentId:a.id});if(fingerprint(current.snapshot)!==r.targetFingerprint)throw new ApiError(409,'هدف الموافقة اتغير');
 }
 if(!a.ownerRequestId&&!a.ownerVoidRequestId)throw new ApiError(409,'موافقة المالك غير مكتملة');
}

async function currentProposalAuthority(tx:Prisma.TransactionClient,a:OrderAmendment,actor:SessionUser,keys:Set<string>){
 const p=a.proposed as unknown as Proposed;
 for(const key of p.requiredPermissions??[])if(!keys.has(key))throw new ApiError(403,'صلاحية التعديل لم تعد متاحة: '+key);
 const limit=await tx.salesDiscountLimit.findUnique({where:{userId:a.requesterId}});
 const percent=decimal(p.subtotal).isZero()?decimal(0):decimal(p.discountAmount).times(100).div(p.subtotal);
 if(!isManager(actor)&&!a.approverId&&(decimal(p.discountAmount).gt(limit?.maxAmount??0)||percent.gt(limit?.maxPercent??0)))throw new ApiError(409,'حد الخصم الحالي يحتاج موافقة المدير');
}
async function financialContext(tx:Prisma.TransactionClient,a:OrderAmendment,actor:SessionUser,allowReserved=false,recovery?:{shiftId:string;cashierId:string}){
 const shift=await tx.shift.findFirst({where:{branchId:a.branchId,cafeId:a.cafeId,cashierId:recovery?.cashierId??actor.id,status:'OPEN',...(recovery?{id:recovery.shiftId}:{})},orderBy:{openedAt:'desc'}});
 if(!shift)throw new ApiError(409,'افتح شيفت بعهدتك في فرع الطلب');
 const waste=(a.proposed as unknown as Proposed).wastePlan?.length;
 const custody=waste?await tx.custodyPeriod.findFirst({where:{cafeId:a.cafeId,branchId:a.branchId,scope:'STOCK',status:'OPEN'},select:{id:true,responsibleShiftId:true}}):null;
 await lockShifts(tx,[...new Set([shift.id,a.originalShiftId,custody?.responsibleShiftId].filter((x):x is string=>!!x))]);await validateOpenPostingShift(tx,shift.id,a.branchId,a.cafeId);
 await lockOrders(tx,[a.orderId],allowReserved?a.id:undefined);await lockOrderPayments(tx,[a.orderId]);
 const order=await readOrder(tx,a.orderId,actor);
 if(stateHash(order)!==a.fingerprint){if(await tx.orderRevision.findUnique({where:{amendmentId:a.id}}))return {shift,order,custody};throw new ApiError(409,'الطلب اتغير؛ أنشئ معاينة جديدة');}
 const original=a.originalShiftId?await tx.shift.findUnique({where:{id:a.originalShiftId},select:{status:true}}):null;
 if((!original||original.status!=='OPEN')&&!a.approverId)throw new ApiError(409,'الشيفت الأصلي اتقفل؛ يلزم اعتماد المدير قبل المتابعة');
 return {shift,order,custody};
}
export async function beginAmendmentSettlement(actor:SessionUser,id:string,requestKey:string,method:Exclude<PaymentMethod,'MIXED'>){
 const keys=await salesAuthority(actor,'sales.edit');if(!keys.has('pos.collect_payment'))throw new ApiError(403,'صلاحية التحصيل مطلوبة');
 if(!['CASH','CARD','WALLET'].includes(method)||requestKey.length<16||requestKey.length>64)throw new ApiError(400,'طلب تسوية غير صالح');
 return protectedTransaction(async tx=>{
  let a=await getAmendment(tx,id,actor);if(a.requesterId!==actor.id)throw new ApiError(403,'الطلب خاص بمحرر آخر');
  const {shift,order}=await financialContext(tx,a,actor,true);
  a=await getAmendment(tx,id,actor);
  if(a.status==='CANCELLED')throw new ApiError(409,'التعديل ملغي؛ أنشئ طلبًا جديدًا');
  const old=await tx.amendmentSettlement.findUnique({where:{amendmentId_requestKey:{amendmentId:id,requestKey}}});if(old)return old;
  if(a.status==='COMMITTED')throw new ApiError(409,'التعديل مكتمل');
  if(await tx.amendmentSettlement.findFirst({where:{amendmentId:id,status:{in:['PENDING','OBSERVED','UNKNOWN','CONFIRMED']}}}))throw new ApiError(409,'راجع محاولة التسوية الحالية قبل إعادة المحاولة');
  await currentProposalAuthority(tx,a,actor,keys);
  const authorization=await approvalEvidence(tx,a,actor);
  const p=a.proposed as unknown as Proposed,s=p.settlement;
  if(a.ownerApprovalRequired&&!keys.has('orders.request_owner_action'))throw new ApiError(403,'صلاحية المرتجع أو إزالة الأصناف غير متاحة');
  if(s.direction==='NONE')throw new ApiError(400,'لا توجد حركة مالية مطلوبة');
  const legs=s.direction==='REFUND'?allocateRefund(s.amount,order.payments.filter(p=>p.type==='COLLECTION'&&p.status==='PAID'&&!p.reversalOfPaymentId).map(p=>({id:p.id,method:p.method,amount:p.amount,refunded:sumMoney(order.payments.filter(r=>r.type==='REFUND'&&r.status==='PAID'&&r.reversalOfPaymentId===p.id).map(r=>r.amount))}))):[{paymentId:null,method,amount:s.amount}];
  const attempt=await tx.amendmentSettlement.create({data:{amendmentId:id,cafeId:a.cafeId,branchId:a.branchId,actorId:actor.id,shiftId:shift.id,requestKey,direction:s.direction,amount:s.amount,legs:json(legs),evidence:json({authorization})}});
  await tx.order.update({where:{id:order.id},data:{activeAmendmentId:id}});await tx.orderAmendment.update({where:{id},data:{status:'SETTLING',approverId:a.approverId??authorization.ownerApproverId}});
  await trace(tx,actor,order,'SETTLEMENT_STARTED',a.reason,{attemptId:attempt.id,direction:s.direction,amount:s.amount,legs,authorization},a,shift.id);return attempt;
 },resolveReadScope(actor));
}

// Evidence is durably observed BEFORE applying internal records. A later stock/DB
// failure leaves a recoverable observed attempt, never a prompt to move money again.
export async function observeAmendmentSettlement(actor:SessionUser,id:string,attemptId:string,outcome:'CONFIRMED'|'FAILED'|'UNKNOWN',evidence:{confirmed:boolean;reference:string;note:string;references?:Record<string,string>}){
 const keys=await salesAuthority(actor,'sales.edit');
 return protectedTransaction(async tx=>{const a=await getAmendment(tx,id,actor);let attempt=await tx.amendmentSettlement.findFirst({where:{id:attemptId,amendmentId:id}});if(!attempt)throw new ApiError(404,'المحاولة غير موجودة');
  if(attempt.actorId!==actor.id&&!(isManager(actor)&&keys.has('sales.approve')))throw new ApiError(403,'محاولة محرر آخر');await lockOrders(tx,[a.orderId],a.id);
  attempt=await tx.amendmentSettlement.findUniqueOrThrow({where:{id:attemptId}});
  if(['OBSERVED','CONFIRMED'].includes(attempt.status))return attempt;
  if(attempt.status==='FAILED')throw new ApiError(409,'المحاولة فشلت؛ ابدأ محاولة جديدة فقط بعد التأكد من عدم تحرك الأموال');
  if(attempt.status==='UNKNOWN'&&(!isManager(actor)||!keys.has('sales.approve')))throw new ApiError(409,'الحالة غير مؤكدة؛ المدير يراجعها قبل المتابعة');
  if(attempt.actorId!==actor.id&&evidence.note.trim().length<3)throw new ApiError(400,'اكتب دليل التحقق عند تسوية محاولة موظف آخر');
  const legs=attempt.legs as unknown as {method:string}[];
  const channels=[...new Set(legs.map(l=>l.method).filter(m=>m!=='CASH'))];
  const refs=channels.map(method=>({method,reference:(evidence.references?.[method]??(channels.length===1?evidence.reference:'')).trim().toUpperCase()}));
  if(outcome==='CONFIRMED'&&(!evidence.confirmed||refs.some(r=>r.reference.length<3||r.reference.length>200)))throw new ApiError(400,'أكد الحركة الفعلية وأدخل مرجعًا مستقلًا لكل وسيلة إلكترونية');
  if(outcome!=='CONFIRMED'&&evidence.note.trim().length<3)throw new ApiError(400,'اكتب نتيجة المحاولة');
  if(outcome==='CONFIRMED')for(const ref of refs){
   // Unique references are the manual-settlement counterpart to a provider id.
   // Repeated confirmation of this attempt returns above without inserting twice.
   const existing=await tx.amendmentTenderReference.findUnique({where:{cafeId_method_reference:{cafeId:a.cafeId,...ref}}});
   if(existing&&existing.attemptId!==attempt.id)throw new ApiError(409,'مرجع التسوية مسجل لمحاولة أخرى؛ راجع المدير ولا تحرك الأموال مرة أخرى');
   await tx.amendmentTenderReference.create({data:{cafeId:a.cafeId,branchId:a.branchId,attemptId:attempt.id,actorId:actor.id,...ref}});
  }
  const next=await tx.amendmentSettlement.update({where:{id:attempt.id},data:{status:outcome==='CONFIRMED'?'OBSERVED':outcome,evidence:json({...attempt.evidence as object,physical:evidence,observingActorId:actor.id}),observedAt:outcome==='CONFIRMED'?new Date():null,failureReason:outcome==='FAILED'?evidence.note:null}});
  if(outcome==='FAILED'){await tx.order.update({where:{id:a.orderId},data:{activeAmendmentId:null}});await tx.orderAmendment.update({where:{id},data:{status:'READY'}});}
  await trace(tx,actor,await readOrder(tx,a.orderId,actor),'SETTLEMENT_'+outcome,a.reason,{attemptId:attempt.id,evidence},a,attempt.shiftId);return next;
 },resolveReadScope(actor));
}

export async function commitAmendment(actor:SessionUser,id:string){
 const keys=await salesAuthority(actor,'sales.edit');
 return protectedTransaction(async tx=>{
  let a=await getAmendment(tx,id,actor);
  if(a.status==='COMMITTED'&&(a.requesterId===actor.id||(isManager(actor)&&keys.has('sales.approve'))))return tx.orderRevision.findUniqueOrThrow({where:{amendmentId:id}});
  const recovery=a.requesterId!==actor.id?await tx.amendmentSettlement.findFirst({where:{amendmentId:id,status:'OBSERVED'}}):null;
  if(a.requesterId!==actor.id&&(!recovery||!isManager(actor)||!keys.has('sales.approve')))throw new ApiError(403,'استكمال تسوية مؤكدة لمحرر آخر يحتاج مديرًا مخولًا');
  if(a.status==='COMMITTED')return tx.orderRevision.findUniqueOrThrow({where:{amendmentId:id}});
  if(a.status==='CANCELLED')throw new ApiError(409,'التعديل ملغي');
  const {order,shift,custody}=await financialContext(tx,a,actor,true,recovery?{shiftId:recovery.shiftId,cashierId:recovery.actorId}:undefined);
  // Re-read after the order serialization point: duplicate commits return history.
  a=await getAmendment(tx,id,actor);if(a.status==='COMMITTED')return tx.orderRevision.findUniqueOrThrow({where:{amendmentId:id}});
  if(a.status==='CANCELLED')throw new ApiError(409,'التعديل ملغي');
  const p=a.proposed as unknown as Proposed;
  const attempt=await tx.amendmentSettlement.findFirst({where:{amendmentId:id,status:{in:['OBSERVED','CONFIRMED']}},orderBy:{createdAt:'desc'}});
  if(p.settlement.direction!=='NONE'&&(!attempt||attempt.status!=='OBSERVED'||attempt.shiftId!==shift.id))throw new ApiError(409,'أكد التسوية الفعلية أولًا؛ لا تعِد تحريك الأموال');
  // Approvals were consumed/reserved at START before money moved. No-settlement
  // revisions validate them here, while recovery applies only the frozen proposal.
  if(!attempt){await currentProposalAuthority(tx,a,actor,keys);
  if(a.ownerApprovalRequired&&!keys.has('orders.request_owner_action'))throw new ApiError(403,'صلاحية المرتجع أو إزالة الأصناف غير متاحة');
  }
  const authorization=attempt?(attempt.evidence as {authorization?:unknown})?.authorization:await approvalEvidence(tx,a,actor);
  if(!a.approverId&&!attempt){const ownerId=(authorization as {ownerApproverId?:string|null})?.ownerApproverId;if(ownerId)a=await tx.orderAmendment.update({where:{id},data:{approverId:ownerId}});}
  if(order.tableSessionId)await lockTableSessions(tx,[order.tableSessionId]);
  const now=new Date();
  for(const item of order.items.filter(i=>!i.voidedAt)){
   const next=p.lines.find(l=>l.id===item.id);
   if(!next){await tx.orderItem.update({where:{id:item.id},data:{voidedAt:now,voidedById:actor.id,voidReason:a.reason,kitchenStatus:'CANCELLED'}});continue;}
   await tx.orderItem.update({where:{id:item.id},data:{quantity:next.quantity,unitPrice:next.unitPrice,lineTotal:next.lineTotal!,itemDiscountType:next.discount.type,itemDiscountValue:next.discount.value,itemDiscountAmount:next.itemDiscount!,invoiceDiscountShare:next.invoiceShare!}});
  }
  for(const next of p.lines.filter(l=>!order.items.some(i=>i.id===l.id))){
   await tx.orderItem.create({data:{id:next.id,orderId:order.id,productId:next.productId,variantId:next.variantId,productName:next.productName,variantName:next.variantName,quantity:next.quantity,unitPrice:next.unitPrice,lineTotal:next.lineTotal!,notes:next.notes,itemDiscountType:next.discount.type,itemDiscountValue:next.discount.value,itemDiscountAmount:next.itemDiscount!,invoiceDiscountShare:next.invoiceShare!,addOns:{create:next.addOns}}});
  }
  await tx.order.update({where:{id:order.id},data:{subtotal:p.subtotal,total:p.total,discountAmount:p.discountAmount,taxAmount:p.taxAmount,serviceChargeAmount:p.serviceChargeAmount,invoiceDiscountType:p.invoiceDiscount.type,invoiceDiscountValue:p.invoiceDiscount.value}});
  const movementIds:string[]=[];
  if(attempt){
   const legs=attempt.legs as unknown as {paymentId:string|null;method:Exclude<PaymentMethod,'MIXED'>;amount:string}[];
   if(attempt.direction==='COLLECTION'){
    const result=await applyOrderPaymentInTx(tx,{orderId:order.id,splits:legs.map(l=>({method:l.method,amount:l.amount})),cashierId:attempt.actorId,shiftId:shift.id,note:`تسوية التعديل ${id}`});
    for(const [index,payment] of result.payments.entries()){await tx.payment.update({where:{id:payment.id},data:{amendmentId:id,amendmentLegKey:attempt.id+':'+index}});movementIds.push(payment.id);}
   }else{
    for(const [index,leg] of legs.entries()){
     const original=order.payments.find(p=>p.id===leg.paymentId&&p.type==='COLLECTION'&&p.status==='PAID');
     const refunded=sumMoney(order.payments.filter(r=>r.reversalOfPaymentId===leg.paymentId&&r.type==='REFUND'&&r.status==='PAID').map(r=>r.amount));
     if(!original||original.method!==leg.method||money(original.amount.minus(refunded)).lt(leg.amount))throw new ApiError(409,'رصيد المرتجع اتغير؛ احتفظ بإثبات التسوية وراجع المدير');
     const payment=await tx.payment.create({data:{cafeId:a.cafeId,branchId:a.branchId,orderId:order.id,shiftId:shift.id,cashierId:attempt.actorId,receivedById:attempt.actorId,amount:leg.amount,method:leg.method,type:'REFUND',status:'PAID',reversalOfPaymentId:original.id,refundReason:a.reason,tableSessionId:order.tableSessionId,amendmentId:id,amendmentLegKey:attempt.id+':'+index,note:`تسوية التعديل ${id}`}});movementIds.push(payment.id);
    }
   }
   await tx.amendmentSettlement.update({where:{id:attempt.id},data:{status:'CONFIRMED'}});
  }
  const payments=await tx.payment.findMany({where:{orderId:order.id}}),paid=collectedAmountExact(payments),remaining=money(decimal(p.total).minus(paid));
  if(remaining.lt(0))throw new ApiError(409,'التسوية غير متوازنة');
  await tx.order.update({where:{id:order.id},data:{revision:{increment:1},activeAmendmentId:null,paidAmount:paid,remainingAmount:remaining,paymentStatus:remaining.isZero()?'PAID':paid.gt(0)?'PARTIAL':'UNPAID'}});
  const wasteEvidence=[];
  if(p.wastePlan?.length){await acquireInventorySharedLocks(tx,[a.branchId]);const attribution=await amendmentStockCustody(tx,a,custody);for(const d of [...p.wastePlan].sort((a,b)=>a.inventoryItemId.localeCompare(b.inventoryItemId))){const item=await lockItemForUpdate(tx,d.inventoryItemId);wasteEvidence.push(await applyStockMutation(tx,{cafeId:a.cafeId,branchId:a.branchId,inventoryItemId:d.inventoryItemId,type:"WASTE",quantity:-d.required,orderId:a.orderId,createdById:actor.id,unitCost:item.costPerUnit,attribution,allowNegative:allowsKnownShortage(order.inventoryEnforcementMode),note:`Prepared quantity removed in amendment ${id}: ${a.reason}`}));}}
  const after=await readOrder(tx,order.id,actor);
  const revision=await tx.orderRevision.create({data:{orderId:order.id,number:after.revision,amendmentId:id,cafeId:a.cafeId,branchId:a.branchId,actorId:a.requesterId,approverId:a.approverId,originalCashierId:order.createdById,originalShiftId:a.originalShiftId,postingShiftId:shift.id,reason:a.reason,before:receiptSnapshot(order),after:receiptSnapshot(after),oldTotal:order.total,newTotal:p.total,discountDelta:money(decimal(p.discountAmount).minus(order.discountAmount)),recognizedDelta:order.status==='SERVED'?money(decimal(p.total).minus(order.total).plus(p.settlement.direction==='REFUND'?p.settlement.amount:0)):0}});
  await tx.orderAmendment.update({where:{id},data:{status:'COMMITTED',kitchenStatus:order.status==='SERVED'&&p.positiveLines.length?'PENDING':null,stockPlan:order.status==='SERVED'?json(p.stockPlan):Prisma.DbNull}});
  await recomputeShiftTotals(shift.id,tx);if(order.tableSessionId)await recomputeSessionTotals(order.tableSessionId,tx);
  await trace(tx,actor,after,'ORDER_AMENDED',a.reason,{before:receiptSnapshot(order),after:receiptSnapshot(after),editingUserId:a.requesterId,commitActorId:actor.id,managerRecovery:!!recovery,authorization,difference:money(decimal(p.total).minus(order.total)),payments:movementIds,settlement:attempt?{id:attempt.id,status:'CONFIRMED',evidence:attempt.evidence}:null,kitchen:{added:p.positiveLines,removed:p.quantityRemoved},stock:{restored:0,wasteEvidence,reason:'Prepared ingredients are not automatically returned'}},a,shift.id);
  return revision;
 },resolveReadScope(actor));
}

export async function cancelAmendment(actor:SessionUser,id:string){
 await salesAuthority(actor,'sales.edit');return protectedTransaction(async tx=>{let a=await getAmendment(tx,id,actor);if(a.requesterId!==actor.id&&!isManager(actor))throw new ApiError(403,'غير مسموح');await lockOrders(tx,[a.orderId],a.id);a=await getAmendment(tx,id,actor);if(a.status==='COMMITTED')throw new ApiError(409,'التعديل مكتمل');if(a.status==='CANCELLED')return {cancelled:true};if(await tx.amendmentSettlement.findFirst({where:{amendmentId:id,status:{in:['PENDING','UNKNOWN','OBSERVED','CONFIRMED']}}}))throw new ApiError(409,'راجع التسوية أولًا؛ لا يمكن إلغاء حركة أموال غير محسومة');await tx.orderAmendment.update({where:{id},data:{status:'CANCELLED'}});await tx.order.update({where:{id:a.orderId},data:{activeAmendmentId:null}});await trace(tx,actor,await readOrder(tx,a.orderId,actor),'AMENDMENT_CANCELLED',a.reason,{},a);return {cancelled:true};},resolveReadScope(actor));
}

async function approvalEvidence(tx:Prisma.TransactionClient,a:OrderAmendment,actor:SessionUser){
 await approvals(tx,a,actor);
 const ownerRequests=await tx.ownerActionRequest.findMany({where:{id:{in:[a.ownerRequestId,a.ownerVoidRequestId].filter((x):x is string=>!!x)}},select:{id:true,ownerId:true,decidedById:true,decisionMethod:true,mode:true,settingsVersion:true,decidedAt:true,executionExpiresAt:true,targetFingerprint:true}});
 const ownerApproverId=ownerRequests[0]?.ownerId??(a.ownerApprovalRequired?a.approverId:null);
 return {managerApproverId:a.approvalRequired?a.approverId:null,ownerApproverId,ownerRequests,settingsVersion:a.approvalSettingsVersion};
}

export async function revisionReceipt(actor:SessionUser,orderId:string,revision:number,reprint:boolean,logPrint=true){
 await salesAuthority(actor,reprint?'receipts.reprint':'receipts.print');await salesAuthority(actor,'sales.view');
 return protectedTransaction(async tx=>{const order=await readOrder(tx,orderId,actor);if(!Number.isInteger(revision)||revision<0||revision>order.revision)throw new ApiError(404,'المراجعة غير موجودة');
  const saved=revision===0?await tx.orderRevision.findFirst({where:{orderId},orderBy:{number:'asc'}}):await tx.orderRevision.findUnique({where:{orderId_number:{orderId,number:revision}}});
  const snapshot=saved?(revision===0?saved.before:saved.after):receiptSnapshot(order);
  if(logPrint)await trace(tx,actor,order,reprint?'RECEIPT_REPRINT_REQUESTED':'RECEIPT_PRINT_REQUESTED','طلب طباعة فقط — لا يثبت نجاح الطابعة',{revision,snapshot});return {orderId,revision,snapshot};
 },resolveReadScope(actor));
}

export async function serveAmendmentAdditions(actor:SessionUser,id:string){
 await salesAuthority(actor,'kitchen.update_status');
 return protectedTransaction(async tx=>{
  const a=await getAmendment(tx,id,actor);
  const custody=await tx.custodyPeriod.findFirst({where:{cafeId:a.cafeId,branchId:a.branchId,scope:'STOCK',status:'OPEN'},select:{id:true,responsibleShiftId:true}});
  if(custody?.responsibleShiftId)await lockShifts(tx,[custody.responsibleShiftId]);
  await lockOrders(tx,[a.orderId]);await lockOrderPayments(tx,[a.orderId]);
  const fresh=await getAmendment(tx,id,actor);if(fresh.kitchenStatus==='SERVED')return {alreadyServed:true};if(fresh.status!=='COMMITTED'||fresh.kitchenStatus!=='PENDING')throw new ApiError(409,'إضافات التحضير غير متاحة');
  const order=await readOrder(tx,a.orderId,actor),p=a.proposed as unknown as Proposed;
  if(['CANCELLED','REJECTED'].includes(order.status))throw new ApiError(409,'راجع إلغاء الطلب قبل تسليم الإضافات');
  await acquireInventorySharedLocks(tx,[a.branchId]);
  const attribution=await amendmentStockCustody(tx,a,custody);
  const stock=[];
  for(const d of [...(a.stockPlan as unknown as Proposed['stockPlan'])].sort((a,b)=>a.inventoryItemId.localeCompare(b.inventoryItemId))){
   const item=await lockItemForUpdate(tx,d.inventoryItemId);
   const mutation=await applyStockMutation(tx,{cafeId:a.cafeId,branchId:a.branchId,inventoryItemId:d.inventoryItemId,type:'USAGE',quantity:-d.required,orderId:a.orderId,createdById:actor.id,unitCost:item.costPerUnit,attribution,allowNegative:allowsKnownShortage(order.inventoryEnforcementMode),note:`إضافات مراجعة ${a.baseRevision+1}: ${a.reason}`});stock.push({...d,...mutation});
  }
  await tx.orderItem.updateMany({where:{orderId:a.orderId,id:{in:p.positiveLines.map(l=>l.id)},voidedAt:null},data:{kitchenStatus:'SERVED'}});
  await tx.orderAmendment.update({where:{id},data:{kitchenStatus:'SERVED'}});
  await trace(tx,actor,order,'AMENDMENT_ADDITIONS_SERVED',a.reason,{lines:p.positiveLines,stock},a);return {served:true,stock:json(stock)};
 },resolveReadScope(actor));
}

async function amendmentStockCustody(tx:Prisma.TransactionClient,a:{cafeId:string;branchId:string},expected:{id:string;responsibleShiftId:string|null}|null){
 const rows=await tx.$queryRaw<{id:string;holderType:string;responsibleShiftId:string|null}[]>`SELECT "id","holderType","responsibleShiftId" FROM "CustodyPeriod" WHERE "cafeId"=${a.cafeId} AND "branchId"=${a.branchId} AND "scope"='STOCK' AND "status"='OPEN' FOR UPDATE`;
 const custody=rows[0];if(!custody||custody.holderType!=='USER'||!custody.responsibleShiftId||custody.id!==expected?.id||custody.responsibleShiftId!==expected?.responsibleShiftId)throw new ApiError(409,'عهدة المخزون غير جاهزة أو اتغيرت؛ أكمل التسليم والاستلام أولًا');
 await assertOpeningReceiptEvidence(tx,custody.responsibleShiftId);return {custodyPeriodId:custody.id,shiftId:custody.responsibleShiftId};
}
