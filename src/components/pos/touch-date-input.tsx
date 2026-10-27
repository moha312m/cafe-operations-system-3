"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function today() { return new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Cairo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
export function TouchDateInput({value, onValueChange, label}: {value:string;onValueChange:(value:string)=>void;label:string}) {
  const [open,setOpen]=useState(false),[month,setMonth]=useState("2000-01");
  const [year,monthNumber]=month.split("-").map(Number);
  const days=new Date(Date.UTC(year,monthNumber,0)).getUTCDate();
  const monthLabel=new Intl.DateTimeFormat("ar-EG",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(year,monthNumber-1,1)));
  function move(delta:number){const date=new Date(Date.UTC(year,monthNumber-1+delta,1));setMonth(date.toISOString().slice(0,7));}
  function choose(date:string){onValueChange(date);setOpen(false);}
  return <>
    <Button type="button" variant="outline" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setMonth((value||today()).slice(0,7));setOpen(true);}}>{value||"اختيار التاريخ"}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader><DialogTitle>{label} — اختيار التاريخ</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" onClick={()=>move(-1)}>الشهر السابق</Button><strong>{monthLabel}</strong><Button variant="outline" onClick={()=>move(1)}>الشهر التالي</Button></div>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-7">{Array.from({length:days},(_,index)=>{
          const day=index+1,date=`${month}-${String(day).padStart(2,"0")}`;
          return <Button key={date} className="min-h-14" variant={date===value?"default":"outline"} aria-pressed={date===value} aria-label={`${day} ${monthLabel}`} onClick={()=>choose(date)}>{day}</Button>;
        })}</div>
        <DialogFooter className="flex-wrap"><Button variant="outline" onClick={()=>setOpen(false)}>إلغاء</Button><Button variant="outline" onClick={()=>choose("")}>مسح التاريخ</Button><Button onClick={()=>choose(today())}>اليوم — القاهرة</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
