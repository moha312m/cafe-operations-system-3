import {NextRequest,NextResponse} from 'next/server';
import {requireKey,handleApiError} from '@/lib/api';
import {listSales} from '@/lib/sales-query';
export async function GET(request:NextRequest){try{return NextResponse.json(await listSales(await requireKey('sales.view'),request.nextUrl.searchParams));}catch(e){return handleApiError(e);}}
