import { NextResponse,type NextRequest } from "next/server";
import { treasuryRead,treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { transferCreateInput } from "@/lib/treasury-rules";
import { createTransfer,transferDto } from "@/lib/treasury-transfers";
import { treasuryListFilters, transferListWhere } from "@/lib/treasury-list-filters";
export async function GET(request:NextRequest){try{const q=treasuryListFilters.parse(Object.fromEntries(request.nextUrl.searchParams));return NextResponse.json(await treasuryRead(async(tx,a)=>{const where=transferListWhere({cafeId:a.cafeId!,branchId:a.branchId},q);const [rows,count]=await Promise.all([tx.moneyTransfer.findMany({where,orderBy:[{createdAt:"desc"},{id:"desc"}],skip:(q.page-1)*50,take:50}),tx.moneyTransfer.count({where})]);return {transfers:rows.map(transferDto),page:q.page,pageSize:50,count};}));}catch(e){return treasuryError(e);}}
export async function POST(request:Request){try{const b=transferCreateInput.parse(await request.json());return await treasuryWrite(request,"treasury.transfer_create","transfer:create",b,{accountIds:[b.fromAccountId,b.toAccountId]},(tx,a,k,f)=>createTransfer(tx,a,b,k,f));}catch(e){return treasuryError(e);}}
