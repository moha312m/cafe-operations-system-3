import React from 'react';
import Link from 'next/link';
import type {SalesReportColumn,SalesReportKind,SalesReportRow} from '@/lib/sales-report-contract';

function renderCell(row:SalesReportRow,key:string,kind?:SalesReportKind){
 const raw=row.cells[key];
 if(raw===null||raw===undefined)return <bdi>غير متاح</bdi>;
 if(kind==='shift-sales'){
  if(key==='variance'){
   const num=Number(raw);
   const cls=!Number.isFinite(num)||num===0?'':num<0?'font-semibold text-destructive':'font-semibold text-emerald-600 dark:text-emerald-400';
   return <span className={cls}><bdi>{num>0?`+${raw}`:raw}</bdi></span>;
  }
  if(key==='card'&&row.cells.cardCount!==undefined)return <bdi>{raw} ({row.cells.cardCount})</bdi>;
  if(key==='wallet'&&row.cells.walletCount!==undefined)return <bdi>{raw} ({row.cells.walletCount})</bdi>;
  if(key==='cash'&&row.cells.cashCount!==undefined)return <bdi>{raw} ({row.cells.cashCount})</bdi>;
 }
 return <bdi>{raw}</bdi>;
}

export function SalesReportRows({
 columns,
 rows,
 onDetail,
 kind,
 canCloseShift=false,
 onRegisterDetails,
}:{
 columns:SalesReportColumn[];
 rows:SalesReportRow[];
 onDetail:(row:SalesReportRow)=>void;
 kind?:SalesReportKind;
 canCloseShift?:boolean;
 onRegisterDetails?:(row:SalesReportRow)=>void;
}){
 return <>
  <div className="space-y-3 md:hidden">
   {rows.map(row=>{
    const isOpenShift=kind==='shift-sales'&&row.cells.status==='OPEN';
    const branchId=row.details?.branchId??'';
    return <article key={row.id} className="workspace-surface space-y-3 p-4">
     <dl className="grid min-w-0 grid-cols-2 gap-3">
      {[...columns].sort((a,b)=>{
       const priority=['name','sku','reference','date','status','net','amount','counted','variance','share','remaining'];
       const rank=(key:string)=>{const i=priority.indexOf(key);return i<0?99:i;};
       return rank(a.key)-rank(b.key);
      }).slice(0,6).map(c=><div key={c.key} className="min-w-0"><dt className="text-sm text-muted-foreground">{c.label}</dt><dd className="break-words font-medium tabular-nums">{renderCell(row,c.key,kind)}</dd></div>)}
     </dl>
     <div className="flex flex-wrap gap-2">
      {onRegisterDetails ? <button type="button" className="min-h-11 flex-1 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground" onClick={()=>onRegisterDetails(row)}>عرض السجل</button> : <button type="button" className="min-h-11 flex-1 rounded-lg border px-4 text-sm font-medium" onClick={()=>onDetail(row)}>تفاصيل</button>}

      {isOpenShift&&canCloseShift&&branchId&&<Link href={`/close-shift?branchId=${encodeURIComponent(branchId)}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 px-4 text-sm font-semibold text-destructive">إغلاق</Link>}
     </div>
    </article>;
   })}
  </div>
  <div className="hidden md:block">
   <div className="max-w-full overflow-x-auto rounded-xl border" tabIndex={0} aria-label="جدول التقرير القابل للتمرير">
    <table className="w-full whitespace-nowrap text-start text-sm">
     <thead className="bg-muted/50">
      <tr>
       {columns.map(c=><th key={c.key} scope="col" className="p-3 text-start font-medium">{c.label}</th>)}
       <th className="p-3">التفاصيل</th>
      </tr>
     </thead>
     <tbody className="divide-y">
      {rows.map(row=>{
       const isOpenShift=kind==='shift-sales'&&row.cells.status==='OPEN';
       const branchId=row.details?.branchId??'';
       return <tr key={row.id}>
        {columns.map(c=><td key={c.key} className="p-3 tabular-nums">{renderCell(row,c.key,kind)}</td>)}
        <td className="p-3">
         <div className="flex items-center gap-1.5">
          {onRegisterDetails ? <button type="button" className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90" onClick={()=>onRegisterDetails(row)}>عرض السجل</button> : <button type="button" className="min-h-11 rounded-lg border px-4 font-medium" onClick={()=>onDetail(row)}>تفاصيل</button>}

          {isOpenShift&&canCloseShift&&branchId&&<Link href={`/close-shift?branchId=${encodeURIComponent(branchId)}`} className="inline-flex min-h-9 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/20">إغلاق</Link>}
         </div>
        </td>
       </tr>;
      })}
     </tbody>
    </table>
   </div>
  </div>
 </>;
}
