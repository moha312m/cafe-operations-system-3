"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { OpeningCashPanel } from "@/components/handovers/opening-cash-panel";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
type OpeningShift = { id:string; shiftNumber:number; custodyGateReason:string|null; cashier:{name:string} };
type OpeningCount = { id:string; shiftId:string|null; status:string; createdAt:string };
export function OpeningVerificationPanel({ branchId }: { branchId: string }) {
 const { canKey } = useApp();
 const [shiftId,setShiftId]=useState(""); const [countSessionId,setCountSessionId]=useState("");
 const [shifts,setShifts]=useState<OpeningShift[]>([]); const [counts,setCounts]=useState<OpeningCount[]>([]);
 const [busy,setBusy]=useState(false); const [loadError,setLoadError]=useState("");
 const mayStart=canKey("stock_count.start"); const mayVerify=canKey("handover.accept");
 const load=useCallback(async()=>{if(!branchId || (!mayStart&&!mayVerify))return;setLoadError("");try{
  const [s,c]=await Promise.all([api<{shifts:OpeningShift[]}>(`/api/shifts?branchId=${branchId}&status=OPEN`),api<{sessions:OpeningCount[]}>(`/api/stock-counts?branchId=${branchId}`)]);
  setShifts(s.shifts.filter(x=>x.custodyGateReason==="AWAITING_OPENING_VERIFICATION")); setCounts(c.sessions);
 }catch(e){setLoadError(e instanceof Error?e.message:"تعذر تحميل الشيفتات");}},[branchId,mayStart,mayVerify]);
 useEffect(()=>{setShiftId("");setCountSessionId("");setShifts([]);setCounts([]);load();},[load]);
 if(!mayStart&&!mayVerify)return null;
 async function startCount(){setBusy(true);try{const r=await api<{countSession:{id:string;reused:boolean}}>("/api/custody/opening-verification",{ method: "POST", body: { action: "start_count", shiftId, branchId } });await load();setCountSessionId(r.countSession.id);toast.success(r.countSession.reused?"في جرد افتتاحي مفتوح بالفعل":"اتفتح الجرد الافتتاحي");}catch(e){toast.error(e instanceof Error?e.message:"تعذر بدء الجرد");}finally{setBusy(false);}}
 async function verify(){setBusy(true);try{const r=await api<{alreadyVerified:boolean;varianceCaseIds:string[]}>("/api/custody/opening-verification",{ method: "POST", body: { action: "verify", shiftId, countSessionId, branchId } });toast.success(r.alreadyVerified?"العهدة كانت متحققة قبل كده":`اتحققت العهدة الافتتاحية · حالات فروقات: ${r.varianceCaseIds.length}`);setShiftId("");setCountSessionId("");await load();}catch(e){toast.error(e instanceof Error?e.message:"تعذر التحقق");}finally{setBusy(false);}}
 const selectableCounts=counts.filter(x=>x.shiftId===shiftId&&x.status!=="LOCKED");
 return <><OpeningCashPanel branchId={branchId}/><section className="space-y-3 rounded-xl border p-4" data-testid="opening-verification-panel">
  <h2 className="font-semibold">التحقق من العهدة الافتتاحية</h2><p className="text-xs text-muted-foreground">اختَر الشيفت الذي يستلم مخزونًا محفوظًا في عهدة الفرع، وافتح جرده ثم تحقّق منه بعد اعتماده.</p>
  {loadError&&<p role="alert" className="text-sm text-destructive">{loadError}</p>}
  {!shifts.length&&!loadError&&<p className="text-sm text-muted-foreground">لا يوجد شيفت ينتظر تحققًا افتتاحيًا في هذا الفرع.</p>}
  <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="opening-shift">الشيفت المستلم</Label><select id="opening-shift" value={shiftId} onChange={e=>{setShiftId(e.target.value);setCountSessionId("");}} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="">اختر الشيفت</option>{shifts.map(s=><option key={s.id} value={s.id}>شيفت #{s.shiftNumber} — {s.cashier.name}</option>)}</select></div>
  <div className="space-y-2"><Label htmlFor="opening-count">الجرد الافتتاحي</Label><select id="opening-count" value={countSessionId} onChange={e=>setCountSessionId(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="">اختر الجرد</option>{selectableCounts.map(c=><option key={c.id} value={c.id}>{new Date(c.createdAt).toLocaleString("ar-EG")} — {c.status==="CONFIRMED"?"معتمد":c.status==="SUBMITTED"?"مقدّم":c.status==="RECOUNT_REQUIRED"?"يحتاج إعادة عد":"جارٍ العد"}</option>)}</select></div></div>
  {countSessionId&&<Link className="text-primary underline" href={`/stock-counts?sessionId=${countSessionId}`}>فتح الجرد وتسجيل الكميات</Link>}
  <div className="flex flex-wrap gap-2">{mayStart&&<Button size="sm" variant="outline" disabled={busy||!shiftId} onClick={startCount} data-testid="opening-verification-start">فتح الجرد الافتتاحي</Button>}{mayVerify&&<Button size="sm" disabled={busy||!shiftId||!countSessionId} onClick={verify} data-testid="opening-verification-verify">تحقّق من العهدة</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={load}>تحديث القائمة</Button></div>
 </section></>;
}
