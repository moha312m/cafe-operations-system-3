import {NextRequest,NextResponse} from 'next/server';
import {ApiError,handleApiError,requireKey} from '@/lib/api';
import {verifyReportOutput,reportOutputFiles} from '@/lib/report-output';
export async function POST(req:NextRequest){try{const actor=await requireKey('reports.export');const input=await req.json();if(typeof input.snapshot!=='string')throw new ApiError(400,'لقطة التقرير مطلوبة');try{return NextResponse.json(reportOutputFiles(verifyReportOutput(actor.id,input.snapshot)));}catch(e){throw new ApiError(400,(e as Error).message);}}catch(e){return handleApiError(e);}}
