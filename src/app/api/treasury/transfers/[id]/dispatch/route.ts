import { treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { dispatchInput } from "@/lib/treasury-rules";
import { dispatchTransfer } from "@/lib/treasury-transfers";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {id}=await params,b=dispatchInput.parse(await request.json());return await treasuryWrite(request,"treasury.transfer_dispatch","transfer:"+id+":dispatch",b,{transferId:id},(tx,a,k,f)=>dispatchTransfer(tx,a,id,b,k,f));}catch(e){return treasuryError(e);}}
