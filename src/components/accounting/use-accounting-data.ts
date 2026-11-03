"use client";

// Fetches an accounting endpoint; a response that arrives after a newer
// request is dropped, so a slow old filter can never overwrite a new one.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

export function useAccountingData<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const id = ++latest.current;
    setLoading(true);
    try {
      const next = await api<T>(url);
      if (id === latest.current) { setData(next); setError(""); }
    } catch (e) {
      if (id === latest.current) setError(e instanceof Error ? e.message : "فشل التحميل");
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  return { data, error, loading, reload: load };
}
