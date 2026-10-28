"use client";
// Roasting station (Phase 9 W1): R1 queue, R5 blocked, R2 start / blocked start, R3 active, R4
// weights (entry, waiting, loss above the boundary, recorded), R7 problem report and its
// confirmation, S6 offline (read-only, unsent draft) and recovery by key, S7 not authorised.
// The server decides everything (H12); this screen sends raw inputs and shows only what the
// server confirmed. Drafts live in sessionStorage only and are never shown as recorded (D14).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStation } from "../../_ui/context";
import { st, type StationKey } from "@/lib/i18n/station";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { newRequestKey, isConclusiveResponse } from "@/lib/request-key";
import { lossVerdict, LOSS_REASONS, PROBLEM_REASONS, type ProblemKind } from "@/lib/station/shared";
import type { StationQueue, QueueItem, StationRoaster } from "@/lib/services/station/queue";
import {
  StationBar, Sheet, Head, Facts, Primary, Secondary, Note, Info, Keypad, BigField, Row, Side, SideLine,
  Confirm, Option, Chips, LogRows, DoneMark, Bid, Num,
} from "../../_ui/blocks";
import { BatchLabelPrint } from "@/components/print/BatchLabelPrint";
import { StationLotScan, type ScannedLot } from "./LotScan";

type Batch = { id: string; batchNumber: string; productId?: string | null; greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number; createdAt: string; greenBean?: { serialNumber: string } | null };
type View =
  | { v: "queue" } | { v: "blocked" } | { v: "start"; key: string } | { v: "active" } | { v: "weights" }
  | { v: "done"; batch: Batch; item: QueueItem | null; lossTone: string; at: string }
  | { v: "problem" } | { v: "problemDone"; at: string; kind: ProblemKind; reason: string; item: QueueItem | null }
  | { v: "recovery"; back: string; asked: string; found: Batch | null; at: string };
type Draft = { green: string; roasted: string; lossReason: string | null; ack: boolean; pendingKey: string | null; lot?: ScannedLot | null };

const TZ = "Asia/Riyadh";
const EMPTY_DRAFT: Draft = { green: "", roasted: "", lossReason: null, ack: false, pendingKey: null };
const k2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
/** A percentage as one left-to-right run inside Arabic text («15.8%», never «%15.8»). */
const pct = (v: number) => `\u2066${v.toFixed(1)}%\u2069`;

/** A typed weight: digits and one point, three decimals at most (keyboard or keypad). */
function cleanWeight(v: string): string {
  let s = v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9.]/g, "");
  const i = s.indexOf(".");
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "").slice(0, 3);
  if (s.startsWith(".")) s = "0" + s;
  return s.slice(0, 7);
}

