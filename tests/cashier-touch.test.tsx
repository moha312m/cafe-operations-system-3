import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CategoryTabs} from '../src/components/pos/category-tabs';
import {normalizeTouchNumber,touchNumberError} from '../src/lib/touch-number';

test('category selection names All products and the selected category explicitly',()=>{
 const html=renderToStaticMarkup(<CategoryTabs categories={[{id:'one',name:'قهوة Coffee طويلة جدًا',isActive:true}]} active="one" counts={new Map([['one',0]])} onChange={()=>{}}/>);
 assert.match(html,/كل المنتجات/);
 assert.match(html,/aria-pressed="true"/);
 assert.match(html,/محدد/);
 assert.match(html,/قهوة Coffee طويلة جدًا/);
 assert.match(html,/>0</);
});
test('many categories expose visible paging and an All categories panel trigger',()=>{
 const categories=Array.from({length:22},(_,i)=>({id:String(i),name:'تصنيف '+i,isActive:true}));
 const html=renderToStaticMarkup(<CategoryTabs categories={categories} active="0" counts={new Map()} onChange={()=>{}}/>);
 assert.match(html,/كل التصنيفات/);
 assert.match(html,/التصنيفات التالية/);
 assert.match(html,/التصنيفات السابقة/);
 assert.doesNotMatch(html,/overflow-x-auto/);
});
test('empty category lists still expose All products',()=>{
 const html=renderToStaticMarkup(<CategoryTabs categories={[]} active="all" counts={new Map()} onChange={()=>{}}/>);
 assert.match(html,/كل المنتجات/);
 assert.match(html,/aria-pressed="true"/);
});

test('Arabic and Persian numeric entry preserves decimal money exactly',()=>{
 assert.equal(normalizeTouchNumber('١٢٣٫٤٥'),'123.45');
 assert.equal(normalizeTouchNumber('۱۲۳٫۴۵'),'123.45');
 assert.equal(touchNumberError('١٢٣٫٤٥',{min:0,max:200}),null);
});
test('numeric entry rejects grouping, exponents, invalid precision and non-finite values',()=>{
 for(const input of ['1,000','1e3','1.234','-1','Infinity','NaN','1.','999999999999999999999999'])assert.ok(touchNumberError(input));
});
test('quantity entry requires an integer in range and cannot delete through zero',()=>{
 assert.ok(touchNumberError('0',{min:1,integer:true}));
 assert.ok(touchNumberError('1.5',{min:1,integer:true}));
 assert.ok(touchNumberError('',{min:1,integer:true,required:true}));
 assert.equal(touchNumberError('12',{min:1,integer:true}),null);
});
test('discount and tender keypad preserves blank and zero but enforces explicit bounds',()=>{
 assert.equal(touchNumberError(''),null);
 assert.equal(touchNumberError('0',{min:0}),null);
 assert.ok(touchNumberError('101',{min:0,max:100}));
 assert.equal(touchNumberError('100',{min:0,max:100}),null);
});
test('signed settlement nets remain possible only with explicit permission from the field',()=>{
 assert.equal(touchNumberError('-12.34',{signed:true}),null);
 assert.equal(touchNumberError('-١٢٫٣٤',{signed:true}),null);
 assert.ok(touchNumberError('-12.34'));
 assert.ok(touchNumberError('-1',{signed:true,min:0}));
});
test('missing categories are never labeled as All products while filtering another id',()=>{
 const html=renderToStaticMarkup(<CategoryTabs categories={[{id:'one',name:'قهوة',isActive:true}]} active="deleted" counts={new Map()} onChange={()=>{}}/>);
 assert.match(html,/التصنيف غير متاح/);
});

test('All categories is disclosed as a dialog rather than an unexplained action',()=>{
 const html=renderToStaticMarkup(<CategoryTabs categories={[{id:'one',name:'قهوة',isActive:true}]} active="all" counts={new Map()} onChange={()=>{}}/>);
 assert.match(html, /aria-haspopup="dialog"/);
 assert.match(html, /aria-expanded="false"/);
});
