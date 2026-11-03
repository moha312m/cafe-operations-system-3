import { ZodError } from "zod";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { requireActiveSession,ApiError,handleApiError } from "@/lib/api";
import { protectedTransaction } from "@/lib/protected-transaction";
import { withIdempotency,requestScope,requestFingerprint } from "@/lib/idempotency";
import { sqlState } from "@/lib/database-errors";
import { requireMoneyAuthority,type TreasuryKey } from "./treasury-authorization";
import { findAccount } from "./treasury-accounts";
import { findTransfer } from "./treasury-transfers";
type Target={accountIds?:string[];transferId?:string};
async function initial(){const a=await requireActiveSession();if(a.role!=="CAFE_OWNER"||!a.cafeId)throw new ApiError(403,"هذه المرحلة للمالك فقط");return a;}
export async function treasuryRead<T>(work:(tx:Prisma.TransactionClient,actor:SessionUser)=>Promise<T>){const a=await initial();return protectedTransaction(async tx=>work(tx,await requireMoneyAuthority(tx,a.cafeId!,"treasury.view")),{cafeId:a.cafeId!});}
export async function treasuryWrite(request:Request,key:TreasuryKey,operation:string,body:unknown,target:Target,work:(tx:Prisma.TransactionClient,actor:SessionUser,key:string,fingerprint:string)=>Promise<unknown>){
 const a=await initial();let actor=a;let businessRefusal:ApiError|undefined;
 try{return await withIdempotency(request,async tx=>{actor=await requireMoneyAuthority(tx,a.cafeId!,key);for(const id of target.accountIds??[])await findAccount(tx,actor,id);if(target.transferId)await findTransfer(tx,actor,target.transferId);return requestScope(actor,"treasury:"+operation);},body,async tx=>{try{return NextResponse.json(await work(tx,actor,request.headers.get("Idempotency-Key")!.trim(),requestFingerprint(body)),{status:201});}catch(error){if(error instanceof ApiError&&error.status>=400&&error.status<500)businessRefusal=error;throw error;}},{scope:{cafeId:a.cafeId!}});}catch(error){
 // Only a failure thrown by this business callback is known to have rolled back.
 // Reservation contention, authorization, unknown DB/commit and transport failures get NO proof marker.
 if(businessRefusal&&error===businessRefusal)return NextResponse.json({error:businessRefusal.message,outcome:"NOT_COMMITTED"},{status:businessRefusal.status});throw error;
 }
}
export function treasuryError(error:unknown){if(error instanceof ZodError)return handleApiError(new ApiError(400,error.issues.map(i=>i.code==="unrecognized_keys"?"يتضمن الطلب حقولًا غير مسموحة":i.message).join("؛ ")));if(error instanceof SyntaxError)return handleApiError(new ApiError(400,"صيغة الطلب غير صالحة"));if(sqlState(error)==="23514")return handleApiError(new ApiError(409,"الحالة المالية أو الفترة المحاسبية تمنع هذه العملية؛ راجع المستند دون إعادة حركة أموال"));if((error as {code?:string})?.code==="P2002")return handleApiError(new ApiError(409,"الكود أو هوية العملية موجودة بالفعل؛ حدّث المستند للمراجعة"));return handleApiError(error);}
