"use client";

import { Children, isValidElement, useId, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Props = Omit<ComponentProps<"select">, "onChange" | "multiple" | "size"> & {onValueChange: (value: string) => void};
function text(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{children?: ReactNode}>(child) ? text(child.props.children) : String(child)).join("");
}

/** Large options in a normal dialog also work with Tab, Enter and Escape. */
export function TouchSelect({value, onValueChange, children, disabled, className, id, name, "aria-label": ariaLabel}: Props) {
  const autoId = useId();
  const [open,setOpen] = useState(false);
  const [query,setQuery] = useState("");
  const options = Children.toArray(children).filter(isValidElement<{value?:string|number;children?:ReactNode;disabled?:boolean}>)
    .map(option => ({value:String(option.props.value ?? text(option.props.children)), label:text(option.props.children), disabled:option.props.disabled}));
  const selected = options.find(option => option.value === String(value ?? ""));
  const label = ariaLabel ?? "اختيار";
  return <>
    {name && <input type="hidden" name={name} value={String(value ?? "")} />}
    <Button id={id ?? autoId} type="button" className={className} variant="outline" aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      onClick={() => {setQuery("");setOpen(true);}}>{selected?.label ?? label}<span aria-hidden="true" className="ms-2">▾</span></Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent dir="rtl" className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        {options.length > 8 && <Input aria-label={`البحث: ${label}`} placeholder="بحث في الاختيارات" value={query} onChange={e => setQuery(e.target.value)} />}
        <div className="grid gap-2">{options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((option,index) => <Button key={`${option.value}:${index}`}
          type="button" className="min-h-14 justify-start text-start" variant={option.value === String(value ?? "") ? "default" : "outline"} aria-pressed={option.value === String(value ?? "")} disabled={option.disabled}
          onClick={() => {onValueChange(option.value);setOpen(false);}}>{option.label}{option.value === String(value ?? "") && " ✓ محدد"}</Button>)}</div>
        {!options.some(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p role="status">لا توجد اختيارات بهذا الاسم.</p>}
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
