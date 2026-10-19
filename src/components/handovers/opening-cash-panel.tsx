"use client";
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api,money } from '@/lib/client';
import { useApp } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ReasonCodeSelect } from '@/components/stock-counts/reason-code-select';
type Storage={id:string;drawerLabel:string;leftInDrawer:string;toTreasury:string;expectedAmount:number;declaredBy:{name:string};declaredAt:string;outgoingShift:{shiftNumber:number;cashier:{name:string}};handover:{status:string};receipt:{id:string;claimantId:string;status:string;claimant:{name:string}}|null};
export function OpeningCashPanel({branchId,onAccepted}:{branchId:string;onAccepted?:()=>void}) {
  const {user,canKey,cafe}=useApp();const currency=cafe?.currency??'EGP';
  const [storages,setStorages]=useState<Storage[]>([]),[selected,setSelected]=useState(''),[count,setCount]=useState(''),[note,setNote]=useState(''),[reason,setReason]=useState(''),[override,setOverride]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const keys=useRef(new Map<string,string>()),currentBranch=useRef(branchId);
  const loadSequence=useRef(0);
  useLayoutEffect(()=>{currentBranch.current=branchId;},[branchId]);
  const mayView=canKey('handover.view');
  useLayoutEffect(()=>{loadSequence.current++;return()=>{loadSequence.current++;};},[branchId,mayView]);
  const load=useCallback(async()=>{if(!branchId||!mayView)return;const context=branchId,sequence=++loadSequence.current;setError('');try{const result=await api<{storages:Storage[]}>(`/api/cash-storage/pending?branchId=${branchId}`);if(currentBranch.current===context&&loadSequence.current===sequence)setStorages(result.storages);}catch(e){if(currentBranch.current===context&&loadSequence.current===sequence)setError(e instanceof Error?e.message:'تعذر تحميل استلام الكاش');}},[branchId,mayView]);
  useEffect(()=>{setStorages([]);setSelected('');setCount('');setNote('');setReason('');setOverride(false);void load();},[load]);
  if(!mayView)return null;
  const storage=storages.find(s=>s.id===selected)??storages.find(s=>s.receipt?.claimantId===user.id)??storages[0];
  const isClaimant=storage?.receipt?.claimantId===user.id;
  const canOverride=user.role==='CAFE_OWNER'&&canKey('handover.exception');
  const hasDifference=!!storage&&count!==''&&Math.abs(Number(count)-storage.expectedAmount)>0.005;
  async function act(action:'ACCEPT'|'DISPUTE'|'DEFER') {
    if(!storage)return;setBusy(true);setError('');const context=branchId;
    try {
      let body:Record<string,unknown>={action,note:note.trim()};
      if(action==='ACCEPT'){
        if(count===''||!Number.isFinite(Number(count))||Number(count)<0)throw new Error('اكتب المبلغ اللي عديته بنفسك، حتى لو صفر');
        body={...body,countedCash:Number(count),reasonCodeId:reason||undefined,override:override||undefined};
        const fingerprint=JSON.stringify({storageId:storage.id,...body});let key=keys.current.get(fingerprint);if(!key){key=crypto.randomUUID();keys.current.set(fingerprint,key);}body.idempotencyKey=key;
      }else if(!note.trim())throw new Error('اكتب سبب التأجيل أو الاعتراض');
      await api(`/api/cash-storage/${storage.id}/receipt`,{method:'POST',body});
      if(currentBranch.current!==context)return;
      toast.success(action==='ACCEPT'?'اتسجل عدّ واستلام الكاش':'اتسجل الإجراء، والشيفت ما زال ينتظر استلام الكاش');
      await load();if(action==='ACCEPT'){setCount('');setNote('');setReason('');setOverride(false);onAccepted?.();}
    }catch(e){if(currentBranch.current===context)setError(e instanceof Error?e.message:'تعذر تسجيل الاستلام');}finally{setBusy(false);}
  }
  return <section className="space-y-3 rounded-xl border p-4" data-testid="opening-cash-panel">
    <h2 className="font-semibold">استلام كاش الدرج من شيفت الليل</h2>
    <p className="text-xs text-muted-foreground">عدّ النقدية بنفسك ثم أكد المبلغ الفعلي. استلام الخامات منفصل عن تأكيد الكاش.</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {!storage?<p className="text-sm text-muted-foreground">لا يوجد تصريح كاش ليل ينتظر الاستلام في هذا الفرع.</p>:<>
      {storages.length>1&&<select aria-label="الدرج المطلوب استلامه" value={storage.id} onChange={e=>{setSelected(e.target.value);setCount('');setNote('');setReason('');setOverride(false);}} className="h-9 w-full rounded border px-3">{storages.map(s=><option key={s.id} value={s.id}>{s.drawerLabel} — شيفت #{s.outgoingShift.shiftNumber}</option>)}</select>}
      <p className="text-sm">شيفت الليل #{storage.outgoingShift.shiftNumber} — {storage.outgoingShift.cashier.name} · سجّل التصريح: {storage.declaredBy.name} · {new Date(storage.declaredAt).toLocaleString('ar-EG')}</p>
      <p className="text-sm">المتوقع في {storage.drawerLabel}: <strong>{money(storage.expectedAmount,currency)}</strong> · المحوّل للخزنة عند القفل: {money(Number(storage.toTreasury),currency)}</p>
      {!storage.receipt?<p className="text-sm">افتح الشيفت الصباحي أولًا عشان يتسجل اسم المستلم.</p>:<>
        <p className="text-sm">المستلم: {storage.receipt.claimant.name} · الحالة: {{PENDING:'منتظر العدّ',DEFERRED:'مؤجل',DISPUTED:'معترض عليه'}[storage.receipt.status]??storage.receipt.status}</p>
        {storage.handover.status!=='COMPLETED'&&<p className="text-sm">أكمل تسليم الفرع الليلي قبل اعتماد الكاش.</p>}
        <div className="space-y-2"><Label>الكاش اللي عديته فعليًا</Label><Input aria-label="الكاش المستلم فعليًا" type="number" min="0" step="0.01" value={count} onChange={e=>setCount(e.target.value)} placeholder="اكتب العدّ الفعلي، الصفر مسموح" disabled={busy||(!isClaimant&&!override)} /></div>
        {(hasDifference||override)&&<ReasonCodeSelect domain="HANDOVER" value={reason} onChange={setReason}/>}
        <Label>ملاحظة الاستلام أو سبب الاعتراض والتأجيل</Label><Textarea aria-label="ملاحظة استلام الكاش" value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/>
        {canOverride&&!isClaimant&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={override} onChange={e=>setOverride(e.target.checked)} />اعتماد استثنائي بواسطة المالك، مع سبب مسجل</label>}
        <div className="flex flex-wrap gap-2"><Button disabled={busy||!canKey('handover.accept')||(!isClaimant&&!override)||storage.handover.status!=='COMPLETED'||count===''} onClick={()=>act('ACCEPT')}>تأكيد العدّ والاستلام</Button><Button variant="outline" disabled={busy||!isClaimant} onClick={()=>act('DISPUTE')}>اعتراض على المبلغ</Button><Button variant="outline" disabled={busy||!isClaimant} onClick={()=>act('DEFER')}>تأجيل الاستلام</Button></div>
      </>}
    </>}
    <div className="flex gap-3"><Button variant="ghost" size="sm" disabled={busy} onClick={load}>تحديث</Button>{canKey('reports.view')&&<Link className="text-sm text-primary underline" href="/reports/opening-receipts">تقرير الاستلامات والعدّ المسجل</Link>}</div>
  </section>;
}
