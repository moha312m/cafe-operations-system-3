"use client";

import {visibleReportCatalog,REPORT_GROUPS} from "@/lib/report-center";
import {SALES_WORKSPACE_LINKS} from "@/lib/sales-report-catalog";
import { currentWorkspaceHref } from "@/lib/workspace-navigation";
import { LayoutDashboard, ReceiptText, Armchair, Coffee, ClipboardList, ChartNoAxesCombined, ScanSearch, Smartphone, BookOpen, FlaskConical, Building2, Users, Package, ShoppingCart, Truck, CreditCard, ClipboardCheck, Scale, Handshake, FileChartColumn, Wallet, Landmark, BookText, Calculator, Settings, ShieldCheck, History, PanelRightClose, PanelRightOpen, ChevronDown } from "lucide-react";
import { createContext, useContext, useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
type NavGroupId = "sales" | "daily" | "menu" | "stock" | "reports" | "finance" | "admin";
const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  {id:"sales",label:"المبيعات"},
  { id: "daily", label: "التشغيل اليومي" },
  { id: "menu", label: "المنيو والمخزون" },
  { id: "stock", label: "الجرد والتسليم" },
  { id: "reports", label: "التقارير والمتابعة" },
  { id: "finance", label: "المحاسبة والماليات" },
  { id: "admin", label: "الإدارة" },
];
const NAV_COLLAPSED_KEY = "nextcup.nav.collapsed";
// Phones are handled by the drawer; this is the short-laptop case (e.g. 1080p
// at 150% scaling inside a browser window), where every pixel of height counts.

// `feature` (when set) hides the item if the cafe has that module disabled.
type NavItem = {
  href: string;
  label: string;
  icon: string;
  permission: Permission;
  group?: NavGroupId;
  ownerOnly?: boolean;
  key?: string; // optional new granular permission key (wins over `permission`)
  anyKey?: string[];
  allKeys?: string[];
  reportGroup?: string;
  reportId?: string;
  feature?: (f: CafeFeatures) => boolean;
};

