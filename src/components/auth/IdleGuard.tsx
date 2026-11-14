"use client";

// Sign-out after 10 minutes without activity (owner, 9 Nov — all ERP users; the stations keep their own rule and never
// mount this). Mounted once by the dashboard shell.
//   · Activity: a tap / click, a key, the wheel or a scroll, a touch — in ANY tab of this site (BroadcastChannel, with
//     localStorage as the fallback), so working in one tab keeps the others signed in.
//   · The server: a keep-alive (POST /api/auth/keepalive) when the page opens and then about once a minute while there is
//     activity — it always sets the session's last use to now and answers the server's own deadline. The page counts to
//     the EARLIER of its own count and that deadline (lib/auth/idle.ts deadlineOf, gate M1): the warning always comes
//     before the server ends the session, and «كمّل» always reaches it in time.
//   · One minute before: «بتطلع خلال دقيقة لعدم النشاط» with a countdown, «كمّل» (a keep-alive; a refusal goes to the
//     sign-in, a failure is retried once and then said) and «اطلع الحين».
//   · At the deadline: DELETE /api/auth/me?reason=idle&ref=<this session> and /login?reason=idle&next=…; every tab of the
//     same session follows. If the person signed in again meanwhile (another session), nothing is ended: the tab reloads.
//   · Back from the background or sleep: a re-check only — past the deadline it leaves at once, no dialog.
import { useCallback, useEffect, useRef, useState } from "react";
import { D21Dialog } from "@/components/ui/Dialog";
import { IDLE_OUT_KEY, deadlineOf, idleLoginUrl, serverDeadlineLocal, shouldPing, stateAt } from "@/lib/auth/idle";
import { clearAllDrafts } from "@/lib/drafts/local-draft";

const CHANNEL = "bf-idle";
const LAST_KEY = "bf-idle-last";
const SERVER_KEY = "bf-idle-server";
const OUT_KEY = IDLE_OUT_KEY;
type Msg =
  | { type: "activity"; at: number }
  | { type: "server"; deadline: number; ref: string }
  | { type: "logout"; kind: "idle" | "user"; ref: string | null };

const here = () => window.location.pathname + window.location.search;
const readNum = (k: string) => { try { return Number(window.localStorage.getItem(k)) || 0; } catch { return 0; } };

let channel: BroadcastChannel | null = null;
function send(msg: Msg) {
  try { channel ??= typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null; channel?.postMessage(msg); } catch { /* no channel */ }
  try {
    if (msg.type === "activity") window.localStorage.setItem(LAST_KEY, String(msg.at));
    else if (msg.type === "server") window.localStorage.setItem(SERVER_KEY, JSON.stringify({ deadline: msg.deadline, ref: msg.ref }));
    else window.localStorage.setItem(OUT_KEY, JSON.stringify({ kind: msg.kind, ref: msg.ref, at: Date.now() }));
  } catch { /* storage unavailable */ }
}

/** The session this tab belongs to (its ref, from its keep-alive) — shared with the shell's «تسجيل خروج». */
let myRef: string | null = null;
/**
 * Did a tab of this session just sign out for inactivity? (D20.1 gate P1.) The tab that reaches the deadline writes it
 * here BEFORE ending the session; another tab whose request lands after the session (and its cookie) is gone — but
 * before the broadcast reached it, as under load — gets a bare 401, and reads this to say «idle», not «session expired».
 */
export function recentIdleSignOut(now = Date.now()): boolean {
  try {
    const v = JSON.parse(window.localStorage.getItem(OUT_KEY) ?? "null") as { kind?: string; ref?: string | null; at?: number } | null;
    if (!v || v.kind !== "idle" || typeof v.at !== "number" || now - v.at > 60_000 || v.at > now + 5_000) return false;
    // This very session only: both refs known and equal (R2-L1 — a marker of another sign-in never speaks for this one).
    return !!v.ref && !!myRef && v.ref === myRef;
  } catch { return false; }
}

/** The shell's «تسجيل خروج»: the other tabs of this session sign out with it. */
export const broadcastLogout = () => send({ type: "logout", kind: "user", ref: myRef });

