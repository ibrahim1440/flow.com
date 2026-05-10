"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  LayoutDashboard, Package, ShoppingCart, Factory, ClipboardCheck, Box,
  Truck, History, TrendingUp, Tag, Users, LogOut, Menu, X, ChevronRight,
  Settings, UserCircle, FlaskConical,
} from "lucide-react";
import { ROLE_LABELS, hasModuleAccess, type Permissions } from "@/lib/auth";
import { LanguageProvider, useI18n } from "@/lib/i18n/context";
import type { Lang, TranslationKey } from "@/lib/i18n/translations";

type User = { id: string; name: string; role: string; permissions: Permissions; preferredLanguage: Lang };
type AppCtx = { user: User; logoBase64: string | null };
const UserContext = createContext<AppCtx | null>(null);
export const useUser = () => useContext(UserContext)?.user ?? null;
export const useLogo = () => useContext(UserContext)?.logoBase64 ?? null;

const NAV_ITEMS: { key: TranslationKey; icon: React.ElementType; href: string }[] = [
  { key: "dashboard",  icon: LayoutDashboard, href: "/dashboard" },
  { key: "inventory",  icon: Package,         href: "/dashboard/inventory" },
  { key: "orders",     icon: ShoppingCart,    href: "/dashboard/orders" },
  { key: "production", icon: Factory,         href: "/dashboard/production" },
  { key: "qc",         icon: ClipboardCheck,  href: "/dashboard/qc" },
  { key: "packaging",  icon: Box,             href: "/dashboard/packaging" },
  { key: "dispatch",   icon: Truck,           href: "/dashboard/dispatch" },
  { key: "history",    icon: History,         href: "/dashboard/history" },
  { key: "analytics",  icon: TrendingUp,      href: "/dashboard/analytics" },
  { key: "labels",     icon: Tag,             href: "/dashboard/labels" },
  { key: "employees",  icon: Users,           href: "/dashboard/employees" },
  { key: "cupping",    icon: FlaskConical,    href: "/dashboard/cupping" },
  { key: "settings",   icon: Settings,        href: "/dashboard/settings" },
];

function SidebarNav({
  user,
  sidebarOpen,
  setSidebarOpen,
  onLogout,
}: {
  user: User;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const router = useRouter();
  const logoBase64 = useLogo();

  const filteredNav = NAV_ITEMS.filter((item) => {
    // Settings is strictly admin-only — double-guard beyond permissions
    if (item.key === "settings" && user.role !== "admin") return false;
    return hasModuleAccess(user.permissions, item.key as string);
  });

  return (
    <aside
      className={`fixed lg:static top-0 h-[100dvh] lg:h-auto z-[50] w-[260px] bg-sidebar text-white transform transition-transform duration-300 ease-in-out flex flex-col ltr:left-0 rtl:right-0 overflow-y-auto ${
        sidebarOpen ? "translate-x-0" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"
      }`}
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      {/* Logo */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          {/* Logo */}
          <div className="w-11 h-11 bg-white/10 rounded-xl flex flex-col items-center justify-center shadow-lg flex-shrink-0 overflow-hidden">
            {logoBase64 ? (
              <img src={logoBase64} alt="Logo" className="w-full h-full object-contain p-1" />
            ) : (
              <>
                <span className="text-[22px] text-white/90 leading-none" style={{ fontFamily: "'Scheherazade New', 'Amiri', serif" }}>ح</span>
                <span className="block w-4 h-[3px] rounded-full mt-0.5" style={{ backgroundColor: "#E25D2F" }} />
              </>
            )}
          </div>
          <div>
            <h2 className="font-extrabold text-sm tracking-widest text-white">HIQBAH</h2>
            <p className="text-[10px] text-white/50 font-light mt-0.5">مقهى و محمصة حقبة</p>
          </div>
        </div>
        <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-white/50 hover:text-white">
          <X size={20} />
        </button>
      </div>

      {/* User card — click to go to profile */}
      <div className="px-5 py-4 border-b border-white/10">
        <button
          onClick={() => { router.push("/dashboard/profile"); setSidebarOpen(false); }}
          className="flex items-center gap-3 w-full text-start hover:opacity-80 transition-opacity"
        >
          <div className="w-9 h-9 rounded-full bg-orange/20 flex items-center justify-center flex-shrink-0">
            <span className="text-orange text-sm font-bold">{user.name.charAt(0)}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{user.name}</p>
            <p className="text-[11px] text-orange">{ROLE_LABELS[user.role] || user.role}</p>
          </div>
          <UserCircle size={16} className="text-white/30 flex-shrink-0" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {filteredNav.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <a
              key={item.key}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-200 ${
                isActive
                  ? "bg-orange text-white shadow-md shadow-orange/25"
                  : "text-sidebar-text hover:bg-sidebar-hover hover:text-white"
              }`}
            >
              <item.icon size={18} strokeWidth={isActive ? 2.5 : 1.5} />
              {t(item.key)}
              {isActive && (
                <ChevronRight
                  size={14}
                  className="ltr:ml-auto rtl:mr-auto opacity-70 rtl:rotate-180"
                />
              )}
            </a>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="px-3 py-3 border-t border-white/10">
        <button
          onClick={onLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-[13px] font-medium text-sidebar-text hover:bg-red-500/15 hover:text-red-400 transition-all duration-200"
        >
          <LogOut size={18} strokeWidth={1.5} />
          {t("signOut")}
        </button>
      </div>
    </aside>
  );
}

function DashboardShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { lang } = useI18n();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/me", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <div className="min-h-screen flex bg-cream">
      {sidebarOpen && (
        <div
          className="fixed inset-x-0 top-0 h-[100dvh] bg-black/40 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <SidebarNav
        user={user}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onLogout={handleLogout}
      />

      <div className="flex-1 flex flex-col min-h-screen">
        <header className="bg-white/80 backdrop-blur-md border-b border-border px-5 py-3.5 flex items-center gap-4 sticky top-0 z-30">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden text-charcoal hover:text-orange transition-colors relative z-[60]"
            style={{ cursor: "pointer" }}
          >
            <Menu size={22} />
          </button>
          <div className="flex-1" />
          <div className="text-sm text-brown font-medium">
            {new Date().toLocaleDateString(lang === "ar" ? "ar-SA" : "en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </div>
        </header>

        <main className="flex-1 p-5 lg:p-7 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [logoBase64, setLogoBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    Promise.all([
      fetch("/api/auth/me").then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
      fetch("/api/settings/logo").then((r) => r.json()).catch(() => ({ logoBase64: null })),
    ])
      .then(([meData, logoData]) => {
        setUser(meData.user);
        setLogoBase64(logoData.logoBase64 ?? null);
      })
      .catch(() => router.push("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-charcoal font-semibold text-lg">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <UserContext value={{ user, logoBase64 }}>
      <LanguageProvider lang={user.preferredLanguage ?? "ar"}>
        <DashboardShell user={user}>{children}</DashboardShell>
      </LanguageProvider>
    </UserContext>
  );
}
