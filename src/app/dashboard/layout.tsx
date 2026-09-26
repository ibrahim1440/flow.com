"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Menu, ShieldAlert } from "lucide-react";
import { LanguageProvider, useI18n } from "@/lib/i18n/context";
import { routeAllowed, type Viewer } from "@/lib/nav/registry";
import { UserContext, type User } from "./user-context";
import { Nav } from "./_components/Nav";
import { Breadcrumbs } from "./_components/Breadcrumbs";
import { ContextualNav } from "./_components/ContextualNav";

function DashboardShell({
  user,
  logoBase64,
  children,
}: {
  user: User;
  logoBase64: string | null;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { lang, t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();

  const viewer: Viewer = { permissions: user.permissions, role: user.role };

  // Hiding a navigation entry keeps a screen out of the way; it does not keep anybody out
  // of it. Typing the address, following an old bookmark or using browser history all
  // reached the page, which then rendered its full chrome and an empty list — because the
  // APIs behind it were refusing every request. The data was never exposed and no write
  // was ever accepted, but the operator was shown a working-looking screen for work they
  // cannot do. The route is refused here, once, for every dashboard page.
  //
  // The rule is unchanged by the navigation restructuring: same module-level check, same
  // admin-only double guard on settings, now read from the registry instead of from a
  // flat array of nav items. See `routeAllowed` for why it stays at module level.
  const allowed = routeAllowed(viewer, pathname);

  async function handleLogout() {
    await fetch("/api/auth/me", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <div className="h-screen overflow-hidden flex bg-oo-bg-app">
      {drawerOpen && (
        <div
          className="fixed inset-x-0 top-0 h-[100dvh] bg-oo-text-primary/30 z-40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <Nav
        viewer={viewer}
        userName={user.name}
        logoBase64={logoBase64}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onLogout={handleLogout}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="bg-oo-bg-default border-b border-oo-border-default px-5 lg:px-7 py-3 flex items-center gap-4 shrink-0 z-30">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={lang === "ar" ? "فتح القائمة" : "Open menu"}
            aria-expanded={drawerOpen}
            aria-controls="primary-navigation"
            className="lg:hidden text-oo-text-secondary hover:text-oo-text-primary transition-colors"
          >
            <Menu size={20} />
          </button>

          <Breadcrumbs viewer={viewer} />

          <div className="flex-1" />

          <div className="text-[12px] text-oo-text-muted whitespace-nowrap hidden sm:block">
            {new Date().toLocaleDateString(lang === "ar" ? "ar-SA" : "en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </div>
        </header>

        <ContextualNav viewer={viewer} />

        <main className="flex-1 overflow-y-auto p-5 lg:p-7">
          {allowed ? (
            children
          ) : (
            <div className="max-w-md mx-auto mt-16 bg-oo-bg-default rounded-oo-large border border-oo-border-default p-8 text-center">
              <div className="w-12 h-12 rounded-oo-medium bg-oo-status-blocked-bg flex items-center justify-center mx-auto mb-4">
                <ShieldAlert size={22} className="text-oo-status-blocked" />
              </div>
              <h1 className="text-lg font-bold text-oo-text-primary">{t("accessDeniedTitle")}</h1>
              <p className="text-sm text-oo-text-secondary mt-1.5">{t("accessDeniedBody")}</p>
              <a
                href="/dashboard"
                className="inline-block mt-5 px-4 py-2 bg-oo-action-primary text-white rounded-oo-small text-sm font-semibold hover:bg-oo-action-primary-hover transition-colors"
              >
                {t("dashboard")}
              </a>
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
      <div className="min-h-screen flex items-center justify-center bg-oo-bg-app">
        <div className="text-center">
          <div className="w-10 h-10 border-[3px] border-oo-action-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-oo-text-secondary font-medium text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <UserContext value={{ user, logoBase64 }}>
      <LanguageProvider lang={user.preferredLanguage ?? "ar"}>
        <DashboardShell user={user} logoBase64={logoBase64}>{children}</DashboardShell>
      </LanguageProvider>
    </UserContext>
  );
}
