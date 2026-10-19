"use client";
import { useEffect,useLayoutEffect,useRef,useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card,CardHeader,CardTitle,CardContent } from '@/components/ui/card';
type Settings={overnightCashEnabled:boolean;drawerLabel:string;placeAcceptanceRequired:boolean};
export function BranchOpeningSettingsCard({branchId}:{branchId:string}) {
  const [settings,setSettings]=useState<Settings|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const currentBranch=useRef(branchId);
  useLayoutEffect(()=>{currentBranch.current=branchId;},[branchId]);
  useEffect(()=>{let alive=true;setSettings(null);setError('');if(branchId)api<{settings:Settings}>(`/api/branches/${branchId}/opening-settings`).then(r=>{if(alive)setSettings(r.settings);}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'تعذر تحميل الإعدادات');});return()=>{alive=false;};},[branchId]);
  async function save(){if(!settings)return;setBusy(true);setError('');const context=branchId;try{const result=await api<{settings:Settings}>(`/api/branches/${context}/opening-settings`,{method:'PATCH',body:{overnightCashEnabled:settings.overnightCashEnabled,drawerLabel:settings.drawerLabel}});if(currentBranch.current===context){setSettings(result.settings);toast.success('اتحفظ إعداد استلام كاش الليل للفرع');}}catch(e){if(currentBranch.current===context)setError(e instanceof Error?e.message:'تعذر حفظ الإعداد');}finally{setBusy(false);}}
  return <Card><CardHeader><CardTitle>كاش الليل واستلام الصباح — الفرع المختار</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">عند قفل آخر شيفت وتسليم عهدة الفرع، سجّل المبلغ المتروك في الدرج والمحوّل للخزنة. الشيفت القادم يعدّ الكاش ويؤكد استلامه قبل التشغيل.</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {settings?<><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.overnightCashEnabled} disabled={busy} onChange={e=>setSettings({...settings,overnightCashEnabled:e.target.checked})}/>إلزام عدّ واستلام كاش الليل</label><Label>اسم الدرج</Label><Input aria-label="اسم الدرج" value={settings.drawerLabel} maxLength={100} disabled={busy} onChange={e=>setSettings({...settings,drawerLabel:e.target.value})}/><Button disabled={busy||!settings.drawerLabel.trim()} onClick={save}>حفظ إعداد الفرع</Button></>:<p className="text-sm">{branchId?'جار تحميل الإعدادات':'اختر الفرع'}</p>}
  </CardContent></Card>;
}
