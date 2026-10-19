import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireActiveSession, handleApiError } from '@/lib/api';
import { moveStoredCash } from '@/lib/overnight-cash';
const schema=z.object({amount:z.number(),reason:z.string().trim().min(1).max(1000),idempotencyKey:z.string().min(1).max(100).optional()}).strict();
export async function POST(request: NextRequest, {params}:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireActiveSession();
    const {id}=await params;
    const data=schema.parse(await request.json());
    const movement=await moveStoredCash({storageId:id,actor,...data});
    return NextResponse.json({movement});
  } catch(error) { return handleApiError(error); }
}
