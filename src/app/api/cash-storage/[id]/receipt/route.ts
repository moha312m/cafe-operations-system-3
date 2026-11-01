import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireKey, handleApiError, ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { acceptOpeningCash, updateOpeningCashReview } from '@/lib/overnight-cash';
const schema=z.discriminatedUnion('action',[
  z.object({action:z.literal('ACCEPT'),countedCash:z.number().nonnegative(),reasonCodeId:z.string().min(1).optional(),note:z.string().max(1000).optional(),idempotencyKey:z.string().min(1).max(100),override:z.boolean().optional()}).strict(),
  z.object({action:z.enum(['DISPUTE','DEFER']),note:z.string().trim().min(1).max(1000)}).strict(),
]);
export async function POST(request: NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireKey('handover.accept');const {id}=await params;
    const storage=await db.cashStorage.findUnique({where:{id},select:{cafeId:true,branchId:true,receipt:{select:{id:true}}}});
    if(!storage || storage.cafeId!==actor.cafeId || (actor.branchId && storage.branchId!==actor.branchId))throw new ApiError(403,'Not allowed');
    if(!storage.receipt)throw new ApiError(409,'Open the incoming shift first to claim its drawer');
    const data=schema.parse(await request.json());
    if(data.action==='ACCEPT') {
      if(data.override)await requireKey('handover.exception');
      const result=await acceptOpeningCash({receiptId:storage.receipt.id,actorId:actor.id,...data});
      return NextResponse.json(result);
    }
    await updateOpeningCashReview({receiptId:storage.receipt.id,actorId:actor.id,...data});
    return NextResponse.json({reviewed:true});
  }catch(error){return handleApiError(error);}
}
