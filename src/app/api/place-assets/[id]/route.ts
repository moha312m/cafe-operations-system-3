import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveSession, requireKey, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";
type Params={params:Promise<{id:string}>};
const patch=z.object({name:z.string().trim().min(1).max(120).optional(),area:z.string().trim().max(120).nullable().optional(),isActive:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0);
export async function PATCH(request:NextRequest,{params}:Params){try{const actor=await requireActiveSession();if(actor.role!=="CAFE_OWNER")throw new ApiError(403,"Only the cafe owner may configure place checks");await requireKey("settings.edit");const {id}=await params;const data=patch.parse(await request.json());const current=await db.placeAsset.findFirst({where:{id,cafeId:actor.cafeId??undefined},select:{id:true,branchId:true}});if(!current)throw new ApiError(403,"Asset is outside this cafe");if(actor.branchId&&actor.branchId!==current.branchId)throw new ApiError(403,"Asset is outside this branch");const asset=await db.$transaction(async tx=>{const updated=await tx.placeAsset.update({where:{id},data,include:{checkpoints:{orderBy:{sortOrder:"asc"}}}});await auditInTransaction(tx,{cafeId:actor.cafeId!,userId:actor.id,action:"PLACE_ASSET_UPDATED",entity:"PlaceAsset",entityId:id,details:data});return updated;});return NextResponse.json({asset});}catch(error){return handleApiError(error);}}
