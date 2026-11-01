"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The customer-facing screen: big order numbers, "being prepared" and
// "ready — please collect". Polls every 5 s; a number that just turned ready
// is highlighted for a while and, once sound is switched on (browsers only
// allow audio after a tap), announced with a chime.

type Data = { branchName: string; preparing: number[]; ready: { orderNumber: number; readyAt: string | null }[] };
type Branch = { id: string; name: string };

const POLL_MS = 5000;
const HIGHLIGHT_MS = 20_000;

function chime() {
  try {
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    [660, 880, 1100].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.16;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {
    // no audio on this device
  }
}

export function CustomerDisplay({ initialBranchId }: { initialBranchId: string | null }) {
  const [branchId, setBranchId] = useState(initialBranchId);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [fresh, setFresh] = useState<Map<number, number>>(new Map());
  const [now, setNow] = useState(0);
  const known = useRef<Set<number> | null>(null);
  const soundRef = useRef(false);

  const load = useCallback(async () => {
    const qs = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
    try {
      const res = await fetch(`/api/display/orders${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && !branchId) {
        const b = await fetch("/api/branches").then((r) => r.json()).catch(() => ({ branches: [] }));
        setBranches(b.branches ?? []);
        return;
      }
      if (!res.ok) {
        setError(res.status === 403 && /غير مفعلة/.test(body.error ?? "")
          ? "شاشة البار متوقفة لهذا الكافيه — الشاشة دي بتعرض حالة «جاهز» اللي بتتعلّم من شاشة البار."
          : body.error ?? "تعذر تحميل الطلبات");
        return;
      }
      const next = body as Data;
      const readyNow = new Set(next.ready.map((o) => o.orderNumber));
      if (known.current) {
        const added = [...readyNow].filter((n) => !known.current!.has(n));
        if (added.length > 0) {
          const at = Date.now();
          const until = at + HIGHLIGHT_MS;
          setNow(at);
          setFresh((prev) => {
            const m = new Map(prev);
            added.forEach((n) => m.set(n, until));
            return m;
          });
          if (soundRef.current) chime();
        }
      }
      known.current = readyNow;
      setError(null);
      setData(next);
    } catch {
      // a missed poll is retried on the next tick
    }
  }, [branchId]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  function enableSound() {
    soundRef.current = true;
    setSoundOn(true);
    chime();
  }

  function fullscreen() {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  const shell = "min-h-dvh bg-zinc-950 text-white";

  if (!branchId && branches) {
    return (
      <main dir="rtl" className={`${shell} grid place-items-center p-6`}>
        <div className="w-full max-w-md space-y-3 text-center">
          <h1 className="text-2xl font-bold">اختار الفرع لشاشة العملاء</h1>
          {branches.map((b) => (
            <button
              key={b.id}
              onClick={() => {
                setBranchId(b.id);
                window.history.replaceState(null, "", `/display?branchId=${b.id}`);
              }}
              className="block w-full rounded-xl bg-zinc-800 px-4 py-3 text-lg hover:bg-zinc-700"
            >
              {b.name}
            </button>
          ))}
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main dir="rtl" className={`${shell} grid place-items-center p-6`}>
        <p className="max-w-xl text-center text-xl">{error}</p>
      </main>
    );
  }

  return (
    <main dir="rtl" className={`${shell} flex flex-col`}>
      <header className="flex items-center gap-3 px-8 py-4">
        <h1 className="text-2xl font-bold">{data?.branchName ?? "…"}</h1>
        <div className="ms-auto flex gap-2 text-sm">
          {!soundOn && (
            <button onClick={enableSound} className="rounded-lg bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700">
              🔊 شغّل الصوت
            </button>
          )}
          <button onClick={fullscreen} className="rounded-lg bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700">
            ⛶ ملء الشاشة
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-6 px-8 pb-8 md:grid-cols-5">
        <section className="rounded-3xl bg-zinc-900 p-6 md:col-span-2">
          <h2 className="mb-6 text-center text-3xl font-bold text-amber-300">⏳ بيتحضر</h2>
          <div className="flex flex-wrap justify-center gap-4" data-testid="display-preparing">
            {data?.preparing.length === 0 && <p className="text-xl text-zinc-500">—</p>}
            {data?.preparing.map((n) => (
              <span key={n} className="min-w-24 rounded-2xl bg-zinc-800 px-5 py-3 text-center text-4xl font-bold tabular-nums">
                {n}
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-3xl bg-emerald-950 p-6 md:col-span-3">
          <h2 className="mb-6 text-center text-4xl font-extrabold text-emerald-300">✅ جاهز — اتفضل استلم</h2>
          <div className="flex flex-wrap justify-center gap-5" data-testid="display-ready">
            {data?.ready.length === 0 && <p className="text-2xl text-emerald-700">—</p>}
            {data?.ready.map((o) => {
              const isFresh = (fresh.get(o.orderNumber) ?? 0) > now;
              return (
                <span
                  key={o.orderNumber}
                  className={
                    "min-w-32 rounded-3xl px-6 py-4 text-center text-6xl font-extrabold tabular-nums transition-colors " +
                    (isFresh ? "animate-pulse bg-emerald-400 text-emerald-950" : "bg-emerald-800 text-white")
                  }
                >
                  {o.orderNumber}
                </span>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
