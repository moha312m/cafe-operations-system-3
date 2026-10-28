import {createHmac,timingSafeEqual} from 'node:crypto';
import {resolveAuthSecret} from './auth';
import {buildXlsx} from './xlsx';
export type ReportOutput={title:string;reporting:unknown;metrics:Record<string,unknown>;rows:Record<string,unknown>[];generatedAt:string;
 /** Human labels for metric keys ("section.key"); exports fall back to the key. */
 labels?:Record<string,string>};
export function signReportOutput(actorId:string,report:ReportOutput){const payload=Buffer.from(JSON.stringify({actorId,expires:Date.now()+30*60000,report})).toString('base64url');return payload+'.'+createHmac('sha256',resolveAuthSecret()).update(payload).digest('base64url');}
export function verifyReportOutput(actorId:string,token:string):ReportOutput{
 if(token.length>2000000)throw Error('حجم التقرير أكبر من المسموح');const [payload,signature,...extra]=token.split('.');if(!payload||!signature||extra.length)throw Error('توقيع التقرير غير صالح');
 const expected=createHmac('sha256',resolveAuthSecret()).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('توقيع التقرير غير صالح');
 const value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(value.actorId!==actorId||value.expires<Date.now())throw Error('حدّث التقرير قبل الطباعة أو التصدير');return value.report;
}
const escape=(s:unknown)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

// ── One table model for every output ─────────────────────────────────
// Screen snapshot → summary rows + one table per section. CSV, print and
// XLSX are all rendered from this model, so they cannot disagree on a total.

const SECTION_LABELS:Record<string,string>={byBranch:'حسب الفرع',byPaymentMethod:'حسب طريقة الدفع',byCashier:'حسب الكاشير',refundsByActor:'المرتجعات حسب المنفّذ',items:'الأصناف',salesByStaff:'مبيعات الموظفين',rows:'التفاصيل'};
export type OutputValue=string|number|boolean|null;
export type OutputTable={key:string;title:string;columns:string[];rows:OutputValue[][]};
export type OutputModel={title:string;summary:{label:string;key:string;value:OutputValue}[];tables:OutputTable[]};

// Money crosses the snapshot as JSON, where Prisma Decimals become strings.
// A plain decimal string is a number again; leading zeros (phone numbers,
// codes) and digit runs past float precision stay text.
const NUMERIC=/^-?(0|[1-9]\d*)(\.\d+)?$/;
export function outputValue(value:unknown):OutputValue{
 if(value===null||value===undefined)return null;
 if(typeof value==='number')return Number.isFinite(value)?value:String(value);
 if(typeof value==='boolean')return value;
 if(typeof value==='string')return NUMERIC.test(value)&&value.replace(/[-.]/g,'').length<=15?Number(value):value;
 return JSON.stringify(value);
}

export function reportOutputModel(report:ReportOutput):OutputModel{
 const period=report.reporting as {mode?:string;windows?:{branchId?:string;startLocal:string;endLocal:string;timezone:string;from:string;to:string;warnings:string[]}[];branches?:{id:string;name:string}[]};
 const info=(label:string,value:unknown,key='')=>({label,key,value:outputValue(value)});
 const periods=period?.windows?.length?period.windows.flatMap((w,i)=>[info(`الفترة ${i+1} — ${period.branches?.find(b=>b.id===w.branchId)?.name??w.branchId??''}`,`${w.startLocal.replace('T',' ')} → ${w.endLocal.replace('T',' ')} · ${w.timezone}`),info(`الفترة ${i+1} UTC`,`${w.from} → ${w.to}`),...w.warnings.map(warning=>info('ملاحظة التوقيت الصيفي',warning))]):[info('الفترة',JSON.stringify(report.reporting))];
 const metrics=Object.entries(report.metrics).flatMap(([section,value])=>value&&typeof value==='object'?Object.entries(value as Record<string,unknown>).map(([k,v])=>{const key=section+'.'+k;return info(report.labels?.[key]??key,v,key);}):[info(report.labels?.[section]??section,value,section)]);
 const summary=[info('التقرير',report.title),info('نوع الفترة',period?.mode??''),info('وقت إنشاء اللقطة',report.generatedAt),info('الحدود','البداية مشمولة والنهاية مستبعدة'),...periods,...metrics];
 const grouped=new Map<string,Record<string,unknown>[]>();
 for(const row of report.rows){const {section,...rest}=row,key=typeof section==='string'?section:'rows';grouped.set(key,[...(grouped.get(key)??[]),rest]);}
 const tables=[...grouped].map(([key,rows])=>{const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))];return {key,title:SECTION_LABELS[key]??key,columns,rows:rows.map(r=>columns.map(c=>outputValue(r[c])))};});
 return {title:report.title,summary,tables};
}

// A text cell that a spreadsheet could read as a formula is prefixed with '.
// Real numbers are written bare so they stay numeric (a negative number is
// not a formula).
const csvCell=(value:OutputValue)=>{if(typeof value==='number')return String(value);let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};

export function reportOutputFiles(report:ReportOutput){
 const model=reportOutputModel(report);
 const line=(cells:OutputValue[])=>cells.map(csvCell).join(',');
 const csv='\uFEFF'+[line(['البند','القيمة','المفتاح']),...model.summary.map(s=>line([s.label,s.value,s.key])),...model.tables.flatMap(t=>['',line([t.title]),line(t.columns),...t.rows.map(line)])].join('\r\n');
 const show=(v:OutputValue)=>escape(v??'');
 const html='<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><title>'+escape(model.title)+'</title><style>body{font:16px Arial;padding:20px}table{width:100%;border-collapse:collapse;overflow-wrap:anywhere;margin-bottom:16px}td,th{border:1px solid #888;padding:8px;text-align:start}tr{break-inside:avoid}p{overflow-wrap:anywhere}td.n{font-variant-numeric:tabular-nums}</style><h1>'+escape(model.title)+'</h1><p>لقطة التقرير نفسها المعروضة على الشاشة؛ لا تعدّ التحصيلات مبيعات جديدة.</p><table>'+model.summary.map(s=>'<tr><th>'+escape(s.label)+'</th><td dir="auto"'+(typeof s.value==='number'?' class="n"':'')+'>'+show(s.value)+'</td></tr>').join('')+'</table>'+model.tables.map(t=>'<h2>'+escape(t.title)+'</h2><table><tr>'+t.columns.map(c=>'<th>'+escape(c)+'</th>').join('')+'</tr>'+t.rows.map(r=>'<tr>'+r.map(v=>'<td dir="auto"'+(typeof v==='number'?' class="n"':'')+'>'+show(v)+'</td>').join('')+'</tr>').join('')+'</table>').join('')+'</html>';
 const xlsx=buildXlsx([{name:'الملخص',headerRows:[0],rows:[['البند','القيمة','المفتاح'],...model.summary.map(s=>[s.label,s.value,s.key])]},...model.tables.map(t=>({name:t.title,headerRows:[0],rows:[t.columns,...t.rows]}))]).toString('base64');
 return {csv,html,xlsx};
}
