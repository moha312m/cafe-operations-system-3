import {NextRequest,NextResponse} from 'next/server';
import {handleApiError,requireKey} from '@/lib/api';
import {readReportingHours,saveReportingHours} from '@/lib/reporting-hours';
type Context={params:Promise<{id:string}>};
export async function GET(_:NextRequest,{params}:Context){try{return NextResponse.json({versions:await readReportingHours(await requireKey('sales.view'),(await params).id)});}catch(e){return handleApiError(e);}}
export async function POST(req:NextRequest,{params}:Context){try{return NextResponse.json(await saveReportingHours(await requireKey('settings.edit'),(await params).id,await req.json()));}catch(e){return handleApiError(e);}}