const NAV_ICONS: Record<string, React.ElementType> = {
 "/dashboard":LayoutDashboard,"/pos":ReceiptText,"/tables":Armchair,"/tables/setup":Armchair,
 "/current-shift":Coffee,"/kitchen":Coffee,"/orders":ClipboardList,"/sales":ChartNoAxesCombined,
 "/tracing":ScanSearch,"/approvals":Smartphone,"/menu":BookOpen,"/recipe-review":FlaskConical,
 "/branches":Building2,"/staff":Users,"/inventory":Package,"/purchases":ShoppingCart,"/suppliers":Truck,
 "/customers":CreditCard,"/stock-counts":ClipboardCheck,"/variances":Scale,"/handovers":Handshake,
 "/report-center":FileChartColumn,"/reports":FileChartColumn,"/expenses":Wallet,"/treasury":Landmark,
 "/finance":Wallet,"/accounting/pnl":ChartNoAxesCombined,"/accounting":BookText,"/shifts":Calculator,"/settings":Settings,
 "/roles-permissions":ShieldCheck,"/audit":History,
};
/** Report links share one catalog, so they pick an icon by report id, then by group, instead of the generic book. */
const REPORT_ICONS: Record<string, React.ElementType> = {
 tables:Armchair,"product-sales":Coffee,"sales-payments":CreditCard,"shift-sales":Calculator,"sales-staff":Users,"purchase-sales":ShoppingCart,
 daily:ChartNoAxesCombined,invoices:ReceiptText,historical:History,stock:Package,"purchase-invoices":ShoppingCart,expenses:Wallet,money:Landmark,
 "trial-balance":Scale,income:ChartNoAxesCombined,"balance-sheet":Scale,"cash-flow":Landmark,ledger:BookText,journal:BookText,customers:CreditCard,
 shifts:Calculator,opening:ClipboardCheck,variances:Scale,actions:ShieldCheck,audit:History,
};
const REPORT_GROUP_ICONS: Record<string, React.ElementType> = {sales:ChartNoAxesCombined,inventory:Package,purchasing:ShoppingCart,finance:Wallet,customers:CreditCard,system:ShieldCheck};
const NAV: NavItem[] = [
  ...SALES_WORKSPACE_LINKS.map(item=>({...item,icon:"",permission:"orders:read" as const,group:"sales" as const})),
  { href: "/report-center", label: "مركز التقارير", icon: "📊", permission: "reports:read", group: "reports" },
  { href: "/dashboard", label: t.nav.dashboard, icon: "📊", permission: "dashboard:read" },
  { href: "/current-shift", label: t.nav.currentShift, icon: "🧑‍💼", permission: "shifts:operate", group: "daily", feature: (f) => f.shiftManagementEnabled },
  { href: "/kitchen", label: t.nav.kitchen, icon: "☕", permission: "orders:update-status", group: "daily", feature: (f) => f.kitchenScreenEnabled },
  { href: "/tables", label: "الترابيزات", icon: "🍽️", permission: "orders:create", group: "daily", key: "tables.view", feature: (f) => f.enableTables },
  // Table setup is no longer a prominent daily page — it's reached from a
  // small "إدارة أرقام الترابيزات" button on /tables (owner/manager only).
  { href: "/orders", label: t.nav.orders, icon: "🔔", permission: "orders:read", group: "daily" },
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
  { href: "/expenses", label: "مصروفات التشغيل", icon: "💸", permission: "cost:read", group: "finance", key: "expenses.view" },
  { href: "/accounting", label: "الأرباح والخسائر والمحاسبة", icon: "📊", permission: "cost:read", group: "finance", key: "accounting.view" },
  { href: "/settings", label: "الإعدادات", icon: "⚙️", permission: "branches:manage", group: "admin" },
  { href: "/roles-permissions", label: "الأدوار والصلاحيات", icon: "🛡️", permission: "users:manage", group: "admin", key: "users.manage_permissions" },
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
  const cashierTouch = ["/pos", "/orders", "/sales", "/tracing", "/tables", "/current-shift", "/close-shift", "/receipts", "/handovers", "/stock-counts"].some(route => pathname === route || pathname.startsWith(route + "/"));
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [rail, setRail] = useState(false);
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

  const catalog=visibleReportCatalog({keys:keySet,features:features??{},role:user.role,branchId:user.branchId});
  const SIDEBAR_REPORT_IDS = new Set(["shift-sales", "product-sales"]);
  const reportNav:NavItem[]=catalog.filter(r => SIDEBAR_REPORT_IDS.has(r.id)).map(report=>({href:report.href,label:report.title,icon:'',permission:'reports:read',group:'reports',allKeys:report.keys,reportGroup:report.group,reportId:report.id}));
  const navItems = [...NAV,...reportNav].filter(
    (item) =>
      // An explicit `key` (new granular gate) wins; else fall back to the
      // legacy permission bridge.
      (!item.ownerOnly || user.role === "CAFE_OWNER") &&
      (item.allKeys ? item.allKeys.every(canKey) : item.anyKey ? item.anyKey.some(canKey) : item.key ? canKey(item.key) : can(item.permission)) &&
      (!item.feature || !features || item.feature(features))
  );

  // Sidebar sections. The server and the first client render show every
  // section open (no hydration mismatch); after mount the saved choice is
  // applied, and on a short screen with no saved choice the sections start
  // collapsed. The section that holds the current page is always open.
  const [collapsedGroups, setCollapsedGroups] = useState<NavGroupId[]>(NAV_GROUPS.map(group=>group.id));
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
      else setCollapsedGroups(NAV_GROUPS.map((g) => g.id));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const currentHref = currentWorkspaceHref(pathname, navItems.map(item => item.href));
  const activeGroup = navItems.find(item => item.href === currentHref)?.group;
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
    const active = currentHref === item.href && item.group === activeGroup;
    const ancestor = !active && pathname.startsWith(item.href + "/");
    const Icon = item.reportGroup
      ? REPORT_ICONS[item.reportId ?? ""] ?? REPORT_GROUP_ICONS[item.reportGroup] ?? FileChartColumn
      : NAV_ICONS[item.href.split("?")[0]] ?? BookOpen;
    if(item.group==="sales")return <Suspense key={item.href} fallback={<Link className="workspace-nav-link block rounded-lg px-3 py-2.5 text-sm" href={item.href}>{item.label}</Link>}><SalesNavLink item={item} close={()=>setMobileNavOpen(false)}/></Suspense>;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileNavOpen(false)}
        aria-current={active ? "page" : undefined}
        aria-label={item.label}
        title={item.label}
        className={cn(
          "workspace-nav-link flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring",
          ancestor && "border-s-2 border-sidebar-primary",
          active
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <span className="workspace-nav-label flex-1">{item.label}</span>
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
              <Coffee className="size-6" aria-hidden="true" />
            </span>
            <div className="workspace-nav-label min-w-0">
              <p className="font-heading text-base font-bold tracking-wider text-sidebar-accent-foreground" dir="ltr">NEXT CUP</p>
              <p className="truncate text-xs" title={cafe?.name}>{cafe?.name ?? t.appName}</p>
              {/^workspace\d{8}-/.test(cafe?.name ?? "") && <p className="mt-1 text-xs text-amber-200">بيانات اصطناعية · معاينة فقط</p>}
              <p className="truncate text-xs text-sidebar-muted-foreground">
                {branchName ?? t.appName}
              </p>
            </div>
          </div>

          <nav aria-label="التنقل الرئيسي" className="workspace-main-nav min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-3 [@media(max-height:760px)]:p-2">
            {navItems.filter((item) => !item.group).map(navLink)}
            {NAV_GROUPS.map((group) => {
              const items = navItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              const isCurrent = group.id === activeGroup;
              const open = rail || isCurrent || !collapsedGroups.includes(group.id);
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
                    className="workspace-nav-group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold text-sidebar-muted-foreground transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
                  >
                    <span className="flex-1 text-start">{group.label}</span>
                    {badge > 0 && (
                      <span className="flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white">
                        {badge}
                      </span>
                    )}
                    <ChevronDown aria-hidden="true" className={cn("size-3", !open && "rotate-90")} />
                  </button>
                  <div id={`nav-group-${group.id}`} hidden={!open} className="mt-1.5 space-y-1.5">
                    {items.filter(item=>!item.reportGroup).map(navLink)}
                    {group.id==='reports'&&REPORT_GROUPS.map(reportGroup=>{const children=items.filter(item=>item.reportGroup===reportGroup.id);if(!children.length)return null;const active=children.some(item=>item.href===currentHref);return <details key={reportGroup.id} open={active||undefined} className="ms-2 space-y-1.5 border-s border-sidebar-border ps-1"><summary className="workspace-report-group min-h-10 cursor-pointer rounded-lg px-3 py-2 text-sm font-medium">تقارير {reportGroup.title}</summary>{children.map(navLink)}</details>;})}
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
              <div className="workspace-nav-label min-w-0">
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
      <div className="app-workspace flex min-h-screen w-full flex-col bg-workspace md:flex-row" data-nav-rail={rail}>
        <aside className={cn("workspace-sidebar sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex print:hidden", rail ? "w-20" : "w-64")}>
          <button type="button" className="mx-3 mt-3 flex min-h-10 items-center justify-center gap-2 rounded-lg border border-sidebar-border text-sm hover:bg-sidebar-accent" aria-label={rail ? "توسيع التنقل" : "طي التنقل"} aria-expanded={!rail} onClick={()=>setRail(value=>!value)}>{rail ? <PanelRightOpen className="size-5"/> : <><PanelRightClose className="size-5"/><span>طي التنقل</span></>}</button>
          {sidebarContent}
        </aside>
        <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <div className="flex items-center gap-3 bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden print:hidden">
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

        <main key={`${user.id}:${user.cafeId}:${user.branchId}:${user.role}:${permKeys.join(",")}`} className="workspace-content min-w-0 flex-1 p-4 md:p-6 lg:p-8">
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

function SalesNavLink({item,close}:{item:NavItem;close:()=>void}){
 const pathname=usePathname(),search=useSearchParams();
 const active=currentWorkspaceHref(pathname+'?'+search.toString(),SALES_WORKSPACE_LINKS.map(l=>l.href))===item.href;
 return <Link href={item.href} onClick={close} aria-current={active?'page':undefined} className={cn('workspace-nav-link flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-2',active?'bg-sidebar-primary text-sidebar-primary-foreground':'text-sidebar-foreground hover:bg-sidebar-accent')}><ReceiptText className="size-5 shrink-0" aria-hidden="true"/><span className="workspace-nav-label">{item.label}</span></Link>;
}
