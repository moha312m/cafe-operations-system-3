import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireActiveSession,requireKey,handleApiError,ApiError } from '@/lib/api';
import { resolveBranchHandoverConfigReadOnly } from '@/lib/handover-config';
import { auditInTransaction } from '@/lib/audit';
type Params={params:Promise<{id:string}>};
const patch=z.object({overnightCashEnabled:z.boolean().optional(),drawerLabel:z.string().trim().min(1).max(100).optional(),placeAcceptanceRequired:z.boolean().optional(),placeInspectorId:z.string().min(1).nullable().optional()}).strict().refine(v=>Object.keys(v).length>0,'Specify a setting');
async function scope(id:string){const actor=await requireActiveSession();const branch=await db.branch.findUnique({where:{id},select:{cafeId:true}});if(!branch || branch.cafeId!==actor.cafeId || (actor.branchId && actor.branchId!==id))throw new ApiError(403,'Not allowed');return {actor,branch};}
export async function GET(_request:NextRequest,{params}:Params){try{const {id}=await params;await scope(id);const settings=await db.branchOpeningSettings.findUnique({where:{branchId:id},select:{overnightCashEnabled:true,drawerLabel:true,placeAcceptanceRequired:true,placeInspectorId:true}});return NextResponse.json({settings:settings??{overnightCashEnabled:false,drawerLabel:'Main drawer',placeAcceptanceRequired:false,placeInspectorId:null}});}catch(error){return handleApiError(error);}}
export async function PATCH(request:NextRequest,{params}:Params){try{
  const {id}=await params;const {actor,branch}=await scope(id);if(actor.role!=='CAFE_OWNER')throw new ApiError(403,'Only the cafe owner may configure shift opening');await requireKey('settings.edit');const data=patch.parse(await request.json());
  const settings=await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Branch" WHERE id=${id} FOR NO KEY UPDATE`;
    if(data.placeAcceptanceRequired){const assets=await tx.placeAsset.count({where:{cafeId:branch.cafeId,branchId:id,isActive:true}});if(assets===0)throw new ApiError(400,'Add at least one active place check before making acceptance mandatory');const current=await tx.branchOpeningSettings.findUnique({where:{branchId:id},select:{placeInspectorId:true}});const inspectorId=data.placeInspectorId??current?.placeInspectorId;if(!inspectorId)throw new ApiError(400,'Select the named place inspector');const inspector=await tx.user.findFirst({where:{id:inspectorId,cafeId:branch.cafeId,branchId:id,isActive:true,archivedAt:null},select:{id:true}});if(!inspector)throw new ApiError(400,'Inspector must be an active employee assigned to this branch');data.placeInspectorId=inspectorId;}else if(data.placeInspectorId){const inspector=await tx.user.findFirst({where:{id:data.placeInspectorId,cafeId:branch.cafeId,branchId:id,isActive:true,archivedAt:null},select:{id:true}});if(!inspector)throw new ApiError(400,'Inspector must be an active employee assigned to this branch');}if(data.overnightCashEnabled){const config=await resolveBranchHandoverConfigReadOnly(tx,branch.cafeId,id);if(!config.enabled || config.configError)throw new ApiError(400,'Configure a valid stock handover before enabling overnight drawer receipts');}
    const saved=await tx.branchOpeningSettings.upsert({where:{branchId:id},create:{branchId:id,cafeId:branch.cafeId,updatedById:actor.id,...data},update:{...data,updatedById:actor.id}});
    await auditInTransaction(tx,{cafeId:branch.cafeId,userId:actor.id,action:'BRANCH_OPENING_SETTINGS_CHANGED',entity:'Branch',entityId:id,details:data});return saved;
  });return NextResponse.json({settings:{overnightCashEnabled:settings.overnightCashEnabled,drawerLabel:settings.drawerLabel,placeAcceptanceRequired:settings.placeAcceptanceRequired,placeInspectorId:settings.placeInspectorId}});
}catch(error){return handleApiError(error);}}

