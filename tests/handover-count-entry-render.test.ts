import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountLineRow } from "../src/components/stock-counts/count-line-row";
const line = { id:"a", inventoryItemId:"item", unit:"KG", disposition:"COUNTED" as const, countedQuantity:"2", effectiveCountedQuantity:"2", countedAt:"v1", expectedQuantity:"900", varianceQuantity:"-898", inventoryItem:{id:"item",name:"بن",category:null,unit:"KG"} };
const props = {line, sessionStatus:"IN_PROGRESS" as const, blind:true,handover:true,can:()=>true,busy:false,onCapture:async()=>{},onAct:()=>{},onDraft:()=>{},onSave:()=>{}};
test("handover capture renders only item unit actual quantity and saving state without hidden columns",()=>{
 const html=renderToStaticMarkup(createElement(CountLineRow,{...props,entry:{value:"2",status:"saved" as const}}));
 assert.equal((html.match(/<td\b/g)??[]).length,4);
 assert.doesNotMatch(html,/مخفي|900|تسجيل<|تصحيح/);
 assert.match(html,/value="2"/); assert.match(html,/محفوظ/); assert.match(html,/كيلو/);
});
test("failed capture displays the retained draft and a retry action",()=>{
 const html=renderToStaticMarkup(createElement(CountLineRow,{...props,entry:{value:"3.125",status:"failed" as const,error:"connection lost"}}));
 assert.match(html,/value="3.125"/); assert.match(html,/connection lost/); assert.match(html,/إعادة الحفظ/);
});
