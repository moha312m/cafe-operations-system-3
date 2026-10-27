import {NextRequest,NextResponse} from 'next/server';import {requireKey,handleApiError} from '@/lib/api';import {listTracing} from '@/lib/sales-query';
export async function GET(request:NextRequest){try{return NextResponse.json(await listTracing(await requireKey('audit.view'),request.nextUrl.searchParams));}catch(e){return handleApiError(e);}}
