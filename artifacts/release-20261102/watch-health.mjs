import {appendFileSync,writeFileSync} from 'node:fs';
const origin='https://cheerful-grace-production-9236.up.railway.app';
const expected='f4ff365c472f';
const started=Date.now();let previous='';
for(let attempt=1;Date.now()-started<20*60*1000;attempt++){
 let event={at:new Date().toISOString(),attempt};
 try{
  const response=await fetch(origin+'/api/health',{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  event.status=response.status;
  if((response.headers.get('content-type')??'').includes('application/json')){
   const value=await response.json();event.ok=value.ok;event.database=value.database;event.commit=value.commit;
  }
 }catch{event.networkError=true;}
 appendFileSync('artifacts/release-20261102/health-observations.jsonl',JSON.stringify(event)+'\n');
 const key=JSON.stringify([event.status,event.ok,event.database,event.commit,event.networkError]);
 if(key!==previous){console.log(JSON.stringify(event));previous=key;}
 if(event.status===200&&event.ok===true&&event.database==='up'&&event.commit===expected){writeFileSync('artifacts/release-20261102/healthy-release.json',JSON.stringify(event,null,2),{flag:'wx'});process.exit(0);}
 await new Promise(resolve=>setTimeout(resolve,5000));
}
console.error('Expected healthy deployment was not observed in 20 minutes.');process.exit(1);
