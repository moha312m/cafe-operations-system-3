"use client";

import { useId, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normalizeTouchNumber, touchNumberError } from "@/lib/touch-number";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"input">, "onChange"> & { onValueChange?: (value: string) => void; integer?: boolean; signed?: boolean };

/** Ordinary editable input plus an explicit keypad; Cancel never changes the invoice. */
export function TouchNumberInput({value, onValueChange, integer: integerProp = false, signed = false, className, disabled, readOnly, min, max, ...props}: Props) {
  const integer = integerProp || String(props.step) === "1";
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [replace, setReplace] = useState(true);
  const label = props["aria-label"] ?? props.placeholder ?? "القيمة";
  const minimum = min === undefined ? (signed ? undefined : 0) : Number(min);
  const error = touchNumberError(draft, {min: minimum, max: max === undefined ? undefined : Number(max), integer, required: props.required, signed});

  function digit(key: string) {
    setDraft(previous => {
      const text = replace ? "" : previous;
      if (key === ".") return text.includes(".") ? text : (text === "-" ? "-0" : text || "0") + ".";
      return text === "0" ? key : text + key;
    });
    setReplace(false);
  }
  return <span className={cn("touch-number inline-flex min-w-0 items-center gap-2", className)}>
    <Input {...props} id={props.id ?? id} type="number" inputMode={integer ? "numeric" : "decimal"} min={minimum} max={max}
      disabled={disabled} readOnly={readOnly} value={value} className="min-w-0 flex-1" onChange={e => onValueChange?.(e.target.value)} />
    <Button type="button" variant="outline" disabled={disabled || readOnly} aria-label={`لوحة أرقام: ${label}`}
      onClick={() => {setDraft(String(value ?? ""));setReplace(true);setOpen(true);}}>أرقام</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="touch-keypad sm:max-w-md" dir="rtl">
        <DialogHeader><DialogTitle>{label} — لوحة الأرقام</DialogTitle></DialogHeader>
        <Input aria-label={`القيمة الجديدة: ${label}`} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} inputMode="none" dir="ltr" value={draft} className="h-14 text-center text-2xl font-semibold"
          onChange={e => {setDraft(normalizeTouchNumber(e.target.value));setReplace(false);}}
          onKeyDown={e => {if(e.key === "Enter" && !error) {e.preventDefault();onValueChange?.(normalizeTouchNumber(draft).trim());setOpen(false);}}} />
        <div className="grid grid-cols-3 gap-2" dir="ltr">
          {["1","2","3","4","5","6","7","8","9"].map(key => <Button key={key} variant="outline" className="min-h-14 text-xl" onClick={() => digit(key)}>{key}</Button>)}
          <Button variant="outline" disabled={integer} aria-label="فاصلة عشرية" onClick={() => digit(".")}>.</Button>
          <Button variant="outline" className="min-h-14 text-xl" onClick={() => digit("0")}>0</Button>
          <Button variant="outline" onClick={() => {setDraft(v => v.slice(0,-1));setReplace(false);}}>مسح رقم</Button>
        </div>
        <Button variant="outline" onClick={() => {setDraft("");setReplace(false);}}>مسح الكل</Button>
        {signed && <Button variant="outline" onClick={() => {setDraft(value => value.startsWith("-") ? value.slice(1) : "-" + value);setReplace(false);}}>تغيير الإشارة + / −</Button>}
        {error && <p id={`${id}-error`} role="alert" className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
          <Button disabled={Boolean(error)} onClick={() => {onValueChange?.(normalizeTouchNumber(draft).trim());setOpen(false);}}>تأكيد القيمة</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </span>;
}
