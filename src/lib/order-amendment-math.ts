import { decimal, money, sumMoney, validCurrencyInput, type Numeric } from '@/lib/money';

export type Discount = {type: string; value: Numeric};
export type AmendmentLine = {id: string; unitPrice: Numeric; addOnTotal: Numeric; quantity: number; discount: Discount};
export function discountFor(base: Numeric, discount: Discount) {
  if (!['NONE','PERCENT','FIXED'].includes(discount.type) || !validCurrencyInput(discount.value.toString())) throw new Error('خصم غير صالح');
  const value=decimal(discount.value), eligible=money(base);
  if(value.lt(0) || (discount.type==='PERCENT' && value.gt(100)) || (discount.type==='NONE' && !value.isZero())) throw new Error('قيمة الخصم غير صالحة');
  const amount=money(discount.type==='PERCENT'?eligible.times(value).div(100):discount.type==='FIXED'?value:0);
  if(amount.gt(eligible)) throw new Error('الخصم أكبر من المبلغ المتاح');
  return amount;
}

// Largest remainder in integer cents, with stable identifiers breaking ties.
export function allocateExact(amount: Numeric, entries: {id:string; weight:Numeric}[],includeCharges=false) {
  const total=money(sumMoney(entries.map(e=>e.weight))), target=money(amount).times(100).toNumber();
  if(target<0 || (!includeCharges&&money(amount).gt(total))) throw new Error('المبلغ أكبر من الرصيد المتاح');
  if(total.isZero()) return entries.map(e=>({id:e.id,amount:'0.00'}));
  const rows=entries.map(e=>{const raw=decimal(e.weight).times(target).div(total); return {id:e.id,cents:raw.floor().toNumber(),remainder:raw.minus(raw.floor())};});
  const ranked=[...rows].sort((a,b)=>b.remainder.comparedTo(a.remainder)||a.id.localeCompare(b.id,'en'));
  let rest=target-rows.reduce((s,r)=>s+r.cents,0);
  for(const row of ranked){if(rest<=0)break;row.cents++;rest--;}
  return rows.map(r=>({id:r.id,amount:money(decimal(r.cents).div(100)).toFixed(2)}));
}

export function priceAmendment(lines: AmendmentLine[], invoice: Discount, charges={taxRate:'0',serviceRate:'0',fixedService:'0'}) {
  if(!lines.length || lines.length>200 || new Set(lines.map(l=>l.id)).size!==lines.length)throw new Error('أصناف الطلب غير صالحة');
  const rows=lines.map(l=>{
    if(!Number.isInteger(l.quantity)||l.quantity<1||l.quantity>100000||!validCurrencyInput(l.unitPrice.toString())||decimal(l.unitPrice).lt(0)||decimal(l.addOnTotal).lt(0))throw new Error('كمية أو سعر غير صالح');
    const gross=money(decimal(l.unitPrice).plus(decimal(l.addOnTotal)).times(l.quantity));
    const itemDiscount=discountFor(gross,l.discount);
    return {...l,gross:gross.toFixed(2),itemDiscount:itemDiscount.toFixed(2),lineTotal:money(gross.minus(itemDiscount)).toFixed(2)};
  });
  const subtotal=money(sumMoney(rows.map(l=>l.gross))), afterLine=money(sumMoney(rows.map(l=>l.lineTotal)));
  if(subtotal.gt('99999999.99'))throw new Error('إجمالي الأصناف خارج النطاق');
  const invoiceAmount=discountFor(afterLine,invoice), shares=allocateExact(invoiceAmount,rows.map(l=>({id:l.id,weight:l.lineTotal})));
  const eligible=money(afterLine.minus(invoiceAmount));
  const service=decimal(charges.serviceRate).gt(0)?money(eligible.times(decimal(charges.serviceRate)).div(100)):money(charges.fixedService);
  const tax=money(eligible.plus(service).times(charges.taxRate).div(100)), total=money(eligible.plus(service).plus(tax));
  if(total.lt(0)||total.gt('99999999.99'))throw new Error('الإجمالي خارج النطاق');
  return {lines:rows.map(r=>({...r,invoiceShare:shares.find(s=>s.id===r.id)!.amount})),subtotal:subtotal.toFixed(2),itemDiscountAmount:money(subtotal.minus(afterLine)).toFixed(2),invoiceDiscountAmount:invoiceAmount.toFixed(2),discountAmount:money(subtotal.minus(afterLine).plus(invoiceAmount)).toFixed(2),serviceChargeAmount:service.toFixed(2),taxAmount:tax.toFixed(2),total:total.toFixed(2)};
}

export function allocateOrderPayable(total:Numeric,lines:{id:string;lineTotal:Numeric;invoiceDiscountShare?:Numeric;quantity:number}[]){
 const weights=lines.map(l=>({id:l.id,weight:money(decimal(l.lineTotal).minus(decimal(l.invoiceDiscountShare??0)))}));
 const zero=sumMoney(weights.map(l=>l.weight)).isZero();
 return allocateExact(total,zero?lines.map(l=>({id:l.id,weight:l.quantity})):weights,true);
}

export function settlementRequired(oldTotal:Numeric,netPaid:Numeric,newTotal:Numeric) {
  const paid=money(netPaid), next=money(newTotal), excess=money(paid.minus(next));
  if(excess.gt(0))return {direction:'REFUND' as const,amount:excess.toFixed(2),remaining:'0.00'};
  if(paid.gte(money(oldTotal))&&next.gt(paid))return {direction:'COLLECTION' as const,amount:money(next.minus(paid)).toFixed(2),remaining:'0.00'};
  return {direction:'NONE' as const,amount:'0.00',remaining:money(next.minus(paid)).toFixed(2)};
}

export function allocateRefund(amount:Numeric,collections:{id:string;method:string;amount:Numeric;refunded:Numeric}[]) {
  const eligible=collections.map(p=>({...p,weight:money(decimal(p.amount).minus(decimal(p.refunded)))})).filter(p=>p.weight.gt(0));
  return allocateExact(amount,eligible).filter(p=>decimal(p.amount).gt(0)).map(p=>({paymentId:p.id,method:eligible.find(e=>e.id===p.id)!.method,amount:p.amount}));
}
