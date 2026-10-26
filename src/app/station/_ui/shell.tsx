"use client";
// Workstations (Phase 9) — the station shell: no sidebar, no dashboard chrome. Two ways in:
//
//  · A PAIRED STATION DEVICE (W2): the device cookie names a registered device of one station.
//    S2 tiles → S3 station PIN → a STATION session bound to the device; «قفل» → S4; «تبديل الموظف»
//    → S5 (the handover of an active task); the idle lock (policy, D7: 5 min) ends the session and
//    returns to the tiles; a revoked device shows DS-15. The ERP's own session is never used here.
//  · ANY OTHER BROWSER (W1, unchanged): the person's own ERP session. An unsigned visitor goes to
//    the sign-in screen and comes back; «تبديل الموظف» and «قفل» sign out; 5 minutes without input
//    sign out. /station itself shows S1 so a tablet can be activated, with the personal sign-in.
import "@/components/shell/direction-2.1.css";
import "@/components/d21/reference.css";
import "../station.css";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StationCtx, clearStationDrafts, loginUrl, type StationInfo, type StationUser } from "./context";
import { LanguageProvider } from "@/lib/i18n/context";
import { useLanguageSwitcher } from "@/lib/i18n/use-language-switcher";
import { applyDocumentLang } from "@/lib/i18n/language-switch";
import type { Lang } from "@/lib/i18n/translations";
import { STATION_IDLE_MS } from "@/lib/station/shared";
import { st } from "@/lib/i18n/station";
import { ActivationScreen, DeviceBar, NoScreen, PinScreen, RevokedScreen, SwitchScreen, TilesScreen, UnauthScreen, clock, type HandoverTask, type RosterEntry } from "./device";
import { StationBar } from "./blocks";

type DeviceEmployee = { id: string; name: string; initials: string; supervisor: boolean; preferredLanguage: Lang };
type DeviceAnswer =
  | { device: null }
  | { device: { state: "unknown" | "revoked"; name?: string } }
  | { device: { state: "active"; id: string; name: string }; station: StationInfo; stations?: StationInfo[]; policy: { idleMinutes: number }; session: { employee: DeviceEmployee } | null };
type Gate =
  | { v: "tiles"; notice?: { tone: "info" | "err" | "warn"; text: string } | null }
  | { v: "pin"; emp: { id: string; name: string; initials: string } }
  | { v: "lock"; emp: { id: string; name: string; initials: string }; at: string; tasks: number }
  | { v: "unauth"; title: string; body: string };
type Phase =
  | { p: "loading" } | { p: "failed" } | { p: "s1" } | { p: "revoked" } | { p: "personal"; user: StationUser }
  | { p: "gate"; station: StationInfo; stations: StationInfo[]; idleMinutes: number; gate: Gate }
  | { p: "in"; station: StationInfo; stations: StationInfo[]; idleMinutes: number; emp: DeviceEmployee; switching: boolean };

/** W3: the station chosen on a device that serves several (kept per browser tab; never a credential). */
const CHOSEN_KEY = "hq.device.station";
function chosenStation(all: StationInfo[], fallback: StationInfo): StationInfo {
  try {
    const id = sessionStorage.getItem(CHOSEN_KEY);
    return all.find((x) => x.id === id) ?? fallback;
  } catch { return fallback; }
}

const noSubscribe = () => () => {};

