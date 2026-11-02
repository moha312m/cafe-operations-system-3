import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductGrid } from '../src/components/pos/product-grid';
import { ProductCard } from '../src/components/pos/product-card';

const base = { products: [], currency: 'EGP', onSelect: () => {} };
test('catalog announces loading rather than reporting no configured products', () => {
 const html = renderToStaticMarkup(<ProductGrid {...base} state="loading" />);
 assert.match(html, /role="status"/);
 assert.match(html, /جارٍ تحميل المنتجات/);
 assert.doesNotMatch(html, /لا توجد منتجات مهيأة/);
});
test('failed catalog offers an explicit retry and keeps the actual error', () => {
 const html = renderToStaticMarkup(<ProductGrid {...base} state="error" error="انتهت مهلة القراءة" onRetry={() => {}} />);
 assert.match(html, /role="alert"/);
 assert.match(html, /انتهت مهلة القراءة/);
 assert.match(html, /إعادة المحاولة/);
});
test('filtered empty catalog offers clear filters, distinct from setup and branch states', () => {
 const filtered = renderToStaticMarkup(<ProductGrid {...base} state="filtered" onClear={() => {}} />);
 assert.match(filtered, /لا توجد نتائج مطابقة/);
 assert.match(filtered, /مسح البحث والتصنيف/);
 const empty = renderToStaticMarkup(<ProductGrid {...base} state="empty" canManageMenu />);
 assert.match(empty, /لا توجد منتجات مهيأة للكاشير/);
 assert.match(empty, /href="\/menu"/);
 const branch = renderToStaticMarkup(<ProductGrid {...base} state="no-branch" />);
 assert.match(branch, /لا يوجد فرع نشط محدد/);
 assert.doesNotMatch(branch, /href="\/menu"/);
 const denied = renderToStaticMarkup(<ProductGrid {...base} state="denied" />);
 assert.match(denied, /صلاحية/);
 assert.doesNotMatch(denied, /href="\/menu"/);
});
test('product tile preserves long names, SKU, actual price and unavailable reason', () => {
 const html = renderToStaticMarkup(<ProductCard currency="EGP" onSelect={() => {}} product={{id:'p',name:'قهوة عربية طويلة Coffee',sku:'NC-AR-123',description:null,basePrice:'12.50',isActive:true,isAvailable:false,category:{id:'c',name:'قهوة'},variants:[],addOns:[]}} />);
 assert.match(html, /قهوة عربية طويلة Coffee/);
 assert.match(html, /NC-AR-123/);
 assert.match(html, /12.50/);
 assert.match(html, /disabled/);
 assert.match(html, /غير متاح للبيع حاليًا/);
});
