"use client";
import {useEffect,useRef,useState,Children,isValidElement,type ReactNode} from 'react';
import Link from 'next/link';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {useApp} from '@/components/app-shell';
import {useWorkspaceRead} from '@/components/cafe/use-workspace-read';
import {PageHeader} from '@/components/cafe/ui';
import {Button} from '@/components/ui/button';
import {nativeFieldClassName} from '@/components/ui/input';
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog';
import {ReportOutputActions} from '@/components/sales/report-output-actions';
import {SalesReportRows} from './sales-report-rows';
import {api} from '@/lib/client';
import {dateStrInTz,addDays} from '@/lib/date-range';
import type {SalesReportKind,SalesReportResponse,SalesReportRow} from '@/lib/sales-report-contract';
import {SALES_REPORT_CATALOG} from '@/lib/sales-report-catalog';
type Options={branches:{id:string;name:string}[];categories:{id:string;name:string}[]};
export function SalesReportWorkspace({kind}:{kind:SalesReportKind}){
 const {user,permKeys,canKey}=useApp();
 const identity=[user.id,user.cafeId,user.branchId,user.role,...permKeys].join(':');
 if(!canKey('reports.view')||!canKey('finance.view_revenue')||!canKey('sales.view'))return <p role="alert" className="workspace-state">ليس لديك صلاحية عرض هذا التقرير.</p>;
 return <ReportInner key={identity+kind} kind={kind} identity={identity}/>;
}
function ReportInner({kind,identity}:{kind:SalesReportKind;identity:string}){
 const {user,canKey}=useApp(),search=useSearchParams(),router=useRouter(),pathname=usePathname();
 const params=new URLSearchParams(search.toString()),today=dateStrInTz(new Date());
 if(!params.has('from'))params.set('from',addDays(today,-6));if(!params.has('to'))params.set('to',today);
 params.delete('export');const query=params.toString();
 const {data,error,loading,refresh}=useWorkspaceRead<SalesReportResponse>('/api/reports/'+kind+'?'+query,identity);
 const [detail,setDetail]=useState<SalesReportRow|null>(null),[hidden,setHidden]=useState<string[]>([]),[prepared,setPrepared]=useState<{query:string;result:SalesReportResponse}|null>(null),[outputError,setOutputError]=useState(''),[preparing,setPreparing]=useState(false);
 const returnFocus=useRef<HTMLElement|null>(null),outputController=useRef<AbortController|null>(null),preferenceKey='nextcup.report.columns:'+user.id+':'+kind;
 useEffect(()=>{const timer=setTimeout(()=>{try{const value=JSON.parse(localStorage.getItem(preferenceKey)??'[]');if(Array.isArray(value)&&value.every(v=>typeof v==='string'))setHidden(value);}catch{/* optional preference */}},0);return()=>clearTimeout(timer);},[preferenceKey]);
 useEffect(()=>()=>outputController.current?.abort(),[query]);
 function navigate(next:URLSearchParams){router.replace(pathname+'?'+next.toString(),{scroll:false});}
 function change(key:string,value:string){const next=new URLSearchParams(query);if(value)next.set(key,value);else next.delete(key);if(key!=='page')next.set('page','1');navigate(next);}
 function apply(form:HTMLFormElement){const next=new URLSearchParams(query);for(const [key,v] of new FormData(form)){if(typeof v==='string'&&v.trim())next.set(key,v.trim());else next.delete(key);}if(kind==='sales-staff'&&next.get('basis')!=='collector')next.delete('method');next.set('page','1');navigate(next);}
 async function prepareAll(){outputController.current?.abort();const controller=new AbortController();outputController.current=controller;setPreparing(true);setOutputError('');try{const result=await api<SalesReportResponse>('/api/reports/'+kind+'?'+query+'&export=all',{signal:controller.signal,readTimeoutMs:20000});if(!controller.signal.aborted)setPrepared({query,result});}catch(e){if(!controller.signal.aborted)setOutputError(e instanceof Error?e.message:'تعذر تجهيز التصدير');}finally{if(outputController.current===controller)setPreparing(false);}}
 const options=data?.filterOptions as Options|undefined,columns=data?.columns.filter(c=>!hidden.includes(c.key))??[],full=prepared?.query===query?prepared.result:undefined;
 const selectClass=nativeFieldClassName+' w-full',fields=[['from','من تاريخ — القاهرة'],['to','إلى تاريخ — القاهرة']] as const;
 return <div dir="rtl" className="workspace-page min-w-0 space-y-5">
  <PageHeader title={SALES_REPORT_CATALOG.find(r=>r.id===kind)!.title} subtitle="نطاق واضح، مصادر قابلة للتتبع، ومبالغ منفصلة حسب معنى كل حدث."><Link href="/report-center" className="inline-flex min-h-11 items-center text-sm text-primary underline">مركز التقارير</Link></PageHeader>
  <form key={query} onSubmit={e=>{e.preventDefault();apply(e.currentTarget);}} className="workspace-surface grid min-w-0 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
   {fields.map(([key,label])=><label key={key} className="min-w-0 space-y-1 text-sm">{label}<input className={selectClass} name={key} type="date" required defaultValue={params.get(key)??''}/></label>)}
   <label className="space-y-1 text-sm">نوع الفترة<select className={selectClass} name="dayMode" defaultValue={params.get('dayMode')??'calendar'}><option value="calendar">أيام القاهرة المدنية</option><option value="business">أيام العمل — ساعات الفروع</option></select></label>
   <label className="space-y-1 text-sm">الفرع<DraftReportSelect className={selectClass} name="branchId" initialValue={user.branchId??params.get('branchId')??''} disabled={!!user.branchId}><option value="">كل الفروع المسموحة</option>{user.branchId&&!options&&<option value={user.branchId}>الفرع المعين</option>}{options?.branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</DraftReportSelect></label>
   <label className="space-y-1 text-sm">بحث في النتائج<input className={selectClass} name="q" maxLength={100} defaultValue={params.get('q')??''} placeholder="اسم، SKU أو مرجع"/></label>
   {kind==='product-sales'&&<><label className="space-y-1 text-sm">التصنيف الحالي<DraftReportSelect className={selectClass} name="categoryId" initialValue={params.get('categoryId')??''}><option value="">كل التصنيفات</option>{options?.categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</DraftReportSelect></label><label className="space-y-1 text-sm">طريقة العرض<select className={selectClass} name="view" defaultValue={params.get('view')??'product'}>{[['product','منتج / حجم'],['lines','بنود الفواتير'],['date','تاريخ القاهرة'],['category','التصنيف'],['brand','العلامة — فحص التغطية'],['cost','التكلفة — فحص التغطية']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></>}
   {['product-sales','shift-sales','sales-payments','sales-staff'].includes(kind)&&<label className="space-y-1 text-sm">معرف الوردية<input className={selectClass} name="shiftId" maxLength={100} defaultValue={params.get('shiftId')??''} placeholder="من تفاصيل الوردية"/></label>}
   {kind==='sales-staff'&&<label className="space-y-1 text-sm">أساس إسناد الموظف<select className={selectClass} name="basis" defaultValue={params.get('basis')??'creator'}><option value="creator">منشئ البيع — createdAt</option><option value="collector">المحصّل — paidAt</option><option value="server">مقدم الطلب — servedAt</option></select></label>}
   {['sales-staff','sales-payments','shift-sales'].includes(kind)&&<label className="space-y-1 text-sm">معرف الموظف<input className={selectClass} name="actorId" maxLength={100} defaultValue={params.get('actorId')??''}/></label>}
   {kind==='tables'&&<label className="space-y-1 text-sm">معرف جلسة الطاولة<input className={selectClass} name="sessionId" maxLength={100} defaultValue={params.get('sessionId')??''}/></label>}
   {(kind==='sales-payments'||kind==='sales-staff'&&params.get('basis')==='collector')&&<label className="space-y-1 text-sm">وسيلة التحصيل<select className={selectClass} name="method" defaultValue={params.get('method')??''}><option value="">كل الوسائل</option>{['CASH','CARD','WALLET','MIXED'].map(v=><option key={v}>{v}</option>)}</select></label>}
   <label className="space-y-1 text-sm">الترتيب<select className={selectClass} name="sort" defaultValue={params.get('sort')??'revenue_desc'}><option value="revenue_desc">المبلغ تنازلياً</option><option value="revenue_asc">المبلغ تصاعدياً</option><option value="name">الاسم / التاريخ</option></select></label>
   <label className="space-y-1 text-sm">حجم الصفحة<select className={selectClass} name="pageSize" defaultValue={params.get('pageSize')??'30'}>{[15,30,60,100].map(v=><option key={v}>{v}</option>)}</select></label>
   <div className="flex items-end gap-2"><Button type="submit">تطبيق الفلاتر</Button><Button type="button" variant="outline" onClick={refresh}>تحديث</Button></div>
  </form>
  <div className="flex flex-wrap gap-2" aria-label="الفلاتر المطبقة">{[...params].filter(([k])=>k!=='page').map(([key,value])=><button key={key} className="max-w-full break-all rounded-full bg-muted px-3 py-2 text-sm" onClick={()=>change(key,'')} aria-label={'إزالة '+key}>{key}: {value} ×</button>)}<Button variant="ghost" onClick={()=>router.replace(pathname,{scroll:false})}>مسح الفلاتر</Button></div>
  {loading&&<div role="status" className="workspace-state animate-pulse">جارٍ تحميل التقرير… الفلاتر محفوظة.</div>}
  {error&&<div role="alert" className="workspace-state space-y-3 border-destructive/30"><p>{error}</p><Button variant="outline" onClick={refresh}>إعادة المحاولة</Button></div>}
  {data&&<>
   <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.summaries.map(s=><div key={s.key} className="workspace-surface p-4"><p className="text-sm text-muted-foreground">{s.label}</p><p className="mt-2 break-words text-xl font-semibold tabular-nums"><bdi>{s.value??'غير متاح'}</bdi></p></div>)}</div>
   <section className="workspace-surface space-y-2 p-4"><p className="text-sm leading-7">{data.metricBasis}</p><p className="text-sm text-muted-foreground">أنشئت اللقطة: <bdi>{new Intl.DateTimeFormat('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'medium',timeStyle:'short'}).format(new Date(data.generatedAt))}</bdi></p><details><summary className="cursor-pointer text-sm font-semibold">تغطية البيانات والمصالحة</summary><ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-7">{data.coverage.map(c=><li key={c}>{c}</li>)}</ul></details></section>
   <section className="workspace-surface space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{data.total} نتيجة مطابقة</h2><details><summary className="cursor-pointer text-sm">اختيار الأعمدة</summary><div className="grid gap-2 p-3 sm:grid-cols-2">{data.columns.map(c=><label key={c.key} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!hidden.includes(c.key)} onChange={e=>{const next=e.target.checked?hidden.filter(k=>k!==c.key):[...hidden,c.key];setHidden(next);try{localStorage.setItem(preferenceKey,JSON.stringify(next));}catch{/* optional preference */}}}/>{c.label}</label>)}</div></details></div>
    <ReportOutputActions snapshot={data.outputSnapshot} disabled={loading||!!error} endpoint={'/api/reports/'+kind+'/output'} scopeLabel="الصفحة المعروضة"/>
    {canKey('reports.export')&&<div className="space-y-2 border-t pt-3"><Button variant="outline" disabled={loading||!!error||preparing} onClick={()=>void prepareAll()}>{preparing?'جارٍ تجهيز اللقطة…':'تجهيز كل النتائج المفلترة — حد 5000 لكل مصدر'}</Button>{outputError&&<p role="alert">{outputError}</p>}{full&&<><p className="text-sm text-muted-foreground">كل {full.total} نتيجة · لقطة مستقلة {full.generatedAt}</p><ReportOutputActions snapshot={full.outputSnapshot} disabled={loading||!!error} endpoint={'/api/reports/'+kind+'/output'} scopeLabel="كل النتائج المفلترة"/></>}</div>}
    {data.rows.length?<SalesReportRows columns={columns} rows={data.rows} onDetail={row=>{returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setDetail(row);}}/>:!loading&&!error&&<div role="status" className="workspace-state py-10 text-center">{['brand','cost'].includes(params.get('view')??'')?'هذا العرض غير متاح؛ راجع تغطية البيانات أعلاه.':'لا توجد نتائج مطابقة. جرّب فترة أو فلاتر أخرى.'}</div>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><p className="text-sm">صفحة {data.page} / {Math.max(1,data.pages)} · {data.rows.length} من {data.total}</p><div className="flex gap-2"><Button variant="outline" disabled={loading||data.page<=1} onClick={()=>change('page',String(data.page-1))}>السابق</Button><Button variant="outline" disabled={loading||data.page>=data.pages} onClick={()=>change('page',String(data.page+1))}>التالي</Button></div></div>
   </section>
  </>}
  <Dialog open={!!detail} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent finalFocus={returnFocus} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" dir="rtl"><DialogTitle>تفاصيل السجل</DialogTitle>{detail&&<div className="space-y-4"><dl className="grid min-w-0 gap-3 sm:grid-cols-2">{[...(data?.columns.map(c=>[c.label,detail.cells[c.key]])??[]),...Object.entries(detail.details??{})].map(([label,value])=><div key={label} className="min-w-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-all tabular-nums"><bdi>{value??'غير متاح'}</bdi></dd></div>)}</dl><div className="flex flex-col gap-2">{detail.href&&<Link className="min-h-11 text-primary underline" href={detail.href}>فتح المصدر الأصلي</Link>}{detail.links?.map((link,index)=><Link key={index} className="min-h-11 break-all text-sm text-primary underline" href={link.href}>{link.label}</Link>)}</div><Button variant="outline" onClick={()=>setDetail(null)}>إغلاق التفاصيل</Button></div>}</DialogContent></Dialog>
 </div>;
}

/** Keep the draft selection when authorized option metadata arrives after the first render. */
function DraftReportSelect({initialValue,children,...props}:{initialValue:string;children:ReactNode;name:string;className:string;disabled?:boolean}){
 const [value,setValue]=useState(initialValue);
 const available=Children.toArray(children).some(child=>isValidElement<{value?:string}>(child)&&child.props.value===value);
 return <select {...props} value={value} onChange={event=>setValue(event.target.value)}>{value&&!available&&<option value={value}>النطاق المحدد</option>}{children}</select>;
}
