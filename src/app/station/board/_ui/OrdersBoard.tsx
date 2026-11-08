"use client";
// «لوحة الطلبات المباشرة» (D15, option C) — the screen. Figma: page D15, frames C1–C6 (approved 8 Nov 2026).
//
//   · Option C: a column per stage that has orders, in the fixed stage order (first stage at the inline start); a column
//     opens when its first order arrives and closes the moment it empties (owner: no grace period).
//   · Live: GET /api/station/board every 10 s with If-None-Match (304 when nothing changed), paused while the screen is
//     hidden. Over 30 s without a good read the board says so and dims the last known board — never «0 orders» on a
//     failure (S1). A refused device (revoked, re-assigned) reloads: the shell then shows what the device is now.
//   · «طلب جديد»: created within 2 minutes. «وصل قبل …»: a stage change this screen saw, for a minute, with a short tint.
//   · Read-only: nothing on it can be tapped except the language switch.
//   · No customer name, price or payment anywhere (owner decision, 8 Nov 2026).
import "../board.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { BrandMark } from "@/components/brand/BrandMark";
import {
  BOARD_POLL_MS, BOARD_STAGES, BOARD_STALE_MS, CHANNEL_LABEL, MOVED_NOTE_MS, NEW_TAG_MS, STAGE_LABEL,
  riyadhClock, sinceText, type BoardAnswer, type BoardOrder, type BoardStage,
} from "@/lib/station/board";

type Lang = "ar" | "en";
const LANG_KEY = "hq.board.lang";
const PAGE_MS = 8_000;

function readLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "ar" || v === "en") return v;
  } catch { /* storage unavailable */ }
  return document.documentElement.lang === "en" ? "en" : "ar";
}
const noSubscribe = () => () => {};

