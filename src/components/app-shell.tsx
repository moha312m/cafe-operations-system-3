"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import {
  ROLE_LABELS,
  type Permission,
} from "@/lib/permissions";
import { primaryKey } from "@/lib/perms/catalog";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CafeFeatures } from "@/lib/cafe-settings";
import { LowStockBanner } from "@/components/low-stock-banner";
import { StaleOrdersBanner } from "@/components/stale-orders-banner";
import { CashierTouchViewport } from "@/components/pos/cashier-touch-viewport";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

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
  canKey: (key: string) => boolean;
  permKeys: string[];
  features: CafeFeatures | null;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppShell");
  return ctx;
}

// The sidebar is grouped so a laptop-height screen shows the section titles and
// the section being worked in, not 25 flat links behind a small inner scroll.
// Items without a `group` (the dashboard) stay pinned above the sections.
type NavGroupId = "daily" | "menu" | "stock" | "reports" | "admin";
const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: "daily", label: "التشغيل اليومي" },
  { id: "menu", label: "المنيو والمخزون" },
  { id: "stock", label: "الجرد والتسليم" },
  { id: "reports", label: "التقارير والمتابعة" },
  { id: "admin", label: "الإدارة" },
];
const NAV_COLLAPSED_KEY = "nextcup.nav.collapsed";
// Phones are handled by the drawer; this is the short-laptop case (e.g. 1080p
// at 150% scaling inside a browser window), where every pixel of height counts.
const SHORT_SCREEN = "(max-height: 760px)";

// `feature` (when set) hides the item if the cafe has that module disabled.
type NavItem = {
  href: string;
  label: string;
  icon: string;
  permission: Permission;
  group?: NavGroupId;
  key?: string; // optional new granular permission key (wins over `permission`)
  feature?: (f: CafeFeatures) => boolean;
};

const NAV: NavItem[] = [
  { href: "/dashboard", label: t.nav.dashboard, icon: "📊", permission: "dashboard:read" },
  { href: "/pos", label: t.nav.pos, icon: "🧾", permission: "orders:create", group: "daily" },
  { href: "/current-shift", label: t.nav.currentShift, icon: "🧑‍💼", permission: "shifts:operate", group: "daily", feature: (f) => f.shiftManagementEnabled },
  { href: "/kitchen", label: t.nav.kitchen, icon: "☕", permission: "orders:update-status", group: "daily", feature: (f) => f.kitchenScreenEnabled },
  { href: "/tables", label: "الترابيزات", icon: "🍽️", permission: "orders:create", group: "daily", key: "tables.view", feature: (f) => f.enableTables },
  // Table setup is no longer a prominent daily page — it's reached from a
  // small "إدارة أرقام الترابيزات" button on /tables (owner/manager only).
  { href: "/orders", label: t.nav.orders, icon: "🔔", permission: "orders:read", group: "daily" },
  { href: "/sales", label: "المبيعات", icon: "📈", permission: "orders:read", group: "daily", key: "sales.view" },
  { href: "/tracing", label: "التتبّع", icon: "🔎", permission: "audit:read", group: "reports", key: "audit.view" },
  // Approvals shows when waiter approval is on OR QR orders route to a waiter.
  { href: "/approvals", label: t.nav.approvals, icon: "📱", permission: "orders:approve", group: "daily", key: "qr_orders.view", feature: (f) => f.qrMenuEnabled },
  { href: "/menu", label: t.nav.menu, icon: "📖", permission: "menu:manage", group: "menu" },
  // Recipe accuracy sits beside the menu: it is about how the menu is made,
  // and it exposes ingredient cost, so it rides the same cost permission.
  { href: "/recipe-review", label: "دقة الوصفات", icon: "🧪", permission: "cost:read", group: "menu" },
  { href: "/branches", label: t.nav.branches, icon: "🏬", permission: "branches:manage", group: "admin", feature: (f) => f.branchManagementEnabled },
  { href: "/staff", label: t.nav.staff, icon: "👥", permission: "users:manage", group: "admin", feature: (f) => f.staffManagementEnabled },
  // Historical finished orders/returns remain reachable after new inventory use is disabled.
  { href: "/inventory", label: t.nav.inventory, icon: "📦", permission: "inventory:read", group: "menu" },
  { href: "/purchases", label: "المشتريات", icon: "🛒", permission: "inventory:read", group: "menu", key: "purchases.view", feature: (f) => f.purchasesEnabled },
  { href: "/suppliers", label: "الموردين", icon: "🚚", permission: "inventory:read", group: "menu", key: "suppliers.view", feature: (f) => f.purchasesEnabled },
  { href: "/customers", label: "العملاء", icon: "💳", permission: "orders:read", group: "daily", key: "customers.view" },
  // Counting, its variance cases, and custody handover. Each gates on its own
  // granular key rather than the legacy bridge: the pages are new, so there is
  // no legacy permission that means "may see this" without over-granting.
  { href: "/stock-counts", label: "جرد المخزون", icon: "📋", permission: "inventory:read", group: "stock", key: "stock_count.view", feature: (f) => f.inventoryEnabled },
  { href: "/variances", label: "الفروقات", icon: "⚖️", permission: "shifts:read", group: "stock", key: "variance.view", feature: (f) => f.shiftManagementEnabled },
  { href: "/handovers", label: "التسليم والاستلام", icon: "🤝", permission: "shifts:operate", group: "stock", key: "handover.view", feature: (f) => f.shiftManagementEnabled },
  { href: "/reports", label: t.nav.reports, icon: "📈", permission: "reports:read", group: "reports" },
  { href: "/shifts", label: t.nav.shiftReports, icon: "🧮", permission: "shifts:read", group: "reports", feature: (f) => f.shiftManagementEnabled },
  { href: "/settings", label: "الإعدادات", icon: "⚙️", permission: "branches:manage", group: "admin" },
  { href: "/roles-permissions", label: "الأدوار والصلاحيات", icon: "🛡️", permission: "users:manage", group: "admin", key: "users.manage_permissions" },
  { href: "/audit", label: t.nav.audit, icon: "🕓", permission: "audit:read", group: "reports" },
];

