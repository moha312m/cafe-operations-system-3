import { isSupportedCurrency } from "@/lib/currency";
import { Prisma,type MoneyAccount } from "@prisma/client";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { lockMoneyAccounts } from "@/lib/transaction-locks";
import { assertMoneyActor,moneyAccountWhere } from "./treasury-authorization";
import { accountCreateInput,accountPatchInput,coverageNotice } from "./treasury-rules";
import { addDays,zonedDayStart } from "@/lib/date-range";
export const treasuryFilters=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),from:z.iso.date().optional(),to:z.iso.date().optional()}).strict().refine(x=>!x.from||!x.to||x.from<=x.to,{message:"نهاية الفترة قبل بدايتها"});
export type TreasuryFilters=z.infer<typeof treasuryFilters>;
export const timeFilter=(f:TreasuryFilters)=>({...f.from?{gte:zonedDayStart(f.from)}:{},...f.to?{lt:zonedDayStart(addDays(f.to,1))}:{}});
export async function accountNet(tx:Prisma.TransactionClient,id:string){return (await tx.moneyMovement.aggregate({where:{accountId:id},_sum:{signedAmount:true}}))._sum.signedAmount??new Prisma.Decimal(0);}
export async function accountDto(tx:Prisma.TransactionClient,a:MoneyAccount){return {id:a.id,code:a.code,name:a.name,kind:a.kind,branchId:a.branchId,currency:a.currency,instaPayEnabled:a.instaPayEnabled,isActive:a.isActive,version:a.version,openingState:a.openingState,openingAt:a.openingAt?.toISOString()??null,recordedBalance:a.openingState==="APPROVED"?(await accountNet(tx,a.id)).toFixed(2):null,sourceCoverage:"LIMITED",coverageNotice,realUseReady:false};}
export async function findAccount(tx:Prisma.TransactionClient,actor:SessionUser,id:string){const a=await tx.moneyAccount.findFirst({where:{id,...moneyAccountWhere(actor)}});if(!a)throw new ApiError(404,"الحساب غير موجود في نطاقك");return a;}
export async function createAccount(tx:Prisma.TransactionClient,actor:SessionUser,input:z.infer<typeof accountCreateInput>){
 actor=await assertMoneyActor(tx,actor,"treasury.manage_accounts");const data=accountCreateInput.parse(input);const branchId=data.branchId??null;
 if(actor.branchId&&branchId!==actor.branchId)throw new ApiError(403,"الحساب خارج نطاق الفرع");
 if(branchId&&!await tx.branch.findFirst({where:{id:branchId,cafeId:actor.cafeId!},select:{id:true}}))throw new ApiError(404,"الفرع غير موجود في نطاقك");
 const cafe=await tx.cafe.findUniqueOrThrow({where:{id:actor.cafeId!},select:{currency:true}});if(!isSupportedCurrency(cafe.currency))throw new ApiError(400,"عملة الكافيه غير مدعومة للحسابات حاليًا");
 const row=await tx.moneyAccount.create({data:{...data,branchId,cafeId:actor.cafeId!,currency:cafe.currency,createdById:actor.id}});
 await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_ACCOUNT_CREATED",entity:"MoneyAccount",entityId:row.id,details:{code:row.code,kind:row.kind,branchId,openingState:"UNSET"}});return accountDto(tx,row);
}
export async function patchAccount(tx:Prisma.TransactionClient,actor:SessionUser,id:string,input:z.infer<typeof accountPatchInput>){
 actor=await assertMoneyActor(tx,actor,"treasury.manage_accounts");const {expectedVersion,...changes}=accountPatchInput.parse(input);await lockMoneyAccounts(tx,[id]);const a=await findAccount(tx,actor,id);
 if(a.version!==expectedVersion)throw new ApiError(409,"بيانات الحساب تغيرت؛ حدّثها قبل تعديل جديد");if(changes.instaPayEnabled&&a.kind!=="BANK")throw new ApiError(400,"ربط إنستاباي للبنك فقط");
 if(changes.isActive===false&&a.isActive){const transit=await tx.moneyTransfer.count({where:{cafeId:actor.cafeId!,status:"IN_TRANSIT",OR:[{fromAccountId:id},{toAccountId:id}]}});if(transit||!(await accountNet(tx,id)).isZero())throw new ApiError(409,"الرصيد المسجل أو تحويل قيد النقل يمنع الأرشفة");}
 const row=await tx.moneyAccount.update({where:{id},data:{...changes,version:{increment:1}}});await auditInTransaction(tx,{cafeId:actor.cafeId,userId:actor.id,action:"MONEY_ACCOUNT_UPDATED",entity:"MoneyAccount",entityId:id,details:{expectedVersion,version:row.version,...changes}});return accountDto(tx,row);
}
export async function accountStatement(tx:Prisma.TransactionClient,actor:SessionUser,id:string,filters:TreasuryFilters){
 actor=await assertMoneyActor(tx,actor,"treasury.view");await lockMoneyAccounts(tx,[id]);const a=await findAccount(tx,actor,id);const where={cafeId:actor.cafeId!,accountId:id,occurredAt:timeFilter(filters)};
 const [rows,count]=await Promise.all([tx.moneyMovement.findMany({where,orderBy:[{occurredAt:"asc"},{id:"asc"}],skip:(filters.page-1)*50,take:50}),tx.moneyMovement.count({where})]);
 return {account:await accountDto(tx,a),movements:rows.map(m=>({id:m.id,kind:m.kind,signedAmount:m.signedAmount.toFixed(2),occurredAt:m.occurredAt.toISOString(),actorId:m.actorId,transferId:m.transferId,sourceKey:m.sourceKey,openingReference:m.openingReference})),page:filters.page,pageSize:50,count};
}
