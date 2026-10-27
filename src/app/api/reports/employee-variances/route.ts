import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError, requireKey, requireFeature, resolveCafeId, resolveBranchId, handleApiError } from '@/lib/api';
import { getDateRangeFromFilter } from '@/lib/date-range';
import { loadEmployeeVariances } from '@/lib/employee-variance-report';
const ranges=['today','yesterday','last_7_days','last_30_days','month','custom_day','custom_range'] as const;
export async function GET(request:NextRequest) {
  try {
    const session=await requireKey('variance.view');
    await requireFeature(session,'shiftManagementEnabled');
    const p=request.nextUrl.searchParams,cafeId=resolveCafeId(session,p.get('cafeId'));
    const branchId=session.branchId||p.get('branchId')?resolveBranchId(session,p.get('branchId')):undefined;
    const rangeKey=z.enum(ranges).parse(p.get('range')??'today');
    for(const name of ['date','from','to']){const date=p.get(name);if(date){
      const parsed=new Date(date+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw new ApiError(400,'تاريخ غير صالح');
    }}
    const range=getDateRangeFromFilter(rangeKey,{date:p.get('date'),from:p.get('from'),to:p.get('to')});
    if(range.error)throw new ApiError(400,range.error);
    const employeeId=p.get('employeeId')||undefined;
    if(employeeId&&!await db.user.findFirst({where:{id:employeeId,cafeId},select:{id:true}}))throw new ApiError(400,'الموظف مش تابع للكافيه');
    const report=await loadEmployeeVariances({cafeId,branchId,from:range.from,to:range.to,employeeId,handoverId:p.get('handoverId')||undefined});
    const employees=await db.user.findMany({where:{cafeId,role:{not:'SUPER_ADMIN'},...(branchId?{OR:[{branchId},{id:{in:[...new Set(report.rows.flatMap(r=>r.relatedEmployees.map(e=>e.id)))]}}]}:{})},select:{id:true,name:true},orderBy:{name:'asc'}});
    const branches=await db.branch.findMany({where:{cafeId,...(session.branchId?{id:session.branchId}:{})},select:{id:true,name:true},orderBy:{name:'asc'}});
    return NextResponse.json({...report,handoverId:p.get("handoverId"),employeeOptions:employees,branchOptions:branches,
      range:{key:range.range,from:range.fromDateStr,to:range.toDateStr,dateBasis:'openedAt',timezone:'Africa/Cairo'}});
  }catch(error){return handleApiError(error);}
}
