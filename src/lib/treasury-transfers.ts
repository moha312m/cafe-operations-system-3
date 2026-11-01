import type { Prisma,MoneyTransfer } from "@prisma/client";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import { dateStrInTz } from "@/lib/date-range";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { lockMoneyTransfer,lockMoneyAccounts } from "@/lib/transaction-locks";
import { assertMoneyActor,moneyTransferWhere } from "./treasury-authorization";
import { findAccount,accountNet } from "./treasury-accounts";
import { transferCreateInput,dispatchInput,receiveInput,cancelInput,channelAllowed,moneySourceKey,actionReceipt,type MoneyAction } from "./treasury-rules";
export async function findTransfer(tx:Prisma.TransactionClient,actor:SessionUser,id:string){const t=await tx.moneyTransfer.findFirst({where:{id,...moneyTransferWhere(actor)}});if(!t)throw new ApiError(404,"التحويل غير موجود في نطاقك");return t;}
export function transferDto(t:MoneyTransfer){return {id:t.id,fromAccountId:t.fromAccountId,toAccountId:t.toAccountId,amount:t.amount.toFixed(2),currency:t.currency,channel:t.channel,status:t.status,reference:t.reference,note:t.note,fromNameSnapshot:t.fromNameSnapshot,toNameSnapshot:t.toNameSnapshot,createdById:t.createdById,createdAt:t.createdAt.toISOString(),dispatchedById:t.dispatchedById,dispatchedAt:t.dispatchedAt?.toISOString()??null,dispatchReference:t.dispatchReference,receivedById:t.receivedById,receivedAt:t.receivedAt?.toISOString()??null,receiveReference:t.receiveReference,cancelledById:t.cancelledById,cancelledAt:t.cancelledAt?.toISOString()??null,cancelReason:t.cancelReason};}
async function receipt(tx:Prisma.TransactionClient,t:MoneyTransfer,action:MoneyAction){
 if(action==="create")return actionReceipt({transferId:t.id,action,recordedAt:t.createdAt.toISOString(),actorId:t.createdById,reference:t.reference});
 if(action==="cancel")return actionReceipt({transferId:t.id,action,recordedAt:t.cancelledAt!.toISOString(),actorId:t.cancelledById!,reason:t.cancelReason!});
 const movement=await tx.moneyMovement.findUniqueOrThrow({where:{sourceKey:moneySourceKey(action==="dispatch"?"TRANSFER_OUT":"TRANSFER_IN",t.id)}});
 return actionReceipt({transferId:t.id,action,recordedAt:movement.occurredAt.toISOString(),actorId:movement.actorId,movementId:movement.id,reference:action==="dispatch"?t.dispatchReference:t.receiveReference});
}
function matches(actor:SessionUser,key:string,fp:string,original:{key:string|null;fp:string|null;actorId:string|null}){if(original.key===null)return false;if(original.key!==key||original.fp!==fp||original.actorId!==actor.id)throw new ApiError(409,"العملية المنفذة تخص طلبًا أصليًا مختلفًا");return true;}
export async function createTransfer(tx:Prisma.TransactionClient,actor:SessionUser,input:z.infer<typeof transferCreateInput>,key:string,fingerprint:string){
 actor=await assertMoneyActor(tx,actor,"treasury.transfer_create");const data=transferCreateInput.parse(input);
 const old=await tx.moneyTransfer.findUnique({where:{cafeId_createdById_creationKey:{cafeId:actor.cafeId!,createdById:actor.id,creationKey:key}}});
 if(old){await findTransfer(tx,actor,old.id);if(old.creationFingerprint!==fingerprint)throw new ApiError(409,"المفتاح مستخدم لمسودة مختلفة");return receipt(tx,old,"create");}
 await lockMoneyAccounts(tx,[data.fromAccountId,data.toAccountId]);const from=await findAccount(tx,actor,data.fromAccountId),to=await findAccount(tx,actor,data.toAccountId);
 if(!from.isActive||!to.isActive||from.currency!=="EGP"||to.currency!=="EGP"||!channelAllowed(data.channel,from,to))throw new ApiError(400,"الحسابات أو قناة التحويل غير متاحة");
 const row=await tx.moneyTransfer.create({data:{...data,cafeId:actor.cafeId!,currency:"EGP",fromNameSnapshot:from.name,toNameSnapshot:to.name,creationKey:key,creationFingerprint:fingerprint,createdById:actor.id}});
 await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_TRANSFER_CREATED",entity:"MoneyTransfer",entityId:row.id,details:{...data,amount:row.amount.toFixed(2),creationKey:key,recordedAt:row.createdAt}});return receipt(tx,row,"create");
}
async function assertMoneyPeriodOpen(tx:Prisma.TransactionClient,cafeId:string,at:Date){
 // The SQL action trigger already holds the shared close gate and selected this timestamp.
 // Give the caller a definitive refusal; the independent movement trigger remains authoritative.
 const day=new Date(dateStrInTz(at));if(await tx.accountingPeriod.findFirst({where:{cafeId,status:"CLOSED",startsOn:{lte:day},endsOn:{gte:day}},select:{id:true}}))throw new ApiError(409,"الفترة المحاسبية لهذا التوقيت مقفولة؛ لم تُثبت حركة الأموال");
}
async function actionStart(tx:Prisma.TransactionClient,actor:SessionUser,id:string,action:"dispatch"|"receive"|"cancel"){
 const key=action==="dispatch"?"treasury.transfer_dispatch":action==="receive"?"treasury.transfer_receive":"treasury.transfer_cancel";
 actor=await assertMoneyActor(tx,actor,key);await lockMoneyTransfer(tx,id);const t=await findTransfer(tx,actor,id);await lockMoneyAccounts(tx,[t.fromAccountId,t.toAccountId]);return {actor,t};
}
export async function dispatchTransfer(tx:Prisma.TransactionClient,actor:SessionUser,id:string,input:z.infer<typeof dispatchInput>,key:string,fingerprint:string){
 const data=dispatchInput.parse(input),start=await actionStart(tx,actor,id,"dispatch");actor=start.actor;const t=start.t;
 if(matches(actor,key,fingerprint,{key:t.dispatchKey,fp:t.dispatchFingerprint,actorId:t.dispatchedById}))return receipt(tx,t,"dispatch");
 if(t.status!=="DRAFT")throw new ApiError(409,"الصرف متاح لمسودة فقط");const from=await findAccount(tx,actor,t.fromAccountId),to=await findAccount(tx,actor,t.toAccountId);
 if(!from.isActive||!to.isActive||!channelAllowed(t.channel,from,to))throw new ApiError(409,"الحساب أو قناة الصرف غير متاحين");
 if(from.openingState!=="APPROVED")throw new ApiError(409,"الرصيد الافتتاحي غير معتمد؛ الرصيد غير معلوم");if((await accountNet(tx,from.id)).lt(t.amount))throw new ApiError(409,"رصيد الحركات المسجلة غير كافٍ؛ لا يثبت ذلك الرصيد البنكي الفعلي");
 if((from.kind!=="TREASURY"||t.channel==="INSTAPAY")&&!data.reference)throw new ApiError(400,"مرجع الصرف مطلوب للحساب البنكي أو المحفظة أو إنستاباي");
 // SQL guard selects the UTC recording time under the G1 gate; RETURNING supplies that exact time.
 const row=await tx.moneyTransfer.update({where:{id},data:{status:"IN_TRANSIT",dispatchedById:actor.id,dispatchedAt:new Date(),dispatchKey:key,dispatchFingerprint:fingerprint,dispatchReference:data.reference??null}});
 await assertMoneyPeriodOpen(tx,actor.cafeId!,row.dispatchedAt!);
 const movement=await tx.moneyMovement.create({data:{cafeId:actor.cafeId!,accountId:t.fromAccountId,transferId:id,kind:"TRANSFER_OUT",signedAmount:t.amount.negated(),occurredAt:row.dispatchedAt!,actorId:actor.id,sourceKey:moneySourceKey("TRANSFER_OUT",id)}});
 await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_TRANSFER_DISPATCHED",entity:"MoneyTransfer",entityId:id,details:{key,reference:row.dispatchReference,recordedAt:row.dispatchedAt,movementId:movement.id,amount:t.amount.toFixed(2),sourceKey:movement.sourceKey}});return receipt(tx,row,"dispatch");
}
export async function receiveTransfer(tx:Prisma.TransactionClient,actor:SessionUser,id:string,input:z.infer<typeof receiveInput>,key:string,fingerprint:string){
 const data=receiveInput.parse(input),start=await actionStart(tx,actor,id,"receive");actor=start.actor;const t=start.t;
 if(matches(actor,key,fingerprint,{key:t.receiveKey,fp:t.receiveFingerprint,actorId:t.receivedById}))return receipt(tx,t,"receive");
 if(t.status!=="IN_TRANSIT")throw new ApiError(409,"الاستلام متاح لتحويل خرج ولم يُستلم فقط");const to=await findAccount(tx,actor,t.toAccountId);
 if(!to.isActive)throw new ApiError(409,"حساب الاستلام غير نشط");if(to.kind!=="TREASURY"&&!data.reference)throw new ApiError(400,"مرجع الاستلام البنكي أو المحفظة مطلوب");
 // Do not revalidate the current InstaPay flag for funds that already left.
 const row=await tx.moneyTransfer.update({where:{id},data:{status:"RECEIVED",receivedById:actor.id,receivedAt:new Date(),receiveKey:key,receiveFingerprint:fingerprint,receiveReference:data.reference??null}});
 await assertMoneyPeriodOpen(tx,actor.cafeId!,row.receivedAt!);
 const movement=await tx.moneyMovement.create({data:{cafeId:actor.cafeId!,accountId:t.toAccountId,transferId:id,kind:"TRANSFER_IN",signedAmount:t.amount,occurredAt:row.receivedAt!,actorId:actor.id,sourceKey:moneySourceKey("TRANSFER_IN",id)}});
 await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_TRANSFER_RECEIVED",entity:"MoneyTransfer",entityId:id,details:{key,reference:row.receiveReference,recordedAt:row.receivedAt,movementId:movement.id,amount:t.amount.toFixed(2),sourceKey:movement.sourceKey}});return receipt(tx,row,"receive");
}
export async function cancelTransfer(tx:Prisma.TransactionClient,actor:SessionUser,id:string,input:z.infer<typeof cancelInput>,key:string,fingerprint:string){
 const data=cancelInput.parse(input),start=await actionStart(tx,actor,id,"cancel");actor=start.actor;const t=start.t;
 if(matches(actor,key,fingerprint,{key:t.cancelKey,fp:t.cancelFingerprint,actorId:t.cancelledById}))return receipt(tx,t,"cancel");if(t.status!=="DRAFT")throw new ApiError(409,"يمكن إلغاء المسودة فقط؛ الأموال المرسلة لها مسار تصحيح منفصل لاحقًا");
 const row=await tx.moneyTransfer.update({where:{id},data:{status:"CANCELLED",cancelledById:actor.id,cancelledAt:new Date(),cancelKey:key,cancelFingerprint:fingerprint,cancelReason:data.reason}});
 await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_TRANSFER_CANCELLED",entity:"MoneyTransfer",entityId:id,details:{key,reason:data.reason,recordedAt:row.cancelledAt}});return receipt(tx,row,"cancel");
}
