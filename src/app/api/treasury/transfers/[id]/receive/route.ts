import { treasuryWrite,treasuryError } from "@/lib/treasury-api";
import { receiveInput } from "@/lib/treasury-rules";
import { receiveTransfer } from "@/lib/treasury-transfers";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {id}=await params,b=receiveInput.parse(await request.json());return await treasuryWrite(request,"treasury.transfer_receive","transfer:"+id+":receive",b,{transferId:id},(tx,a,k,f)=>receiveTransfer(tx,a,id,b,k,f));}catch(e){return treasuryError(e);}}
