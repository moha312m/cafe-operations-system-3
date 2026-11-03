import {NextRequest,NextResponse} from 'next/server';
import {ApiError,handleApiError,requireKey} from '@/lib/api';
import {verifyReportOutput,reportOutputFiles} from '@/lib/report-output';
export async function POST(req:NextRequest){try{const actor=await requireKey('reports.export');const input=await req.json();if(typeof input.snapshot!=='string')throw new ApiError(400,'لقطة التقرير مطلوبة');try{const report=verifyReportOutput(actor.id,input.snapshot);const scope=report.reporting as Record<string,unknown>|null;if(scope?.scopeFingerprint||scope?.invoiceScopeFingerprint)throw new ApiError(403,'استخدم مسار تصدير التقرير للتحقق من نطاقه الحالي');return NextResponse.json(reportOutputFiles(report));}catch(e){throw new ApiError(400,(e as Error).message);}}catch(e){return handleApiError(e);}}
