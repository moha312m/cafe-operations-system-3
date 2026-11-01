import {NextRequest,NextResponse} from 'next/server';import {z} from 'zod';
import {requireKey,handleApiError} from '@/lib/api';import {revisionReceipt} from '@/lib/order-amendments';
const schema=z.object({revision:z.number().int().min(0),reprint:z.boolean(),logPrint:z.boolean().default(true)}).strict();
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await requireKey('sales.view'),b=schema.parse(await request.json());return NextResponse.json(await revisionReceipt(actor,(await params).id,b.revision,b.reprint,b.logPrint));}catch(e){return handleApiError(e);}}
