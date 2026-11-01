// AUTHORED, NOT RUN. Future dedicated-environment authority is mandatory.
// These gates are safeguards, not a substitute for the owner's separate runtime approval.
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFileSync,appendFileSync,mkdirSync } from "node:fs";
import { PrismaClient,type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { matchingAdvisoryWait,type WaitObservation } from "./treasury-coordination";
import type { SessionUser } from "@/lib/auth";
import { requestFingerprint } from "@/lib/idempotency";
const PIN_PATH="artifacts/acc-02/implementation-20261031/migration-pin.json";
if(process.env.ACC02A_RUNTIME_AUTHORIZED!=="yes"||!process.env.NODE_TEST_CONTEXT)throw Error("ACC-02A DB/API tests NOT AUTHORIZED; do not run before a separate runtime grant");
const pin=JSON.parse(readFileSync(PIN_PATH,"utf8")) as {file:string;sha256:string};
assert.equal(process.env.ACC02A_APPROVED_MIGRATION_SHA256,pin.sha256,"exact applied migration authorization required");
const target=new URL(process.env.DATABASE_URL??"");assert.equal(target.hostname,"127.0.0.1");assert.equal(target.port,"5434");assert.equal(target.pathname,"/cafe_ops_test_finf5");
export const ORIGIN=process.env.ACC02A_BASE_URL??"";assert.equal(ORIGIN,"http://127.0.0.1:3106","owned approved runtime server correspondence required");
export const db=new PrismaClient({datasourceUrl:target.toString()});
const run=process.env.ACC02A_RUN_ID??"";assert.match(run,/^ACC02A-[A-Za-z0-9_-]{8,80}$/);
const out="artifacts/acc-02/"+run;mkdirSync(out,{recursive:true});
export function evidence(kind:string,data:unknown){appendFileSync(out+"/evidence.jsonl",JSON.stringify({at:new Date().toISOString(),kind,data})+"\n");}
let verified:Promise<void>|undefined;
export function ready(){return verified??=verify()}
async function verify(){
 const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");assert.equal(hash(pin.file),pin.sha256);
 const historical=JSON.parse(readFileSync("artifacts/acc-02/implementation-20261031/historical-migrations.json","utf8")) as {file:string;sha256:string}[];
 const source=JSON.parse(readFileSync("artifacts/acc-02/implementation-20261031/source-manifest.json","utf8")) as {file:string;sha256:string}[];for(const f of source)assert.equal(hash(f.file),f.sha256);
 const facts=await db.$transaction(async tx=>{await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");const [identity]=await tx.$queryRaw<{database:string;port:string;directory:string;system_identifier:string}[]>`SELECT current_database() AS database,current_setting('port') AS port,current_setting('data_directory') AS directory,system_identifier::text FROM pg_control_system()`;const marker=await tx.$queryRaw<{id:number;note:string}[]>`SELECT id,note FROM "_disposable_test_database"`;const history=await tx.$queryRaw<{migration_name:string;checksum:string;finished:boolean;rolled_back:boolean}[]>`SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations"`;return {identity,marker,history};});
 assert.equal(facts.identity.database,"cafe_ops_test_finf5");assert.equal(facts.identity.port,"5434");assert.equal(facts.identity.directory.replaceAll("\\","/"),"C:/Dev/_nextcup_test_postgres/pgdata");assert.equal(facts.identity.system_identifier,"7693368256609479860");assert.deepEqual(facts.marker,[{id:1,note:"Disposable. Automated tests create and delete data here. Never point this at real cafe data."}]);
 assert.equal(facts.history.length,historical.length+1);for(const f of [...historical,pin]){const name=f.file.split("/").at(-2),h=facts.history.find(h=>h.migration_name===name);assert.ok(h?.finished&&!h.rolled_back);assert.equal(h.checksum,f.sha256);}
 evidence("verified-environment",{...facts,sourceFiles:source.length});
}
const passwords=new Map<string,string>(),cookies=new Map<string,string>();
export async function login(a:SessionUser){const r=await fetch(ORIGIN+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:a.email,password:passwords.get(a.id)})});assert.equal(r.status,200);cookies.set(a.id,r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; "));}
export async function http<T=Record<string,unknown>>(a:SessionUser,path:string,method="GET",body?:unknown,key?:string){const r=await fetch(ORIGIN+path,{method,signal:AbortSignal.timeout(30000),headers:{"Content-Type":"application/json",cookie:cookies.get(a.id)??"",...key?{"Idempotency-Key":key}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,body:await r.json() as T,replayed:r.headers.get("Idempotency-Replayed")};}
export type Fixture={marker:string;cafeId:string;branchId:string;otherBranchId:string;owner:SessionUser;otherOwner:SessionUser;staff:SessionUser;from:string;to:string};
export async function fixture(label:string,opening?:number):Promise<Fixture>{
 await ready();const marker=run+"-"+label+"-"+randomUUID().slice(0,8);const cafe=await db.cafe.create({data:{name:marker,slug:marker.toLowerCase(),currency:"EGP",settings:{create:{stockCountPolicy:"NO_SHIFT_COUNT"}},branches:{create:[{name:"Synthetic A",menuSlug:"a"},{name:"Synthetic B",menuSlug:"b"}]}},include:{branches:true}});
 const nonce=await fetch(ORIGIN+"/menu/"+cafe.slug+"/a");assert.equal(nonce.status,200);assert.ok((await nonce.text()).includes(marker),"owned app/source/test DB correspondence");
 const actor=async(suffix:string,role:"CAFE_OWNER"|"CASHIER")=>{const password=randomUUID()+"-synthetic-only";const row=await db.user.create({data:{cafeId:cafe.id,role,name:marker+suffix,email:marker.toLowerCase()+suffix+"@example.invalid",passwordHash:await bcrypt.hash(password,10)},select:{id:true,cafeId:true,branchId:true,role:true,name:true,email:true}});passwords.set(row.id,password);await login(row);return row;};
 const owner=await actor("owner","CAFE_OWNER"),otherOwner=await actor("owner2","CAFE_OWNER"),staff=await actor("cashier","CASHIER");
 const create=async(code:string,kind:"TREASURY"|"BANK")=>{const r=await http<{id:string}>(owner,"/api/treasury/accounts","POST",{code,name:marker+code,kind,instaPayEnabled:kind==="BANK"},randomUUID());assert.equal(r.status,201,JSON.stringify(r.body));return r.body.id;};const from=await create("SOURCE","BANK"),to=await create("DEST","BANK");
 if(opening!==undefined)await approvedSyntheticOpening(owner,from,opening,marker);
 const fx={marker,cafeId:cafe.id,branchId:cafe.branches[0].id,otherBranchId:cafe.branches[1].id,owner,otherOwner,staff,from,to};evidence("retained-fixture",fx);return fx;
}
export async function approvedSyntheticOpening(owner:SessionUser,accountId:string,amount:number,reference:string){await ready();const account=await db.moneyAccount.findUniqueOrThrow({where:{id:accountId}});assert.equal(account.cafeId,owner.cafeId);assert.ok(reference.startsWith(run));await db.$transaction(async tx=>{const [stamp]=await tx.$queryRaw<{at:Date}[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at`;await tx.moneyAccount.update({where:{id:accountId},data:{openingState:"APPROVED",openingAt:stamp.at,openingReference:reference,openingApprovedAt:stamp.at,openingApprovedById:owner.id,version:{increment:1}}});await tx.moneyMovement.create({data:{cafeId:owner.cafeId!,accountId,kind:"OPENING",signedAmount:amount,occurredAt:stamp.at,actorId:owner.id,sourceKey:"money-opening:"+accountId,openingReference:reference}});await tx.auditLog.create({data:{cafeId:owner.cafeId,userId:owner.id,action:"ACC02A_SYNTHETIC_TEST_OPENING",entity:"MoneyAccount",entityId:accountId,details:{reference,amount}}});});}
export const draftBody=(fx:Fixture,amount=20)=>({fromAccountId:fx.from,toAccountId:fx.to,amount,channel:"INSTAPAY",reference:fx.marker,note:"declared synthetic internal transfer"});
export const draft=(fx:Fixture,amount=20,key=randomUUID(),actor=fx.owner)=>http<{transferId:string;action:string;recordedAt:string}>(actor,"/api/treasury/transfers","POST",draftBody(fx,amount),key);
export const act=(fx:Fixture,id:string,action:"dispatch"|"receive"|"cancel",key=randomUUID(),actor=fx.owner,body?:unknown)=>http<{transferId:string;action:string;recordedAt:string;movementId?:string}>(actor,"/api/treasury/transfers/"+id+"/"+action,"POST",body??(action==="cancel"?{reason:"synthetic cancellation"}:{[action==="dispatch"?"moneyLeft":"moneyReceived"]:true,reference:fx.marker}),key);
export async function removeOwnCache(fx:Fixture,actor:SessionUser,key:string,body:unknown){await ready();const rows=await db.idempotencyKey.findMany({where:{key,requestHash:requestFingerprint(body)}});assert.equal(rows.length,1);assert.ok(rows[0].scope.startsWith(fx.cafeId+":")&&rows[0].scope.includes(":"+actor.id+":treasury:"));assert.equal((await db.idempotencyKey.deleteMany({where:{id:rows[0].id,scope:rows[0].scope,key,requestHash:rows[0].requestHash}})).count,1);evidence("owned-cache-removed",{scope:rows[0].scope,key});}
export async function waitForLock(fragment:string,timeout=4000){const until=Date.now()+timeout;while(Date.now()<until){const rows=await db.$queryRaw<{pid:number;wait_event:string}[]>`SELECT pid,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE ${'%'+fragment+'%'}`;if(rows.length){evidence("actual-database-wait",{fragment,rows});return}await new Promise(r=>setTimeout(r,20))}assert.fail("No observed lock wait: "+fragment);}
export async function locked<T>(prepare:(tx:Prisma.TransactionClient)=>Promise<void>,work:(release:()=>void)=>Promise<T>){let entered!:()=>void,release!:()=>void;const entry=new Promise<void>(r=>entered=r),exit=new Promise<void>(r=>release=r);const held=db.$transaction(async tx=>{await prepare(tx);entered();await exit},{timeout:20000});try{await Promise.race([entry,held]);return await work(release)}finally{release();await held}}

export async function waitForAdvisoryBlock(relation:string,blockerPid:number,timeout=4000){const until=Date.now()+timeout;while(Date.now()<until){const rows=await db.$queryRaw<WaitObservation[]>`SELECT pid,query,wait_event,pg_blocking_pids(pid) AS blocking_pids FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND wait_event='advisory'`;const observed=matchingAdvisoryWait(rows,relation,blockerPid);if(observed){evidence("observed-advisory-blocker",{pid:observed.pid,blockerPid,relation});return}await new Promise(r=>setTimeout(r,20))}assert.fail("No actual advisory waiter/blocker observed");}
