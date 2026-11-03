import { NextResponse,type NextRequest } from "next/server";
import { treasuryRead,treasuryError } from "@/lib/treasury-api";
import { accountStatement,treasuryFilters } from "@/lib/treasury-accounts";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const {id}=await params,q=treasuryFilters.parse(Object.fromEntries(request.nextUrl.searchParams));return NextResponse.json(await treasuryRead((tx,a)=>accountStatement(tx,a,id,q)));}catch(e){return treasuryError(e);}}
