"use client";
// Workstations (Phase 9) — the station shell root: no sidebar, no dashboard chrome. W1 runs on the
// person's own ERP session (owner decision D3): no device pairing and no station PIN (W2). An
// unsigned visitor goes to the sign-in screen and comes back here; «تبديل الموظف» and «قفل» sign
// out; and a /station page signs itself out after 5 minutes without input (client-side idle lock,
// on top of the server session's own limits).
import "@/components/shell/direction-2.1.css";
import "@/components/d21/reference.css";
import "./station.css";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StationCtx, clearStationDrafts, loginUrl, type StationUser } from "./_ui/context";
import { LanguageProvider } from "@/lib/i18n/context";
import type { Lang } from "@/lib/i18n/translations";
import { STATION_IDLE_MS } from "@/lib/station/shared";

export default function StationLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StationUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) { window.location.replace(loginUrl()); return; }
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        // A temporary password or a forced MFA enrolment is finished in the ERP first.
        if (j.user?.passwordChangeRequired || j.user?.mfaEnrollmentRequired) { window.location.replace("/dashboard"); return; }
        setUser(j.user);
      })
      .catch(() => setFailed(true));
  }, []);

  const signOut = useCallback(async (reason?: string) => {
    clearStationDrafts();
    try { await fetch("/api/auth/me", { method: "DELETE" }); } catch { /* the cookie is cleared server-side when reachable */ }
    window.location.replace(loginUrl(reason));
  }, []);

  // Idle lock (D3): any key, pointer or touch resets the 5-minute timer.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!user) return;
    const arm = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { void signOut("station_idle"); }, STATION_IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { events.forEach((e) => window.removeEventListener(e, arm)); if (timer.current) clearTimeout(timer.current); };
  }, [user, signOut]);

  const lang: Lang = user?.preferredLanguage === "en" ? "en" : "ar";
  return (
    <div className="d21 ws" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} data-shell="station">
      {/* IBM Plex, self-hosted (public/fonts), as the Direction 2.1 shell loads it. */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      {user ? (
        <StationCtx value={{ user, signOut }}>
          <LanguageProvider lang={lang}>{children}</LanguageProvider>
        </StationCtx>
      ) : (
        <div className="ws-plain" role="status" aria-live="polite">
          {failed ? (lang === "ar" ? "تعذّر الاتصال بالنظام." : "Could not reach the system.") : (lang === "ar" ? "جارٍ التحميل…" : "Loading…")}
        </div>
      )}
    </div>
  );
}
