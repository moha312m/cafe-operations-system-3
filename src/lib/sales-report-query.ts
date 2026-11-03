import {z} from 'zod';
import {addDays,dateStrInTz} from './date-range';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const id=z.string().trim().min(1).max(100).optional();
export const reportQuerySchema=z.object({cafeId:id,branchId:id,from:day.optional(),to:day.optional(),q:z.string().trim().max(100).optional(),shiftId:id,categoryId:id,actorId:id,sessionId:id,
 dayMode:z.enum(['calendar','business']).default('calendar'),view:z.enum(['product','lines','date','category','brand','cost']).default('product'),basis:z.enum(['creator','collector','server']).default('creator'),method:z.enum(['CASH','CARD','WALLET','MIXED']).optional(),
 sort:z.enum(['name','revenue_desc','revenue_asc']).default('revenue_desc'),page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30),export:z.enum(['page','all']).default('page')
}).strict().refine(q=>!q.from||!q.to||q.from<=q.to,{message:'بداية الفترة بعد نهايتها'});
export function parseReportQuery(params:URLSearchParams){const q=reportQuerySchema.parse(Object.fromEntries(params));const to=q.to??dateStrInTz(new Date()),from=q.from??addDays(to,-6);return {...reportQuerySchema.parse({...q,from,to}),from,to};}
export type SalesReportQuery=ReturnType<typeof parseReportQuery>;
