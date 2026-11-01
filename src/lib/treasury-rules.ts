import { z } from "zod";
const text=(max:number)=>z.string().trim().min(1,"هذا الحقل مطلوب").max(max,"النص أطول من الحد المسموح");
export const moneyAccountKind=z.enum(["TREASURY","BANK","WALLET"]);
export const transferChannel=z.enum(["INTERNAL","INSTAPAY"]);
export const transferStatus=z.enum(["DRAFT","IN_TRANSIT","RECEIVED","CANCELLED"]);
export function moneyCents(value:string|number):bigint { const s=String(value);if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw new RangeError("المبلغ بمنزلتين عشريتين كحد أقصى");const [whole,fraction=""]=s.replace("-","").split(".");return (s.startsWith("-")?-BigInt("1"):BigInt("1"))*(BigInt(whole)*BigInt("100")+BigInt(fraction.padEnd(2,"0"))); }
export function formatMoneyCents(value:bigint):string {const n=value<BigInt("0")?-value:value;return (value<BigInt("0")?"-":"")+String(n/BigInt("100"))+"."+String(n%BigInt("100")).padStart(2,"0");}
export const transferAmount=z.number({error:"أدخل مبلغًا رقميًا محدودًا"}).finite("أدخل مبلغًا محدودًا").superRefine((n,c)=>{try{const amount=moneyCents(n);if(amount<=BigInt("0")||amount>BigInt("999999999999"))throw Error();}catch{c.addIssue({code:"custom",message:"مبلغ موجب رقمي بمنزلتين وداخل سعة التخزين"});}});
export const accountCreateInput=z.object({code:text(30).transform(s=>s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_-]+$/)),name:z.string().trim().min(2,"الاسم حرفان على الأقل").max(100,"الاسم لا يتجاوز ١٠٠ حرف"),kind:moneyAccountKind,branchId:text(128).nullable().optional(),instaPayEnabled:z.boolean().default(false)}).strict().refine(v=>v.kind==="BANK"||!v.instaPayEnabled,{message:"ربط إنستاباي لحساب البنك فقط"});
export const accountPatchInput=z.object({expectedVersion:z.number().int().min(0).max(2147483646),name:z.string().trim().min(2,"الاسم حرفان على الأقل").max(100,"الاسم لا يتجاوز ١٠٠ حرف").optional(),instaPayEnabled:z.boolean().optional(),isActive:z.boolean().optional()}).strict().refine(v=>v.name!==undefined||v.instaPayEnabled!==undefined||v.isActive!==undefined,{message:"حدد تعديلًا"});
export const transferCreateInput=z.object({fromAccountId:text(128),toAccountId:text(128),amount:transferAmount,channel:transferChannel,reference:text(160).optional(),note:text(1000)}).strict().refine(v=>v.fromAccountId!==v.toAccountId,{message:"اختر حسابين مختلفين"});
export const dispatchInput=z.object({moneyLeft:z.literal(true,{error:"أكد خروج الأموال فعليًا"}),reference:text(160).optional()}).strict();
export const receiveInput=z.object({moneyReceived:z.literal(true,{error:"أكد الاستلام الفعلي"}),reference:text(160).optional()}).strict();
export const cancelInput=z.object({reason:text(1000)}).strict();
export function channelAllowed(channel:string,from:{kind:string;instaPayEnabled?:boolean},to:{kind:string}):boolean{return channel==="INTERNAL"||(channel==="INSTAPAY"&&from.kind==="BANK"&&from.instaPayEnabled===true&&["BANK","WALLET"].includes(to.kind));}
export function moneyAccountInScope(actor:{cafeId:string|null;branchId:string|null},account:{cafeId:string;branchId:string|null}):boolean{return actor.cafeId===account.cafeId&&(!actor.branchId||actor.branchId===account.branchId);}
export function moneySourceKey(kind:"OPENING"|"TRANSFER_OUT"|"TRANSFER_IN",id:string):string{return kind==="OPENING"?"money-opening:"+id:"money-transfer:"+id+(kind==="TRANSFER_OUT"?":out":":in");}
export function recordedBalance(state:string,amounts:(string|number)[]):string|null{return state!=="APPROVED"?null:formatMoneyCents(amounts.reduce<bigint>((n,x)=>n+moneyCents(x),BigInt("0")));}
export type MoneyAction="create"|"dispatch"|"receive"|"cancel";
export type MoneyActionReceipt={transferId:string;action:MoneyAction;recordedAt:string;actorId:string;movementId?:string;reference?:string|null;reason?:string};
export function actionReceipt(event:MoneyActionReceipt):MoneyActionReceipt{return {...event};}
export const coverageNotice="رصيد الحركات المسجلة فقط؛ لا يشمل التحصيلات والمشتريات والمصروفات وأموال التسليم القديمة. الأرصدة الحقيقية وربط المصادر والافتتاح معلقون للاعتماد.";
