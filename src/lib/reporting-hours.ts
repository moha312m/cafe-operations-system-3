import {z} from 'zod';
import {db} from './db';
import {ApiError,resolveReadScope} from './api';
import type {SessionUser} from './auth';
import {resolvePermissions} from './perms/effective';
import {auditInTransaction} from './audit';
import {customWindow,legacyReportingHours,outsideWindows,transitionIssues,validateHours,versionForDate,windowsForDates,type ReportingHours} from './business-day';
import {dateStrInTz} from './date-range';
import {reportEventWhere} from './report-window-scope';

async function scopedBranch(actor:SessionUser,id:string){
 const scope=resolveReadScope(actor);if(scope.branchId&&scope.branchId!==id)throw new ApiError(403,'الفرع خارج نطاقك');
 const branch=await db.branch.findFirst({where:{id,...(scope.cafeId?{cafeId:scope.cafeId}:{})}});if(!branch)throw new ApiError(404,'الفرع خارج نطاقك');return branch;
}
export async function readReportingHours(actor:SessionUser,id:string){await scopedBranch(actor,id);return db.branchReportingVersion.findMany({where:{branchId:id},orderBy:{effectiveDate:'asc'}});}
const inputSchema=z.object({startTime:z.string(),endTime:z.string(),timezone:z.string().max(100),is24Hours:z.boolean(),effectiveDate:z.string(),acknowledgeGap:z.boolean().default(false)}).strict();
export async function saveReportingHours(actor:SessionUser,id:string,raw:unknown,now=new Date()){
 const {keys}=await resolvePermissions(actor);
 if(!['CAFE_OWNER','BRANCH_MANAGER','SUPER_ADMIN'].includes(actor.role)||!keys.has('settings.edit'))throw new ApiError(403,'لا توجد صلاحية لتعديل ساعات التقارير');
 const branch=await scopedBranch(actor,id),input=inputSchema.parse(raw);
 try{validateHours(input);}catch(e){throw new ApiError(400,(e as Error).message);}
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Branch" WHERE id=${id} FOR UPDATE`;
  const versions=await tx.branchReportingVersion.findMany({where:{branchId:id},orderBy:{effectiveDate:'asc'}});
  const previous=versions.at(-1);
  if(input.effectiveDate<=dateStrInTz(now,input.timezone)||input.effectiveDate<=dateStrInTz(now,previous?.timezone??'Africa/Cairo'))throw new ApiError(400,'اختر تاريخ سريان مستقبليًا لحماية التقارير التاريخية');
  if(previous&&input.effectiveDate<=previous.effectiveDate)throw new ApiError(409,'نسخ الإعدادات محفوظة؛ اختر تاريخًا بعد آخر نسخة مسجلة');
  const issues=transitionIssues(input,versions);
  if(issues.some(i=>i.kind==='overlap'))throw new ApiError(409,'التغيير يسبب تداخل فترتين؛ عدّل وقت البداية أو تاريخ السريان');
  if(issues.some(i=>i.kind==='gap')&&!input.acknowledgeGap)throw new ApiError(409,'توجد فترة خارج ساعات التقارير؛ راجعها وأكّد ظهورها في عرض خارج الساعات');
  const {acknowledgeGap:_,...data}=input;void _;
  const saved=await tx.branchReportingVersion.create({data:{...data,branchId:id,createdById:actor.id}});
  await auditInTransaction(tx,{cafeId:branch.cafeId,userId:actor.id,action:'REPORTING_HOURS_CHANGED',entity:'BranchReportingVersion',entityId:saved.id,details:{branchId:id,before:previous??legacyReportingHours,after:saved,effectiveDate:input.effectiveDate,issues}});
  return {version:saved,issues};
 });
}
export async function resolveReportingSelection(actor:SessionUser,params:URLSearchParams,{optional=false,cafeId}:{optional?:boolean;cafeId?:string}={}){
 const scope=resolveReadScope(actor),requested=params.get('branchId');
 if(requested&&scope.branchId&&requested!==scope.branchId)throw new ApiError(403,'الفرع خارج نطاقك');
 const availableBranches=await db.branch.findMany({where:{...(scope.cafeId?{cafeId:scope.cafeId}:cafeId?{cafeId}:{}),...(scope.branchId?{id:scope.branchId}:{})},select:{id:true,name:true,reportingVersions:{orderBy:{effectiveDate:'asc'}}}});
 const branches=requested?availableBranches.filter(b=>b.id===requested):availableBranches;
 if(requested&&!branches.length)throw new ApiError(403,'الفرع خارج نطاقك');
 if(optional&&!params.has('reportMode')&&((params.has('from')||params.has('to'))||!branches.some(b=>b.reportingVersions.length)))return null;
 const mode=params.get('reportMode')??'business';if(!['business','outside','custom'].includes(mode))throw new ApiError(400,'نوع التقرير غير صالح');
 const windows=branches.flatMap(branch=>{
  const versions:ReportingHours[]=branch.reportingVersions;
  const tz=versionForDate(params.get('businessFrom')??params.get('date')??dateStrInTz(new Date()),versions).timezone;
  const from=params.get('businessFrom')??params.get('date')??dateStrInTz(new Date(),tz),to=params.get('businessTo')??from;
  try{
   if(mode==='custom')return [{...customWindow(params.get('customStart')??'',params.get('customEnd')??'',params.get('customTimezone')??'Africa/Cairo'),branchId:branch.id}];
   return mode==='outside'?outsideWindows(branch.id,from,to,versions):windowsForDates(branch.id,from,to,versions);
  }catch(e){throw new ApiError(400,(e as Error).message);}
 });
 const coverage=branches.flatMap(branch=>{
  if(mode==='custom')return [];
  const from=params.get('businessFrom')??params.get('date')??dateStrInTz(new Date(),versionForDate(dateStrInTz(new Date()),branch.reportingVersions).timezone),to=params.get('businessTo')??from;
  return outsideWindows(branch.id,from,to,branch.reportingVersions);
 });
 const outsideCounts=await Promise.all(branches.map(async b=>({branchId:b.id,orders:await db.order.count({where:{...(scope.cafeId?{cafeId:scope.cafeId}:{}),...reportEventWhere(coverage.filter(w=>w.branchId===b.id))}}),payments:await db.payment.count({where:{...(scope.cafeId?{cafeId:scope.cafeId}:{}),...reportEventWhere(coverage.filter(w=>w.branchId===b.id),'createdAt',true)}}),adjustments:await db.orderRevision.count({where:{...(scope.cafeId?{cafeId:scope.cafeId}:{}),...reportEventWhere(coverage.filter(w=>w.branchId===b.id))}})})));
 return {mode,windows,branches:availableBranches.map(b=>({id:b.id,name:b.name,versions:b.reportingVersions})),outsideCounts,coverageNote:'خارج الساعات: من نهاية الفترة إلى بداية يوم العمل التالي؛ البداية مشمولة والنهاية مستبعدة. المدة المخصصة مستقلة ولا تغير الإعدادات.',boundary:'[start,end)',recognition:{sales:'Order.createdAt (SERVED)',adjustments:'OrderRevision.createdAt (delta only)',collectionsAndRefunds:'Payment.createdAt'}};
}
