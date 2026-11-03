import { treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { cancelInput } from "@/lib/treasury-rules";
import { cancelTransfer } from "@/lib/treasury-transfers";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {id}=await params,b=cancelInput.parse(await request.json());return await treasuryWrite(request,"treasury.transfer_cancel","transfer:"+id+":cancel",b,{transferId:id},(tx,a,k,f)=>cancelTransfer(tx,a,id,b,k,f));}catch(e){return treasuryError(e);}}
