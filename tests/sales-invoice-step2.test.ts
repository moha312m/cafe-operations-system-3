import test from 'node:test';import assert from 'node:assert/strict';
import {invoiceConditions,redactInvoiceCustomer,invoiceFilterSchema} from '../src/lib/sales-invoice-filters';
test('POS register and returns apply real source/payment predicates',()=>{
 const f=invoiceFilterSchema.parse({source:'CASHIER_POS',returns:'1',businessStatus:'SERVED'}),where=invoiceConditions(f,true);
 assert.equal(where.source,'CASHIER_POS');assert.equal(where.status,'SERVED');assert.deepEqual(where.payments,{some:{type:'REFUND',status:'PAID'}});
});
test('customer search requires authority and nested revision payloads are redacted',()=>{
 const f=invoiceFilterSchema.parse({customer:'علي'});assert.throws(()=>invoiceConditions(f,false));
 const data={customerName:'علي',revisions:[{before:{customerPhone:'0123',total:'100'}}]};
 assert.deepEqual(redactInvoiceCustomer(data,false),{customerName:null,revisions:[{before:{customerPhone:null,total:'100'}}]});assert.deepEqual(redactInvoiceCustomer(data,true),data);
});
test('invoice schema rejects unknown source, unsupported sort and unknown query fields',()=>{
 for(const v of [{source:'FAKE'},{sort:'sql'},{arbitrary:'x'}])assert.equal(invoiceFilterSchema.safeParse(v).success,false);
});