export function AppShell({
  user,
  cafe,
  branchName,
  features,
  permKeys,
  children,
}: {
  user: SessionUser;
  cafe: AppContextValue["cafe"];
  branchName: string | null;
  features: CafeFeatures | null;
  permKeys: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const cashierTouch = ["/pos", "/orders", "/sales", "/tracing", "/tables", "/current-shift", "/receipts", "/reports"].some(route => pathname === route || pathname.startsWith(route + "/"));
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => { if (desktop.matches) setMobileNavOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const keySet = new Set(permKeys);
  const canKey = (key: string) => keySet.has(key);
  // Legacy Permission → its canonical key, then membership in the effective set.
  const can = (permission: Permission) => {
    const key = primaryKey(permission);
    return key ? keySet.has(key) : false;
  };

  const navItems = NAV.filter(
    (item) =>
      // An explicit `key` (new granular gate) wins; else fall back to the
      // legacy permission bridge.
      (item.key ? canKey(item.key) : can(item.permission)) &&
      (!item.feature || !features || item.feature(features))
  );

  // Sidebar sections. The server and the first client render show every
  // section open (no hydration mismatch); after mount the saved choice is
  // applied, and on a short screen with no saved choice the sections start
  // collapsed. The section that holds the current page is always open.
  const [collapsedGroups, setCollapsedGroups] = useState<NavGroupId[]>([]);
  useEffect(() => {
    const valid = (v: unknown): v is NavGroupId => NAV_GROUPS.some((g) => g.id === v);
    const timer = window.setTimeout(() => {
      let saved: NavGroupId[] | null = null;
      try {
        const raw = window.localStorage.getItem(NAV_COLLAPSED_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) saved = parsed.filter(valid);
      } catch { /* storage unavailable or corrupt: fall back to the default */ }
      if (saved) setCollapsedGroups(saved);
      else if (window.matchMedia(SHORT_SCREEN).matches) setCollapsedGroups(NAV_GROUPS.map((g) => g.id));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const activeGroup = navItems.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  )?.group;
  function toggleGroup(id: NavGroupId) {
    setCollapsedGroups((current) => {
      const next = current.includes(id) ? current.filter((g) => g !== id) : [...current, id];
      try { window.localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* not critical */ }
      return next;
    });
  }

  // Pending QR-approval count for the sidebar badge (assignment-aware,
  // lightweight 20s poll — only for users who can act on the queue).
  const [pendingQr, setPendingQr] = useState(0);
  const canSeeQr = canKey("qr_orders.view") || canKey("qr_orders.approve");
  useEffect(() => {
    if (!canSeeQr || !features?.qrMenuEnabled) return;
    let stop = false;
    const tick = () =>
      fetch("/api/qr-orders/pending?countOnly=1")
        .then((r) => (r.ok ? r.json() : { count: 0 }))
        .then((d) => { if (!stop) setPendingQr(d.count ?? 0); })
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 20_000);
    return () => { stop = true; clearInterval(timer); };
  }, [canSeeQr, features?.qrMenuEnabled, pathname]);

  // Refresh branch and role after an owner edit while this page stays open.
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (!response.ok) return;
        const { user: current } = await response.json() as { user: SessionUser };
        if (!stopped && (current.branchId !== user.branchId ||
            current.cafeId !== user.cafeId || current.role !== user.role ||
            current.name !== user.name)) router.refresh();
      } catch { /* Keep the current view during temporary connection failures. */ }
    };
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(onFocus, 20_000);
    return () => {
      stopped = true;
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [router, user.branchId, user.cafeId, user.role, user.name]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = user.name.slice(0, 2);
  const showStockBanner =
    (user.role === "CAFE_OWNER" || user.role === "BRANCH_MANAGER") &&
    can("inventory:read") &&
    (!features || features.inventoryEnabled);
  const showStaleBanner =
    (user.role === "CAFE_OWNER" || user.role === "BRANCH_MANAGER") && can("orders:read");

  const navLink = (item: NavItem) => {
    const active = pathname === item.href || pathname.startsWith(item.href + "/");
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileNavOpen(false)}
        aria-current={active ? (pathname === item.href ? "page" : "location") : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring [@media(max-height:760px)]:py-1.5",
          active
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <span className="text-base leading-none">{item.icon}</span>
        <span className="flex-1">{item.label}</span>
        {item.href === "/approvals" && pendingQr > 0 && (
          <span className="flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white">
            {pendingQr}
          </span>
        )}
      </Link>
    );
  };

  const sidebarContent = (
    <>
          <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-5 [@media(max-height:760px)]:py-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-sidebar-primary text-xl text-sidebar-primary-foreground shadow-sm">
              ☕
            </span>
            <div className="min-w-0">
              <p className="truncate font-heading text-sm font-bold text-sidebar-accent-foreground">
                {cafe?.name ?? t.appName}
              </p>
              <p className="truncate text-xs text-sidebar-muted-foreground">
                {branchName ?? t.appName}
              </p>
            </div>
          </div>

          <nav aria-label="التنقل الرئيسي" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-3 [@media(max-height:760px)]:p-2">
            {navItems.filter((item) => !item.group).map(navLink)}
            {NAV_GROUPS.map((group) => {
              const items = navItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              const isCurrent = group.id === activeGroup;
              const open = isCurrent || !collapsedGroups.includes(group.id);
              // A collapsed section must not hide a waiting QR approval.
              const badge = !open && items.some((item) => item.href === "/approvals") ? pendingQr : 0;
              return (
                <div key={group.id} className="pt-1.5">
                  <button
                    type="button"
                    onClick={() => { if (!isCurrent) toggleGroup(group.id); }}
                    aria-expanded={open}
                    aria-controls={`nav-group-${group.id}`}
                    aria-disabled={isCurrent || undefined}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold text-sidebar-muted-foreground transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
                  >
                    <span className="flex-1 text-start">{group.label}</span>
                    {badge > 0 && (
                      <span className="flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white">
                        {badge}
                      </span>
                    )}
                    <span aria-hidden="true" className="text-[10px] leading-none">{open ? "▾" : "◂"}</span>
                  </button>
                  <div id={`nav-group-${group.id}`} hidden={!open} className="space-y-0.5">
                    {items.map(navLink)}
                  </div>
                </div>
              );
            })}
          </nav>

          <div className="border-t border-sidebar-border p-4 [@media(max-height:760px)]:p-2.5">
            <div className="mb-3 flex items-center gap-2.5 [@media(max-height:760px)]:mb-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent-foreground/10 text-xs font-semibold text-sidebar-accent-foreground">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-sidebar-accent-foreground">{user.name}</p>
                <p className="truncate text-xs text-sidebar-muted-foreground">
                  {ROLE_LABELS[user.role]}
                </p>
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full rounded-lg border border-sidebar-accent-foreground/15 px-3 py-2 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
            >
              {t.common.signOut}
            </button>
          </div>
    </>
  );

  return (
    <AppContext.Provider value={{ user, cafe, branchName, can, canKey, permKeys, features }}>
      <CashierTouchViewport active={cashierTouch} />
      <div className="flex min-h-screen w-full flex-col bg-workspace md:flex-row">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
          {sidebarContent}
        </aside>
        <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <div className="flex items-center gap-3 bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden">
            <DialogTrigger className="shrink-0 rounded-lg border border-sidebar-border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring">
              القائمة
            </DialogTrigger>
            <p className="min-w-0 truncate text-sm font-semibold text-sidebar-accent-foreground">{cafe?.name ?? t.appName}</p>
          </div>
          <DialogContent scrollable={false} className="flex h-[calc(100dvh-2rem)] max-w-xs flex-col gap-0 overflow-hidden bg-sidebar p-0 pt-10 text-sidebar-foreground">
            <DialogTitle className="sr-only">التنقل الرئيسي</DialogTitle>
            {sidebarContent}
          </DialogContent>
        </Dialog>

        <main key={`${user.cafeId}:${user.branchId}:${user.role}`} className="min-w-0 flex-1 overflow-x-hidden p-4 md:p-6 lg:p-8">
          {showStaleBanner && (
            <StaleOrdersBanner pathname={pathname} showBranch={!user.branchId} currency={cafe?.currency ?? "EGP"} />
          )}
          {showStockBanner && <LowStockBanner pathname={pathname} showBranch={!user.branchId} />}
          {children}
        </main>
      </div>
    </AppContext.Provider>
  );
}
