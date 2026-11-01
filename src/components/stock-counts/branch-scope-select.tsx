"use client";
import { useEffect, useId, useState } from "react";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Label } from "@/components/ui/label";
export function BranchScopeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
 const { user } = useApp(); const id = useId(); const [branches, setBranches] = useState<{id:string;name:string;isActive:boolean}[]>([]); const [error, setError] = useState("");
 useEffect(() => { if (user.branchId) return; let alive = true; api<{branches:{id:string;name:string;isActive:boolean}[]}>("/api/branches").then(r=>{if(alive)setBranches(r.branches.filter(b=>b.isActive));}).catch(e=>{if(alive)setError(e instanceof Error?e.message:"تعذر تحميل الفروع");});return()=>{alive=false;};},[user.branchId]);
 useEffect(()=>{if(!value && branches[0])onChange(branches[0].id);},[value,branches,onChange]);
 if(user.branchId)return null;
 return <div className="space-y-1"><Label htmlFor={id}>الفرع</Label><select id={id} aria-label="الفرع" value={value} onChange={e=>onChange(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-sm"><option value="" disabled>اختر الفرع</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select>{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}</div>;
}
