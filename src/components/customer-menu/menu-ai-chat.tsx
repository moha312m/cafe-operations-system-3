"use client";

import { useRef, useState } from "react";
import { money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MenuData, MenuProduct } from "./types";

type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; products: MenuProduct[] };

const SUGGESTIONS = [
  "عايز عصير فريش",
  "عايز حاجة ساقعة",
  "عايز قهوة خفيفة",
  "عايز حاجة حلوة",
  "رشحلي حاجة مشهورة",
  "أرخص مشروب عندكم إيه؟",
];

// Floating "اسأل المساعد" assistant for the public QR menu. Recommends
// products from the current branch menu only; each recommendation renders
// as a card with an "أضف للسلة" button that reuses the page's add flow.
export function MenuAIChat({
  menu,
  onPick,
  raised = false,
}: {
  menu: MenuData;
  onPick: (product: MenuProduct) => void;
  raised?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const byId = new Map(menu.products.map((p) => [p.id, p]));

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || loading) return;
    setError(false);
    setInput("");
    setMessages((m) => [...m, { role: "user", text: msg }]);
    setLoading(true);
    try {
      const res = await fetch("/api/public-menu-ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: menu.branch.id, message: msg }),
      });
      const data = await res.json();
      const products = Array.isArray(data.productIds)
        ? (data.productIds as string[]).map((id) => byId.get(id)).filter(Boolean as unknown as (p: MenuProduct | undefined) => p is MenuProduct)
        : [];
      setMessages((m) => [
        ...m,
        { role: "assistant", text: data.reply ?? "حصلت مشكلة، جرب تاني", products },
      ]);
    } catch {
      setError(true);
      setMessages((m) => [...m, { role: "assistant", text: "حصلت مشكلة، جرب تاني", products: [] }]);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" }));
    }
  }

  function addProduct(p: MenuProduct) {
    // Products with size/add-on choices need the config dialog, which can't
    // stack over this one — close the chat so it's usable.
    if (p.variants.length > 0 || p.addOns.length > 0) {
      setOpen(false);
      setTimeout(() => onPick(p), 150);
    } else {
      onPick(p);
    }
  }

  return (
    <>
      {/* Floating trigger */}
      <button
        onClick={() => setOpen(true)}
        className={`fixed start-4 z-30 flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-all active:scale-95 ${raised ? "bottom-24" : "bottom-4"}`}
      >
        <span className="text-base">✨</span>
        اسأل المساعد
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] w-full max-w-lg flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <span>✨</span> مساعد المنيو
            </DialogTitle>
          </DialogHeader>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-center text-sm text-muted-foreground">
                  اسألني أرشحلك من المنيو 👇
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-600 px-3 py-2 text-sm text-white">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="space-y-2">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">
                    {m.text}
                  </div>
                  {m.products.length > 0 && (
                    <div className="space-y-2">
                      {m.products.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between gap-2 rounded-xl border bg-card p-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {p.variants.length > 0
                                ? `من ${money(p.variants[0].price, menu.cafe.currency)}`
                                : money(p.basePrice, menu.cafe.currency)}
                            </p>
                          </div>
                          <Button size="sm" onClick={() => addProduct(p)}>
                            أضف للسلة
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-emerald-600" />
                جاري التفكير...
              </div>
            )}
            {error && !loading && (
              <p className="text-center text-xs text-destructive">حصلت مشكلة، جرب تاني</p>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t p-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="اكتب طلبك… مثلاً: عايز حاجة ساقعة"
              disabled={loading}
            />
            <Button type="submit" disabled={loading || !input.trim()}>
              إرسال
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
