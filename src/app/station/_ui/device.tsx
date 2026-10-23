"use client";
// Workstations W2 — the screens of a shared station device before (and between) the work: S1
// activation, S2 employee tiles, S3 station PIN, S4 locked, S5 switch with the task handover, S7 not
// assigned, DS-15 revoked (Figma page 630:2: 646:425, 646:319 / 655:956 / 659:1221, 646:363 /
// 656:738 / 660:981, 646:460, 647:206, 647:465). The server decides everything; these screens send
// the person's choice and show the server's answer. No PIN, code or token is ever stored here (the
// device code shown on S1 is not a secret: it only pairs the activation code with this browser).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { st, type StationKey } from "@/lib/i18n/station";
import { localizeApiError } from "@/lib/i18n/api-errors";
import type { Lang } from "@/lib/i18n/translations";
import { CODE_ALPHABET } from "@/lib/station/codes";
import { StationBar, Sheet, Primary, Secondary, Note, Info, Keypad, Option, Bid, CheckIco } from "./blocks";
import type { StationInfo } from "./context";

const TZ = "Asia/Riyadh";
export const clock = (d: Date | string | number = Date.now()) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function useT(lang: Lang) {
  const t = useCallback((k: StationKey, vars?: Record<string, string | number>) => st(k, lang, vars), [lang]);
  return t;
}

/** The bar of the device screens: station, «roaster · place», connection and the clock (S1–S4). */
export function DeviceBar({ lang, station, extra }: { lang: Lang; station: StationInfo | null; extra?: ReactNode }) {
  const t = useT(lang);
  const [now, setNow] = useState(() => clock());
  useEffect(() => { const id = setInterval(() => setNow(clock()), 15000); return () => clearInterval(id); }, []);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  const location = station ? [station.roaster?.name, station.place].filter(Boolean).join(" · ") : undefined;
  return (
    <StationBar station={station?.name ?? t("deviceNew")} location={location || undefined} extra={extra}
      conn={online ? { tone: "ok", label: t("connected") } : { tone: "er", label: t("offline") }} updated={now} updatedWord="" />
  );
}

// ── S1 · activation ───────────────────────────────────────────────────────────────────────────
const DEVICE_CODE_KEY = "hq.device.code";
function randomCode(n: number) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}
/** The code this browser shows until it is activated (kept per browser; a new one if storage is gone). */
function deviceCode(): string {
  try {
    const v = localStorage.getItem(DEVICE_CODE_KEY);
    if (v && /^WS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(v)) return v;
    const c = `WS-${randomCode(4)}`;
    localStorage.setItem(DEVICE_CODE_KEY, c);
    return c;
  } catch { return `WS-${randomCode(4)}`; }
}

export function ActivationScreen({ lang, onActivated, personalHref }: { lang: Lang; onActivated: () => void; personalHref: string }) {
  const t = useT(lang);
  const [code] = useState(() => (typeof window === "undefined" ? "WS-····" : deviceCode()));
  const [act, setAct] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ready = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(act);
  async function go() {
    if (!ready || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/station/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: code, activationCode: act }) });
      if (r.ok) { try { localStorage.removeItem(DEVICE_CODE_KEY); } catch { /* */ } onActivated(); return; }
      const j = await r.json().catch(() => ({}));
      setErr(localizeApiError(j, lang) ?? t("s1Refused"));
    } catch { setErr(t("offline")); } finally { setBusy(false); }
  }
  return (
    <>
      <DeviceBar lang={lang} station={null} />
      <Sheet plain testId="station-s1" foot={<><Primary onClick={go} disabled={!ready} wait={busy} testId="station-activate">{t("s1Primary")}</Primary><Note>{t("s1Note")}</Note></>}>
        <div className="ws-center">
          <div>
            <h1 className="ws-t2">{t("s1Title")}</h1>
            <p className="ws-lead">{t("s1Sub")}</p>
          </div>
          <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
            <div className="lbl">{t("s1CodeLabel")}</div>
            <div className="ws-devcode" data-testid="station-device-code">{code}</div>
            <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{t("s1CodeHint")}</div>
          </div>
          <div style={{ display: "grid", gap: 8, width: "min(420px, 100%)" }}>
            <label className="ws-field-t" htmlFor="ws-act">{t("s1ActLabel")}</label>
            <div className={`ws-actfield${err ? " bad" : ""}`}>
              <input id="ws-act" data-testid="station-activation-code" value={act} maxLength={6} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} inputMode="text" dir="ltr"
                placeholder="······" aria-invalid={!!err || undefined}
                onChange={(e) => setAct(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6))} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
            </div>
            {err ? <div className="ws-pinerr" role="alert" data-testid="station-activation-error">{err}</div> : <div className="ws-small">{t("s1ActHint")}</div>}
          </div>
          <a className="ws-link" href={personalHref} data-testid="station-personal">{t("s1Personal")}</a>
        </div>
      </Sheet>
    </>
  );
}

