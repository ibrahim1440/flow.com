"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { routeAllowed, type Viewer } from "@/lib/nav/registry";
import { LanguageProvider, useI18n } from "@/lib/i18n/context";
import { UserContext, type User } from "./user-context";
import { AppShell } from "@/components/shell/AppShell";
import { StepUpProvider } from "@/components/auth/StepUp";
import { ShellLoading, MfaRequiredScreen, PasswordChangeRequiredScreen } from "@/components/shell/ShellStates";
import { SESSION_EXPIRED_LOGIN } from "@/lib/session-expired";
import { DesktopRecommendedNotice } from "@/components/shell/DesktopRecommendedNotice";

/**
 * The menu lives in one registry — see `@/lib/nav/registry`. Sidebar, rail, tab bar,
 * breadcrumbs, active-page resolution and the route guard below all read it, so they cannot
 * disagree about what exists, what it is called, or who may see it.
 *
 * Every dashboard route renders in the Direction 2.1 shell (`@/components/shell/AppShell`):
 * the legacy navy shell and its route switch were retired once the last module moved
 * (docs/shell/MIGRATION-PLAN.md, phase 6).
 */

function DashboardShell({ user, children }: { user: User; children: React.ReactNode }) {
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
  // Same rule as before the restructuring, read from the registry: the module is checked
  // here and sub-privileges are left to the page and its API, which refuse the work.
  const allowed = routeAllowed(viewer, pathname);

  async function handleLogout() {
    await fetch("/api/auth/me", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <AppShell
      user={user}
      viewer={viewer}
      lang={lang}
      allowed={allowed}
      onLogout={handleLogout}
      deniedTitle={t("accessDeniedTitle")}
      deniedBody={t("accessDeniedBody")}
      homeLabel={t("dashboard")}
    >
      <DesktopRecommendedNotice lang={lang} />
      {children}
    </AppShell>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    // The uploaded Settings logo is no longer fetched here: the UI chrome shows the brand mark.
    fetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 401 && (await r.json().catch(() => null))?.code === "SESSION_ENDED" ? "ended" : "failed");
        return r.json();
      })
      .then((meData) => {
        setUser(meData.user);
      })
      // A cookie that no longer names a live session (idle 4 h, absolute 12 h, logout,
      // revocation — SESSION_ENDED): the sign-in screen says so in both languages. No cookie
      // at all: the plain sign-in screen.
      .catch((e: Error) => { if (e.message === "ended") window.location.replace(SESSION_EXPIRED_LOGIN); else router.push("/login"); })
      .finally(() => setLoading(false));
  }, [router]);

  // The session check every route shows first, drawn in Direction 2.1 (UI batch 2).
  if (loading) return <ShellLoading />;

  if (!user) return null;

  return (
    <UserContext value={{ user }}>
      <LanguageProvider lang={user.preferredLanguage ?? "ar"}>
        <StepUpProvider lang={user.preferredLanguage === "en" ? "en" : "ar"} privileged={!!user.privileged}>
          {user.mfaEnrollmentRequired ? (
            // AUTH_MFA_MODE=required: a privileged account without two-step verification may only enroll.
            <MfaRequiredScreen lang={user.preferredLanguage === "en" ? "en" : "ar"} />
          ) : user.passwordChangeRequired ? (
            // A temporary password from the administrator (UR-03e / UR-04): set one's own first.
            <PasswordChangeRequiredScreen lang={user.preferredLanguage === "en" ? "en" : "ar"} />
          ) : (
            <DashboardShell user={user}>{children}</DashboardShell>
          )}
        </StepUpProvider>
      </LanguageProvider>
    </UserContext>
  );
}