export function RoastingStation() {
  const { user, signOut, mode, station, lock, switchEmployee } = useStation();
  const onDevice = mode === "device";
  const lang = user.preferredLanguage === "en" ? "en" : "ar";
  const t = useCallback((k: StationKey, vars?: Record<string, string | number>) => st(k, lang, vars), [lang]);
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const time = useCallback((d: string | Date | number, sec = true) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}), hour12: false }), []);
  const dateLine = useMemo(() => new Date().toLocaleDateString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }), [lang]);

  const [q, setQ] = useState<StationQueue | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [unauth, setUnauth] = useState<{ code: string; text: string } | false>(false);
  const [online, setOnline] = useState(true);
  const [updated, setUpdated] = useState<string>("");
  const [view, setView] = useState<View>({ v: "queue" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [roasterId, setRoasterId] = useState<string | null>(() => { try { return sessionStorage.getItem("hq.station.roaster"); } catch { return null; } });
  const etag = useRef<string>("");
  const [now, setNow] = useState(() => Date.now());

  // ── Server reads ──────────────────────────────────────────────────────────────────────────
  // `poll`: a background read (H5). On a station device it is not activity, so it never keeps a
  // station session alive past the idle lock (x-station-poll, read by the station guard).
  const load = useCallback(async (force = false, poll = false): Promise<StationQueue | null> => {
    try {
      const r = await fetch(`/api/station/roasting/queue${roasterId && !onDevice ? `?roasterId=${encodeURIComponent(roasterId)}` : ""}`, { cache: "no-store", headers: { ...(!force && etag.current ? { "If-None-Match": etag.current } : {}), ...(poll ? { "x-station-poll": "1" } : {}) } });
      setOnline(true);
      if (r.status === 401) { await signOut(onDevice ? "ended" : undefined); return null; }
      if (r.status === 403) { const j = await r.json().catch(() => ({})); setUnauth({ code: String(j.code ?? ""), text: localizeApiError(j, lang) ?? "" }); return null; }
      if (r.status === 304) { setUpdated(time(Date.now())); return q; }
      if (!r.ok) { setLoadErr(true); return null; }
      const j = (await r.json()) as StationQueue;
      etag.current = r.headers.get("ETag") ?? "";
      setQ(j); setLoadErr(false); setUpdated(time(j.serverTime));
      return j;
    } catch {
      setOnline(false);
      return null;
    }
  }, [roasterId, signOut, time, q, onDevice, lang]);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- the queue is an external system read on mount and when the roaster changes
  useEffect(() => { void load(true); }, [roasterId]);
  // Polling with a version (H5): every 15 s on the reading views; nothing is written by a poll.
  useEffect(() => {
    if (!["queue", "blocked", "active", "start"].includes(view.v)) return;
    const id = setInterval(() => { void load(false, true); }, 15000);
    return () => clearInterval(id);
  }, [view.v, load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  // While the server is unreachable (whatever the browser thinks), keep asking every 5 s; the
  // answer flips the station back online and starts the S6 recovery below.
  useEffect(() => {
    if (online) return;
    const id = setInterval(() => { void load(false, true); }, 5000);
    return () => clearInterval(id);
  }, [online, load]);
  useEffect(() => {
    const off = () => setOnline(false);
    const on = () => { setOnline(true); void load(true); };
    window.addEventListener("offline", off); window.addEventListener("online", on);
    return () => { window.removeEventListener("offline", off); window.removeEventListener("online", on); };
  }, [load]);

  const roaster: StationRoaster | null = q?.roaster ?? null;
  const mine = q?.mine ?? null;
  const item = mine?.item ?? null;
  const name = useCallback((i: QueueItem | null) => (i ? (lang === "ar" ? i.nameAr || i.nameEn : i.nameEn) : ""), [lang]);

  // ── Draft (sessionStorage only, per person and per claim) ────────────────────────────────
  const draftKey = mine ? `hq.station.roast.${user.id}.${mine.id}` : null;
  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  if (draftKey !== draftFor) {
    let d = EMPTY_DRAFT;
    try { const raw = draftKey ? sessionStorage.getItem(draftKey) : null; if (raw) d = { ...EMPTY_DRAFT, ...JSON.parse(raw) }; } catch { /* storage unavailable */ }
    setDraftFor(draftKey); setDraftState(d);
  }
  const setDraft = useCallback((patch: Partial<Draft>) => {
    setDraftState((cur) => {
      const next = { ...cur, ...patch };
      try { if (draftKey) sessionStorage.setItem(draftKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, [draftKey]);
  const clearDraft = useCallback(() => { try { if (draftKey) sessionStorage.removeItem(draftKey); } catch { /* */ } setDraftState(EMPTY_DRAFT); }, [draftKey]);
  const [focus, setFocus] = useState<"green" | "roasted">("green");
  // ON mode only (Settings › Production «تأكيد الكيس بالمسح»): the roaster opened «كيس غير المقترح».
  const [scanOpen, setScanOpen] = useState(false);
  const [stage, setStage] = useState<"entry" | "wait" | "loss">("entry");
  const [needAck, setNeedAck] = useState(false);

  // ── Writes (each with its Idempotency-Key; the key is kept until the answer is conclusive) ──
  const keys = useRef<Record<string, string>>({});
  const post = useCallback(async (slot: string, url: string, body?: unknown, fixedKey?: string) => {
    const key = fixedKey ?? (keys.current[slot] ??= newRequestKey());
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (isConclusiveResponse(r.status)) delete keys.current[slot];
    return { status: r.status, body: j, key };
  }, []);
  const refusal = (body: unknown) => localizeApiError(body, lang) ?? L("تعذّر تنفيذ الإجراء.", "The action could not be completed.");

  // ── S6 recovery: an interrupted roast is asked about by key before anything is sent again ──
  const recover = useCallback(async () => {
    if (!draft.pendingKey) return;
    const back = time(Date.now());
    try {
      const r = await fetch(`/api/station/actions/${encodeURIComponent(draft.pendingKey)}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setOnline(true);
      const asked = time(Date.now());
      if (j.found && j.kind === "ROAST") {
        const b = j.batch as Batch;
        clearDraft();
        setView({ v: "recovery", back, asked, found: b, at: time(b.createdAt) });
        void load(true);
      } else {
        setView({ v: "recovery", back, asked, found: null, at: asked });
      }
    } catch { setOnline(false); }
  }, [draft.pendingKey, time, clearDraft, load]);
  // S6: when the connection returns, ask about the interrupted roast before anything else.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- reacts to the browser's connection only
  useEffect(() => { if (online && draft.pendingKey && stage !== "wait" && view.v === "weights") void recover(); }, [online]);

  // ── Actions ─────────────────────────────────────────────────────────────────────────────
  async function start(it: QueueItem) {
    if (busy || !online) return;
    setBusy(true); setErr("");
    try {
      const r = await post(`start:${it.key}`, "/api/station/roasting/start", { itemType: it.itemType, itemId: it.itemId, roasterId: roaster?.id ?? null, ...(it.slot ? { slotId: it.slot.id } : {}) });
      if (r.status === 200 || r.status === 201) { await load(true); setView({ v: "active" }); return; }
      setErr(refusal(r.body));
    } catch { setOnline(false); } finally { setBusy(false); }
  }

  async function claimAction(slot: "resume" | "release") {
    if (!mine || busy || !online) return;
    setBusy(true); setErr("");
    try {
      const r = await post(`${slot}:${mine.id}`, `/api/station/claims/${mine.id}/${slot}`);
      if (r.status === 200 || r.status === 201) {
        if (slot === "release") clearDraft();
        await load(true);
        setView(slot === "release" ? { v: "queue" } : { v: "active" });
        return;
      }
      setErr(refusal(r.body));
    } catch { setOnline(false); } finally { setBusy(false); }
  }

  const [problemKind, setProblemKind] = useState<ProblemKind | null>(null);
  const [problemReason, setProblemReason] = useState<string | null>(null);
  async function sendProblem() {
    if (!mine || !problemKind || !problemReason || busy || !online) return;
    setBusy(true); setErr("");
    try {
      const r = await post(`problem:${mine.id}`, "/api/station/problems", { claimId: mine.id, kind: problemKind, reason: problemReason });
      if (r.status === 200 || r.status === 201) {
        const at = time(r.body.createdAt ?? Date.now());
        setView({ v: "problemDone", at, kind: problemKind, reason: problemReason, item });
        setProblemKind(null); setProblemReason(null);
        void load(true);
        return;
      }
      setErr(refusal(r.body));
    } catch { setOnline(false); } finally { setBusy(false); }
  }

  const g = Number(draft.green), rq = Number(draft.roasted);
  const loss = item ? lossVerdict(g, rq, item.expectedLossPct) : null;
  const cap = roaster && g > 0 ? (+g.toFixed(3) > roaster.nominalKg ? "over" : (+g.toFixed(3) < roaster.minKg || +g.toFixed(3) > roaster.maxKg) ? "outside" : "ok") : "ok";
  const weightsReady = g > 0 && rq > 0 && rq < g && cap !== "over" && (cap !== "outside" || draft.ack);

  async function record() {
    if (!mine || !item || busy) return;
    if (!(g > 0 && rq > 0)) { setErr(t("measureRequired")); return; }
    if (rq >= g) { setErr(t("roastedTooHigh")); return; }
    if (loss?.tone === "above" && !draft.lossReason) { setStage("loss"); return; }
    if (!online) return;
    const key = draft.pendingKey ?? newRequestKey();
    setDraft({ pendingKey: key });
    setBusy(true); setErr(""); setStage("wait");
    try {
      const body = {
        ...(item.itemType === "RoastCoffee" ? { productId: item.productId, allocate: "oldest" } : { productId: item.productId, productionOrderId: item.itemId }),
        greenBeanQuantity: +g.toFixed(3), roastedBeanQuantity: +rq.toFixed(3),
        roasterId: roaster?.id ?? null, claimId: mine.id, ack: draft.ack, lossReason: draft.lossReason,
        // The sack the roaster scanned (LotScan.tsx); without a scan, the «اسحب من» lot the station showed: the server
        // records exactly that lot or refuses (409 GREEN_LOT_CHANGED) — it never switches lots silently (council F1).
        ...(draft.lot ? { greenBeanId: draft.lot.id } : item.green ? { expectedGreenBeanId: item.green.lotId } : {}),
        // Started from a slot of today's schedule: the batch links to it (the slot becomes recorded).
        ...(mine.slot ? { scheduledSlotId: mine.slot.id } : {}),
      };
      // The station's own record route (W2): on a paired device the station guard runs, then the
      // ERP's one roast POST records it; with a personal session it is that POST unchanged.
      const r = await post("roast", "/api/station/roasting/record", body, key);
      if (r.status === 200 || r.status === 201) {
        const b = r.body as Batch;
        clearDraft(); setStage("entry"); setNeedAck(false);
        setView({ v: "done", batch: b, item, lossTone: loss?.tone ?? "ok", at: time(b.createdAt) });
        void load(true);
        return;
      }
      // Ambiguous (5xx, 408, 425, 429): the key stays with the draft; the next press re-sends it.
      if (!isConclusiveResponse(r.status)) { setStage("entry"); setErr(refusal(r.body)); return; }
      setDraft({ pendingKey: null });
      setStage(r.body?.code === "LOSS_REASON_REQUIRED" ? "loss" : "entry");
      if (r.body?.code === "ACK_REQUIRED") { setNeedAck(true); setDraft({ ack: false, pendingKey: null }); }
      // The suggested lot changed since the screen showed it: the suggestion is refreshed («اسحب من» shows the new one).
      if (r.body?.code === "GREEN_LOT_CHANGED") void load(true);
      setErr(refusal(r.body));
    } catch {
      // Nothing came back: the roast may or may not have committed. The key is kept; nothing is
      // re-sent until the server is asked about it (S6 recovery).
      setOnline(false); setStage("entry");
    } finally { setBusy(false); }
  }

  // Keypad → the focused field.
  function onKey(k: string) {
    const cur = focus === "green" ? draft.green : draft.roasted;
    const next = k === "del" ? cur.slice(0, -1) : cleanWeight(cur + k);
    setDraft(focus === "green" ? { green: next } : { roasted: next });
  }

  // ── Shared chrome ───────────────────────────────────────────────────────────────────────
  const conn = !online ? { tone: "er" as const, label: t("offline") } : stage === "wait" ? { tone: "in" as const, label: t("connectedWaiting") } : { tone: "ok" as const, label: t("connected") };
  const bar = (
    <StationBar
      station={station?.name ?? t("stationName")}
      location={station ? [roaster?.name ?? station.roaster?.name, station.place].filter(Boolean).join(" · ") || undefined : roaster ? [roaster.name, roaster.statusReason].filter(Boolean).join(" · ") : undefined}
      site={q?.site ? (lang === "en" ? q.site.nameEn || q.site.nameAr : q.site.nameAr) : null}
      conn={conn} updated={updated || "—"} updatedWord={t("lastUpdate")}
      emp={{ name: user.name, tag: onDevice ? t("stationSession") : t("personalSession") }}
      lockLabel={t("lock")} switchLabel={t("switchEmployee")}
      onLock={() => void lock()} onSwitch={() => switchEmployee()}
    />
  );
  const steps = [t("stepConfirm"), t("stepRoast"), t("stepWeights"), t("stepQc")];
  const itemSub = (i: QueueItem | null, long = false): ReactNode => {
    if (!i) return null;
    const refs: ReactNode[] = [];
    if (i.productionNumber) refs.push(<Bid key="po">{i.productionNumber}</Bid>);
    if (i.forStock) refs.push(<span key="stock">{t("forStock")}</span>);
    if (i.orders.length) refs.push(<span key="o">{t("forOrders", { orders: "" })}{i.orders.map((o, n) => <span key={n}>{n ? " · " : ""}<Bid>#{o.orderNumber}</Bid></span>)}{long && i.orders[0] ? ` · ${i.orders[0].customerName}` : ""}</span>);
    if (i.needKg > 0) refs.push(<span key="n">{t("neededRoasted", { kg: k2(i.needKg) })}</span>);
    return refs.map((r, n) => <span key={n}>{n ? " · " : ""}{r}</span>);
  };
  const roasterStatus = (r: StationRoaster | null) => !r ? { tone: "", label: t("noRoaster") }
    : r.status === "AVAILABLE" ? { tone: "ok", label: t("roasterAvailable") }
    : r.status === "MAINTENANCE" ? { tone: "wa", label: t("roasterMaintenance") } : { tone: "er", label: t("roasterStopped") };
  const errBox = err ? <Info tone="err" title={err} testId="station-error" /> : null;
  const offlineBox = !online ? <Info tone="err" title={t("offlineTitle")} testId="station-offline">{t("offlineBody", { time: updated || "—" })}</Info> : null;

  // ── S7 not authorised ───────────────────────────────────────────────────────────────────
  if (unauth !== false) {
    // S7. On a station device the session ends and the tiles come back; the server's words say why
    // (not assigned, or — UR-S17 — assigned without the module privilege).
    return (<>{bar}
      <Sheet plain testId="station-unauth" foot={<><Primary onClick={() => void signOut()} testId="station-signout">{onDevice ? t("s7Back") : t("signOut")}</Primary><Note>{onDevice ? t("s7Note") : t("unauthNote")}</Note></>}>
        <div className="ws-done" style={{ maxWidth: 640 }}>
          <span className="ws-mark-warn" aria-hidden="true">!</span>
          <h1 className="ws-t2" style={{ fontSize: 28, lineHeight: "38px" }}>{onDevice && unauth.code !== "STATION_NOT_ASSIGNED" && unauth.text ? unauth.text : t("unauthTitle", { name: user.name })}</h1>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 15, lineHeight: "24px" }}>{onDevice ? (unauth.code === "STATION_NOT_ASSIGNED" ? t("s7Body", { station: station?.name ?? "" }) : "") : t("unauthBody")}</p>
        </div>
      </Sheet></>);
  }
  if (!q) {
    return (<>{bar}<Sheet plain>{loadErr ? <div className="ws-done"><b>{t("loadFailed")}</b><button type="button" className="btn" onClick={() => void load(true)}>{t("retry")}</button></div> : offlineBox ?? <span role="status">{t("loading")}</span>}</Sheet></>);
  }

  const items = q.items;
  // Today's slots of the schedule come first (Figma R1 649:258), then the live demand.
  const slots = q.slots ?? [];
  const startable = [...slots, ...items].filter((i) => !i.blocked && i.key !== mine?.item?.key);
  const openItem = view.v === "start" ? [...slots, ...items].find((i) => i.key === view.key) ?? null : null;
  const hhmm = (d: string) => time(d, false);
  const whyText = (i: QueueItem): string => {
    switch (i.blocked) {
      case "AWAITING_TRANSFER": return L("بانتظار تحويل البن إلى موقع الإنتاج", "Waiting for the green to be transferred to the production site");
      case "GREEN_SHORT": return `${L("تواصل مع المشرف", "Contact the supervisor")} · ${t("whyGreenShort", { have: k2(i.greenAvailableKg), need: k2(i.plannedGreenKg ?? 0) })}`;
      case "NO_GREEN_SOURCE": return `${L("تواصل مع المشرف", "Contact the supervisor")} · ${t("whyNoGreen")}`;
      case "WAITING_ORDER": return t("whyWaitingOrder");
      case "STOCK_NOT_ALLOWED": return t("whyStock");
      case "CLAIMED": return t("whyClaimed", { name: i.claim?.claimedByName ?? "", time: i.claim ? time(i.claim.claimedAt, false) : "" });
      default: return "";
    }
  };
  const drawFromLine = (i: QueueItem): ReactNode => {
    const g0 = i.green!;
    const site = lang === "ar" ? g0.siteNameAr : g0.siteNameEn || g0.siteNameAr;
    return <>{L("اسحب من: ", "Draw from: ")}<bdi>{lang === "ar" ? g0.nameAr || g0.nameEn : g0.nameEn}</bdi> · <Bid>{g0.code || g0.serial}</Bid>{site ? <> · {site}</> : null}</>;
  };
  const drawFromSub = (i: QueueItem): ReactNode => {
    const g0 = i.green!;
    const sacks = g0.sacks ? (g0.sacks.from === g0.sacks.to ? L(`الكيس ${g0.sacks.from} من ${g0.sacks.of}`, `Sack ${g0.sacks.from} of ${g0.sacks.of}`) : L(`الأكياس ${g0.sacks.from}–${g0.sacks.to} من ${g0.sacks.of}`, `Sacks ${g0.sacks.from}–${g0.sacks.to} of ${g0.sacks.of}`)) : null;
    return <>{[sacks, g0.code ? g0.serial : null, t("cardGreenS", { kg: k2(g0.availableKg) }), g0.fallback ? L("اللوت الافتراضي لا يكفي: الأقدم من نفس البن", "The default lot is short: the oldest of the same coffee") : null].filter(Boolean).join(" · ")}</>;
  };
  const greenWaitBody = (i: QueueItem): ReactNode => i.greenWait ? <>
    {lang === "ar" ? i.greenWait.ar : i.greenWait.en}
    {i.greenWait.transferHref ? <> <a className="ops-link" href={i.greenWait.transferHref} target="_blank" rel="noreferrer" data-testid="station-transfer-link">{L("حوّل الآن", "Transfer now")}</a></> : null}
  </> : whyText(i);
  const stateLabel = (s: string) => s === "PAUSED" ? t("paused") : s === "STOPPED_MALFUNCTION" ? t("malfunction") : s === "RELEASE_REQUESTED" ? t("releaseRequested") : t("roasting");

  // ── R1 queue ────────────────────────────────────────────────────────────────────────────
  if (view.v === "queue") {
    const rs = roasterStatus(roaster);
    const first = startable[0] ?? null;
    const rows: ReactNode[] = [];
    if (mine) {
      rows.push(<Row key="mine" on testId="queue-row-mine" onClick={() => setView({ v: "active" })}
        title={<bdi>{name(item) || t("rowMine")}</bdi>} sub={<>{itemSub(item)}{item?.plannedGreenKg ? <> · {t("plannedGreen", { kg: k2(item.plannedGreenKg) })}</> : null}</>}
        right={<span className={`st ws-st ${mine.state === "ROASTING" ? "in" : "wa"}`}>{mine.state === "ROASTING" ? t("rowMine") : stateLabel(mine.state)}</span>} />);
    }
    slots.forEach((i) => {
      const s = i.slot!;
      const isFirst = !mine && first?.key === i.key;
      const otherOperator = s.operatorId !== user.id && s.operatorName ? <> · {t("slotOperator", { name: s.operatorName })}</> : null;
      rows.push(<Row key={i.key} on={isFirst} dim={!!i.blocked} testId={`queue-slot-${s.id}`} onClick={() => { setErr(""); setView({ v: "start", key: i.key }); }}
        title={<><span className="n ws-row-time" data-testid="queue-slot-time">{hhmm(s.startsAt)}</span><bdi>{name(i)}</bdi></>}
        sub={<>{itemSub(i)}{i.forStock || i.orders.length || i.needKg > 0 ? " · " : ""}{i.blocked ? whyText(i) : t("plannedGreen", { kg: k2(s.plannedGreenKg) })}{otherOperator}</>}
        right={<span className={`st ws-st ${i.blocked ? (i.blocked === "CLAIMED" ? "wa" : "er") : isFirst ? "in" : s.status === "IN_PROGRESS" ? "wa" : ""}`}>{i.blocked ? (i.blocked === "CLAIMED" ? t("rowClaimedBy", { name: i.claim?.claimedByName ?? "" }) : t("rowBlocked")) : isFirst ? t("rowNext") : s.status === "IN_PROGRESS" ? t("slotInProgress") : t("planned")}</span>} />);
    });
    items.filter((i) => i.key !== mine?.item?.key).forEach((i) => {
      const isFirst = !mine && first?.key === i.key;
      rows.push(<Row key={i.key} on={isFirst} dim={!!i.blocked} testId={`queue-row-${i.itemId}`} onClick={() => { setErr(""); setView({ v: "start", key: i.key }); }}
        title={<bdi>{name(i)}</bdi>}
        sub={<>{itemSub(i)}{i.blocked ? <> · {whyText(i)}</> : i.plannedGreenKg ? <> · {t("plannedGreen", { kg: k2(i.plannedGreenKg) })}</> : null}</>}
        right={<span className={`st ws-st ${i.blocked ? (i.blocked === "CLAIMED" ? "wa" : "er") : isFirst ? "in" : ""}`}>{i.blocked ? (i.blocked === "CLAIMED" ? t("rowClaimedBy", { name: i.claim?.claimedByName ?? "" }) : t("rowBlocked")) : isFirst ? t("rowNext") : t("rowQueued")}</span>} />);
    });
    const nBlocked = [...slots, ...items].filter((i) => i.blocked).length;
    return (<>{bar}
      <Sheet testId="station-queue"
        head={<Head title={roaster ? `${t("queueTitle")} · ${roaster.name}` : t("queueTitle")} sub={<>{dateLine} · {t("queueCount", { n: slots.length + items.length + (mine && !items.some((i) => i.key === mine.item?.key) ? 1 : 0) })}</>} status={rs} since={<>{t("lastUpdate")} <Num>{updated}</Num></>} />}
        foot={<>
          {mine
            ? <Primary onClick={() => setView({ v: "active" })} testId="queue-continue">{t("continueMine", { name: name(item) })}</Primary>
            : <Primary disabled={!first || !online} onClick={() => first && setView({ v: "start", key: first.key })} testId="queue-open-next">{first ? t("openNext", { name: name(first) }) : t("queueEmpty")}</Primary>}
          <Secondary onClick={() => setView({ v: "blocked" })} testId="queue-blocked">{t("blockedBtn", { n: nBlocked })}</Secondary>
          <Note>{slots.length ? t("queueNoteSlots") : t("queueNote")}</Note>
        </>}>
        <div className="ws-split">
          <div className="ws-col" style={{ gap: 12 }}>
            {offlineBox}
            {rows.length ? <div className="ws-rows" data-testid="queue-rows">{rows}</div> : <Info tone="muted" title={t("queueEmpty")} testId="queue-empty">{t("queueEmptyBody")}</Info>}
          </div>
          <Side title={t("todayTitle")}>
            <SideLine>{t("todayDone", { n: q.today.batches, r: q.today.rejected })}</SideLine>
            <SideLine>{roaster ? (roaster.status === "AVAILABLE" ? t("todayCapacity", { kg: k2(roaster.defaultTargetKg) }) : t("todayCapacityOff", { state: rs.label, kg: k2(roaster.defaultTargetKg) })) : t("todayNoRoaster")}</SideLine>
            <SideLine>{t("todayBlocked", { n: nBlocked })}</SideLine>
            {q.roasters.length > 1 && !onDevice ? (
              <Chips label={t("chooseRoaster")} value={roaster?.id ?? null} options={q.roasters.map((r) => ({ value: r.id, label: r.name }))}
                onChange={(v) => { setRoasterId(v); try { sessionStorage.setItem("hq.station.roaster", v); } catch { /* */ } }} testId="roaster-choice" />
            ) : null}
          </Side>
        </div>
      </Sheet></>);
  }

  // ── R5 blocked ──────────────────────────────────────────────────────────────────────────
  if (view.v === "blocked") {
    const list = [...slots, ...items].filter((i) => i.blocked);
    const mineStopped = mine && mine.state !== "ROASTING" ? mine : null;
    const n = list.length + (mineStopped ? 1 : 0);
    return (<>{bar}
      <Sheet testId="station-blocked"
        head={<Head title={t("blockedTitle")} sub={t("blockedSub")} status={{ tone: n ? "er" : "", label: t("blockedCount", { n }) }} />}
        foot={<><Primary onClick={() => setView({ v: "queue" })} testId="blocked-back">{t("backToQueue")}</Primary><Note>{t("blockedNote")}</Note></>}>
        <div className="ws-rows" style={{ gap: 12 }}>
          {mineStopped ? <Row key="mine" onClick={() => setView({ v: "active" })} title={<bdi>{name(item)}</bdi>}
            sub={mineStopped.state === "PAUSED" ? t("whyPaused") : mineStopped.state === "STOPPED_MALFUNCTION" ? t("whyMalfunction") : t("whyRelease")}
            right={<span className="st ws-st wa">{stateLabel(mineStopped.state)}</span>} /> : null}
          {list.map((i) => (
            <Row key={i.key} testId={`blocked-row-${i.itemId}`} onClick={() => { setErr(""); setView({ v: "start", key: i.key }); }}
              title={<bdi>{name(i)}</bdi>} sub={<>{itemSub(i)} · {whyText(i)}</>}
              right={<span className={`st ws-st ${i.blocked === "WAITING_ORDER" || i.blocked === "CLAIMED" ? "wa" : "er"}`}>{i.blocked === "WAITING_ORDER" ? t("stWaitingOrder") : i.blocked === "CLAIMED" ? t("stClaimed") : t("stBlocked")}</span>} />
          ))}
          {n === 0 ? <Info tone="muted" title={t("blockedNone")} /> : null}
        </div>
      </Sheet></>);
  }

  // ── R2 start / start blocked ────────────────────────────────────────────────────────────
  if (view.v === "start") {
    const i = openItem;
    if (!i) { setTimeout(() => setView({ v: "queue" }), 0); return null; }
    const roasterOff = !!roaster && roaster.status !== "AVAILABLE";
    const notOperator = !!roaster && !roaster.assigned && user.role !== "admin";
    const why = i.blocked ?? (roasterOff ? "ROASTER" : notOperator ? "OPERATOR" : mine ? "ONE_ACTIVE" : null);
    const blocked = !!why;
    const expected = i.expectedLossPct;
    return (<>{bar}
      <Sheet testId="station-start"
        head={<Head title={<bdi>{name(i)}</bdi>} sub={itemSub(i, true)} steps={{ items: steps, cur: 0 }} status={blocked ? { tone: "er", label: t("rowBlocked") } : { tone: "", label: i.slot?.status === "IN_PROGRESS" ? t("slotInProgress") : t("planned") }} since={i.slot ? t("slotPlannedAt", { time: hhmm(i.slot.startsAt) }) : t("inQueueSince")} />}
        foot={<>
          {blocked
            ? <Primary disabled testId="start-blocked">{why === "AWAITING_TRANSFER" ? L("بانتظار تحويل", "Waiting for a transfer") : why === "GREEN_SHORT" || why === "NO_GREEN_SOURCE" ? L("تواصل مع المشرف", "Contact the supervisor") : t("cannotStart")}</Primary>
            : <Primary onClick={() => void start(i)} wait={busy} disabled={!online} testId="start-roast">{t("startBtn")}</Primary>}
          <Secondary onClick={() => { setErr(""); setView({ v: "queue" }); }} testId="start-back">{t("backToQueue")}</Secondary>
          <Note>{t("startNote")}</Note>
        </>}>
        <div className="ws-col" style={{ gap: 12 }}>
          {roaster
            ? <Confirm ok={!roasterOff && !notOperator} title={t("cardRoaster", { name: roaster.name })} sub={roasterOff ? t("cardRoasterOff") : t("cardRoasterOk", { kg: k2(roaster.defaultTargetKg) })} />
            : <Confirm ok title={t("cardNoRoaster")} sub={t("cardNoRoasterS")} />}
          <Confirm ok={!i.blocked}
            title={i.green ? drawFromLine(i) : t("cardGreenNone")}
            sub={i.green ? drawFromSub(i) : t("cardGreenS", { kg: k2(i.greenAvailableKg) })} />
          <div style={{ marginTop: 8 }}>
            <Facts plain items={[
              [t("factPlanned"), i.plannedGreenKg ? t("factPlannedV", { kg: k2(i.plannedGreenKg) }) : "—"],
              [t("factExpectedLoss"), t("factExpectedLossV", { pct: pct(expected), limit: pct(expected + 5) })],
              [t("factOperator"), user.name],
            ]} />
          </div>
          {why === "AWAITING_TRANSFER" ? <Info tone="warn" title={L("بانتظار تحويل", "Waiting for a transfer")} testId="start-why">{greenWaitBody(i)}</Info>
            : why === "GREEN_SHORT" || why === "NO_GREEN_SOURCE" ? <Info tone="err" title={L("تواصل مع المشرف", "Contact the supervisor")} testId="start-why">{greenWaitBody(i)}</Info>
            : why === "OPERATOR" ? <Info tone="err" title={t("startBlockedOperator")} testId="start-why">{L("اطلب من المسؤول ربطك بها من إعدادات الحمّاصات.", "Ask the administrator to assign you in the roaster settings.")}</Info>
            : why === "ROASTER" ? <Info tone="err" title={t("startBlockedRoaster")} testId="start-why">{roasterStatus(roaster).label}{roaster?.statusReason ? ` · ${roaster.statusReason}` : ""}</Info>
            : why ? <Info tone="err" title={t("startBlockedOther")} testId="start-why">{why === "ONE_ACTIVE" ? L("لديك دفعة نشطة. أنهِها أو حرّرها قبل بدء أخرى.", "You already have an active roast. Finish or release it first.") : whyText(i)}</Info>
            : <Info tone="muted" title={t("startInfo")}>{t("startInfoB")}</Info>}
          {!blocked && roaster && !roaster.assigned && user.role === "admin" ? <Info tone="warn" title={t("adminNotAssigned")} /> : null}
          {offlineBox}{errBox}
        </div>
      </Sheet></>);
  }

  // Everything below works on the caller's own claim.
  if (!mine && ["active", "weights", "problem"].includes(view.v)) { setTimeout(() => setView({ v: "queue" }), 0); return null; }

  const startedAt = mine ? time(mine.claimedAt, false) : "";
  const elapsedMs = mine ? Math.max(0, now - new Date(mine.claimedAt).getTime()) : 0;
  const nextItem = startable[0] ?? null;
  const rFacts: [ReactNode, ReactNode][] = [
    [t("factRoaster"), roaster?.name ?? "—"],
    [t("factPlanned"), item?.plannedGreenKg ? t("factPlannedV", { kg: k2(item.plannedGreenKg) }) : "—"],
    [t("factOperator"), user.name],
  ];

  // «اسحب من»: the server's own pick (the same function the roast POST applies), or the scanned override.
  const drawFrom = draft.lot
    ? <Info tone="info" title={<>{L("اسحب من: ", "Draw from: ")}{lang === "ar" ? draft.lot.nameAr || draft.lot.nameEn : draft.lot.nameEn} · <Bid>{draft.lot.code || draft.lot.serial}</Bid></>} testId="station-draw-from">{L("الكيس الممسوح (بدل المقترح)", "The scanned sack (instead of the suggested one)")}</Info>
    : item?.green ? <Info tone="info" title={drawFromLine(item)} testId="station-draw-from">{drawFromSub(item)}</Info>
    : item?.greenWait ? <Info tone="warn" title={L("بانتظار البن", "Waiting for the green")} testId="station-draw-from">{greenWaitBody(item)}</Info>
    : null;

  // ── R3 active ───────────────────────────────────────────────────────────────────────────
  if (view.v === "active" && mine) {
    const stopped = mine.state !== "ROASTING";
    const mm = Math.floor(elapsedMs / 60000), ss = Math.floor((elapsedMs % 60000) / 1000);
    return (<>{bar}
      <Sheet testId="station-active"
        head={<Head title={<bdi>{name(item)}</bdi>} sub={itemSub(item, true)} steps={{ items: steps, cur: 1 }} status={{ tone: stopped ? "wa" : "in", label: stateLabel(mine.state) }} since={t("startedAt", { time: startedAt, name: user.name })} />}
        foot={stopped ? <>
          <Primary onClick={() => void claimAction("resume")} wait={busy} disabled={!online} testId="active-resume">{t("resume")}</Primary>
          <Secondary onClick={() => void claimAction("release")} testId="active-release" disabled={busy || !online}>{t("releaseTask")}</Secondary>
          <Note>{t("everyAction")}</Note>
        </> : <>
          <Primary onClick={() => {
            setErr(""); setStage("entry");
            // From a slot: the green field starts at the slot's planned green (the operator weighs and corrects it).
            if (!draft.green && mine.slot) setDraft({ green: cleanWeight(String(+mine.slot.plannedGreenKg.toFixed(3))) });
            setView({ v: "weights" });
          }} testId="active-finish">{t("finishRoast")}</Primary>
          <Secondary onClick={() => { setErr(""); setView({ v: "problem" }); }} testId="active-problem">{t("reportProblem")}</Secondary>
          <Note>{nextItem ? t("nextOnRoaster", { name: name(nextItem) }) : t("noNext")}</Note>
        </>}>
        <div className="ws-col" style={{ gap: 20 }}>
          {drawFrom}
          <Facts items={rFacts} />
          <div className="ws-timer">
            <div className="lbl">{t("sinceStart")}</div>
            <div className="ws-clock" data-testid="active-timer">{String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}</div>
            <div className="ws-timer-s">{t("infoOnly", { time: startedAt })}</div>
          </div>
          {stopped ? <Info tone="warn" title={t("pausedInfo")}>{t("pausedInfoB")}</Info> : <Info tone="muted" title={t("activeInfo")}>{t("activeInfoB")}</Info>}
          {offlineBox}{errBox}
        </div>
      </Sheet></>);
  }

  // ── R4 weights: entry · waiting · loss above the boundary · S6 offline ──────────────────
  if (view.v === "weights" && mine) {
    const wait = stage === "wait";
    const off = wait;
    const fieldFocus = stage === "loss" ? null : focus;
    const draftHint = !online ? t("draftHint") : undefined;
    const lossBox = loss ? (
      <div className={`ws-loss${loss.tone === "above" ? " warn" : ""}`} data-testid="weights-loss" style={stage === "loss" ? { marginTop: 0 } : undefined}>
        <div><div className="lbl">{t("lossComputed")}</div><div style={{ marginTop: 6 }}><span className="mid">{k2(loss.kg)}</span><span className="unit">{t("kg")}</span><span className="mid" style={{ marginInlineStart: 16 }}>{pct(loss.pct)}</span></div></div>
        <div style={{ flex: 1 }} />
        <div className="ws-loss-r">
          <span className={`st ws-st ${loss.tone === "above" ? "wa" : loss.tone === "below" ? "wa" : "ok"}`}>{loss.tone === "above" ? t("lossAbove") : loss.tone === "below" ? t("lossBelow") : t("lossOk")}</span>
          <div>{loss.tone === "above" ? t("lossAboveNote", { limit: pct(loss.limit) }) : t("lossExpected", { pct: pct(loss.expected), limit: pct(loss.limit) })}</div>
        </div>
      </div>
    ) : null;
    const capBox = roaster && cap === "over" ? <Info tone="err" title={t("overNominal", { kg: k2(g), name: roaster.name, nominal: k2(roaster.nominalKg) })} testId="weights-capacity" />
      : roaster && (cap === "outside" || needAck) ? (
        <Info tone="warn" title={t("outsideRange", { kg: k2(g), name: roaster.name, min: k2(roaster.minKg), max: k2(roaster.maxKg) })} testId="weights-ack">
          <div style={{ marginBottom: 10 }}>{t("outsideRangeB")}</div>
          <Chips label={t("ackLabel")} value={draft.ack ? "ack" : null} options={[{ value: "ack", label: t("ackLabel") }]} onChange={() => setDraft({ ack: !draft.ack })} testId="weights-ack-choice" />
        </Info>
      ) : null;
    const fields = (
      <div className="ws-fields" style={stage === "loss" ? { marginTop: 0 } : undefined}>
        <BigField id="ws-green" testId="weights-green" label={t("greenActual")} value={draft.green} unit={t("kg")} focus={fieldFocus === "green"} off={off}
          bad={cap === "over"} hint={draftHint ?? t("greenHint")} onFocus={() => setFocus("green")} onChange={(v) => setDraft({ green: cleanWeight(v) })} />
        <BigField id="ws-roasted" testId="weights-roasted" label={t("roastedActual")} value={draft.roasted} unit={t("kg")} focus={fieldFocus === "roasted"} off={off}
          hint={draftHint ?? t("roastedHint")} onFocus={() => setFocus("roasted")} onChange={(v) => setDraft({ roasted: cleanWeight(v) })} />
      </div>
    );
    const lossOptions = LOSS_REASONS.map((r) => ({ value: r as string, label: t(`loss${r}` as StationKey) }));
    const head = <Head title={<bdi>{name(item)}</bdi>} sub={itemSub(item, true)} steps={{ items: steps, cur: 2 }} status={{ tone: "in", label: t("awaitingWeights") }}
      since={t("roastStartedAgo", { time: startedAt, min: Math.floor(elapsedMs / 60000) })} />;

    if (stage === "loss") {
      return (<>{bar}
        <Sheet testId="station-loss" head={head}
          foot={<>
            <Primary disabled={!draft.lossReason || !online} wait={busy} onClick={() => void record()} testId="weights-submit">{t("finishSend")}</Primary>
            <Secondary onClick={() => { setStage("entry"); setFocus("roasted"); }} testId="weights-fix">{t("fixWeight")}</Secondary>
            <Note>{t("lossNote")}</Note>
          </>}>
          <div className="ws-col" style={{ gap: 16 }}>
            {fields}{lossBox}
            <div>
              <div className="ws-lab">{t("lossReason")} <span className="ws-req">*</span></div>
              <Chips label={t("lossReason")} value={draft.lossReason} options={lossOptions} onChange={(v) => setDraft({ lossReason: v })} testId="loss-reason" />
            </div>
            {errBox}
          </div>
        </Sheet></>);
    }

    const primary = !online
      ? <Primary disabled testId="weights-submit">{t("waitingConn")}</Primary>
      : wait ? <Primary wait testId="weights-submit">{t("sending")}</Primary>
      : cap === "over" ? <Primary disabled testId="weights-submit">{t("overNominalBtn")}</Primary>
      : <Primary disabled={!weightsReady} onClick={() => void record()} testId="weights-submit">{t("finishSend")}</Primary>;
    return (<>{bar}
      <Sheet testId={!online ? "station-offline-draft" : wait ? "station-wait" : "station-weights"} head={head}
        foot={<>
          {primary}
          {!wait && online ? <Secondary onClick={() => { setErr(""); setView({ v: "problem" }); }} testId="weights-problem">{t("reportProblem")}</Secondary> : null}
          <Note>{!online ? t("offlineNote") : t("weightsNote")}</Note>
        </>}>
        <div className="ws-split">
          <div className="ws-col">
            {!online ? <div style={{ marginBottom: 16 }}>{offlineBox}</div> : <>{drawFrom}<div style={{ marginTop: 12 }}><Facts items={rFacts} /></div></>}
            {/* The sack scan only when the owner turned it on (Settings › Production, «تأكيد الكيس بالمسح»), and then only as
                an override — «كيس غير المقترح» — never a step: without it the server's pick is recorded. */}
            {online && !wait && q.lotScan ? (
              scanOpen || draft.lot
                ? <div style={{ marginTop: 12 }}><StationLotScan lang={lang} productId={item?.productId ?? null} greenKg={g} roasterId={roaster?.id ?? null}
                    auto={item?.green ? { serial: item.green.serial, nameAr: item.green.nameAr, nameEn: item.green.nameEn } : null}
                    lot={draft.lot ?? null} onLot={(l) => setDraft({ lot: l })} /></div>
                : <div style={{ marginTop: 12 }}><Secondary onClick={() => setScanOpen(true)} testId="station-lot-override">{L("كيس غير المقترح؟ امسحه", "A different sack? Scan it")}</Secondary></div>
            ) : null}
            <div style={!online ? undefined : undefined}>{fields}</div>
            {online ? lossBox : null}
            <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
              {!online ? <Info tone="muted" title={t("draftTitle")}>{t("draftBody")}</Info> : null}
              {wait ? <Info tone="info" title={t("waitTitle")} testId="weights-wait">{t("waitBody")}</Info> : null}
              {online && !wait ? capBox : null}
              {errBox}
            </div>
          </div>
          <div style={{ flex: "none" }}>
            <Keypad label={t("entersInto", { field: focus === "green" ? t("greenActual") : t("roastedActual") })} onKey={onKey} off={wait} delLabel={t("del")} />
          </div>
        </div>
      </Sheet></>);
  }

  // ── R4 recorded ─────────────────────────────────────────────────────────────────────────
  if (view.v === "done" || (view.v === "recovery" && view.found)) {
    const b = view.v === "done" ? view.batch : view.found!;
    const doneItem = view.v === "done" ? view.item : item;
    if (view.v === "recovery") {
      const v = view;
      return (<>{bar}
        <Sheet plain testId="station-recovery" foot={<><Primary onClick={() => setView({ v: "done", batch: b, item: doneItem, lossTone: "ok", at: v.at })} testId="recovery-continue">{t("continue")}</Primary><Note>{t("recoveryNote")}</Note></>}>
          <div className="ws-plain-w">
            <Head title={t("recoveryTitle")} sub={t("recoverySub")} />
            <LogRows lines={[[t("recBack"), v.back], [t("recAsked"), v.asked], [<>{t("recFound", { time: v.at, batch: "" })}<Bid>{b.batchNumber}</Bid></>, v.asked]]} />
            <Info tone="muted" title={t("recInfoFound")}>{t("recInfoFoundB")}</Info>
          </div>
        </Sheet></>);
    }
    const lossKg = b.wasteQuantity ?? +(b.greenBeanQuantity - b.roastedBeanQuantity).toFixed(3);
    const lossPct = b.greenBeanQuantity > 0 ? (lossKg / b.greenBeanQuantity) * 100 : 0;
    return (<>{bar}
      <Sheet testId="station-done"
        head={<Head title={<bdi>{name(doneItem)}</bdi>} sub={itemSub(doneItem, true)} steps={{ items: steps, cur: 4 }} status={{ tone: "in", label: t("awaitingQc") }} since={t("recordedAt", { time: view.at })} />}
        foot={<>
          {nextItem ? <Primary onClick={() => setView({ v: "start", key: nextItem.key })} testId="done-next">{t("startNext", { name: name(nextItem) })}</Primary>
            : <Primary onClick={() => setView({ v: "queue" })} testId="done-next">{t("viewQueue")}</Primary>}
          {nextItem ? <Secondary onClick={() => setView({ v: "queue" })} testId="done-queue">{t("viewQueue")}</Secondary> : null}
          <Note>{nextItem ? t("nextNote", { name: name(nextItem) }) : t("noNext")}</Note>
        </>}>
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <div className="ws-done">
            <DoneMark />
            <div className="ws-done-t">{t("recordedTitle")}</div>
            <div className="ws-done-n" data-testid="done-batch">{b.batchNumber}</div>
            <span className="st ws-st in">{t("awaitingQcNA")}</span>
            <div className="ws-summary">
              <Facts items={[
                [t("sumGreen"), <>{t("sumGreenV", { kg: k2(b.greenBeanQuantity), lot: "" })}<Bid>{b.greenBean?.serialNumber ?? ""}</Bid></>],
                [t("sumRoasted"), t("sumRoastedV", { kg: k2(b.roastedBeanQuantity) })],
                [t("sumLoss"), <><Num>{k2(lossKg)}</Num> {t("kg")} · <Num>{pct(lossPct)}</Num> · {view.lossTone === "above" ? t("sumLossAbove") : t("sumLossNormal")}</>],
                [t("sumBy"), <>{user.name} · <Num>{view.at}</Num></>],
              ]} />
            </div>
            <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{t("recordedNote")}<BatchLabelPrint permissions={user.permissions} productId={b.productId ?? doneItem?.productId} productLabel={name(doneItem)} batch={{ id: b.id, batchNumber: b.batchNumber }}
              buttonLabel={t("printLabel")} unavailable={<> · {t("labelsUnavailable")}</>} className="btn" testId="done-print-label" /></div>
          </div>
        </div>
      </Sheet></>);
  }

  // ── S6 recovery: the action never arrived ───────────────────────────────────────────────
  if (view.v === "recovery") {
    const v = view;
    return (<>{bar}
      <Sheet plain testId="station-recovery" foot={<><Primary onClick={() => { setView({ v: "weights" }); void record(); }} disabled={!online} testId="recovery-resend">{t("resend")}</Primary><Secondary onClick={() => setView({ v: "weights" })}>{t("cancel")}</Secondary><Note>{t("recoveryNote")}</Note></>}>
        <div className="ws-plain-w">
          <Head title={t("recoveryTitle")} sub={t("recoverySub")} />
          <LogRows lines={[[t("recBack"), v.back], [t("recAsked"), v.asked], [t("recNotFound"), v.asked]]} />
          <Info tone="muted" title={t("recInfoNot")}>{t("recInfoNotB")}</Info>
        </div>
      </Sheet></>);
  }

  // ── R7 report a problem ─────────────────────────────────────────────────────────────────
  if (view.v === "problem" && mine) {
    const kinds: { k: ProblemKind; title: StationKey; desc: StationKey }[] = [
      { k: "PAUSE", title: "optPause", desc: "optPauseS" },
      { k: "MALFUNCTION", title: "optMalfunction", desc: "optMalfunctionS" },
      { k: "RELEASE_REQUEST", title: "optRelease", desc: "optReleaseS" },
    ];
    const stateAfter = problemKind === "PAUSE" ? t("paused") : problemKind === "MALFUNCTION" ? t("malfunction") : problemKind === "RELEASE_REQUEST" ? t("releaseRequested") : "—";
    return (<>{bar}
      <Sheet testId="station-problem"
        head={<Head title={t("problemTitle", { name: name(item) })} sub={<>{itemSub(item)} · {t("problemSub", { time: startedAt })}</>} />}
        foot={<>
          <Primary disabled={!problemKind || !problemReason || !online} wait={busy} onClick={() => void sendProblem()} testId="problem-send">{t("sendReport")}</Primary>
          <Secondary onClick={() => setView({ v: "active" })} testId="problem-back">{t("cancel")}</Secondary>
          <Note>{t("reportNote")}</Note>
        </>}>
        <div className="ws-split">
          <div className="ws-col" style={{ gap: 12 }}>
            {kinds.map((o) => <Option key={o.k} on={problemKind === o.k} onClick={() => setProblemKind(o.k)} title={t(o.title)} desc={t(o.desc)} testId={`problem-kind-${o.k}`} />)}
            <div style={{ marginTop: 4 }}>
              <div className="ws-lab">{t("whatHappened")} <span className="ws-req">*</span></div>
              <Chips label={t("whatHappened")} value={problemReason} options={PROBLEM_REASONS.map((r) => ({ value: r as string, label: t(`r${r}` as StationKey) }))} onChange={setProblemReason} testId="problem-reason" />
            </div>
            {offlineBox}{errBox}
          </div>
          <Side title={t("recordedSide")} stretch>
            <SideLine>{t("recEmployee", { name: user.name })}</SideLine>
            <SideLine>{t("recTime")}</SideLine>
            <SideLine>{t("recReason", { reason: problemReason ? t(`r${problemReason}` as StationKey) : "—" })}</SideLine>
            <SideLine>{t("recState", { state: stateAfter })}</SideLine>
            <SideLine>{t("recStock")}</SideLine>
          </Side>
        </div>
      </Sheet></>);
  }

  // ── R7 report recorded ──────────────────────────────────────────────────────────────────
  if (view.v === "problemDone") {
    const v = view;
    const kindLabel = v.kind === "PAUSE" ? t("optPause") : v.kind === "MALFUNCTION" ? t("optMalfunction") : t("optRelease");
    const stateL = v.kind === "PAUSE" ? t("paused") : v.kind === "MALFUNCTION" ? t("malfunction") : t("releaseRequested");
    return (<>{bar}
      <Sheet plain testId="station-problem-done" foot={<><Primary onClick={() => setView({ v: "queue" })} testId="problem-done-back">{t("backToQueue")}</Primary><Note>{t("everyAction")}</Note></>}>
        <div className="ws-plain-w">
          <Head title={t("reportDone")} sub={<><bdi>{name(v.item)}</bdi>{v.item ? <> · {itemSub(v.item)}</> : null}</>} status={{ tone: "wa", label: stateL }} since={t("confirmedAt", { time: v.at })} />
          <LogRows lines={[
            [t("reportLine1", { name: user.name, kind: kindLabel, reason: t(`r${v.reason}` as StationKey) }), v.at],
            [t("reportLine2", { state: stateL }), v.at],
            [t("reportLine3"), v.at],
          ]} />
          <Info tone="muted" title={t("reportDoneInfo")}>{t("reportDoneInfoB")}</Info>
        </div>
      </Sheet></>);
  }

  setTimeout(() => setView({ v: "queue" }), 0);
  return null;
}
