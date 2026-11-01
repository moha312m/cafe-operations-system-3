import { NextResponse } from "next/server";
import { treasuryRead,treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { accountPatchInput } from "@/lib/treasury-rules";
import { accountDto,findAccount,patchAccount } from "@/lib/treasury-accounts";
type Params={params:Promise<{id:string}>};
export async function GET(_:Request,{params}:Params){try{const {id}=await params;return NextResponse.json(await treasuryRead(async(tx,a)=>({account:await accountDto(tx,await findAccount(tx,a,id))})));}catch(e){return treasuryError(e);}}
export async function PATCH(request:Request,{params}:Params){try{const {id}=await params,b=accountPatchInput.parse(await request.json());return await treasuryWrite(request,"treasury.manage_accounts","account:"+id+":patch",b,{accountIds:[id]},(tx,a)=>patchAccount(tx,a,id,b));}catch(e){return treasuryError(e);}}
