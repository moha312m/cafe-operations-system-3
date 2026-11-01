import {NextRequest,NextResponse} from 'next/server';
import {requireKey,handleApiError} from '@/lib/api';
import {approveAmendment,beginAmendmentSettlement,observeAmendmentSettlement,commitAmendment,cancelAmendment} from '@/lib/order-amendments';
import {z} from 'zod';
const schema=z.discriminatedUnion('action',[
 z.object({action:z.enum(['approve','commit','cancel'])}).strict(),
 z.object({action:z.literal('begin'),requestKey:z.string().min(16).max(64),method:z.enum(['CASH','CARD','WALLET'])}).strict(),
 z.object({action:z.literal('observe'),attemptId:z.string(),outcome:z.enum(['CONFIRMED','FAILED','UNKNOWN']),evidence:z.object({confirmed:z.boolean(),reference:z.string().max(200),note:z.string().max(500),references:z.record(z.string(),z.string().max(200)).optional()}).strict()}).strict(),
]);
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await requireKey('sales.edit'),id=(await params).id,b=schema.parse(await request.json());let result;
 if(b.action==='approve')result=await approveAmendment(actor,id);
 else if(b.action==='begin')result=await beginAmendmentSettlement(actor,id,b.requestKey,b.method);
 else if(b.action==='observe')result=await observeAmendmentSettlement(actor,id,b.attemptId,b.outcome,b.evidence);
 else if(b.action==='commit')result=await commitAmendment(actor,id);
 else result=await cancelAmendment(actor,id);
 return NextResponse.json({result});}catch(e){return handleApiError(e);}}
