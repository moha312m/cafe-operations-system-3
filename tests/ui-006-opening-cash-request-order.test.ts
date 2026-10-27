import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual component; only its hook host, context and external HTTP
// boundary are controlled. No copy of the product's response guard is tested.
const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/handovers/opening-cash-panel.tsx',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},
}).outputText;
type Node={type:unknown;props:Record<string,unknown>};
type Slot={value?:unknown;deps?:unknown[];cleanup?:()=>void};
function host() {
  const slots:Slot[]=[], effects:Array<()=>void>=[], layout:Array<()=>void>=[];
  const requests:Array<{url:string;resolve:(data:unknown)=>void;reject:(error:Error)=>void}>=[];
  let cursor=0, tree:unknown, branch='A', visible=true;
  const state=(initial:unknown)=>{const i=cursor++;slots[i]??={value:initial};return [slots[i].value,(v:unknown)=>{slots[i].value=v;}];};
  const effect=(queue:Array<()=>void>)=>(fn:()=>void|(()=>void),deps:unknown[])=>{
    const i=cursor++, old=slots[i];
    if(!old||deps.some((dep,j)=>!Object.is(dep,old.deps?.[j]))) {
      slots[i]={deps,cleanup:old?.cleanup};queue.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn()||undefined;});
    }
  };
  const hooks={useState:state,useRef:(initial:unknown)=>{const i=cursor++;slots[i]??={value:{current:initial}};return slots[i].value;},
    useCallback:(fn:unknown,deps:unknown[])=>{const i=cursor++;if(!slots[i]||deps.some((d,j)=>!Object.is(d,slots[i].deps?.[j])))slots[i]={value:fn,deps};return slots[i].value;},
    useLayoutEffect:effect(layout),useEffect:effect(effects)};
  const exports:Record<string,(props:unknown)=>unknown>={};
  const mockedRequire=(id:string)=>{
    if(id==='react')return hooks;
    if(id==='@/lib/client')return {api:(url:string)=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),money:(amount:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount)};
    if(id==='@/components/app-shell')return {useApp:()=>({user:{id:'claimant',role:'CAFE_OWNER'},cafe:{currency:'USD'},canKey:()=>visible})};
    if(id==='sonner')return {toast:{success(){}}};
    if(id==='react/jsx-runtime')return require(id);
    if(id==='next/link')return {default:'a'};
    return new Proxy({},{get:(_,key)=>String(key)});
  };
  vm.runInNewContext(code,{exports,require:mockedRequire,crypto:globalThis.crypto,Intl,Date});
  const render=(next=branch)=>{branch=next;cursor=0;tree=exports.OpeningCashPanel({branchId:branch});while(layout.length)layout.shift()!();while(effects.length)effects.shift()!();return tree;};
  const settle=async(index:number,data:unknown,error?:Error)=>{if(error)requests[index].reject(error);else requests[index].resolve(data);await new Promise(resolve=>setImmediate(resolve));render();};
  const nodes=(value:unknown):Node[]=>{if(Array.isArray(value))return value.flatMap(nodes);if(value&&typeof value==='object'&&'props' in value){const node=value as Node;return [node,...nodes(node.props.children)];}return [];};
  const text=(value:unknown):string=>{if(Array.isArray(value))return value.map(text).join(' ');if(value&&typeof value==='object'&&'props' in value)return text((value as Node).props.children);return value==null||typeof value==='boolean'?'':String(value);};
  return {render,settle,requests,nodes:()=>nodes(tree),text:(value=tree)=>text(value),setVisible:(v:boolean)=>{visible=v;render();},unmount:()=>slots.forEach(s=>s.cleanup?.())};
}
function storages(branch:string,old=false,extra=false) {
  const row=(id:string,label:string,amount:number)=>({id,drawerLabel:label,leftInDrawer:String(amount),toTreasury:'0',expectedAmount:amount,declaredBy:{name:'Owner'},declaredAt:'2026-10-07T12:00:00Z',outgoingShift:{shiftNumber:1,cashier:{name:'Owner'}},handover:{status:'COMPLETED'},receipt:{id:'receipt-'+id,claimantId:'claimant',status:'PENDING',claimant:{name:'Owner'}}});
  const label=branch==='A'?'A-main':'B-annex';
  return {storages:[row(branch,`UI006 ${old?'OLD ':''}drawer ${label}`,branch==='A'?(old?2222.22:7777.25):(old?333.33:111.50)),...(extra?[row(branch+'-second','Selected second drawer',42.75)]:[])]};
}
for(const [start,middle,label,amount] of [['A','B','UI006 drawer A-main','$7,777.25'],['B','A','UI006 drawer B-annex','$111.50']]) {
  test(`first-held ${start}-${middle}-${start} cannot overwrite latest cash amount or drawer label`,async()=>{
    const h=host();h.render(start);h.render(middle);await h.settle(1,storages(middle));h.render(start);await h.settle(2,storages(start));
    assert.ok(h.text().includes(label));assert.ok(h.text().includes(amount));
    await h.settle(0,storages(start,true));
    assert.ok(h.text().includes(label),h.text());assert.ok(h.text().includes(amount),h.text());assert.ok(!h.text().includes('OLD drawer'));
  });
  test(`middle-held ${start}-${middle}-${start} ignores the other branch response`,async()=>{
    const h=host();h.render(start);await h.settle(0,storages(start));h.render(middle);h.render(start);await h.settle(2,storages(start));await h.settle(1,storages(middle));
    assert.ok(h.text().includes(label));assert.ok(h.text().includes(amount));
  });
}
test('newer refresh wins and a legitimate selected drawer survives reload',async()=>{
  const h=host();h.render();await h.settle(0,storages('A',false,true));
  const select=h.nodes().find(n=>n.type==='select')!;
  (select.props.onChange as (e:unknown)=>void)({target:{value:'A-second'}});h.render();
  const refresh=h.nodes().find(n=>typeof n.props.onClick==='function'&&h.text(n).includes('تحديث'))!;
  const first=(refresh.props.onClick as ()=>Promise<void>)();const second=(refresh.props.onClick as ()=>Promise<void>)();
  await h.settle(2,storages('A',false,true));await second;await h.settle(1,storages('A',true,true));await first;
  assert.ok(h.text().includes('Selected second drawer'));assert.ok(h.text().includes('$42.75'));
  assert.equal(h.nodes().find(n=>n.type==='select')!.props.value,'A-second');
  assert.ok(!h.text().includes('OLD drawer'));
});
test('a stale same-branch error cannot replace a newer successful load',async()=>{
  const h=host();h.render('A');h.render('B');h.render('A');await h.settle(2,storages('A'));await h.settle(0,null,new Error('OLD request error'));
  assert.ok(!h.nodes().some(n=>n.props.role==='alert'));assert.ok(h.text().includes('$7,777.25'));
});
test('losing view permission invalidates an outstanding response',async()=>{
  const h=host();h.render();h.setVisible(false);h.setVisible(true);await h.settle(1,storages('A'));await h.settle(0,storages('A',true));
  assert.ok(h.text().includes('$7,777.25'));assert.ok(!h.text().includes('OLD drawer'));
});
