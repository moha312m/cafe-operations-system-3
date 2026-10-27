import {addDays,DEFAULT_TZ,zonedDateTime} from './date-range';
export type ReportingHours={startTime:string;endTime:string;timezone:string;is24Hours:boolean;effectiveDate:string};
export type ReportWindow={branchId?:string;businessDate:string;from:Date;to:Date;startLocal:string;endLocal:string;timezone:string;warnings:string[];kind:'business'|'outside'|'custom'};
export const legacyReportingHours:ReportingHours={startTime:'00:00',endTime:'00:00',timezone:DEFAULT_TZ,is24Hours:true,effectiveDate:'0001-01-01'};
export function validDate(value:string){const d=new Date(value+'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&value>='2000-01-01'&&value<='2100-12-31';}
export function validateHours(h:ReportingHours){
 if(![h.startTime,h.endTime].every(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw Error('وقت التقرير غير صالح');
 if(h.is24Hours!== (h.startTime===h.endTime))throw Error('للعمل 24 ساعة اختر وقت بداية ونهاية متساويين وفعّل وضع 24 ساعة');
 if(!validDate(h.effectiveDate))throw Error('تاريخ السريان غير صالح');
 try{new Intl.DateTimeFormat('en',{timeZone:h.timezone}).format();}catch{throw Error('المنطقة الزمنية غير صالحة');}
 if(!h.timezone.includes('/')&&h.timezone!=='UTC')throw Error('اختر اسم منطقة زمنية مثل Africa/Cairo');
 return h;
}
export function versionForDate(date:string,versions:ReportingHours[]):ReportingHours{
 return [...versions].filter(v=>v.effectiveDate<=date).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0]??legacyReportingHours;
}
export function businessWindow(date:string,h:ReportingHours):ReportWindow{
 if(!validDate(date))throw Error('تاريخ العمل غير صالح');
 validateHours({...h,effectiveDate:date});
 const startLocal=date+'T'+h.startTime,endLocal=(h.is24Hours||h.endTime<h.startTime?addDays(date,1):date)+'T'+h.endTime;
 const start=zonedDateTime(startLocal,h.timezone),end=zonedDateTime(endLocal,h.timezone);
 if(end.at<=start.at)throw Error('فترة التقرير غير موجبة بعد تطبيق المنطقة الزمنية');
 return {businessDate:date,from:start.at,to:end.at,startLocal,endLocal,timezone:h.timezone,warnings:[start.warning,end.warning].filter((v):v is string=>!!v),kind:'business'};
}
function dates(from:string,to:string){if(!validDate(from)||!validDate(to)||from>to)throw Error('نطاق تاريخ العمل غير صالح');const result=[];for(let d=from;d<=to;d=addDays(d,1)){if(result.length>=62)throw Error('أقصى مدة 62 يوم عمل');result.push(d);}return result;}
export function windowsForDates(branchId:string,from:string,to:string,versions:ReportingHours[]):ReportWindow[]{return dates(from,to).map(date=>({...businessWindow(date,versionForDate(date,versions)),branchId}));}
export function outsideWindows(branchId:string,from:string,to:string,versions:ReportingHours[]):ReportWindow[]{
 return windowsForDates(branchId,from,to,versions).flatMap(w=>{const next=businessWindow(addDays(w.businessDate,1),versionForDate(addDays(w.businessDate,1),versions));return w.to<next.from?[{...w,from:w.to,to:next.from,startLocal:w.endLocal,endLocal:next.startLocal,kind:'outside' as const,warnings:[...w.warnings,...next.warnings,...(w.timezone!==next.timezone?['نهاية التغطية في '+next.timezone]:[])]}]:[];});
}
export function customWindow(start:string,end:string,timezone:string):ReportWindow{
 const a=zonedDateTime(start,timezone),b=zonedDateTime(end,timezone);if(b.at<=a.at)throw Error('نهاية المدة المخصصة يجب أن تكون بعد البداية');
 if(b.at.getTime()-a.at.getTime()>63*86400000)throw Error('أقصى مدة مخصصة 63 يومًا');
 return {businessDate:start.slice(0,10),from:a.at,to:b.at,startLocal:start,endLocal:end,timezone,warnings:[a.warning,b.warning].filter((v):v is string=>!!v),kind:'custom'};
}
export function transitionIssues(next:ReportingHours,versions:ReportingHours[]){
 const previous=businessWindow(addDays(next.effectiveDate,-1),versionForDate(addDays(next.effectiveDate,-1),versions));const current=businessWindow(next.effectiveDate,next);
 return previous.to.getTime()===current.from.getTime()?[]:[{kind:previous.to>current.from?'overlap' as const:'gap' as const,from:new Date(Math.min(previous.to.getTime(),current.from.getTime())).toISOString(),to:new Date(Math.max(previous.to.getTime(),current.from.getTime())).toISOString()}];
}
