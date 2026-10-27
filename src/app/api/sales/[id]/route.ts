import {NextRequest,NextResponse} from 'next/server';
import {requireKey,handleApiError} from '@/lib/api';
import {saleDetail} from '@/lib/sales-query';
import {previewAmendment,stageAmendment} from '@/lib/order-amendments';
import {z} from 'zod';
type Context={params:Promise<{id:string}>};
export async function GET(_request:NextRequest,{params}:Context){try{return NextResponse.json(await saleDetail(await requireKey('sales.view'),(await params).id));}catch(e){return handleApiError(e);}}
const schema=z.object({action:z.enum(['preview','stage']),input:z.unknown(),requestKey:z.string().optional()}).strict();
export async function POST(request:NextRequest,{params}:Context){try{const actor=await requireKey('sales.edit'),body=schema.parse(await request.json()),id=(await params).id;return NextResponse.json(body.action==='preview'?await previewAmendment(actor,id,body.input):{amendment:await stageAmendment(actor,id,body.input,body.requestKey??'')});}catch(e){return handleApiError(e);}}
