import { NextResponse,type NextRequest } from "next/server";
import { treasuryRead,treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { accountCreateInput } from "@/lib/treasury-rules";
import { createAccount,accountDto } from "@/lib/treasury-accounts";
import { treasuryListFilters, accountListWhere } from "@/lib/treasury-list-filters";
export async function GET(request:NextRequest){try{const q=treasuryListFilters.parse(Object.fromEntries(request.nextUrl.searchParams));return NextResponse.json(await treasuryRead(async(tx,actor)=>{const where=accountListWhere({cafeId:actor.cafeId!,branchId:actor.branchId},q);const [rows,count,branches]=await Promise.all([tx.moneyAccount.findMany({where,orderBy:[{createdAt:"desc"},{id:"desc"}],skip:(q.page-1)*50,take:50}),tx.moneyAccount.count({where}),tx.branch.findMany({where:{cafeId:actor.cafeId!,...(actor.branchId?{id:actor.branchId}:{}),isActive:true},select:{id:true,name:true},orderBy:{name:"asc"}})]);return {accounts:await Promise.all(rows.map(a=>accountDto(tx,a))),branches,count,page:q.page,pageSize:50};}));}catch(e){return treasuryError(e);}}
export async function POST(request:Request){try{const b=accountCreateInput.parse(await request.json());return await treasuryWrite(request,"treasury.manage_accounts","account:create",b,{},(tx,a)=>createAccount(tx,a,b));}catch(e){return treasuryError(e);}}
