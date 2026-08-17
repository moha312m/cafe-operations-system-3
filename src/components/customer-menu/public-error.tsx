"use client";

import { useEffect } from "react";

// Last-resort error boundary for PUBLIC customer pages (/qr, /menu):
// customers must never see the raw Next.js crash screen.
export function PublicMenuError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("public menu error boundary", error);
  }, [error]);

  return (
    <main dir="rtl" className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <p className="text-4xl">☕</p>
        <p className="text-lg font-semibold">حصل خطأ مؤقت</p>
        <p className="text-sm text-muted-foreground">
          جرب تاني بعد لحظات، أو اطلب من الكاشير مباشرة.
        </p>
        <button
          onClick={retry}
          className="mt-2 h-11 w-full rounded-xl bg-foreground text-sm font-semibold text-background"
        >
          إعادة المحاولة
        </button>
      </div>
    </main>
  );
}

// Shared loading skeleton for the public menu while the server renders.
export function PublicMenuLoading() {
  return (
    <main dir="rtl" className="mx-auto min-h-dvh w-full max-w-lg animate-pulse space-y-3 p-4">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-full bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-36 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </div>
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 w-20 rounded-full bg-muted" />
        ))}
      </div>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-24 rounded-xl bg-muted" />
      ))}
    </main>
  );
}
