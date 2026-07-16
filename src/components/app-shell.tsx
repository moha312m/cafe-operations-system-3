"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import {
  hasPermission,
  ROLE_LABELS,
  type Permission,
} from "@/lib/permissions";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type AppContextValue = {
  user: SessionUser;
  cafe: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    taxRate: number;
  } | null;
  branchName: string | null;
  can: (permission: Permission) => boolean;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppShell");
  return ctx;
}

const NAV: { href: string; label: string; icon: string; permission: Permission }[] = [
  { href: "/dashboard", label: t.nav.dashboard, icon: "📊", permission: "dashboard:read" },
  { href: "/pos", label: t.nav.pos, icon: "🧾", permission: "orders:create" },
  { href: "/current-shift", label: t.nav.currentShift, icon: "🧑‍💼", permission: "shifts:operate" },
  { href: "/kitchen", label: t.nav.kitchen, icon: "☕", permission: "orders:update-status" },
  { href: "/orders", label: t.nav.orders, icon: "🔔", permission: "orders:read" },
  { href: "/approvals", label: t.nav.approvals, icon: "📱", permission: "orders:approve" },
  { href: "/menu", label: t.nav.menu, icon: "📖", permission: "menu:manage" },
  { href: "/branches", label: t.nav.branches, icon: "🏬", permission: "branches:manage" },
  { href: "/staff", label: t.nav.staff, icon: "👥", permission: "users:manage" },
  { href: "/inventory", label: t.nav.inventory, icon: "📦", permission: "inventory:read" },
  { href: "/reports", label: t.nav.reports, icon: "📈", permission: "reports:read" },
  { href: "/shifts", label: t.nav.shiftReports, icon: "🧮", permission: "shifts:read" },
  { href: "/audit", label: t.nav.audit, icon: "🕓", permission: "audit:read" },
];

export function AppShell({
  user,
  cafe,
  branchName,
  children,
}: {
  user: SessionUser;
  cafe: AppContextValue["cafe"];
  branchName: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const can = (permission: Permission) => hasPermission(user.role, permission);

  const navItems = NAV.filter((item) => can(item.permission));

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = user.name.slice(0, 2);

  return (
    <AppContext.Provider value={{ user, cafe, branchName, can }}>
      <div className="flex min-h-screen w-full bg-slate-50 dark:bg-background">
        {/* Premium dark sidebar */}
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-[#0f172a] text-slate-300">
          <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
            <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-600 text-xl shadow-sm">
              ☕
            </span>
            <div className="min-w-0">
              <p className="truncate font-heading text-sm font-bold text-white">
                {cafe?.name ?? t.appName}
              </p>
              <p className="truncate text-xs text-slate-400">
                {branchName ?? t.appName}
              </p>
            </div>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
            {navItems.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-emerald-600 text-white shadow-sm"
                      : "text-slate-300 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <span className="text-base leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-white/10 p-4">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{user.name}</p>
                <p className="truncate text-xs text-slate-400">
                  {ROLE_LABELS[user.role]}
                </p>
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/5"
            >
              {t.common.signOut}
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-x-hidden p-6 lg:p-8">{children}</main>
      </div>
    </AppContext.Provider>
  );
}
