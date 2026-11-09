"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Store,
  Receipt,
  LayoutDashboard,
  CheckSquare,
  Menu,
  X,
  Coffee,
  Building2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PrototypeShellProps {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  {
    href: "/prototypes/pos",
    labelAr: "الكاشير ونقطة البيع",
    shortLabelAr: "الكاشير",
    icon: Store,
    badgeAr: "مباشر",
  },
  {
    href: "/prototypes/expenses",
    labelAr: "المصروفات التشغيلية",
    shortLabelAr: "المصروفات",
    icon: Receipt,
  },
  {
    href: "/prototypes/dashboard",
    labelAr: "لوحة المالك الشاملة",
    shortLabelAr: "اللوحة",
    icon: LayoutDashboard,
  },
  {
    href: "/prototypes/tasks",
    labelAr: "المهام وقوائم التحقق",
    shortLabelAr: "المهام",
    icon: CheckSquare,
    badgeAr: "7 مهام",
  },
];

export function PrototypeShell({ children }: PrototypeShellProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  return (
    <div
      dir="rtl"
      className={cn(
        "min-h-screen w-full bg-[#F6F7F4] text-[#17221E] antialiased selection:bg-[#27695B]/20 selection:text-[#17221E] font-sans",
        // Scoped design token variables for all descendant elements
        "[--proto-rail:#151918] [--proto-tile:#202624] [--proto-canvas:#F6F7F4] [--proto-surface:#FFFFFF] [--proto-text:#17221E] [--proto-primary:#27695B]"
      )}
    >
      {/* Top Banner / System Environment Bar */}
      <header className="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-[#E2E4DE] bg-white/95 px-3 sm:px-6 backdrop-blur-md">
        <div className="flex items-center gap-3">
          {/* Mobile Menu Hamburger */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "إغلاق القائمة الجانبية" : "فتح القائمة الجانبية"}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#E2E4DE] text-[#17221E] hover:bg-[#F6F7F4] focus-visible:outline-2 focus-visible:outline-[#27695B] lg:hidden"
          >
            {mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>

          {/* Logo & Cafe Brand */}
          <Link
            href="/prototypes/dashboard"
            className="flex items-center gap-2.5 rounded-lg py-1 px-1.5 focus-visible:outline-2 focus-visible:outline-[#27695B]"
          >
            <div className="flex size-9 items-center justify-center rounded-lg bg-[#27695B] text-white shadow-xs">
              <Coffee className="size-5" />
            </div>
            <div className="flex flex-col">
              <span className="font-heading text-base font-bold leading-tight text-[#17221E]">
                نكست كب <span className="text-[#27695B]">|</span> NextCup
              </span>
              <span className="text-[11px] font-medium text-[#64746B]">
                نظام إدارة وتشغيل المقاهي
              </span>
            </div>
          </Link>
        </div>

        {/* Center / Right: Branch Context & Prototype Pill */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Active Branch Chip */}
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-[#E2E4DE] bg-[#F6F7F4] px-3 py-1.5 text-xs font-semibold text-[#17221E]">
            <Building2 className="size-3.5 text-[#27695B]" />
            <span>فرع وسط البلد (القاهرة)</span>
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </div>

          {/* Prototype Badge */}
          <div className="flex items-center gap-1 rounded-full border border-[#27695B]/20 bg-[#27695B]/10 px-2.5 py-1 text-xs font-medium text-[#27695B]">
            <Sparkles className="size-3" />
            <span>نموذج بصري تفاعلي</span>
          </div>
        </div>
      </header>

      {/* Main Layout Container (Desktop Rail + Content Area) */}
      <div className="flex min-h-[calc(100vh-3.5rem)] w-full">
        {/* Desktop / Tablet Navigation Rail */}
        <aside
          aria-label="القائمة الجانبية الرئيسية"
          className="hidden lg:flex w-64 shrink-0 flex-col justify-between border-l border-black/10 bg-[#151918] p-3 text-white"
        >
          <div className="flex flex-col gap-1.5">
            <div className="px-3 py-2 text-[11px] font-semibold tracking-wider text-white/50 uppercase">
              وحدات النظام المعتمدة
            </div>

            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group relative flex min-h-[48px] items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition-all outline-none",
                    "focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#151918]",
                    isActive
                      ? "bg-[#27695B] text-white shadow-sm font-semibold"
                      : "bg-[#202624] text-white/85 hover:bg-[#202624]/80 hover:text-white"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Icon
                      className={cn(
                        "size-5 shrink-0 transition-transform group-hover:scale-105",
                        isActive ? "text-white" : "text-emerald-400"
                      )}
                    />
                    <span>{item.labelAr}</span>
                  </div>

                  {item.badgeAr && (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        isActive
                          ? "bg-white/20 text-white"
                          : "bg-white/10 text-white/70"
                      )}
                    >
                      {item.badgeAr}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>

          {/* Rail Footer / System Status */}
          <div className="rounded-xl border border-white/10 bg-[#202624] p-3 text-xs text-white/70">
            <div className="flex items-center justify-between font-semibold text-white/90">
              <span>حالة النظام</span>
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                متصل
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-white/60">
              البيانات تجريبية محلية 100% بدون أي عمليات كتابة بقاعدة البيانات.
            </p>
          </div>
        </aside>

        {/* Mobile Navigation Drawer Overlay */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-50 flex lg:hidden bg-black/60 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileMenuOpen(false)}
            aria-modal="true"
            role="dialog"
          >
            <div
              className="flex h-full w-72 max-w-[80vw] flex-col justify-between border-l border-white/10 bg-[#151918] p-4 text-white shadow-2xl animate-in slide-in-from-right-full duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-[#27695B] text-white">
                      <Coffee className="size-4" />
                    </div>
                    <span className="font-heading font-bold text-white">نكست كب</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(false)}
                    aria-label="إغلاق القائمة"
                    className="flex size-11 items-center justify-center rounded-lg text-white/80 hover:bg-white/10"
                  >
                    <X className="size-5" />
                  </button>
                </div>

                <div className="mt-4 flex flex-col gap-2">
                  <div className="px-2 text-[11px] font-semibold text-white/50 uppercase">
                    التنقل السريع بين النماذج
                  </div>
                  {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const isActive = pathname === item.href;

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileMenuOpen(false)}
                        className={cn(
                          "flex min-h-[48px] items-center justify-between rounded-xl px-3.5 py-3 text-sm font-medium transition-all",
                          isActive
                            ? "bg-[#27695B] text-white font-semibold"
                            : "bg-[#202624] text-white/85 hover:bg-[#202624]/80"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Icon className={cn("size-5", isActive ? "text-white" : "text-emerald-400")} />
                          <span>{item.labelAr}</span>
                        </div>
                        {item.badgeAr && (
                          <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs text-white">
                            {item.badgeAr}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-white/10 pt-3 text-xs text-white/60">
                فرع وسط البلد | وردية الصباح #142
              </div>
            </div>
          </div>
        )}

        {/* Main Content Viewport */}
        <main className="flex-1 w-full min-w-0 overflow-y-auto pb-16 lg:pb-0">
          <div className="mx-auto w-full max-w-7xl p-3 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Sticky Bottom Navigation Bar (min touch target >= 48px) */}
      <nav
        aria-label="شريط التنقل السفلي للهاتف"
        className="fixed bottom-0 inset-x-0 z-40 flex lg:hidden h-16 items-center justify-around border-t border-[#E2E4DE] bg-white px-2 shadow-lg"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center min-h-[48px] min-w-[56px] px-2 py-1 rounded-lg text-xs font-medium transition-colors",
                isActive
                  ? "text-[#27695B] font-bold"
                  : "text-[#64746B] hover:text-[#17221E]"
              )}
            >
              <Icon className={cn("size-5 mb-0.5", isActive ? "text-[#27695B]" : "text-[#64746B]")} />
              <span className="text-[11px] leading-tight">{item.shortLabelAr}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
