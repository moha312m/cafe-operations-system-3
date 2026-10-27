"use client";
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, money } from '@/lib/client';
import { useApp } from '@/components/app-shell';
import { dateStrInTz, addDays } from '@/lib/date-range';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VarianceDetail } from '@/components/variances/variance-detail';
import { STATUS_LABEL,type VarianceStatus } from '@/components/variances/variance-labels';
import type { EmployeeVarianceRow, VarianceCategory, VarianceEmployee, summarizeEmployeeVariances } from '@/lib/employee-variance-report';

type Report=ReturnType<typeof summarizeEmployeeVariances>&{handoverId:string|null;employeeOptions:VarianceEmployee[];branchOptions:VarianceEmployee[];range:{from:string;to:string}};
const LABEL:Record<VarianceCategory,string>={CASH:'كاش',CARD:'فيزا',WALLET:'محفظة',TENDER:'وسائل دفع أخرى',STOCK:'خامات',HANDOVER_CASH:'نقدية التسليم',OPENING:'فرق افتتاح'};
const UNIT:Record<string,string>={KG:'كجم',GRAM:'جرام',LITER:'لتر',ML:'مل',PIECE:'قطعة',BOX:'علبة',BAG:'كيس'};
const RESPONSIBILITY:Record<EmployeeVarianceRow['responsibility'],string>={CUSTODY:'منسوب لعهدة الموظف — لم تعتمد المسؤولية',ASSIGNED:'مسؤولية معتمدة',UNRESOLVED:'غير محسوم المسؤولية',BRANCH:'عهدة الفرع'};
const localDate=(value:string)=>new Date(value).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'short',timeStyle:'short'});
export default function EmployeeVariancesPage(){
  const {canKey,cafe,user}=useApp();const allowed=canKey('variance.view');
  const today=dateStrInTz(new Date());
  const [range,setRange]=useState('last_7_days'),[date,setDate]=useState(today),[from,setFrom]=useState(addDays(today,-6)),[to,setTo]=useState(today);
  const [employee,setEmployee]=useState(''),[branch,setBranch]=useState(''),[report,setReport]=useState<Report|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null);
  const requestSequence=useRef(0);
  const currency=cafe?.currency??'EGP';
  const load=useCallback(async()=>{
    if(!allowed)return;const sequence=++requestSequence.current;setLoading(true);setError('');
    const p=new URLSearchParams({range,date,from,to});if(employee)p.set('employeeId',employee);if(branch)p.set('branchId',branch);
    const handoverId=new URLSearchParams(window.location.search).get('handoverId');if(handoverId)p.set('handoverId',handoverId);
    try{const data=await api<Report>('/api/reports/employee-variances?'+p);if(sequence===requestSequence.current)setReport(data);}
    catch(e){if(sequence===requestSequence.current){const message=e instanceof Error?e.message:'تعذر تحميل التقرير';setError(message);setReport(null);toast.error(message);}}
    finally{if(sequence===requestSequence.current)setLoading(false);}
  },[allowed,range,date,from,to,employee,branch]);
  const invalidateRequests=useCallback(()=>{requestSequence.current++;},[]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),150);return()=>{clearTimeout(timer);invalidateRequests();};},[load,invalidateRequests]);
  if(!allowed)return <main className="p-6">ليس لديك صلاحية لعرض فروق الموظفين</main>;
  return <main className="space-y-5 p-4 sm:p-6" dir="rtl">
    <header className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">تقرير فروق الموظفين</h1><Link href="/reports" className="text-primary underline print:hidden">تقارير المبيعات</Link><Button className="ms-auto print:hidden" variant="outline" disabled={loading||!report} onClick={()=>window.print()}>طباعة التقرير</Button></header>
    <div className="flex flex-wrap items-end gap-3 rounded-xl border p-4 print:hidden">
      <label className="space-y-1 text-sm">الفترة<select disabled={!!report?.handoverId} aria-label="الفترة" className="block rounded-md border bg-background p-2" value={range} onChange={e=>setRange(e.target.value)}>
        <option value="today">اليوم</option><option value="yesterday">أمس</option><option value="last_7_days">آخر 7 أيام</option><option value="month">الشهر الحالي</option><option value="last_30_days">آخر 30 يوم</option><option value="custom_day">يوم محدد</option><option value="custom_range">من تاريخ إلى تاريخ</option></select></label>
      {!report?.handoverId&&range==='custom_day'&&<label className="text-sm">اليوم<Input aria-label="اليوم" type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>}
      {!report?.handoverId&&range==='custom_range'&&<><label className="text-sm">من<Input aria-label="من تاريخ" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="text-sm">إلى<Input aria-label="إلى تاريخ" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></>}
      <label className="space-y-1 text-sm">الموظف<select aria-label="الموظف" className="block rounded-md border bg-background p-2" value={employee} onChange={e=>setEmployee(e.target.value)}><option value="">كل الموظفين</option>{report?.employeeOptions.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
      {!user.branchId&&<label className="space-y-1 text-sm">الفرع<select aria-label="الفرع" className="block rounded-md border bg-background p-2" value={branch} onChange={e=>setBranch(e.target.value)}><option value="">كل الفروع</option>{report?.branchOptions.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
    </div>
    <p className="text-sm text-muted-foreground">الفترة حسب تاريخ تسجيل الفرق بتوقيت القاهرة. كل حالة توضح شيفت اكتشافها؛ مسؤولية الموظف تعتمد بشكل مستقل. العجز والزيادة معروضين منفصلين.</p>
    {loading?<p role="status">جاري تحميل التقرير…</p>:error?<p role="alert" className="text-destructive">{error}</p>:report&&<>
      <p className="text-sm">{report.handoverId?<span>كشف تسليم محدد · <Link href="/reports/employee-variances" className="text-primary underline">كل الموظفين والفترات</Link></span>:<>الفترة: {report.range.from} إلى {report.range.to}</>} · {report.rows.length} حالة · {report.unresolved.length} حالة تخص عهدة الفرع أو غير محسومة المسؤولية</p>
      <section className="space-y-3" aria-label="ملخص الموظفين">{report.employees.map(g=><article className="rounded-xl border p-4 break-inside-avoid" key={g.employee.id}>
        <h2 className="mb-3 font-semibold">{g.employee.name}</h2><div className="grid gap-3 sm:grid-cols-3">{(Object.keys(LABEL) as VarianceCategory[]).filter(c=>g.totals[c].count>0).map(c=><div className="rounded-lg bg-muted/40 p-3" key={c}><p className="font-medium">{LABEL[c]}</p><p>عجز: {money(g.totals[c].shortage,currency)} · زيادة: {money(g.totals[c].surplus,currency)}</p>{g.totals[c].unpriced>0&&<p className="text-sm">{g.totals[c].unpriced} حالة لم تتوفر قيمتها المالية</p>}</div>)}</div>
        {g.stock.map(s=><p className="mt-2 text-sm" key={s.itemId+s.unit}>{s.name}: عجز {s.shortage} {UNIT[s.unit]??s.unit} · زيادة {s.surplus} {UNIT[s.unit]??s.unit}</p>)}
        {g.unresolvedCount>0&&<p className="mt-3 text-sm text-amber-700">{g.unresolvedCount} فرق مرتبط بفترة شارك فيها الموظف؛ غير داخل في إجمالي عجز عهدته.</p>}
      </article>)}</section>
      {report.rows.length===0?<p className="rounded-xl border p-6 text-center">مفيش فروق مسجلة بالفلاتر دي</p>:<div className="overflow-x-auto rounded-xl border"><table className="w-full text-sm"><thead className="bg-muted/50"><tr>{['تسجيل الفرق / الشيفت','الموظف / الفرع','النوع / الصنف','المتوقع','الفعلي','الفرق','السبب','حالة المراجعة','المسؤولية'].map(h=><th className="p-3 text-start" key={h}>{h}</th>)}</tr></thead><tbody>{report.rows.map(r=><tr key={r.id} className="border-t align-top break-inside-avoid">
        <td className="p-3"><p>{localDate(r.openedAt)}</p>{r.shift&&<Link className="text-primary underline" href={'/reports/shift/'+r.shift.id}>شيفت #{r.shift.number}<span className="block text-xs">افتتاح: {localDate(r.shift.openedAt)}</span></Link>}</td>
        <td className="p-3"><p>{r.employee?.name??(r.relatedEmployees.map(e=>e.name).join('، ')||'غير محدد')}</p><p className="text-muted-foreground">{r.branch.name}</p>{r.custodian&&r.assignedResponsibility&&r.custodian.id!==r.assignedResponsibility.id&&<p className="text-xs">صاحب العهدة: {r.custodian.name}</p>}{r.outgoingEmployee&&<p className="text-xs">المسلم: {r.outgoingEmployee.name} · المستلم: {r.incomingEmployee?.name??'عهدة الفرع'}</p>}</td>
        <td className="p-3">{LABEL[r.category]}{r.item&&<p>{r.item.name} ({UNIT[r.unit??'']??r.unit})</p>}</td>
        <td className="p-3 tabular-nums">{r.expected??'غير متاح'}</td><td className="p-3 tabular-nums">{r.actual??'غير متاح'}</td>
        <td className="p-3"><p className={r.variance!==null&&r.variance<0?'text-red-700':'text-emerald-700'}>{r.variance===null?'غير متاح':r.variance<0?'عجز '+Math.abs(r.variance):'زيادة '+r.variance}</p>{r.category==='STOCK'&&<p>{r.financialImpact===null?'القيمة غير متاحة':money(r.financialImpact,currency)}</p>}</td>
        <td className="max-w-xs whitespace-pre-wrap p-3">{r.reason??'لم يسجل سبب'}</td><td className="p-3">{r.status==='UNRECORDED'?'تسليم سابق غير متحقق منه':STATUS_LABEL[r.status as VarianceStatus]??r.status}</td><td className="p-3"><p>{RESPONSIBILITY[r.responsibility]}</p>{r.assignedResponsibility&&<p>المسؤول: {r.assignedResponsibility.name}</p>}{!r.id.startsWith('legacy:')&&<button className="mt-2 text-primary underline print:hidden" onClick={()=>setSelected(r.id)}>مراجعة الحالة</button>}</td>
      </tr>)}</tbody></table></div>}
    </>}
    <VarianceDetail caseId={selected} onClose={()=>setSelected(null)} onAdvanced={()=>void load()}/>
  </main>;
}