export function StationShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/station";
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ p: "loading" });
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  // Before anybody is signed in here (S1, a revoked or failed device, the PIN pad), the screen reads in
  // the language the page was served in (the root layout: the browser's signed-in account, else the
  // sign-in screen's last choice), not always Arabic. Read after mount: the server render stays Arabic.
  const pageLang = useSyncExternalStore(noSubscribe, () => (document.documentElement.lang === "en" ? "en" : "ar") as Lang, () => "ar" as Lang);
  const lang: Lang = phase.p === "personal" ? (phase.user.preferredLanguage === "en" ? "en" : "ar") : phase.p === "in" ? phase.emp.preferredLanguage : pageLang;
  const t = useCallback((k: Parameters<typeof st>[0], v?: Record<string, string | number>) => st(k, lang, v), [lang]);
  // The quick language switch, for a PERSONAL session only (W1: the person's own ERP session at
  // a browser — their profile language, saved as in the ERP). A shared device (W2) follows each
  // signed-in employee's saved language and never offers it: the PIN flows are untouched.
  const setPersonalLang = useCallback((l: Lang) => setPhase((p) => (p.p === "personal" ? { ...p, user: { ...p.user, preferredLanguage: l } } : p)), []);
  const switcher = useLanguageSwitcher(lang, setPersonalLang);
  // <html lang/dir> follow the session's language (a client navigation from the sign-in screen
  // keeps the root layout's <html> as that screen left it). Only once a session is known.
  const known = phase.p === "personal" || phase.p === "in";
  useEffect(() => { if (known) applyDocumentLang(lang); }, [known, lang]);

  // ── What this browser is: a paired device (W2) or a personal session (W1) ───────────────────
  const personal = useCallback(async () => {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    if (r.status === 401) { window.location.replace(loginUrl()); return; }
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    // A temporary password or a forced MFA enrolment is finished in the ERP first.
    if (j.user?.passwordChangeRequired || j.user?.mfaEnrollmentRequired) { window.location.replace("/dashboard"); return; }
    setPhase({ p: "personal", user: j.user });
  }, []);

  const refresh = useCallback(async (gate?: Gate) => {
    try {
      const r = await fetch("/api/station/device", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as DeviceAnswer;
      if (!j.device) {
        if (pathname === "/station") setPhase({ p: "s1" });
        else await personal();
        return;
      }
      if (j.device.state === "revoked") { clearStationDrafts(); setPhase({ p: "revoked" }); return; }
      if (j.device.state === "unknown") { setPhase({ p: "s1" }); return; }
      const a = j as Extract<DeviceAnswer, { station: StationInfo }>;
      const stations = a.stations?.length ? a.stations : [a.station];
      if (a.session) {
        setPhase({ p: "in", station: a.station, stations, idleMinutes: a.policy.idleMinutes, emp: a.session.employee, switching: false });
        if ((pathname === "/station" || !pathname.startsWith(a.station.home ?? "/station/__none")) && a.station.home) router.replace(a.station.home);
        return;
      }
      clearStationDrafts();
      setRoster(null);
      const chosen = chosenStation(stations, a.station);
      setPhase({ p: "gate", station: chosen, stations, idleMinutes: a.policy.idleMinutes, gate: gate ?? { v: "tiles" } });
      const rr = await fetch(`/api/station/roster?stationId=${encodeURIComponent(chosen.id)}`, { cache: "no-store" });
      if (rr.ok) setRoster(((await rr.json()) as { employees: RosterEntry[] }).employees);
      else setRoster([]);
    } catch {
      setPhase({ p: "failed" });
    }
  }, [pathname, personal, router]);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- the device is an external system read once on mount
  useEffect(() => { void refresh(); }, []);

  // ── Ending a session ─────────────────────────────────────────────────────────────────────────
  const endDevice = useCallback(async (url: string, body: unknown): Promise<{ ended?: boolean; at?: string; activeTasks?: number; employee?: { id: string; name: string; initials: string } } | null> => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }, []);

  const signOut = useCallback(async (reason?: string) => {
    clearStationDrafts();
    if (phase.p === "personal") {
      try { await fetch("/api/auth/me", { method: "DELETE" }); } catch { /* the cookie is cleared server-side when reachable */ }
      window.location.replace(loginUrl(reason));
      return;
    }
    // Device: a 401 from a station API (the session ended: idle, revoked, replaced) — back to the
    // tiles, or DS-15 when the device itself was revoked.
    if (reason !== "ended") await endDevice("/api/station/sign-out", { mode: "sign_out", claims: "keep" });
    await refresh({ v: "tiles", notice: { tone: "info", text: t("sessionEnded") } });
  }, [phase.p, endDevice, refresh, t]);

  const lock = useCallback(async () => {
    if (phase.p === "personal") return signOut();
    if (phase.p !== "in") return;
    const emp = phase.emp;
    clearStationDrafts();
    const out = await endDevice("/api/station/lock", {});
    await refresh({ v: "lock", emp: { id: emp.id, name: emp.name, initials: emp.initials }, at: clock(out?.at ?? Date.now()), tasks: out?.activeTasks ?? 0 });
  }, [phase, signOut, endDevice, refresh]);

  const [task, setTask] = useState<HandoverTask | undefined>(undefined);
  const switchEmployee = useCallback(() => {
    if (phase.p === "personal") { void signOut(); return; }
    if (phase.p !== "in") return;
    setTask(undefined);
    setPhase({ ...phase, switching: true });
    // The outgoing employee's active task (S5), read from the station queue (a read, not activity).
    // W4: on a packaging station it is the order being prepared (the preparation tab's claim).
    if (phase.station.type === "QUALITY") { setTask(null); return; } // the QC station holds no claims
    if (phase.station.type === "PACKAGING") {
      void fetch("/api/station/prep/queue", { cache: "no-store", headers: { "x-station-poll": "1" } })
        .then(async (r) => {
          if (!r.ok) { setTask(null); return; }
          const m = (await r.json()).mine;
          setTask(m ? { title: lang === "ar" ? `تجهيز الطلب #${m.orderNumber}` : `Preparing order #${m.orderNumber}`, ref: null, startedAt: m.claimedAt } : null);
        })
        .catch(() => setTask(null));
      return;
    }
    void fetch("/api/station/roasting/queue", { cache: "no-store", headers: { "x-station-poll": "1" } })
      .then(async (r) => {
        if (!r.ok) { setTask(null); return; }
        const q = await r.json();
        const m = q.mine;
        if (!m) { setTask(null); return; }
        const name = m.item ? (lang === "ar" ? m.item.nameAr || m.item.nameEn : m.item.nameEn) : "";
        setTask({ title: name, ref: m.item?.productionNumber ?? null, startedAt: m.claimedAt });
      })
      .catch(() => setTask(null));
  }, [phase, signOut, lang]);

  const confirmSwitch = useCallback(async (claims: "keep" | "release") => {
    clearStationDrafts();
    await endDevice("/api/station/sign-out", { mode: "switch", claims });
    await refresh({ v: "tiles" });
  }, [endDevice, refresh]);

  // ── Idle lock (D7) ─────────────────────────────────────────────────────────────────────────
  // Any key, pointer or touch resets the timer. Personal: sign out after 5 minutes (W1). Device:
  // the station session ends after the policy's minutes and the tiles come back (S2); a PIN screen
  // left half-typed returns to the tiles after the same time.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleMs = phase.p === "personal" ? STATION_IDLE_MS : phase.p === "in" || phase.p === "gate" ? phase.idleMinutes * 60_000 : 0;
  const idleKey = phase.p === "in" ? `in:${phase.emp.id}` : phase.p === "gate" ? `gate:${phase.gate.v}` : phase.p;
  useEffect(() => {
    if (!idleMs || (phase.p === "gate" && phase.gate.v === "tiles")) return;
    const fire = async () => {
      if (phase.p === "personal") { void signOut("station_idle"); return; }
      if (phase.p === "in") {
        clearStationDrafts();
        await endDevice("/api/station/lock", { idle: true });
        await refresh({ v: "tiles", notice: { tone: "info", text: st("idleEnded", lang, { n: phase.idleMinutes }) } });
        return;
      }
      void refresh({ v: "tiles" });
    };
    const arm = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void fire(); }, idleMs); };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { events.forEach((e) => window.removeEventListener(e, arm)); if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed per screen (idleKey), not per render
  }, [idleKey, idleMs]);

  // ── Render ─────────────────────────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (phase.p === "loading" || phase.p === "failed") {
    body = (
      <div className="ws-plain" role="status" aria-live="polite">
        {phase.p === "failed" ? (lang === "ar" ? "تعذّر الاتصال بالنظام." : "Could not reach the system.") : (lang === "ar" ? "جارٍ التحميل…" : "Loading…")}
      </div>
    );
  } else if (phase.p === "s1") {
    body = <ActivationScreen lang={lang} personalHref={loginUrl(undefined, "/station/roasting")} onActivated={() => void refresh()} />;
  } else if (phase.p === "revoked") {
    body = <RevokedScreen lang={lang} onAgain={() => setPhase({ p: "s1" })} />;
  } else if (phase.p === "gate") {
    const g = phase.gate;
    const toTiles = () => void refresh({ v: "tiles" });
    const refused = (r: { code: string; text: string; name?: string }) => {
      if (r.code === "STATION_NOT_ASSIGNED") setPhase({ ...phase, gate: { v: "unauth", title: st("unauthTitle", lang, { name: r.name ?? "" }), body: st("s7Body", lang, { station: phase.station.name }) } });
      else if (r.code === "STATION_DEVICE_REVOKED" || r.code === "STATION_DEVICE_REQUIRED") void refresh();
      else void refresh({ v: "tiles", notice: { tone: "err", text: r.text } });
    };
    const signedIn = () => void refresh();
    body = g.v === "tiles" ? (
      <TilesScreen lang={lang} station={phase.station} roster={roster} notice={g.notice} stations={phase.stations}
        onStation={(st) => { try { sessionStorage.setItem(CHOSEN_KEY, st.id); } catch { /* storage unavailable */ } void refresh({ v: "tiles" }); }}
        onPick={(e) => e.locked ? setPhase({ ...phase, gate: { v: "tiles", notice: { tone: "err", text: st("pinLocked", lang) } } }) : setPhase({ ...phase, gate: { v: "pin", emp: e } })} />
    ) : g.v === "pin" ? (
      <PinScreen key={`pin-${g.emp.id}`} lang={lang} station={phase.station} emp={g.emp} onBack={toTiles} onSignedIn={signedIn} onRefused={refused} />
    ) : g.v === "lock" ? (
      <PinScreen key={`lock-${g.emp.id}`} lang={lang} station={phase.station} emp={g.emp} locked={{ at: g.at, tasks: g.tasks }} onBack={toTiles} onSignedIn={signedIn} onRefused={refused} />
    ) : (
      <UnauthScreen lang={lang} station={phase.station} title={g.title} body={g.body} onBack={toTiles} />
    );
  } else {
    const user: StationUser = phase.p === "personal" ? phase.user : { id: phase.emp.id, name: phase.emp.name, role: "station", permissions: {}, preferredLanguage: phase.emp.preferredLanguage };
    const station = phase.p === "in" ? phase.station : null;
    if (phase.p === "in" && phase.switching) {
      const bar = (
        <StationBar station={phase.station.name} location={[phase.station.roaster?.name, phase.station.place].filter(Boolean).join(" · ") || undefined}
          conn={{ tone: "ok", label: t("connected") }} updated={clock()} updatedWord={t("lastUpdate")}
          emp={{ name: phase.emp.name, tag: t("stationSession") }} lockLabel={t("lock")} switchLabel={t("switchEmployee")} onLock={() => void lock()} onSwitch={() => undefined} />
      );
      body = <SwitchScreen lang={lang} bar={bar} name={phase.emp.name} task={task} onConfirm={confirmSwitch} onBack={() => setPhase({ ...phase, switching: false })} />;
    } else if (phase.p === "in" && !pathname.startsWith(phase.station.home ?? "/station/__none")) {
      body = phase.station.home ? <div className="ws-plain" role="status">{t("loading")}</div> : <NoScreen lang={lang} station={phase.station} bar={<DeviceBar lang={lang} station={phase.station} />} />;
    } else {
      body = (
        <StationCtx value={{ user, mode: phase.p === "in" ? "device" : "personal", station, signOut, lock, switchEmployee, stations: phase.p === "in" ? phase.stations : undefined }}>
          <LanguageProvider lang={lang} switcher={phase.p === "personal" ? switcher : undefined}>{children}</LanguageProvider>
        </StationCtx>
      );
    }
  }

  return (
    <div className="d21 ws" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} data-shell="station" data-station-mode={phase.p}>
      {/* IBM Plex, self-hosted (public/fonts), as the Direction 2.1 shell loads it. */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      {body}
    </div>
  );
}
