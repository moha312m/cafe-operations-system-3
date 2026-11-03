import test from 'node:test';
import assert from 'node:assert/strict';
import {reportOutputModel,reportOutputFiles} from '../src/lib/report-output';
test('Step 2 output retains exact decimal text, Arabic and leading-zero SKUs without formulas',()=>{
 const report={title:'تقرير',reporting:{scope:'page'},metrics:{},generatedAt:'2026-11-03',preserveStrings:true,rows:[{SKU:'0012',amount:'1234567890123.45',name:'=1+1',arabic:'قهوة'}]};
 const model=reportOutputModel(report);assert.equal(model.tables[0].rows[0][1],'1234567890123.45');
 const files=reportOutputFiles(report);assert.ok(files.csv.includes('0012'));assert.ok(files.csv.includes("'=1+1"));assert.ok(files.html.includes('قهوة'));assert.ok(files.html.includes('@page'));
});

test('legacy exports still convert ordinary decimals and safely handle non-string metrics',()=>{
 const model=reportOutputModel({title:'قديم',reporting:{},metrics:{count:2},generatedAt:'2026-11-03',rows:[{net:'12.50',sku:'0012'}]});
 assert.equal(model.tables[0].rows[0][0],12.5);assert.equal(model.tables[0].rows[0][1],'0012');assert.ok(model.summary.some(s=>s.value===2));
});

test('printed scope retains declared filters while internal authorization fingerprints stay out of exports',()=>{
 const report={title:'التقرير',reporting:{from:'2026-11-01',scopeFingerprint:'private-authority-fingerprint'},metrics:{},context:{'أساس الإسناد':'collector','نطاق التصدير':'كل النتائج المفلترة'},generatedAt:'2026-11-03',rows:[]};
 const files=reportOutputFiles(report);assert.ok(!files.html.includes('private-authority-fingerprint'));assert.ok(files.html.includes('collector'));assert.ok(files.csv.includes('كل النتائج المفلترة'));
});

test('wide analytical records print as readable field/value details instead of an overflowing A4 table',()=>{
 const row=Object.fromEntries(Array.from({length:15},(_,i)=>['حقل '+i,'قيمة '+i]));
 const files=reportOutputFiles({title:'وردية',reporting:{},metrics:{},generatedAt:'2026-11-03',preserveStrings:true,rows:[row]});
 assert.ok(files.html.includes('<dl>'));assert.ok(files.html.includes('حقل 14'));assert.ok(files.html.includes('قيمة 14'));
});
