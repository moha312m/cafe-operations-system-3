'use client';
import {useRef,useState} from 'react';
import {api} from '@/lib/client';
import {useApp} from '@/components/app-shell';
import {Button} from '@/components/ui/button';
export function ReportOutputActions({snapshot,disabled=false}:{snapshot?:string;disabled?:boolean}){
 const {canKey}=useApp(),[busy,setBusy]=useState(false),[error,setError]=useState(''),lock=useRef(false);
 if(!snapshot||!canKey('reports.export'))return null;
 async function output(kind:'print'|'csv'|'xlsx'){if(lock.current||disabled)return;lock.current=true;setBusy(true);setError('');try{
  const files=await api<{html:string;csv:string;xlsx:string}>('/api/reports/output',{method:'POST',body:{snapshot}});
  if(kind==='print'){const frame=document.createElement('iframe');frame.title='طباعة لقطة التقرير';frame.style.cssText='position:fixed;width:1px;height:1px;inset:0;opacity:0;pointer-events:none';frame.onload=()=>{frame.contentWindow?.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow?.focus();frame.contentWindow?.print();};document.body.append(frame);frame.srcdoc=files.html;}
  else{const blob=kind==='csv'?new Blob([files.csv],{type:'text/csv;charset=utf-8'}):new Blob([Uint8Array.from(atob(files.xlsx),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='sales-report.'+kind;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 }catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 return <div className="space-y-2"><div className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy||disabled} onClick={()=>void output('print')}>طباعة فترة التقرير والإجماليات</Button><Button variant="outline" disabled={busy||disabled} onClick={()=>void output('csv')}>تصدير CSV — اللقطة المعروضة</Button><Button variant="outline" disabled={busy||disabled} onClick={()=>void output('xlsx')}>تصدير Excel — نفس اللقطة</Button></div>{error&&<p role="alert">{error}</p>}</div>;
}
