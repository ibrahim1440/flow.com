"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { LogOut, Menu, X, ShieldAlert, UserCircle } from "lucide-react";
import { ROLE_LABELS } from "@/lib/auth-shared";
import { routeAllowed, type Viewer } from "@/lib/nav/registry";
import { SidebarNav, ContextualNav, Breadcrumbs, useDrawerFocus } from "./_components/Nav";
import { LanguageProvider, useI18n } from "@/lib/i18n/context";
import { UserContext, useLogo, type User } from "./user-context";

/**
 * The menu now lives in one registry — see `@/lib/nav/registry`.
 *
 * What used to be here was a flat array of twenty-four leaves with no parent
 * relationships, rendered as one level of links. That is the whole reason the reference
 * design's contextual navigation was missing from the application: there was no structure
 * a second level could be derived from. Sidebar, contextual bar, breadcrumbs, active-page
 * resolution and the route guard below all read that registry now, so they cannot
 * disagree about what exists, what it is called, or who may see it.
 */

function DashboardShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { lang, t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const logoBase64 = useLogo();

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useDrawerFocus(sidebarOpen, menuButtonRef);

  // The drawer covers 260 of a 390px screen behind a backdrop, closes on Escape and moves
  // focus into itself — every signal says modal. It was not: the content behind it stayed
  // in the tab order, so Tab walked focus onto controls nobody could see. `inert` fixes
  // both halves at once, because the browser's own tab order is the containment.
  //
  // Only while the drawer is a drawer. Above lg the sidebar is permanent, so the flag is
  // cleared on the way up rather than inerting the whole application.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const close = () => { if (desktop.matches) setSidebarOpen(false); };
    close();
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);

  const viewer: Viewer = { permissions: user.permissions, role: user.role };

  // Hiding a navigation entry keeps a screen out of the way; it does not keep anybody out
  // of it. Typing the address, following an old bookmark or using browser history all
  // reached the page, which then rendered its full chrome and an empty list — because the
  // APIs behind it were refusing every request. The data was never exposed and no write
  // was ever accepted, but the operator was shown a working-looking screen for work they
  // cannot do. The route is refused here, once, for every dashboard page.
  //
  // Same rule as before the restructuring, read from the registry: the module is checked
  // here and sub-privileges are left to the page and its API, which refuse the work.
  const allowed = routeAllowed(viewer, pathname);

  // Escape closes the drawer, which is what every drawer does and what a keyboard user
  // will try first.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  async function handleLogout() {
    await fetch("/api/auth/me", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <div className="h-screen overflow-hidden flex bg-cream">
      {sidebarOpen && (
        <div
          className="fixed inset-x-0 top-0 h-[100dvh] bg-black/40 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        aria-label={lang === "ar" ? "القائمة الجانبية" : "Sidebar"}
        className={`fixed lg:static top-0 h-[100dvh] z-[50] w-[260px] bg-sidebar text-white transform transition-transform duration-300 ease-in-out flex flex-col ltr:left-0 rtl:right-0 overflow-y-auto ${
          sidebarOpen ? "translate-x-0" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"
        }`}
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-white/10 rounded-xl flex flex-col items-center justify-center shadow-lg flex-shrink-0 overflow-hidden">
              {logoBase64 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoBase64} alt="Logo" className="w-full h-full object-contain p-1" />
              ) : (
                <>
                  <span className="text-[22px] text-white/90 leading-none" style={{ fontFamily: "'Scheherazade New', 'Amiri', serif" }}>ح</span>
                  <span className="block w-4 h-[3px] rounded-full mt-0.5" style={{ backgroundColor: "#7C3AED" }} />
                </>
              )}
            </div>
            <div>
              <h2 className="font-extrabold text-sm tracking-widest text-white">HIQBAH</h2>
              <p className="text-[10px] text-white/50 font-light mt-0.5">مقهى و محمصة حقبة</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            onClick={() => setSidebarOpen(false)}
            aria-label={lang === "ar" ? "إغلاق القائمة" : "Close menu"}
            className="lg:hidden text-white/50 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

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

        <SidebarNav viewer={viewer} lang={lang} onNavigate={() => setSidebarOpen(false)} />

        <div className="px-3 py-3 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-[13px] font-medium text-sidebar-text hover:bg-red-500/15 hover:text-red-400 transition-all duration-200"
          >
            <LogOut size={18} strokeWidth={1.5} />
            {t("signOut")}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0" inert={sidebarOpen}>
        <header className="bg-white/80 backdrop-blur-md border-b border-border px-5 py-3.5 flex items-center gap-4 z-30 flex-shrink-0">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label={lang === "ar" ? "فتح القائمة" : "Open menu"}
            aria-expanded={sidebarOpen}
            className="lg:hidden text-charcoal hover:text-orange transition-colors relative z-[60]"
            style={{ cursor: "pointer" }}
          >
            <Menu size={22} />
          </button>
          {/* Where you are, so a deep link does not arrive without context. */}
          <div className="min-w-0 flex-1">
            <Breadcrumbs viewer={viewer} lang={lang} />
          </div>
          <div className="hidden sm:block text-sm text-brown font-medium flex-shrink-0">
            {/* Arabic locale, LATIN digits, Gregorian calendar — the same rule the Sales
                formatters follow. Plain "ar-SA" renders ٢٦ سبتمبر ٢٠٢٦, which is the one
                thing this interface is not allowed to do, and the Sales digit audit never
                caught it because the audit mounts page components and this is the shell. */}
            {new Date().toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </div>
        </header>

        {/* The pages of the section you are in. Renders nothing when there is only one. */}
        {allowed && <ContextualNav viewer={viewer} lang={lang} />}

        <main className="flex-1 overflow-y-auto p-5 lg:p-7">
          {allowed ? (
            children
          ) : (
            <div className="max-w-md mx-auto mt-16 bg-white rounded-2xl border border-border p-8 text-center">
              <div className="w-12 h-12 rounded-xl bg-oo-status-blocked-bg flex items-center justify-center mx-auto mb-4">
                <ShieldAlert size={22} className="text-oo-status-blocked" />
              </div>
              <h1 className="text-lg font-extrabold text-charcoal">{t("accessDeniedTitle")}</h1>
              <p className="text-sm text-brown mt-1.5">{t("accessDeniedBody")}</p>
              <Link
                href="/dashboard"
                className="inline-block mt-5 px-4 py-2 bg-orange text-white rounded-lg text-sm font-bold hover:bg-orange-dark transition-colors"
              >
                {t("dashboard")}
              </Link>
            </div>
          )}
        </main>
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
