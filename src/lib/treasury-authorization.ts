import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { ApiError,requireActiveSession } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { resolveStaffBranchInTransaction } from "@/lib/staff-branch";
import { protectedContext } from "@/lib/protected-transaction";
export type TreasuryKey="treasury.view"|"treasury.manage_accounts"|"treasury.transfer_create"|"treasury.transfer_dispatch"|"treasury.transfer_receive"|"treasury.transfer_cancel";
export async function assertMoneyActor(tx:Prisma.TransactionClient,actor:SessionUser,key:TreasuryKey):Promise<SessionUser>{
 if(!actor.cafeId)throw new ApiError(403,"نطاق الكافيه مطلوب");
 await tx.$queryRaw`SELECT "id" FROM "Cafe" WHERE "id"=${actor.cafeId} FOR SHARE`;
 await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actor.id} FOR NO KEY UPDATE`;
 const current=await tx.user.findUnique({where:{id:actor.id},include:{cafe:true}});
 if(!current||!current.isActive||current.archivedAt||!current.cafe?.isActive||current.cafeId!==actor.cafeId||current.role!=="CAFE_OWNER")throw new ApiError(403,"هذه المرحلة للمالك النشط فقط");
 if(current.cafeRoleId)await tx.$queryRaw`SELECT "id" FROM "CafeRole" WHERE "id"=${current.cafeRoleId} FOR SHARE`;
 const branch=await resolveStaffBranchInTransaction(tx,actor.id);if(!branch)throw new ApiError(403,"تعذر تحديد نطاق الحساب");
 const fresh:SessionUser={...actor,...branch,cafeId:current.cafeId,role:current.role,name:current.name,email:current.email};
 const {keys}=await resolvePermissions(fresh,tx);if(!keys.has(key))throw new ApiError(403,"ليس لديك صلاحية لهذه العملية");
 protectedContext(tx).scope={cafeId:fresh.cafeId!,...(fresh.branchId?{branchId:fresh.branchId}:{})};return fresh;
}
export async function requireMoneyAuthority(tx:Prisma.TransactionClient,cafeId:string,key:TreasuryKey){
 await tx.$queryRaw`SELECT "id" FROM "Cafe" WHERE "id"=${cafeId} FOR SHARE`;
 const actor=await requireActiveSession(tx);if(actor.cafeId!==cafeId)throw new ApiError(403,"نطاق الحساب تغير");return assertMoneyActor(tx,actor,key);
}
export const moneyAccountWhere=(actor:SessionUser)=>({cafeId:actor.cafeId!,...(actor.branchId?{branchId:actor.branchId}:{})});
export const moneyTransferWhere=(actor:SessionUser)=>({cafeId:actor.cafeId!,...(actor.branchId?{fromAccount:{branchId:actor.branchId},toAccount:{branchId:actor.branchId}}:{})});
