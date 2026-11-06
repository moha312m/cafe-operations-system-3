"use client";
// The morning after a branch-custody night, as three steps on one screen: open the opening count,
// record it (here, not on another page), then verify the custody against it. Navigation only: the
// count is the ordinary stock count with its own blind entry and confirmation, and «تحقّق من العهدة»
// is still refused by the server until that count is CONFIRMED.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { OpeningCashPanel } from "@/components/handovers/opening-cash-panel";
import { StockCountDetail } from "@/components/stock-counts/stock-count-detail";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { PendingReport } from "./next-step-model";
type OpeningShift = { id:string; shiftNumber:number; custodyGateReason:string|null; cashier:{name:string} };
type OpeningCount = { id:string; shiftId:string|null; status:string; createdAt:string };
const COUNT_STATUS: Record<string,string> = { CONFIRMED:"معتمد", SUBMITTED:"مُرسل — مستني الاعتماد", RECOUNT_REQUIRED:"يحتاج إعادة عد" };
const countLabel = (status:string) => COUNT_STATUS[status] ?? "جارٍ العد";
export function OpeningVerificationPanel({ branchId, includeCash = true, hideWhenEmpty = false, onPending }: {
 branchId: string; includeCash?: boolean;
 /** On the /handovers list: render nothing unless a shift is waiting (or loading failed). */
 hideWhenEmpty?: boolean; onPending?: (report: PendingReport) => void;
}) {
 const { canKey } = useApp();
 const [pickedShift,setPickedShift]=useState(""); const [pickedCount,setPickedCount]=useState("");
 const [shifts,setShifts]=useState<OpeningShift[]>([]); const [counts,setCounts]=useState<OpeningCount[]>([]);
 const [busy,setBusy]=useState(false); const [loadError,setLoadError]=useState(""); const [loaded,setLoaded]=useState(false);
 const mayStart=canKey("stock_count.start"); const mayVerify=canKey("handover.accept"); const mayCount=canKey("stock_count.view");
 const load=useCallback(async()=>{if(!branchId || (!mayStart&&!mayVerify))return;setLoadError("");try{
  const [s,c]=await Promise.all([api<{shifts:OpeningShift[]}>(`/api/shifts?branchId=${branchId}&status=OPEN`),api<{sessions:OpeningCount[]}>(`/api/stock-counts?branchId=${branchId}`)]);
  setShifts(s.shifts.filter(x=>x.custodyGateReason==="AWAITING_OPENING_VERIFICATION")); setCounts(c.sessions); setLoaded(true);
 }catch(e){setLoadError(e instanceof Error?e.message:"تعذر تحميل الشيفتات");}},[branchId,mayStart,mayVerify]);
 useEffect(()=>{setPickedShift("");setPickedCount("");setShifts([]);setCounts([]);setLoaded(false);load();},[load]);
 const pending:PendingReport=!mayStart&&!mayVerify?0:loadError?"error":loaded?shifts.length:null;
 useEffect(()=>{onPending?.(pending);},[onPending,pending]);
 if(!mayStart&&!mayVerify)return includeCash ? <OpeningCashPanel branchId={branchId}/> : null;
 // One waiting shift, or one count for it, is chosen without asking; a list appears only when there is a real choice.
 const shiftId=shifts.some(s=>s.id===pickedShift)?pickedShift:shifts.length===1?shifts[0].id:"";
 const selectableCounts=counts.filter(x=>x.shiftId===shiftId&&x.status!=="LOCKED").sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const count=selectableCounts.find(c=>c.id===pickedCount)??selectableCounts[0]??null;
 const shift=shifts.find(s=>s.id===shiftId)??null;
 async function startCount(){setBusy(true);try{const r=await api<{countSession:{id:string;reused:boolean}}>("/api/custody/opening-verification",{ method: "POST", body: { action: "start_count", shiftId, branchId } });await load();setPickedCount(r.countSession.id);toast.success(r.countSession.reused?"في جرد افتتاحي مفتوح بالفعل":"اتفتح الجرد الافتتاحي");}catch(e){toast.error(e instanceof Error?e.message:"تعذر بدء الجرد");}finally{setBusy(false);}}
 async function verify(){if(!count)return;setBusy(true);try{const r=await api<{alreadyVerified:boolean;varianceCaseIds:string[]}>("/api/custody/opening-verification",{ method: "POST", body: { action: "verify", shiftId, countSessionId: count.id, branchId } });toast.success(r.alreadyVerified?"العهدة كانت متحققة قبل كده":`اتحققت العهدة الافتتاحية · حالات فروقات: ${r.varianceCaseIds.length}`);setPickedShift("");setPickedCount("");await load();}catch(e){toast.error(e instanceof Error?e.message:"تعذر التحقق");}finally{setBusy(false);}}
 const cash=includeCash?<OpeningCashPanel branchId={branchId}/>:null;
 if(hideWhenEmpty&&!shifts.length&&!loadError)return cash;
 const step=!count?1:count.status==="CONFIRMED"?3:2;
 const stepClass=(n:number)=>`rounded-lg border p-3 ${step===n?"border-primary/40 bg-primary/5":step>n?"opacity-70":"opacity-60"}`;
 return <>{cash}<details id="handover-step-opening" className="rounded-xl border p-4" data-testid="opening-verification-panel" open={shifts.length>0||!!loadError}>
  <summary className="cursor-pointer font-semibold">التحقق من العهدة الافتتاحية{!shifts.length&&!loadError&&<span className="ms-2 text-xs font-normal text-muted-foreground">— مفيش شيفت مستني تحقق</span>}</summary><div className="mt-3 space-y-3">
  {loadError&&<p role="alert" className="text-sm text-destructive">{loadError}</p>}
  {!shifts.length&&!loadError&&<p className="text-sm text-muted-foreground">لا يوجد شيفت ينتظر تحققًا افتتاحيًا في هذا الفرع.</p>}
  {shifts.length>1&&<div className="space-y-2"><Label htmlFor="opening-shift">الشيفت المستلم</Label><select id="opening-shift" value={shiftId} onChange={e=>{setPickedShift(e.target.value);setPickedCount("");}} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="">اختر الشيفت</option>{shifts.map(s=><option key={s.id} value={s.id}>شيفت #{s.shiftNumber} — {s.cashier.name}</option>)}</select></div>}
  {shift&&<>
   <p className="text-sm">شيفت #{shift.shiftNumber} — {shift.cashier.name} مستلم عهدة الفرع، ومحتاج يجرد الفرع ويتحقق قبل البيع.</p>
   {selectableCounts.length>1&&<div className="space-y-2"><Label htmlFor="opening-count">الجرد الافتتاحي</Label><select id="opening-count" value={count?.id??""} onChange={e=>setPickedCount(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm">{selectableCounts.map(c=><option key={c.id} value={c.id}>{new Date(c.createdAt).toLocaleString("ar-EG")} — {countLabel(c.status)}</option>)}</select></div>}
   <ol className="space-y-2" aria-label="خطوات التحقق الافتتاحي">
    <li className={stepClass(1)}><p className="font-medium">{step>1?"✓ ":"١. "}افتح جرد الافتتاح</p>
     {step===1&&(mayStart?<Button size="sm" className="mt-2 min-h-10" disabled={busy} onClick={startCount} data-testid="opening-verification-start">ابدأ جرد الافتتاح</Button>:<p className="mt-1 text-xs text-muted-foreground">فتح الجرد محتاج صلاحية بدء الجرد.</p>)}</li>
    <li className={stepClass(2)}><p className="font-medium">{step>2?"✓ ":"٢. "}سجّل الكميات وابعت الجرد{count&&step===2?` — ${countLabel(count.status)}`:""}</p>
     {step===2&&count&&["SUBMITTED","RECOUNT_REQUIRED"].includes(count.status)&&!canKey("stock_count.confirm")&&<p className="mt-1 text-xs text-muted-foreground" data-testid="opening-count-awaiting-confirm">الجرد اتبعت — اعتماده من مسؤول بصلاحية تأكيد الجرد، وبعدها تظهر خطوة «تحقّق من العهدة».</p>}
     {step===2&&count&&(mayCount
      ? <div className="mt-2"><StockCountDetail key={count.id} embedded expectedBranchId={branchId} sessionId={count.id} onClose={()=>setPickedCount("")} onChanged={()=>void load()} /></div>
      : <Link className="mt-1 inline-block text-primary underline" href={`/stock-counts?sessionId=${count.id}`}>فتح الجرد وتسجيل الكميات</Link>)}</li>
    <li className={stepClass(3)}><p className="font-medium">٣. تحقّق من العهدة</p>
     {step===3&&(mayVerify?<Button size="sm" className="mt-2 min-h-10" disabled={busy} onClick={verify} data-testid="opening-verification-verify">تحقّق من العهدة</Button>:<p className="mt-1 text-xs text-muted-foreground">التحقق محتاج صلاحية استلام العهدة.</p>)}</li>
   </ol>
  </>}
  {!shift&&shifts.length>1&&<p className="text-xs text-muted-foreground">اختار الشيفت اللي هيستلم.</p>}
 </div></details></>;
}
