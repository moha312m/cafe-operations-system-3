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
import { Button } from "@/components/ui/button";
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

  return (
    <AppContext.Provider value={{ user, cafe, branchName, can }}>
      <div className="flex min-h-screen w-full">
        <aside className="flex w-56 shrink-0 flex-col border-e bg-sidebar">
          <div className="flex items-center gap-2 border-b px-4 py-4">
            <span className="text-xl">☕</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {cafe?.name ?? t.appName}
              </p>
              {branchName && (
                <p className="truncate text-xs text-muted-foreground">{branchName}</p>
              )}
            </div>
          </div>
          <nav className="flex-1 space-y-1 p-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                  pathname.startsWith(item.href) && "bg-accent"
                )}
              >
                <span>{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="border-t p-3">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {ROLE_LABELS[user.role]}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              onClick={logout}
            >
              {t.common.signOut}
            </Button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 bg-muted/20 p-6">{children}</main>
      </div>
    </AppContext.Provider>
  );
}
