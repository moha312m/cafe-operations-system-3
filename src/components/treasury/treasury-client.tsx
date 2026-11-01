"use client";
import { useEffect,useRef,useState } from "react";
import { api,ApiRequestError } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { moneyIntentOwner,loadMoneyDocumentIntent,beginMoneyIntent,completeMoneyIntent,keepMoneyIntent,type MoneyIntent } from "@/lib/treasury-intent";
export const field="w-full rounded-lg border bg-background p-2 disabled:opacity-60";
export const button="rounded-lg border px-4 py-2 disabled:opacity-50";
export const date=(iso:string)=>new Date(iso).toLocaleString("ar-EG",{timeZone:"Africa/Cairo"});
export const errorText=(e:unknown)=>e instanceof Error?e.message:"تعذر إكمال العملية";
export function useTreasuryData<T>(path:string,version:number){
 const {user,canKey}=useApp(),owner=moneyIntentOwner(user),identity=owner+path,allowed=user.role==="CAFE_OWNER"&&canKey("treasury.view");
 const [state,setState]=useState<{identity:string;version:number;data?:T;error?:string}>({identity:"",version:-1});
 useEffect(()=>{if(!allowed)return;let live=true;api<T>(path).then(data=>{if(live)setState({identity,version,data})}).catch(e=>{if(live)setState({identity,version,error:errorText(e)})});return()=>{live=false}},[identity,path,version,allowed]);
 return {allowed,loading:state.identity!==identity||state.version!==version,data:state.identity===identity?state.data:undefined,error:state.identity===identity?state.error:undefined};
}
export function useMoneyCommand(documentPath:string,after:()=>void){
 const {user,canKey}=useApp(),owner=moneyIntentOwner(user),identity=owner+documentPath;
 const current=useRef(identity),live=useRef(true);current.current=identity;
 const [state,setState]=useState<{identity:string;ready:boolean;pending:MoneyIntent|null;busy:boolean;error:string;receipt?:{transferId?:string;action?:string;recordedAt?:string;id?:string};review?:Record<string,unknown>}>({identity:"",ready:false,pending:null,busy:false,error:""});
 useEffect(()=>{live.current=true;let mounted=true;Promise.resolve().then(()=>loadMoneyDocumentIntent(window.sessionStorage,owner,documentPath)).then(pending=>{if(mounted)setState({identity,ready:true,pending,busy:false,error:""})}).catch(e=>{if(mounted)setState({identity,ready:false,pending:null,busy:false,error:errorText(e)})});return()=>{mounted=false;live.current=false}},[identity,owner,documentPath]);
 const visible=state.identity===identity?state:{identity,ready:false,pending:null,busy:false,error:""};
 const permission=(path:string)=>path.includes("/accounts")?"treasury.manage_accounts":path.endsWith("/dispatch")?"treasury.transfer_dispatch":path.endsWith("/receive")?"treasury.transfer_receive":path.endsWith("/cancel")?"treasury.transfer_cancel":"treasury.transfer_create";
 async function run(path:string,body?:unknown){
  if(!visible.ready||visible.busy||user.role!=="CAFE_OWNER"||!canKey(permission(visible.pending?.path??path)))return;
  let intent=visible.pending;setState(s=>({...s,busy:true,error:"",receipt:undefined,review:undefined}));
  try{
   intent??=beginMoneyIntent(window.sessionStorage,owner,path,body);
   setState(s=>({...s,pending:intent}));
   const receipt=await api<{transferId?:string;action?:string;recordedAt?:string;id?:string}>(intent.path,{method:/^\/api\/treasury\/accounts\/[^/]+$/.test(intent.path)?"PATCH":"POST",body:intent.body,idempotencyKey:intent.key});
   if(!live.current||current.current!==identity)return;
   if(!completeMoneyIntent(window.sessionStorage,owner,intent))throw Error("هوية الطلب تغيرت؛ راجع نتيجته قبل حركة جديدة");
   setState({identity,ready:true,pending:null,busy:false,error:"",receipt});after();
  }catch(e){if(!live.current||current.current!==identity)return;let keep=keepMoneyIntent(e instanceof ApiRequestError?e.status:undefined,e instanceof ApiRequestError?e.payload:undefined,!!visible.pending);
   if(intent&&!keep){try{keep=!completeMoneyIntent(window.sessionStorage,owner,intent)}catch{keep=true}}
   setState({identity,ready:true,pending:keep?intent:null,busy:false,error:errorText(e)});if(!keep)after();
  }
 }
 async function reviewMetadata(){const intent=visible.pending;if(!intent?.path.includes("/accounts"))return;try{const result=intent.path==="/api/treasury/accounts"?await api<{accounts:Record<string,unknown>[]}>(intent.path+"?code="+encodeURIComponent(String(intent.body.code))):await api<{account:Record<string,unknown>}>(intent.path);if(!live.current||current.current!==identity)return;const account="accounts" in result?result.accounts[0]:result.account;if(!account)throw Error("لم يُعثر على الحساب؛ راجع القائمة قبل حسم الطلب");setState(s=>({...s,review:account,error:""}));}catch(e){if(live.current&&current.current===identity)setState(s=>({...s,error:errorText(e)}));}}
 function acknowledgeMetadata(){if(!visible.review||!visible.pending)return;try{if(!completeMoneyIntent(window.sessionStorage,owner,visible.pending))throw Error("هوية الطلب تغيرت");setState({identity,ready:true,pending:null,busy:false,error:""});after();}catch(e){setState(s=>({...s,error:errorText(e)}));}}
 return {...visible,blocked:!visible.ready||visible.busy||!!visible.pending,run,reviewMetadata,acknowledgeMetadata,can:(path:string)=>user.role==="CAFE_OWNER"&&canKey(permission(path))};
}
export function PendingMoney({command}:{command:ReturnType<typeof useMoneyCommand>}){return <>{command.error&&<p role="alert">{command.error}</p>}{command.pending&&<section aria-label="طلب سابق معلق" className="space-y-2 rounded-lg border p-3"><p>يوجد طلب محفوظ لم تُحسم نتيجته. استعد النتيجة بنفس البيانات والمفتاح؛ لا تنفذ حركة أموال جديدة أثناء الاستعادة.</p><button className={button} disabled={command.busy||!command.can(command.pending.path)} onClick={()=>command.run(command.pending!.path)}>استعادة نتيجة العملية</button>{command.pending.path.includes("/accounts")&&<><button className={button} disabled={command.busy} onClick={command.reviewMetadata}>مراجعة بيانات الحساب الحالية</button>{command.review&&<div><p>الحساب الحالي: {String(command.review.name)} — {String(command.review.code)}؛ الإصدار {String(command.review.version)}. قد يكون التعديل السابق غير محفوظ. راجع البيانات قبل حسم الطلب.</p><button className={button} onClick={command.acknowledgeMetadata}>راجعت الحساب وأحسم الطلب السابق</button></div>}</>}</section>}{command.receipt&&<p role="status">تم حفظ أو استعادة نتيجة العملية{command.receipt.recordedAt?" — "+date(command.receipt.recordedAt):""}.</p>}</>}
export function TreasuryAccess({children}:{children:React.ReactNode}){const {user,canKey}=useApp();return user.role==="CAFE_OWNER"&&canKey("treasury.view")?<>{children}</>:<p role="alert">الحسابات والتحويلات متاحة للمالك المخوّل فقط.</p>}
