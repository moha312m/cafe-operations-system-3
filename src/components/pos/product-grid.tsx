"use client";

import Link from "next/link";
import { AlertTriangle, Coffee, LoaderCircle, MapPin, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductCard } from "./product-card";
import type { Product } from "./types";

export type CatalogState = "loading" | "error" | "no-branch" | "denied" | "empty" | "filtered" | "ready";

export function ProductGrid({
  products, currency, onSelect, state = products.length ? "ready" : "filtered", error, onRetry, onClear, canManageMenu = false,
}: {
  products: Product[];
  currency: string;
  onSelect: (product: Product) => void;
  state?: CatalogState;
  error?: string;
  onRetry?: () => void;
  onClear?: () => void;
  canManageMenu?: boolean;
}) {
  if (state !== "ready") {
    const description = {
      loading: ["جارٍ تحميل المنتجات…", "نحمّل قائمة البيع والأسعار المتاحة في نطاقك."],
      error: ["تعذر تحميل قائمة البيع", error ?? "تحقق من الاتصال ثم أعد المحاولة."],
      "no-branch": ["لا يوجد فرع نشط محدد", "اختر فرعًا للعمل. إذا لم يتوفر فرع، اطلب من المدير ضبط نطاق الحساب."],
      denied: ["صلاحية الكاشير غير متاحة", "اطلب من المسؤول منح صلاحية إنشاء الطلبات في الفرع المسموح."],
      empty: ["لا توجد منتجات مهيأة للكاشير", "أضف منتجات في المنيو أو فعّل ظهورها في الكاشير."],
      filtered: ["لا توجد نتائج مطابقة", "جرّب اسم المنتج أو SKU آخر، أو امسح التصنيف والبحث."],
    }[state];
    const Icon = state === "loading" ? LoaderCircle : state === "error" ? AlertTriangle : state === "denied" ? ShieldAlert : state === "no-branch" ? MapPin : state === "filtered" ? Search : Coffee;
    return <div role={state === "error" || state === "denied" ? "alert" : "status"} className="cashier-catalog-state flex min-h-56 flex-1 flex-col items-center justify-center gap-3 rounded-2xl bg-card p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary"><Icon aria-hidden="true" className={state === "loading" ? "size-6 animate-spin" : "size-6"} /></span>
      <h3 className="text-lg font-semibold">{description[0]}</h3>
      <p className="max-w-md text-sm leading-7 text-muted-foreground">{description[1]}</p>
      {state === "error" && onRetry && <Button onClick={onRetry}>إعادة المحاولة</Button>}
      {state === "filtered" && onClear && <Button variant="outline" onClick={onClear}>مسح البحث والتصنيف</Button>}
      {state === "empty" && canManageMenu && <Link href="/menu" className="inline-flex min-h-12 items-center rounded-xl bg-primary px-5 font-semibold text-primary-foreground">إعداد منتجات المنيو</Link>}
    </div>;
  }
  return <div role="group" className="cashier-products grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto pb-4 pe-1 2xl:grid-cols-3" aria-label="المنتجات">
    {products.map(product => <ProductCard key={product.id} product={product} currency={currency} onSelect={onSelect} />)}
  </div>;
}