// ── DS-15 · revoked ───────────────────────────────────────────────────────────────────────────
export function RevokedScreen({ lang, onAgain }: { lang: Lang; onAgain: () => void }) {
  const t = useT(lang);
  return (
    <>
      <DeviceBar lang={lang} station={null} />
      <Sheet plain testId="station-revoked" foot={<><Primary onClick={onAgain} testId="station-register-again">{t("ds15Btn")}</Primary><Note>{t("s1Note")}</Note></>}>
        <div className="ws-center" style={{ gap: 20, maxWidth: 640 }}>
          <span className="ws-errmark" aria-hidden="true">!</span>
          <h1 className="ws-t2" style={{ fontSize: 28, lineHeight: "38px" }}>{t("ds15Title")}</h1>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 15, lineHeight: "24px" }}>{t("ds15Body")}</p>
        </div>
      </Sheet>
    </>
  );
}

// ── S2 · the tiles ────────────────────────────────────────────────────────────────────────────
export type RosterEntry = { id: string; name: string; initials: string; supervisor: boolean; locked: boolean };
const TYPE_WORD: Record<string, { ar: string; en: string }> = { ROASTING: { ar: "التحميص", en: "Roasting" }, QUALITY: { ar: "الجودة", en: "Quality" }, PACKAGING: { ar: "التعبئة والتجهيز", en: "Packaging" } };
export const typeWord = (type: string, lang: Lang) => (TYPE_WORD[type] ? TYPE_WORD[type][lang] : type);

