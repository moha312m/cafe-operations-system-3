import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';
const root=process.cwd(),file=path.resolve('artifacts/workspace-redesign-20261102/private-step2-closeout-config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=file;process.env.DATABASE_URL=config.databaseUrl;
const {verifyWorkspace}=await import('../../workspace-redesign-20261102/workspace-guard.mjs');
const {proof}=await verifyWorkspace();
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(3113,'127.0.0.1',resolve)});await new Promise(resolve=>probe.close(resolve));
const directory=path.resolve('artifacts/erp-experience-20261102/step2-closeout'),id='preview-closeout-'+Date.now();
const stdout=path.join(directory,id+'.stdout.log'),stderr=path.join(directory,id+'.stderr.log'),out=fs.openSync(stdout,'wx'),err=fs.openSync(stderr,'wx');
const args=[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3113'];
const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,DATABASE_URL:config.databaseUrl,AUTH_SECRET:config.authSecret,NEXTCUP_INTEGRATION_VERIFY:'1',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'}});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();fs.closeSync(out);fs.closeSync(err);
const record={at:new Date().toISOString(),pid:child.pid,executable:process.execPath,args,cwd:root,stdout,stderr,sourceSha256:config.source.sha256,buildId:fs.readFileSync('.next-integration/BUILD_ID','utf8').trim(),database:proof,baseUrl:config.baseUrl};
fs.writeFileSync(path.join(directory,'preview-closeout.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({pid:child.pid,baseUrl:config.baseUrl,buildId:record.buildId}));


for(let i=0;i<30;i++){try{const response=await fetch(config.baseUrl+'/login',{signal:AbortSignal.timeout(1000)});if(response.status===200)break;}catch{}await new Promise(r=>setTimeout(r,200));}
const {proof:correspondence}=await verifyWorkspace({requireCorrespondence:true});fs.writeFileSync(path.join(directory,'closeout-correspondence.json'),JSON.stringify({...record,database:correspondence},null,2));console.log(JSON.stringify({state:'VERIFIED',pid:child.pid,url:config.baseUrl,sourceSha256:config.source.sha256,buildId:record.buildId}));
