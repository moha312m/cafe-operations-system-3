import { NextResponse, type NextRequest } from 'next/server';
import { requireKey,resolveBranchId,handleApiError,ApiError } from '@/lib/api';
import { db } from '@/lib/db';
export async function GET(request:NextRequest) {
  try {
    const actor=await requireKey('handover.view');const branchId=resolveBranchId(actor,request.nextUrl.searchParams.get('branchId'));
    const branch=await db.branch.findUnique({where:{id:branchId},select:{cafeId:true}});
    if(!branch || branch.cafeId!==actor.cafeId)throw new ApiError(403,'Not allowed');
    const storages=await db.cashStorage.findMany({where:{cafeId:branch.cafeId,branchId,OR:[{receipt:{is:null}},{receipt:{is:{acceptedAt:null}}}]},orderBy:[{declaredAt:'desc'},{id:'desc'}],include:{declaredBy:{select:{id:true,name:true}},outgoingShift:{select:{id:true,shiftNumber:true,cashier:{select:{id:true,name:true}}}},handover:{select:{status:true}},movements:true,receipt:{include:{claimant:{select:{id:true,name:true}},events:{orderBy:{createdAt:'asc'}}}}}});
    return NextResponse.json({storages:storages.map(s=>({...s,expectedAmount:Math.round((Number(s.leftInDrawer)+s.movements.reduce((sum,m)=>sum+Number(m.amount),0))*100)/100}))});
  }catch(error){return handleApiError(error);}
}