type Answer = { ok: true; deadline: number | null; ref: string } | { ok: false; status: number };
async function keepAlive(): Promise<Answer> {
  const sentAt = Date.now();
  try {
    const r = await fetch("/api/auth/keepalive", { method: "POST", cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status };
    const b = (await r.json()) as { now: string; deadline: string; ref: string };
    return { ok: true, deadline: serverDeadlineLocal(b, sentAt), ref: b.ref };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function IdleGuard({ lang, onLogoutNow }: { lang: "ar" | "en"; onLogoutNow: () => void }) {
  const ar = lang === "ar";
  const last = useRef(0);
  const server = useRef<number | null>(null);
  const lastPing = useRef(0);
  const pending = useRef(false);
  const pinging = useRef(false);
  const lastSent = useRef(0);
  const warning = useRef(false);
  const leaving = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // The session ended on the server (a 401 to the keep-alive): straight to the idle sign-in.
  const gone = useCallback(() => { if (!leaving.current) { leaving.current = true; clearAllDrafts(); window.location.replace(idleLoginUrl(here())); } }, []);

  const leave = useCallback((kind: "idle" | "user", tell: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    clearAllDrafts(); // P2 gate B1: an idle sign-out leaves no unsaved draft for the next person on this device
    if (tell) send({ type: "logout", kind, ref: myRef });
    if (kind === "user") { onLogoutNow(); return; }
    const go = () => window.location.replace(idleLoginUrl(here()));
    if (!tell) { go(); return; }
    // End THIS session (IDLE_TIMEOUT). A newer sign-in in the meantime (409 SESSION_CHANGED): end nothing, reload into it.
    const q = `reason=idle${myRef ? `&ref=${encodeURIComponent(myRef)}` : ""}`;
    const done = fetch(`/api/auth/me?${q}`, { method: "DELETE", keepalive: true }).then((r) => r.status).catch(() => 0);
    void Promise.race([done, new Promise<number>((r) => setTimeout(() => r(0), 1500))]).then((status) => {
      if (status === 409) window.location.reload(); else go();
    });
  }, [onLogoutNow]);

  const adopt = useCallback((a: Extract<Answer, { ok: true }>) => {
    if (myRef && a.ref !== myRef) { window.location.reload(); return; } // the cookie now names another sign-in
    myRef = a.ref;
    if (a.deadline !== null) { server.current = a.deadline; send({ type: "server", deadline: a.deadline, ref: a.ref }); }
  }, []);

  const ping = useCallback(async () => {
    if (pinging.current || leaving.current) return;
    pinging.current = true;
    lastPing.current = Date.now();
    pending.current = false;
    const a = await keepAlive();
    pinging.current = false;
    if (a.ok) adopt(a);
    else if (a.status === 401) gone();
  }, [adopt, gone]);

  const check = useCallback(() => {
    if (leaving.current) return;
    last.current = Math.max(last.current, readNum(LAST_KEY));
    const now = Date.now();
    if (shouldPing(lastPing.current, now, pending.current) && !warning.current) void ping();
    const s = stateAt(deadlineOf(last.current, server.current), now);
    if (s.state === "expired") { setSecondsLeft(null); leave("idle", true); return; }
    warning.current = s.state === "warn";
    setSecondsLeft(s.state === "warn" ? s.secondsLeft : null);
  }, [leave, ping]);

  const activity = useCallback((at: number, own: boolean) => {
    if (leaving.current) return;
    last.current = Math.max(last.current, at);
    if (!own) { warning.current = false; setSecondsLeft(null); return; }
    pending.current = true;
    if (at - lastSent.current >= 1000) { lastSent.current = at; send({ type: "activity", at }); }
    if (shouldPing(lastPing.current, at, true)) void ping();
  }, [ping]);

  const fromServer = useCallback((deadline: number, ref: string) => {
    if (myRef && ref !== myRef) return; // another sign-in's tab
    server.current = deadline;
    if (warning.current && stateAt(deadlineOf(last.current, deadline), Date.now()).state === "active") { warning.current = false; setSecondsLeft(null); }
  }, []);

  useEffect(() => {
    const now = Date.now();
    last.current = Math.max(now, readNum(LAST_KEY));
    send({ type: "activity", at: now });
    void ping(); // the page's own load: the server's deadline and this session's ref
    // Activity of this tab — not while the warning is up: only «كمّل» answers it.
    const onAct = () => { if (!warning.current) activity(Date.now(), true); };
    const evs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of evs) window.addEventListener(e, onAct, { passive: true, capture: true });
    window.addEventListener("scroll", onAct, { passive: true, capture: true });
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    let ch: BroadcastChannel | null = null;
    try { ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null; } catch { ch = null; }
    const onMsg = (m: Msg) => {
      if (m.type === "activity") activity(m.at, false);
      else if (m.type === "server") fromServer(m.deadline, m.ref);
      else if (!m.ref || !myRef || m.ref === myRef) leave(m.kind, false); // only this session's tabs follow
    };
    if (ch) ch.onmessage = (e: MessageEvent<Msg>) => onMsg(e.data);
    const onStorage = (e: StorageEvent) => {
      if (!e.newValue) return;
      try {
        if (e.key === LAST_KEY) onMsg({ type: "activity", at: Number(e.newValue) || 0 });
        else if (e.key === SERVER_KEY) { const v = JSON.parse(e.newValue) as { deadline: number; ref: string }; onMsg({ type: "server", ...v }); }
        else if (e.key === OUT_KEY) { const v = JSON.parse(e.newValue) as { kind: "idle" | "user"; ref: string | null }; onMsg({ type: "logout", ...v }); }
      } catch { /* a value from an older page */ }
    };
    window.addEventListener("storage", onStorage);
    const t = window.setInterval(check, 1000);
    return () => {
      for (const e of evs) window.removeEventListener(e, onAct, { capture: true });
      window.removeEventListener("scroll", onAct, { capture: true });
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("storage", onStorage);
      ch?.close();
      window.clearInterval(t);
    };
  }, [activity, check, fromServer, leave, ping]);

  // «كمّل»: a keep-alive (user-driven). Refused (401) → the idle sign-in; no answer → once more, then say so.
  const keepGoing = async () => {
    setFailed(false);
    let a = await keepAlive();
    if (!a.ok && a.status !== 401) { await new Promise((r) => setTimeout(r, 1500)); a = await keepAlive(); }
    if (!a.ok) { if (a.status === 401) gone(); else setFailed(true); return; }
    const now = Date.now();
    adopt(a);
    last.current = now;
    lastPing.current = now;
    lastSent.current = now;
    pending.current = false;
    send({ type: "activity", at: now });
    warning.current = false;
    setSecondsLeft(null);
  };

  if (secondsLeft === null) return null;
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return (
    <D21Dialog lang={lang} title={ar ? "بتطلع خلال دقيقة لعدم النشاط" : "You'll be signed out in a minute"}
      sub={ar ? "ما فيه نشاط من 9 دقايق. تبي تكمّل؟" : "No activity for 9 minutes. Do you want to continue?"}
      onClose={() => void keepGoing()} testId="idle-warning" width={380}
      actions={<>
        <button type="button" className="btn p" onClick={() => void keepGoing()} data-testid="idle-continue">{ar ? "كمّل" : "Continue"}</button>
        <button type="button" className="btn" onClick={() => leave("user", true)} data-testid="idle-logout">{ar ? "اطلع الحين" : "Sign out now"}</button>
      </>}>
      <p className="idle-count" role="timer" aria-live="polite" data-testid="idle-countdown"
        style={{ margin: 0, textAlign: "center", fontFamily: "var(--f-num)", fontSize: 30, fontWeight: 700 }}><bdi>{mm}:{ss}</bdi></p>
      {failed ? <p role="alert" data-testid="idle-continue-failed" style={{ margin: "8px 0 0", textAlign: "center", color: "var(--status-danger)", fontSize: 13 }}>
        {ar ? "تعذّر الاتصال بالنظام — تأكد من الإنترنت وجرّب «كمّل» مرة ثانية." : "Could not reach the system — check the connection and try «Continue» again."}</p> : null}
    </D21Dialog>
  );
}
