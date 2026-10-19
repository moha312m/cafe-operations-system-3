"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// The same editors can live in a page workspace or their original dialog.
// Long content scrolls through the page; nested confirmations use the shared
// viewport-constrained dialog, preserving its fixed close/footer controls.
export function DetailFrame({ embedded, open, busy, title, onClose, children, hideBack = false }: {
  embedded?: boolean; hideBack?: boolean; open: boolean; busy: boolean; title: string;
  onClose: () => void; children: ReactNode;
}) {
  if (embedded) return open ? <section className="min-w-0 space-y-4 rounded-xl border p-3 sm:p-5" aria-label={title}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">{title}</h2>
      {!hideBack && <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>رجوع للقائمة</Button>}
    </header>
    {children}
  </section> : null;
  return <Dialog open={open} onOpenChange={value => !value && !busy && onClose()}>
    <DialogContent className="max-w-4xl">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

export function ConfirmHandoverAction({ title, open, busy, onCancel, onConfirm, children }: {
  title: string; open: boolean; busy: boolean; onCancel: () => void;
  onConfirm: () => void; children?: ReactNode;
}) {
  return <Dialog open={open} onOpenChange={value => !value && !busy && onCancel()}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <p className="text-sm">{children ?? "سيُسجل هذا الإجراء باسمك في سجل المراجعة. راجع البيانات قبل التأكيد."}</p>
      <DialogFooter className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onConfirm}>تأكيد الإجراء</Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>إلغاء</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
