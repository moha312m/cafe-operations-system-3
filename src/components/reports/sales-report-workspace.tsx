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
import {cn} from '@/lib/utils';
type Options={branches:{id:string;name:string}[];categories:{id:string;name:string}[]};
const PRESETS=[['اليوم',0],['أمس',1],['آخر 7 أيام',6]] as const;
/** Filters worth a chip; sort/pageSize/date range are controls, not filters. */
const CHIP_LABELS:Record<string,string>={q:'بحث',branchId:'الفرع',categoryId:'التصنيف',dayMode:'نوع الفترة',view:'العرض',shiftId:'الوردية',basis:'أساس الإسناد',actorId:'الموظف',sessionId:'جلسة الطاولة',method:'وسيلة التحصيل'};
const CHIP_DEFAULTS:Record<string,string>={dayMode:'calendar',view:'product',basis:'creator'};
const CHIP_VALUES:Record<string,string>={'dayMode:business':'أيام العمل','view:lines':'بنود الفواتير','view:date':'تاريخ القاهرة','view:category':'التصنيف','view:brand':'العلامة','view:cost':'التكلفة','basis:collector':'المحصّل','basis:server':'مقدم الطلب'};
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
 const selectClass=cn(nativeFieldClassName,'w-full min-h-11 py-1 md:min-h-9'),btnClass='md:min-h-9 md:py-1',defaultRange={from:addDays(today,-6),to:today};
 const labelOf=(list:{id:string;name:string}[]|undefined,id:string)=>list?.find(x=>x.id===id)?.name??'محدد';
 const chips=[...params].filter(([k,v])=>v&&k in CHIP_LABELS&&CHIP_DEFAULTS[k]!==v).map(([k,v])=>[k,k==='branchId'?labelOf(options?.branches,v):k==='categoryId'?labelOf(options?.categories,v):CHIP_VALUES[k+':'+v]??v] as const);
 const advancedCount=chips.filter(([k])=>k!=='q'&&k!=='branchId').length;
 const activePreset=PRESETS.find(([,d])=>params.get('from')===addDays(today,-d)&&params.get('to')===(d===1?addDays(today,-1):today))?.[0];
 function preset(days:number){const next=new URLSearchParams(query);next.set('from',addDays(today,-days));next.set('to',days===1?addDays(today,-1):today);next.set('page','1');navigate(next);}
 function clearFilters(range:{from:string;to:string}) {
  const next=new URLSearchParams(range);
  const cafeId=params.get('cafeId');
  if(cafeId)next.set('cafeId',cafeId);
  navigate(next);
 }
 const title=SALES_REPORT_CATALOG.find(r=>r.id===kind)!.title;
 return <div dir="rtl" className="workspace-page min-w-0 space-y-4">
  <nav aria-label="مسار التنقل" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"><span>التقارير</span><span aria-hidden="true">/</span><Link href="/report-center" className="text-primary hover:underline">مركز التقارير</Link><span aria-hidden="true">/</span><span aria-current="page" className="text-foreground">{title}</span></nav>
  <PageHeader title={title} subtitle={<span className="text-sm text-muted-foreground">نطاق واضح، مصادر قابلة للتتبع، ومبالغ منفصلة حسب معنى كل حدث.</span>}/>
  <form key={query} onSubmit={e=>{e.preventDefault();apply(e.currentTarget);}} className="report-dense min-w-0 space-y-3 rounded-2xl border bg-card p-4">
   <div className="flex flex-wrap items-center gap-2">
    <div className="min-w-0 basis-full sm:min-w-48 sm:basis-auto sm:flex-1"><input className={selectClass} name="q" type="search" maxLength={100} defaultValue={params.get('q')??''} placeholder="بحث بالاسم أو SKU أو المرجع" aria-label="بحث في النتائج"/></div>
    <div className="flex w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground md:w-auto"><span>من</span><input className={cn(selectClass,'min-w-0 flex-1 md:w-36 md:flex-none')} name="from" type="date" required defaultValue={params.get('from')??''} aria-label="من تاريخ — القاهرة"/><span>إلى</span><input className={cn(selectClass,'min-w-0 flex-1 md:w-36 md:flex-none')} name="to" type="date" required defaultValue={params.get('to')??''} aria-label="إلى تاريخ — القاهرة"/></div>
    <div className="flex flex-wrap gap-1" role="group" aria-label="فترات سريعة">{PRESETS.map(([label,days])=><Button key={label} type="button" size="sm" variant={activePreset===label?'secondary':'outline'} className={btnClass} aria-pressed={activePreset===label} onClick={()=>preset(days)}>{label}</Button>)}</div>
    <DraftReportSelect className={cn(selectClass,'md:w-44')} name="branchId" initialValue={user.branchId??params.get('branchId')??''} disabled={!!user.branchId}><option value="">كل الفروع المسموحة</option>{user.branchId&&!options&&<option value={user.branchId}>الفرع المعين</option>}{options?.branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</DraftReportSelect>
    <AdvancedFilters count={advancedCount}>
     <label className="space-y-1 text-xs text-muted-foreground">نوع الفترة<select className={selectClass} name="dayMode" defaultValue={params.get('dayMode')??'calendar'}><option value="calendar">أيام القاهرة المدنية</option><option value="business">أيام العمل — ساعات الفروع</option></select></label>
     {kind==='product-sales'&&<><label className="space-y-1 text-xs text-muted-foreground">التصنيف الحالي<DraftReportSelect className={selectClass} name="categoryId" initialValue={params.get('categoryId')??''}><option value="">كل التصنيفات</option>{options?.categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</DraftReportSelect></label><label className="space-y-1 text-xs text-muted-foreground">طريقة العرض<select className={selectClass} name="view" defaultValue={params.get('view')??'product'}>{[['product','منتج / حجم'],['lines','بنود الفواتير'],['date','تاريخ القاهرة'],['category','التصنيف'],['brand','العلامة — فحص التغطية'],['cost','التكلفة — فحص التغطية']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></>}
     {['product-sales','shift-sales','sales-payments','sales-staff'].includes(kind)&&<label className="space-y-1 text-xs text-muted-foreground">معرف الوردية<input className={selectClass} name="shiftId" maxLength={100} defaultValue={params.get('shiftId')??''} placeholder="من تفاصيل الوردية"/></label>}
     {kind==='sales-staff'&&<label className="space-y-1 text-xs text-muted-foreground">أساس إسناد الموظف<select className={selectClass} name="basis" defaultValue={params.get('basis')??'creator'}><option value="creator">منشئ البيع — createdAt</option><option value="collector">المحصّل — paidAt</option><option value="server">مقدم الطلب — servedAt</option></select></label>}
     {['sales-staff','sales-payments','shift-sales'].includes(kind)&&<label className="space-y-1 text-xs text-muted-foreground">معرف الموظف<input className={selectClass} name="actorId" maxLength={100} defaultValue={params.get('actorId')??''}/></label>}
     {kind==='tables'&&<label className="space-y-1 text-xs text-muted-foreground">معرف جلسة الطاولة<input className={selectClass} name="sessionId" maxLength={100} defaultValue={params.get('sessionId')??''}/></label>}
     {(kind==='sales-payments'||kind==='sales-staff'&&params.get('basis')==='collector')&&<label className="space-y-1 text-xs text-muted-foreground">وسيلة التحصيل<select className={selectClass} name="method" defaultValue={params.get('method')??''}><option value="">كل الوسائل</option>{['CASH','CARD','WALLET','MIXED'].map(v=><option key={v}>{v}</option>)}</select></label>}
     <div className="grid grid-cols-2 gap-2 border-t pt-3"><label className="space-y-1 text-xs text-muted-foreground">الترتيب<select className={selectClass} name="sort" defaultValue={params.get('sort')??'revenue_desc'}><option value="revenue_desc">المبلغ تنازلياً</option><option value="revenue_asc">المبلغ تصاعدياً</option><option value="name">الاسم / التاريخ</option></select></label><label className="space-y-1 text-xs text-muted-foreground">حجم الصفحة<select className={selectClass} name="pageSize" defaultValue={params.get('pageSize')??'30'}>{[15,30,60,100].map(v=><option key={v}>{v}</option>)}</select></label></div>
    </AdvancedFilters>
    <div className="flex gap-2 md:ms-auto"><Button type="submit" size="sm" className={btnClass}>تطبيق</Button><Button type="button" size="sm" variant="ghost" className={btnClass} onClick={()=>clearFilters(defaultRange)}>إعادة ضبط</Button></div>
   </div>
   {chips.length>0&&<div className="flex flex-wrap items-center gap-2 border-t pt-3" aria-label="الفلاتر المطبقة">{chips.map(([key,value])=><button key={key} type="button" className="inline-flex min-h-8 max-w-full min-w-0 items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm hover:bg-muted/70" onClick={()=>change(key,'')} aria-label={'إزالة فلتر '+CHIP_LABELS[key]}><span className="text-muted-foreground">{CHIP_LABELS[key]}:</span><bdi className="truncate">{value}</bdi><span aria-hidden="true">×</span></button>)}<Button type="button" size="sm" variant="ghost" className={btnClass} onClick={()=>clearFilters({from:params.get('from')!,to:params.get('to')!})}>مسح الكل</Button></div>}
  </form>
  {loading&&<div role="status" className="workspace-state animate-pulse">جارٍ تحميل التقرير… الفلاتر محفوظة.</div>}
  {error&&<div role="alert" className="workspace-state space-y-3 border-destructive/30"><p>{error}</p><Button variant="outline" onClick={refresh}>إعادة المحاولة</Button></div>}
  {data&&<>
   <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">{data.summaries.map(s=><div key={s.key} className="min-w-0 rounded-xl border bg-card px-4 py-3"><p className="text-sm font-medium text-muted-foreground">{s.label}</p><p className="mt-1 break-words text-2xl font-bold leading-8 tabular-nums"><bdi>{s.value??'غير متاح'}</bdi>{s.value&&/^-?\d+\.\d+$/.test(s.value)&&<span className="ms-1 text-xs font-normal text-muted-foreground">ج.م</span>}</p></div>)}</div>
   <details className="workspace-surface px-4 py-3"><summary className="cursor-pointer text-sm font-semibold">أساس الحساب وتغطية البيانات <span className="ms-2 text-xs font-normal text-muted-foreground">أنشئت اللقطة: <bdi>{new Intl.DateTimeFormat('ar-EG-u-nu-latn',{timeZone:'Africa/Cairo',dateStyle:'medium',timeStyle:'short'}).format(new Date(data.generatedAt))}</bdi></span></summary><p className="mt-3 text-sm leading-7">{data.metricBasis}</p><ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-7">{data.coverage.map(c=><li key={c}>{c}</li>)}</ul></details>
   <section className="workspace-surface space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{data.total} نتيجة مطابقة</h2><div className="flex items-center gap-2"><Button type="button" size="sm" variant="outline" className="md:min-h-9 md:py-1" onClick={refresh}>تحديث</Button><details><summary className="cursor-pointer text-sm">اختيار الأعمدة</summary><div className="grid gap-2 p-3 sm:grid-cols-2">{data.columns.map(c=><label key={c.key} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!hidden.includes(c.key)} onChange={e=>{const next=e.target.checked?hidden.filter(k=>k!==c.key):[...hidden,c.key];setHidden(next);try{localStorage.setItem(preferenceKey,JSON.stringify(next));}catch{/* optional preference */}}}/>{c.label}</label>)}</div></details></div></div>
    <ReportOutputActions snapshot={data.outputSnapshot} disabled={loading||!!error} endpoint={'/api/reports/'+kind+'/output'} scopeLabel="الصفحة المعروضة"/>
    {canKey('reports.export')&&<div className="space-y-2 border-t pt-3"><Button variant="outline" disabled={loading||!!error||preparing} onClick={()=>void prepareAll()}>{preparing?'جارٍ تجهيز اللقطة…':'تجهيز كل النتائج المفلترة — حد 5000 لكل مصدر'}</Button>{outputError&&<p role="alert">{outputError}</p>}{full&&<><p className="text-sm text-muted-foreground">كل {full.total} نتيجة · لقطة مستقلة {full.generatedAt}</p><ReportOutputActions snapshot={full.outputSnapshot} disabled={loading||!!error} endpoint={'/api/reports/'+kind+'/output'} scopeLabel="كل النتائج المفلترة"/></>}</div>}
    {data.rows.length?<SalesReportRows columns={columns} rows={data.rows} onDetail={row=>{returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setDetail(row);}}/>:!loading&&!error&&<div role="status" className="workspace-state py-10 text-center">{['brand','cost'].includes(params.get('view')??'')?'هذا العرض غير متاح؛ راجع تغطية البيانات أعلاه.':'لا توجد نتائج مطابقة. جرّب فترة أو فلاتر أخرى.'}</div>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><p className="text-sm">صفحة {data.page} / {Math.max(1,data.pages)} · {data.rows.length} من {data.total}</p><div className="flex gap-2"><Button variant="outline" disabled={loading||data.page<=1} onClick={()=>change('page',String(data.page-1))}>السابق</Button><Button variant="outline" disabled={loading||data.page>=data.pages} onClick={()=>change('page',String(data.page+1))}>التالي</Button></div></div>
   </section>
  </>}
  <Dialog open={!!detail} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent finalFocus={returnFocus} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" dir="rtl"><DialogTitle>تفاصيل السجل</DialogTitle>{detail&&<div className="space-y-4"><dl className="grid min-w-0 gap-3 sm:grid-cols-2">{[...(data?.columns.map(c=>[c.label,detail.cells[c.key]])??[]),...Object.entries(detail.details??{})].map(([label,value])=><div key={label} className="min-w-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-all tabular-nums"><bdi>{value??'غير متاح'}</bdi></dd></div>)}</dl><div className="flex flex-col gap-2">{detail.href&&<Link className="min-h-11 text-primary underline" href={detail.href}>فتح المصدر الأصلي</Link>}{detail.links?.map((link,index)=><Link key={index} className="min-h-11 break-all text-sm text-primary underline" href={link.href}>{link.label}</Link>)}</div><Button variant="outline" onClick={()=>setDetail(null)}>إغلاق التفاصيل</Button></div>}</DialogContent></Dialog>
 </div>;
}

/** Native disclosure keeps every field inside the form (FormData); this adds outside-click and Escape dismissal. */
function AdvancedFilters({count,children}:{count:number;children:ReactNode}){
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const el=ref.current;if(!el)return;const outside=(e:Event)=>{if(el.open&&!el.contains(e.target as Node))el.open=false;},esc=(e:KeyboardEvent)=>{if(e.key==='Escape'&&el.open){el.open=false;el.querySelector('summary')?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',esc);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',esc);};},[]);
 return <details ref={ref} className="md:relative max-md:w-full"><summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border bg-background px-3 text-sm md:min-h-9">فلاتر إضافية{count>0&&<span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{count}</span>}</summary><div className="z-20 mt-2 grid w-full gap-3 rounded-lg border bg-popover p-4 shadow-lg md:absolute md:end-0 md:top-full md:w-80">{children}</div></details>;
}

/** Keep the draft selection when authorized option metadata arrives after the first render. */
function DraftReportSelect({initialValue,children,...props}:{initialValue:string;children:ReactNode;name:string;className:string;disabled?:boolean}){
 const [value,setValue]=useState(initialValue);
 const available=Children.toArray(children).some(child=>isValidElement<{value?:string}>(child)&&child.props.value===value);
 return <select {...props} value={value} onChange={event=>setValue(event.target.value)}>{value&&!available&&<option value={value}>النطاق المحدد</option>}{children}</select>;
}
