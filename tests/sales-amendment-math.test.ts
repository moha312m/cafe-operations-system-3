import test from 'node:test';
import assert from 'node:assert/strict';
import { priceAmendment, allocateRefund, settlementRequired,allocateOrderPayable } from '../src/lib/order-amendment-math';

const line = (id='tea',quantity=1) => ({id,unitPrice:'100',addOnTotal:'0',quantity,discount:{type:'NONE' as const,value:'0'}});
const invoice = {type:'NONE' as const,value:'0'};
test('100 with 10% invoice discount becomes 90 without charges',()=>{
 const p=priceAmendment([line()],{type:'PERCENT',value:'10'}); assert.equal(p.total,'90.00'); assert.equal(p.discountAmount,'10.00');
});
test('line discount precedes invoice discount: 100 -> 90 -> 81',()=>{
 const p=priceAmendment([{...line(),discount:{type:'PERCENT',value:'10'}}],{type:'PERCENT',value:'10'});
 assert.equal(p.total,'81.00'); assert.equal(p.lines[0].lineTotal,'90.00'); assert.equal(p.lines[0].invoiceShare,'9.00');
});
test('fixed discount and removal preserve historical unit price',()=>{
 assert.equal(priceAmendment([{...line(),discount:{type:'FIXED',value:'20'}}],invoice).total,'80.00');
 assert.equal(priceAmendment([line()],invoice).total,'100.00');
});
test('saved tax/service treatment: discount, then service, then tax',()=>{
 const p=priceAmendment([line()],{type:'FIXED',value:'10'},{taxRate:'14',serviceRate:'10',fixedService:'0'});
 assert.equal(p.serviceChargeAmount,'9.00'); assert.equal(p.taxAmount,'13.86'); assert.equal(p.total,'112.86');
});
test('invoice allocation conserves cents with stable ties',()=>{
 const lines=['c','a','b'].map(id=>({...line(id),unitPrice:'0.01'}));
 const p=priceAmendment(lines,{type:'FIXED',value:'0.02'});
 assert.deepEqual(p.lines.map(x=>[x.id,x.invoiceShare]),[['c','0.00'],['a','0.01'],['b','0.01']]); assert.equal(p.total,'0.01');
});
for(const bad of [{type:'PERCENT',value:'101'},{type:'FIXED',value:'101'},{type:'FIXED',value:'-1'},{type:'NONE',value:'1'},{type:'FIXED',value:'1.001'}]){
 test(`reject invalid discount ${JSON.stringify(bad)}`,()=>assert.throws(()=>priceAmendment([line()],bad)));
}
test('reject bad quantities and negative prices',()=>{
 for(const quantity of [0,-1,1.1,100001])assert.throws(()=>priceAmendment([line('x',quantity)],invoice));
 assert.throws(()=>priceAmendment([{...line(),unitPrice:'-1'}],invoice));
});
test('unpaid and partially paid revisions do not invent cash',()=>{
 assert.deepEqual(settlementRequired('100','0','90'),{direction:'NONE',amount:'0.00',remaining:'90.00'});
 assert.deepEqual(settlementRequired('100','50','120'),{direction:'NONE',amount:'0.00',remaining:'70.00'});
});
test('paid higher, lower, discount and unchanged',()=>{
 assert.equal(settlementRequired('0','0','100').direction,'COLLECTION');
 assert.equal(settlementRequired('0','0','100').amount,'100.00');
 assert.equal(settlementRequired('100','100','120').amount,'20.00');
 assert.equal(settlementRequired('100','100','120').direction,'COLLECTION');
 assert.equal(settlementRequired('100','100','80').amount,'20.00');
 assert.equal(settlementRequired('100','100','90').amount,'10.00');
 assert.equal(settlementRequired('100','100','100').direction,'NONE');
});
test('mixed refund follows original tender and remaining refundable amounts',()=>{
 const p=allocateRefund('20',[{id:'cash',method:'CASH',amount:'60',refunded:'10'},{id:'card',method:'CARD',amount:'40',refunded:'0'}]);
 assert.deepEqual(p,[{paymentId:'cash',method:'CASH',amount:'11.11'},{paymentId:'card',method:'CARD',amount:'8.89'}]);
 assert.throws(()=>allocateRefund('91',[{id:'a',method:'CARD',amount:'100',refunded:'10'}]));
});
test('fully refunded legs cannot be refunded twice; card-only stays card',()=>{
 assert.deepEqual(allocateRefund('10',[{id:'a',method:'CASH',amount:'50',refunded:'50'},{id:'b',method:'CARD',amount:'100',refunded:'0'}]),[{paymentId:'b',method:'CARD',amount:'10.00'}]);
});
test('item payment shares include invoice discount, tax and service exactly once',()=>{
 assert.deepEqual(allocateOrderPayable('102.60',[{id:'a',lineTotal:'50',invoiceDiscountShare:'5',quantity:1},{id:'b',lineTotal:'50',invoiceDiscountShare:'5',quantity:1}]),[{id:'a',amount:'51.30'},{id:'b',amount:'51.30'}]);
 assert.deepEqual(allocateOrderPayable('11.40',[{id:'a',lineTotal:'0',quantity:1},{id:'b',lineTotal:'0',quantity:1}]),[{id:'a',amount:'5.70'},{id:'b',amount:'5.70'}]);
});
