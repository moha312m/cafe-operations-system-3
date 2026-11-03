import {z} from 'zod';
import type {Prisma} from '@prisma/client';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const text=z.string().trim().max(100).optional();
export const invoiceFilterSchema=z.object({cafeId:text,q:text,branchId:text,userId:text,customer:text,invoice:text,source:z.enum(['CASHIER_POS','QR_MENU','WAITER']).optional(),returns:z.literal('1').optional(),businessStatus:z.enum(['PENDING_WAITER_APPROVAL','CONFIRMED','PREPARING','READY','SERVED','CANCELLED','REJECTED']).optional(),sort:z.enum(['newest','oldest','total_desc']).default('newest'),from:day.optional(),to:day.optional(),business:z.enum(['0','1']).default('0'),status:z.enum(['UNPAID','PARTIAL','PAID','PENDING_COLLECTION','REFUNDED']).optional(),paymentMethod:z.enum(['CASH','CARD','WALLET']).optional(),action:z.string().max(80).optional(),page:z.coerce.number().int().min(1).max(10000).default(1),reportMode:z.enum(['business','outside','custom']).optional(),date:day.optional(),businessFrom:day.optional(),businessTo:day.optional(),customStart:z.string().max(40).optional(),customEnd:z.string().max(40).optional(),customTimezone:z.string().max(100).optional()}).strict();
export type InvoiceFilters=z.infer<typeof invoiceFilterSchema>;
export function invoiceConditions(f:InvoiceFilters,customerAllowed:boolean):Prisma.OrderWhereInput{
 if(f.customer&&!customerAllowed)throw Error('ليس لديك صلاحية البحث ببيانات العملاء');
 return {...(f.source?{source:f.source}:{}),...(f.businessStatus?{status:f.businessStatus}:{}),...(f.invoice?{id:f.invoice}:{}),...(f.customer?{OR:[{customerName:{contains:f.customer,mode:'insensitive'}},{customerPhone:{contains:f.customer}}]}:{}),...(f.returns?{payments:{some:{type:'REFUND',status:'PAID'}}}:{})};
}
const privateKeys=new Set(['customerName','customerPhone','customerId','customer','deliveryAddress']);
/** Strip customer identity from nested receipt/revision snapshots as well as current invoices. */
export function redactInvoiceCustomer<T>(value:T,allowed:boolean):T{
 if(allowed)return value;
 function clean(v:unknown):unknown{if(v instanceof Date||v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(clean);if('toFixed' in v)return v;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,privateKeys.has(k)?null:clean(x)]));}
 return clean(value) as T;
}
