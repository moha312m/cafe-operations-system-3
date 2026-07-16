"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/admin/dashboard", label: t.admin.nav.dashboard, icon: "▦" },
  { href: "/admin/cafes", label: t.admin.nav.cafes, icon: "☕" },
  { href: "/admin/reports", label: t.admin.nav.reports, icon: "📈" },
  { href: "/admin/users", label: t.admin.nav.users, icon: "👥" },
  { href: "/admin/subscriptions", label: t.admin.nav.subscriptions, icon: "💳" },
  { href: "/admin/payments", label: t.admin.nav.payments, icon: "💰" },
  { href: "/admin/audit", label: t.admin.nav.audit, icon: "🕓" },
  { href: "/admin/settings", label: t.admin.nav.settings, icon: "⚙️" },
];

export function AdminShell({
  userName,
  children,
}: {
  userName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen w-full bg-slate-100">
      {/* Dark premium sidebar */}
      <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-300">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">
            ☕
          </span>
          <div className="min-w-0">
            <p className="truncate font-heading text-sm font-bold text-white">
              {t.admin.brand}
            </p>
            <p className="truncate text-xs text-slate-400">{t.admin.brandSub}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-indigo-600 text-white shadow-sm"
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
            <span className="flex size-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
              {userName.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{userName}</p>
              <p className="truncate text-xs text-slate-400">{t.roles.SUPER_ADMIN}</p>
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

      <main className="min-w-0 flex-1 overflow-x-hidden p-8">{children}</main>
    </div>
  );
}