export function TilesScreen({ lang, station, roster, notice, onPick, stations, onStation }: { lang: Lang; station: StationInfo; roster: RosterEntry[] | null; notice?: { tone: "info" | "err" | "warn"; text: string } | null; onPick: (e: RosterEntry) => void; stations?: StationInfo[]; onStation?: (s: StationInfo) => void }) {
  const t = useT(lang);
  return (
    <>
      <DeviceBar lang={lang} station={station} />
      <Sheet plain testId="station-s2">
        <div className="ws-center">
          {stations && stations.length > 1 && onStation ? (
            // W3: one device, several stations — the station is chosen BEFORE the employee.
            <div className="ws-stchoice" role="group" aria-label={lang === "ar" ? "اختر المحطة" : "Choose the station"} data-testid="station-choice">
              <div className="lbl">{lang === "ar" ? "المحطة على هذا الجهاز" : "Station on this device"}</div>
              <div className="ws-chips">
                {stations.map((s) => (
                  <button key={s.id} type="button" className="ws-choice" aria-pressed={s.id === station.id} onClick={() => onStation(s)} data-testid={`station-choice-${s.type}`}>
                    {s.id === station.id ? <CheckIco size="s" /> : null}{s.name} · {typeWord(s.type, lang)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <h1 className="ws-t2" data-testid="station-title">{t("s2Title")}</h1>
            <p className="ws-lead">{t("s2Sub")}</p>
          </div>
          {notice ? <Info tone={notice.tone} title={notice.text} testId="station-notice" /> : null}
          {roster === null ? <div role="status">{t("loading")}</div> : roster.length === 0 ? (
            <Info tone="info" title={t("s2Empty")} testId="station-roster-empty">{t("s2EmptyBody")}</Info>
          ) : (
            <div className="ws-tiles" data-testid="station-tiles">
              {roster.map((e) => (
                <button key={e.id} type="button" className="ws-tile" onClick={() => onPick(e)} aria-disabled={e.locked || undefined} data-testid={`station-tile-${e.id}`}>
                  <span className="ws-av" aria-hidden="true">{e.initials}</span>
                  <div>
                    <div className="ws-tile-n">{e.name}</div>
                    <div className="ws-tile-s">{e.locked ? <span className="st er">{t("pinLockedTile")}</span> : [typeWord(station.type, lang), e.supervisor ? t("supervisor") : null].filter(Boolean).join(" · ")}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="ws-foot-note">{t("s2Note")}</div>
        </div>
      </Sheet>
    </>
  );
}

// ── S3 / S4 · the station PIN ─────────────────────────────────────────────────────────────────
export function PinScreen({ lang, station, emp, locked, onBack, onSignedIn, onRefused }: {
  lang: Lang; station: StationInfo; emp: { id: string; name: string; initials: string };
  locked?: { at: string; tasks: number } | null; onBack: () => void; onSignedIn: () => void;
  onRefused: (r: { code: string; text: string; name?: string }) => void;
}) {
  const t = useT(lang);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);
  const first = emp.name.trim().split(/\s+/)[0] ?? emp.name;
  const submit = useCallback(async (value: string) => {
    if (sent.current) return;
    sent.current = true; setBusy(true); setErr("");
    try {
      const r = await fetch("/api/station/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId: emp.id, pin: value, stationId: station.id }) });
      if (r.ok) { onSignedIn(); return; }
      const j = await r.json().catch(() => ({}));
      const text = localizeApiError(j, lang) ?? t("pinWrong");
      if (j.code === "STATION_PIN_WRONG" || r.status === 429) { setErr(r.status === 429 ? text : t("pinWrong")); setPin(""); return; }
      onRefused({ code: j.code ?? String(r.status), text, name: j.name });
    } catch { setErr(t("offline")); setPin(""); } finally { sent.current = false; setBusy(false); }
  }, [emp.id, station.id, lang, onRefused, onSignedIn, t]);
  const press = useCallback((k: string) => {
    if (busy) return;
    setErr("");
    setPin((p) => {
      const n = k === "del" ? p.slice(0, -1) : p.length >= 6 ? p : p + k;
      if (n.length === 6 && p.length === 5) void submit(n);
      return n;
    });
  }, [busy, submit]);
  // A keyboard works too: digits, Backspace (the pad is an aid, PHASE9 §6 desktop-first rule).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); press("del"); }
      else if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [press, onBack]);
  return (
    <>
      <DeviceBar lang={lang} station={station} />
      <Sheet plain testId={locked ? "station-s4" : "station-s3"}>
        <div className="ws-center" style={{ gap: locked ? 24 : 20 }}>
          {locked ? (
            <div>
              <h1 className="ws-t2" data-testid="station-title">{t("s4Title")}</h1>
              <p className="ws-lead">{t("s4Sub", { name: emp.name, time: locked.at })}{locked.tasks ? ` · ${locked.tasks === 1 ? t("s4Tasks1") : t("s4TasksN", { n: locked.tasks })}` : ""}</p>
            </div>
          ) : null}
          <div className="ws-pinrow">
            <div className="ws-who">
              <span className="ws-av lg" aria-hidden="true">{emp.initials}</span>
              <div><div className="ws-who-n" data-testid="station-pin-name">{emp.name}</div><div className="ws-who-s">{[typeWord(station.type, lang), station.name].join(" · ")}</div></div>
              <button type="button" className="btn ws-notyou" onClick={onBack} data-testid="station-not-you">{t("notYou", { first })}</button>
            </div>
            <div className="ws-pinbox">
              <div className="ws-prompt" id="ws-pin-l">{locked ? t("s4Prompt") : t("s3Prompt")}</div>
              <div className={`ws-dots${err ? " bad" : ""}`} role="img" aria-labelledby="ws-pin-l" aria-describedby="ws-pin-err" data-testid="station-pin-dots" data-filled={pin.length}>
                {Array.from({ length: 6 }, (_, i) => <span key={i} className={i < pin.length ? "on" : ""} />)}
              </div>
              <Keypad onKey={press} off={busy} decimal={false} delLabel={lang === "ar" ? "حذف" : "Delete"} />
              <div className="ws-pinerr" id="ws-pin-err" role="alert" data-testid="station-pin-error">{err}</div>
            </div>
          </div>
          <div className="ws-foot-note">{t("pinNote")}</div>
        </div>
      </Sheet>
    </>
  );
}

// ── S7 · not assigned (or refused) ────────────────────────────────────────────────────────────
export function UnauthScreen({ lang, station, title, body, onBack }: { lang: Lang; station: StationInfo; title: string; body: string; onBack: () => void }) {
  const t = useT(lang);
  return (
    <>
      <DeviceBar lang={lang} station={station} />
      <Sheet plain testId="station-s7" foot={<><Primary onClick={onBack} testId="station-back-to-tiles">{t("s7Back")}</Primary><Note>{t("s7Note")}</Note></>}>
        <div className="ws-center" style={{ gap: 20, maxWidth: 640 }}>
          <span className="ws-warnmark" aria-hidden="true">!</span>
          <h1 className="ws-t2" style={{ fontSize: 28, lineHeight: "38px" }} data-testid="station-title">{title}</h1>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 15, lineHeight: "24px" }}>{body}</p>
        </div>
      </Sheet>
    </>
  );
}

// ── S5 · switch employee and the handover of an active task ───────────────────────────────────
export type HandoverTask = { title: string; ref: string | null; startedAt: string } | null;
export function SwitchScreen({ lang, bar, name, task, onConfirm, onBack }: { lang: Lang; bar: ReactNode; name: string; task: HandoverTask | undefined; onConfirm: (claims: "keep" | "release") => Promise<void>; onBack: () => void }) {
  const t = useT(lang);
  const [choice, setChoice] = useState<"keep" | "release">("keep");
  const [busy, setBusy] = useState(false);
  return (
    <>
      {bar}
      <Sheet plain testId="station-s5" foot={<>
        <Primary onClick={async () => { setBusy(true); try { await onConfirm(task ? choice : "keep"); } finally { setBusy(false); } }} wait={busy} disabled={task === undefined} testId="station-switch-confirm">{t("s5Primary")}</Primary>
        <Secondary onClick={onBack} testId="station-switch-back">{t("back")}</Secondary>
        <Note>{t("s5Note")}</Note>
      </>}>
        <div className="ws-plain-w">
          <h1 className="ws-t2" data-testid="station-title">{t("s5Title")}</h1>
          <div className="ws-sub" style={{ color: "var(--text-secondary)", fontSize: 15, lineHeight: "24px" }}>{task === null ? t("s5SubNone", { name }) : t("s5Sub", { name })}</div>
          {task ? (
            <>
              <div className="ws-task" data-testid="station-switch-task">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 17, lineHeight: "26px", fontWeight: 600 }}>{task.title}</div>
                  <div style={{ fontSize: 14, lineHeight: "22px", color: "var(--text-muted)", marginTop: 2 }}>{task.ref ? <><Bid>{task.ref}</Bid> · </> : null}{t("s5Started", { time: clock(task.startedAt) })}</div>
                </div>
                <span className="st in" style={{ fontSize: 15 }}>{t("activeTask")}</span>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                <Option title={t("s5Keep")} desc={t("s5KeepDesc")} on={choice === "keep"} onClick={() => setChoice("keep")} testId="station-switch-keep" />
                <Option title={t("s5Release")} desc={t("s5ReleaseDesc")} on={choice === "release"} onClick={() => setChoice("release")} testId="station-switch-release" />
              </div>
            </>
          ) : null}
          <Info tone="muted" title={t("s5InfoTitle")}>{t("s5InfoBody")}</Info>
        </div>
      </Sheet>
    </>
  );
}

/** A screen of a station type that is not built yet (only roasting exists, W1). */
export function NoScreen({ lang, station, bar }: { lang: Lang; station: StationInfo; bar: ReactNode }) {
  const t = useT(lang);
  return (
    <>
      {bar}
      <Sheet plain testId="station-noscreen">
        <div className="ws-center" style={{ gap: 16, maxWidth: 640 }}>
          <h1 className="ws-t2">{station.name}</h1>
          <Info tone="info" title={t("noScreen")}>{t("noScreenBody")}</Info>
        </div>
      </Sheet>
    </>
  );
}
