import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SalesRegister} from '../src/components/sales/sales-workspace';

const invoices=[{id:'invoice-25-LTR',orderNumber:25,createdAt:'2026-11-02T12:00:00Z',branch:{id:'branch',name:'الفرع الرئيسي الطويل'},createdBy:{id:'cashier',name:'كاشير الاختبار'},paymentStatus:'PARTIAL',total:'125.50',paidAmount:'100.25',remainingAmount:'25.25',revision:2}];
test('sales register exposes separate invoice, collected and remaining values with a detail action',()=>{
 const html=renderToStaticMarkup(<SalesRegister orders={invoices} busy={false} onOpen={()=>{}}/>);
 for(const label of ['الفاتورة / الوقت','الفرع / الكاشير','حالة الدفع','الإجمالي','المحصّل','المتبقي','عرض الفاتورة #25','مدفوع جزئيًا','كاشير الاختبار','الفرع الرئيسي الطويل'])assert.ok(html.includes(label),label);
 assert.match(html,/125\.50/);assert.match(html,/100\.25/);assert.match(html,/25\.25/);
 assert.match(html,/مراجعة 2/);assert.doesNotMatch(html,/<details/);
});
test('busy invoice register blocks detail actions without relabeling financial values',()=>{
 const html=renderToStaticMarkup(<SalesRegister orders={invoices} busy onOpen={()=>{}}/>);
 assert.match(html,/<button[^>]+disabled/);assert.match(html,/25\.25/);
});
