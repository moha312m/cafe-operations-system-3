import {createHmac,timingSafeEqual} from 'node:crypto';
import {resolveAuthSecret} from './auth';
export type ReportOutput={title:string;reporting:unknown;metrics:Record<string,unknown>;rows:Record<string,unknown>[];generatedAt:string};
export function signReportOutput(actorId:string,report:ReportOutput){const payload=Buffer.from(JSON.stringify({actorId,expires:Date.now()+30*60000,report})).toString('base64url');return payload+'.'+createHmac('sha256',resolveAuthSecret()).update(payload).digest('base64url');}
export function verifyReportOutput(actorId:string,token:string):ReportOutput{
 if(token.length>2000000)throw Error('حجم التقرير أكبر من المسموح');const [payload,signature,...extra]=token.split('.');if(!payload||!signature||extra.length)throw Error('توقيع التقرير غير صالح');
 const expected=createHmac('sha256',resolveAuthSecret()).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('توقيع التقرير غير صالح');
 const value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(value.actorId!==actorId||value.expires<Date.now())throw Error('حدّث التقرير قبل الطباعة أو التصدير');return value.report;
}
const escape=(s:unknown)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function reportOutputFiles(report:ReportOutput){
 const period=report.reporting as {mode?:string;windows?:{branchId?:string;startLocal:string;endLocal:string;timezone:string;from:string;to:string;warnings:string[]}[];branches?:{id:string;name:string}[]};
 const periods:[string,unknown][]=period?.windows?.length?period.windows.flatMap((w,i)=>[[`الفترة ${i+1} — ${period.branches?.find(b=>b.id===w.branchId)?.name??w.branchId??''}`,`${w.startLocal.replace('T',' ')} → ${w.endLocal.replace('T',' ')} · ${w.timezone}`],[`الفترة ${i+1} UTC`,`${w.from} → ${w.to}`],...w.warnings.map(warning=>['ملاحظة التوقيت الصيفي',warning]) ] as [string,unknown][]):[['الفترة',JSON.stringify(report.reporting)]];
 const rows:[string,unknown][]=[['التقرير',report.title],['نوع الفترة',period?.mode??''],['وقت إنشاء اللقطة',report.generatedAt],['الحدود','البداية مشمولة والنهاية مستبعدة'],...periods,...Object.entries(report.metrics).flatMap(([section,value])=>value&&typeof value==='object'?Object.entries(value as Record<string,unknown>).map(([k,v])=>[section+'.'+k,v] as [string,unknown]):[[section,value] as [string,unknown]])];
 const cells=(value:unknown)=>{let text=typeof value==='object'?JSON.stringify(value):String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
 const csv='\uFEFF'+[...rows.map(row=>row.map(cells).join(',')),...report.rows.map(row=>Object.entries(row).map(([k,v])=>cells(k+': '+(typeof v==='object'?JSON.stringify(v):v))).join(','))].join('\r\n');
 const html='<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><title>'+escape(report.title)+'</title><style>body{font:16px Arial;padding:20px}table{width:100%;border-collapse:collapse;overflow-wrap:anywhere}td,th{border:1px solid #888;padding:10px;text-align:start}tr{break-inside:avoid}p{overflow-wrap:anywhere}</style><h1>'+escape(report.title)+'</h1><p>لقطة التقرير نفسها المعروضة على الشاشة؛ لا تعدّ التحصيلات مبيعات جديدة.</p><table>'+rows.map(([k,v])=>'<tr><th>'+escape(k)+'</th><td dir="auto">'+escape(typeof v==='object'?JSON.stringify(v):v)+'</td></tr>').join('')+'</table><h2>التفاصيل</h2>'+report.rows.map(row=>'<p>'+Object.entries(row).map(([k,v])=>escape(k)+': '+escape(typeof v==='object'?JSON.stringify(v):v)).join(' · ')+'</p>').join('')+'</html>';
 return {csv,html};
}
