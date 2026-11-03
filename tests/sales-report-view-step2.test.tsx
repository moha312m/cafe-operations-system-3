import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {SalesReportRows} from '../src/components/reports/sales-report-rows';
test('reports use readable mobile cards, a contained desktop table and honest unavailable values',()=>{
 const html=renderToStaticMarkup(<SalesReportRows columns={[{key:'sku',label:'SKU'},{key:'net',label:'الصافي'},{key:'share',label:'المساهمة'}]} rows={[{id:'1',cells:{sku:'0012',net:'4000.00',share:null}}]} onDetail={()=>{}}/>);
 for(const text of ['0012','4000.00','غير متاح','overflow-x-auto','md:hidden','hidden md:block','تفاصيل'])assert.ok(html.includes(text),text);
});
