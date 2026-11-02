import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/client';
const original=globalThis.fetch;
test('opt-in read deadline bounds an unresponsive GET including response parsing, and retry recovers',async()=>{
 try{
  let signal:AbortSignal|undefined;
  globalThis.fetch=async(_url,options)=>{signal=options?.signal as AbortSignal;return new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}})};
  const start=Date.now();
  await assert.rejects(api('/api/scoped-read',{readTimeoutMs:30}),/انتهت مهلة/);
  assert.ok(Date.now()-start<1000); assert.equal(signal?.aborted,true);
  globalThis.fetch=async()=>Response.json({rows:[1]});
  assert.deepEqual(await api('/api/scoped-read',{readTimeoutMs:100}),{rows:[1]});
 }finally{globalThis.fetch=original}
});
test('superseded reads abort and never return late data even if the transport ignores the signal',async()=>{
 try{
  const controller=new AbortController(); let resolve!:(value:Response)=>void;
  globalThis.fetch=()=>new Promise<Response>(r=>{resolve=r});
  const pending=api('/api/scoped-read',{signal:controller.signal,readTimeoutMs:1000});
  controller.abort(); await assert.rejects(pending,e=>e instanceof Error&&e.name==='AbortError');
  resolve(Response.json({old:true}));
 }finally{globalThis.fetch=original}
});
test('read cancellation cannot abort a money write or replace its original idempotency identity',async()=>{
 try{
  const controller=new AbortController();controller.abort(); let request:RequestInit|undefined;
  globalThis.fetch=async(_url,options)=>{request=options;return Response.json({receipt:'retained'})};
  const body={amount:12.5};
  assert.deepEqual(await api('/api/payments',{method:'POST',body,idempotencyKey:'original-key',signal:controller.signal,readTimeoutMs:1}),{receipt:'retained'});
  assert.equal(request?.signal,undefined);assert.equal((request?.headers as Record<string,string>)['Idempotency-Key'],'original-key');assert.equal(request?.body,JSON.stringify(body));
 }finally{globalThis.fetch=original}
});
