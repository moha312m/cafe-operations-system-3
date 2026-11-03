import {NextResponse,type NextRequest} from 'next/server';
import {z} from 'zod';
import {requireActiveSession,resolveReadScope,resolveCafeId,handleApiError,ApiError} from '@/lib/api';
import {resolvePermissions} from '@/lib/perms/effective';
import {verifyReportOutput,reportOutputFiles} from '@/lib/report-output';
import {assertOutputScope} from '@/lib/sales-report-math';
export async function POST(request:NextRequest){try{
 const actor=await requireActiveSession(),{keys}=await resolvePermissions(actor),scope=resolveReadScope(actor);
 if(!keys.has('sales.view')||!keys.has('reports.export'))throw new ApiError(403,'ليس لديك صلاحية تصدير المبيعات');
 const {snapshot}=z.object({snapshot:z.string().min(1).max(1800000)}).strict().parse(await request.json());
 let report;try{report=verifyReportOutput(actor.id,snapshot);const saved=report.reporting as {invoiceScopeFingerprint:string;filters?:{cafeId?:string}};assertOutputScope(saved.invoiceScopeFingerprint,JSON.stringify([actor.id,resolveCafeId(actor,saved.filters?.cafeId),scope.branchId??null,actor.role,[...keys].sort()]));}catch(error){throw new ApiError(403,(error as Error).message);}
 return NextResponse.json(reportOutputFiles(report),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return handleApiError(error);}}
