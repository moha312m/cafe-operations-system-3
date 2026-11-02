"use client";
import {useApp} from "@/components/app-shell";
import {useWorkspaceRead} from "@/components/cafe/use-workspace-read";
/** Accounting reads share the current query/identity deadline and cancellation. */
export function useAccountingData<T>(url:string|null){
 const {user}=useApp();
 const {data,error,loading,refresh}=useWorkspaceRead<T>(url,`${user.id}:${user.cafeId}:${user.branchId}`);
 return {data:data??null,error:error??"",loading,reload:refresh};
}
