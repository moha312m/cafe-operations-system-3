import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TreasuryAccountRows,TreasuryTransferRows,type Account,type Transfer} from '../src/components/treasury/treasury-workspace';

const account = {id:'account-1',code:'BANK-طويل-42',name:'حساب البنك للاختبار',kind:'BANK',branchId:'branch-1',currency:'EGP',instaPayEnabled:false,isActive:true,version:0,openingState:'UNSET',openingAt:null,recordedBalance:null,sourceCoverage:'LIMITED',coverageNotice:'تغطية محدودة',realUseReady:false} as Account;
test('Treasury accounts expose branch, stable code and an explicit unknown balance without inventing zero',()=>{
 const html=renderToStaticMarkup(<TreasuryAccountRows accounts={[account]} branches={[{id:'branch-1',name:'فرع التجربة'}]}/>);
 assert.match(html,/فرع التجربة/); assert.match(html,/BANK-طويل-42/);assert.match(html,/غير معلوم/);assert.match(html,/الافتتاح غير معتمد/);assert.doesNotMatch(html,/0\.00/);assert.match(html,/\/treasury\/accounts\/account-1/);
});
test('Treasury approved recorded balance remains distinct from available funds and shared branch is explicit',()=>{
 const html=renderToStaticMarkup(<TreasuryAccountRows accounts={[{...account,branchId:null,openingState:'APPROVED',recordedBalance:'0.00'}]} branches={[]}/>);
 assert.match(html,/مشترك للكافيه/);assert.match(html,/0\.00/);assert.match(html,/رصيد الحركات المسجلة/);assert.match(html,/لا يمثل الرصيد المتاح/);
});
test('Treasury transfer register keeps the source destination state channel date and detail path',()=>{
 const transfer={id:'transfer-1',fromNameSnapshot:'خزنة المصدر',toNameSnapshot:'بنك الوجهة',amount:'125.50',currency:'EGP',channel:'INSTAPAY',status:'DRAFT',createdAt:'2026-11-02T10:00:00.000Z',reference:'REF-42'} as Transfer;
 const html=renderToStaticMarkup(<TreasuryTransferRows transfers={[transfer]}/>);
 for(const label of ['خزنة المصدر','بنك الوجهة','125.50','إنستاباي','مسودة','REF-42']) assert.ok(html.includes(label));
 assert.match(html,/2026/);assert.match(html,/\/treasury\/transfers\/transfer-1/);assert.match(html,/المسودة لا تحرك أموالًا/);
});
