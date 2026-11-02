"use client";
import {useEffect,useState} from "react";
import {api} from "@/lib/client";
/** Query/identity keyed reads; refresh keeps only the same authorized scope. */
export function useWorkspaceRead<T>(path:string|null,identity:string){
 const [version,setVersion]=useState(0);
 const [state,setState]=useState<{path:string|null;identity:string;version:number;data?:T;error?:string}>({path:null,identity:"",version:-1});
 useEffect(()=>{
  if(!path)return;
  const controller=new AbortController();
  api<T>(path,{signal:controller.signal,readTimeoutMs:20_000}).then(data=>{
   if(!controller.signal.aborted)setState({path,identity,version,data});
  }).catch(error=>{
   if(!controller.signal.aborted)setState(previous=>({path,identity,version,data:previous.path===path&&previous.identity===identity?previous.data:undefined,error:error instanceof Error?error.message:"تعذر تحميل البيانات"}));
  });
  return ()=>controller.abort();
 },[path,identity,version]);
 const current=path!==null&&state.path===path&&state.identity===identity;
 return {data:current?state.data:undefined,error:current?state.error:undefined,loading:path!==null&&(!current||state.version!==version),refresh:()=>setVersion(value=>value+1)};
}