export function OrdersBoard() {
  const initialLang = useSyncExternalStore(noSubscribe, readLang, () => "ar" as Lang);
  const [langPick, setLangPick] = useState<Lang | null>(null);
  const lang = langPick ?? initialLang;
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [board, setBoard] = useState<BoardAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastOk, setLastOk] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());
  /** server time − client time, so «منذ» and «طلب جديد» follow the server's clock. */
  const [skew, setSkew] = useState(0);
  const etag = useRef<string | null>(null);
  const prevStage = useRef<Map<string, BoardStage> | null>(null);
  const [moved, setMoved] = useState<Map<string, number>>(new Map());

  const pick = (l: Lang) => {
    setLangPick(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* storage unavailable */ }
  };

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/station/board", { cache: "no-store", headers: { "x-station-poll": "1", ...(etag.current ? { "If-None-Match": etag.current } : {}) } });
      if (r.status === 401 || r.status === 403) { window.location.reload(); return; }
      if (r.status === 304) { setLastOk(Date.now()); setFailed(false); return; }
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as BoardAnswer;
      etag.current = r.headers.get("etag");
      const sk = new Date(j.serverTime).getTime() - Date.now();
      setSkew(sk);
      // A stage change since the last board (not on the first read: nothing «moved» when the screen just opened).
      const prev = prevStage.current;
      if (prev) {
        const t = Date.now() + sk;
        setMoved((m) => {
          const next = new Map([...m].filter(([, at]) => t - at < MOVED_NOTE_MS));
          for (const o of j.orders) { const p = prev.get(o.id); if (p && p !== o.stage) next.set(o.id, t); }
          return next;
        });
      }
      prevStage.current = new Map(j.orders.map((o) => [o.id, o.stage]));
      setBoard(j);
      setLastOk(Date.now());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) { void poll(); timer = setInterval(() => void poll(), BOARD_POLL_MS); } };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const vis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", vis);
    return () => { stop(); document.removeEventListener("visibilitychange", vis); };
  }, [poll]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const serverNow = now + skew;
  const stale = !!board && (failed || (lastOk > 0 && now - lastOk > BOARD_STALE_MS));
  const columns = board?.columns ?? [];

  return (
    <div className="bd" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} data-testid="orders-board">
      <header className="bd-bar">
        <span className="bd-mark"><BrandMark /></span>
        <div className="bd-id"><b>{L("لوحة الطلبات", "Orders board")}</b><span>{L("للعرض فقط · أرض المصنع", "Display only · Factory floor")}</span></div>
        <span className={`bd-live${stale ? " stale" : ""}`} role="status" data-testid="board-live"><i aria-hidden="true" />{stale ? L("غير متصل", "Offline") : L("مباشر", "Live")}</span>
        <span className="bd-sp" />
        <span className="bd-trail" aria-label={L(`مراحل مفتوحة: ${columns.length} من 7`, `Open stages: ${columns.length} of 7`)}>
          {L(`مراحل مفتوحة: ${columns.length} من 7`, `Open stages: ${columns.length} of 7`)}
          {BOARD_STAGES.map((s) => <i key={s} className={`st-${s}${columns.includes(s) ? " on" : ""}`} aria-hidden="true" />)}
        </span>
        <span className="bd-lang" role="group" aria-label={L("اللغة", "Language")}>
          <button type="button" aria-pressed={lang === "ar"} onClick={() => pick("ar")} lang="ar">ع</button>
          <button type="button" aria-pressed={lang === "en"} onClick={() => pick("en")} lang="en">EN</button>
        </span>
        <span className="bd-clock" data-testid="board-clock">{riyadhClock(serverNow)}</span>
      </header>
      {stale ? (
        <div className="bd-stale" role="alert" data-testid="board-stale">
          {L(`⚠ الاتصال متقطّع — آخر تحديث ${riyadhClock(lastOk + skew)}. البيانات قد لا تكون محدثة، والشاشة تحاول تلقائيًا.`,
            `⚠ Connection lost — last update ${riyadhClock(lastOk + skew)}. The board may be out of date; it keeps retrying.`)}
        </div>
      ) : null}
      {!board ? (
        <div className="bd-empty" role="status">
          {failed ? <div><b>{L("تعذّر الاتصال بالنظام", "Could not reach the system")}</b><span>{L("الشاشة تحاول مرة أخرى كل 10 ثوانٍ.", "The board retries every 10 seconds.")}</span></div> : <span>{L("جارٍ التحميل…", "Loading…")}</span>}
        </div>
      ) : columns.length === 0 ? (
        <div className="bd-empty" data-testid="board-empty">
          <div><b>{L("لا توجد طلبات مفتوحة الآن", "No open orders right now")}</b><span>{L("أي طلب جديد يظهر هنا فورًا.", "Any new order appears here at once.")}</span></div>
        </div>
      ) : (
        <div className={`bd-cols${stale ? " dim" : ""}`} data-testid="board-columns" data-open={columns.join(",")}>
          {columns.map((s) => (
            <Column key={s} stage={s} lang={lang} L={L} now={serverNow} moved={moved}
              orders={board.orders.filter((o) => o.stage === s)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Column({ stage, orders, lang, L, now, moved }: { stage: BoardStage; orders: BoardOrder[]; lang: Lang; L: (ar: string, en: string) => string; now: number; moved: Map<string, number> }) {
  const body = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState({ n: 1, i: 0 });
  // More cards than the column holds: it turns its own pages every 8 s («1/2»); nobody needs to touch the screen.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const n = Math.max(1, Math.ceil(el.scrollHeight / Math.max(1, el.clientHeight) - 0.02));
      setPages((p) => (p.n === n ? p : { n, i: Math.min(p.i, n - 1) }));
    };
    // The observer reports the first size at once, then every change.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [orders.length]);
  useEffect(() => {
    if (pages.n < 2) return;
    const t = setInterval(() => setPages((p) => ({ ...p, i: (p.i + 1) % p.n })), PAGE_MS);
    return () => clearInterval(t);
  }, [pages.n]);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTo({ top: pages.i * el.clientHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [pages.i]);

  return (
    <section className={`bd-col st-${stage}`} aria-label={`${STAGE_LABEL[stage][lang]} · ${orders.length}`} data-testid={`board-col-${stage}`}>
      <div className="bd-col-h">
        <h2>{STAGE_LABEL[stage][lang]}</h2>
        {pages.n > 1 ? <span className="pg">{pages.i + 1}/{pages.n}</span> : null}
        <span className="n">{orders.length}</span>
      </div>
      <div className="bd-col-b" ref={body}>
        <div className="bd-grid">
          {orders.map((o) => <Card key={o.id} o={o} lang={lang} L={L} now={now} movedAt={moved.get(o.id) ?? null} />)}
        </div>
      </div>
    </section>
  );
}

function Card({ o, lang, L, now, movedAt }: { o: BoardOrder; lang: Lang; L: (ar: string, en: string) => string; now: number; movedAt: number | null }) {
  const isNew = o.stage === "new" && now - new Date(o.createdAt).getTime() < NEW_TAG_MS;
  const movedSec = movedAt ? Math.max(0, Math.round((now - movedAt) / 1000)) : null;
  const showMoved = movedSec !== null && movedSec * 1000 < MOVED_NOTE_MS;
  const src = CHANNEL_LABEL[o.source][lang] + (o.repName ? ` · ${o.repName}` : "");
  const qty = [
    o.units ? L(`${o.units} وحدة`, `${o.units} units`) : null,
    o.kg ? L(`${o.kg} كجم`, `${o.kg} kg`) : null,
    L(`${o.lines} ${o.lines === 1 ? "صنف" : o.lines === 2 ? "صنفان" : "أصناف"}`, `${o.lines} item${o.lines === 1 ? "" : "s"}`),
  ].filter(Boolean).join(" · ");
  const cls = ["bd-card", isNew ? "new" : "", o.hold ? "hold" : "", showMoved ? "moved" : "", o.stage === "done" ? "done" : ""].filter(Boolean).join(" ");
  return (
    <article className={cls} data-testid={`board-card-${o.orderNumber}`} data-stage={o.stage}>
      <div className="bd-card-1">
        <span className="no">#{o.orderNumber}</span>
        <span className="ago">{o.stage === "done" && o.deliveredAt ? riyadhClock(o.deliveredAt) : sinceText(o.createdAt, now, lang)}</span>
      </div>
      <div className="bd-card-2">
        <span className="bd-src" data-testid="board-source">{src}</span>
        <span className="qty">{qty}</span>
      </div>
      {isNew || showMoved || o.hold || o.preparingBy || o.partial || o.stage === "done" ? (
        <div className="bd-tags">
          {isNew ? <span className="bd-tag-new">{L("طلب جديد", "New order")}</span> : null}
          {showMoved ? <span className="bd-tag-moved">{L(`وصل قبل ${movedSec} ث`, `arrived ${movedSec} s ago`)}</span> : null}
          {o.hold ? <span className="bd-tag-hold">● {L("معلّق مؤقتًا", "On hold")}</span> : null}
          {o.preparingBy ? <span className="bd-tag-muted">{L(`مع ${o.preparingBy}`, `with ${o.preparingBy}`)}</span> : null}
          {o.partial ? <span className="bd-tag-muted">{L("جزئي", "Partial")}</span> : null}
          {o.stage === "done" ? <span className="bd-tag-muted">{L("وقت التسليم", "Delivered at")}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
