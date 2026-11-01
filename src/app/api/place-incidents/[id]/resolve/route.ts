import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveSession,requireKey,handleApiError,ApiError } from "@/lib/api";
import { resolvePlaceIncident } from "@/lib/place-receipts";
type Params={params:Promise<{id:string}>};
const schema=z.object({repairNote:z.string().trim().min(3).max(1000)}).strict();
export async function POST(request:NextRequest,{params}:Params){try{const actor=await requireActiveSession();if(actor.role!=="CAFE_OWNER")throw new ApiError(403,"Only the cafe owner may resolve equipment incidents");await requireKey("settings.edit");const {id}=await params;const data=schema.parse(await request.json());if(!actor.cafeId)throw new ApiError(403,"Cafe required");await resolvePlaceIncident({incidentId:id,cafeId:actor.cafeId,actorId:actor.id,repairNote:data.repairNote});return NextResponse.json({resolved:true});}catch(error){return handleApiError(error);}}
