"use client";
// Packaging station (Phase 9 W4): two tabs that never share a queue or an action.
//   «التعبئة» — PA1 released batches, PA2 the packaging task with the material check (and its
//   shortage state), PA3 packed. Packs through the ERP's one packaging operation.
//   «تجهيز الطلبات» — P1 the queue, P2 picking with lot verification (W1: last four only on a unique
//   match; P3 ambiguous → the full number; P3 wrong lot → refused), P7 partial, P4 prepared, P6
//   handed to dispatch (J-18). Nothing here moves stock; the delivery stays in the ERP dispatch page.
//   P5 «المتوقفة» lists what blocks either tab, with the reason and who releases it.
// The server decides everything (H12): this screen sends raw inputs and shows only confirmed results.
// Every write carries an Idempotency-Key kept until the answer is conclusive, so a retry replays.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useStation } from "../../_ui/context";
import { st } from "@/lib/i18n/station";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { newRequestKey, isConclusiveResponse } from "@/lib/request-key";
import { StationBar, Sheet, Head, Primary, Secondary, Note, Info, Keypad, BigField, Row, Option, Chips, DoneMark, Bid, Num, CheckIco } from "../../_ui/blocks";
import { BatchLabelPrint } from "@/components/print/BatchLabelPrint";
import type { PackBatch, PackPending, PackBlocked } from "@/lib/services/station/packaging";
import type { PrepOrder, PrepQueue, MatchAnswer, HandoffView } from "@/lib/services/station/prep";

type Tab = "packaging" | "preparation";
type PackQueue = { batches: PackBatch[]; pending: PackPending[]; blocked: PackBlocked[]; serverTime: string; version: string; site?: { id: string; nameAr: string; nameEn: string | null; source: "station" | "roast" } | null };
type Api = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- API bodies are read field by field

const TZ = "Asia/Riyadh";
const kg2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const clock = (d: string | number | Date, sec = true) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}), hour12: false });
const digitsOnly = (v: string, max: number) => v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9]/g, "").slice(0, max);
const lotChars = (v: string) => v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 24);

export function PackagingStation() {
  const { user, signOut, mode, station, lock, switchEmployee } = useStation();
  const onDevice = mode === "device";
  const lang: "ar" | "en" = user.preferredLanguage === "en" ? "en" : "ar";
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);

  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [tab, setTabState] = useState<Tab>(() => { try { return sessionStorage.getItem("hq.station.pack.tab") === "preparation" ? "preparation" : "packaging"; } catch { return "packaging"; } });
  const setTab = (t: Tab) => { setTabState(t); setBlockedOpen(false); try { sessionStorage.setItem("hq.station.pack.tab", t); } catch { /* storage unavailable */ } };
  const [packQ, setPackQ] = useState<PackQueue | null>(null);
  const [prepQ, setPrepQ] = useState<PrepQueue | null>(null);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState("");
  const [unauth, setUnauth] = useState<string | false>(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(id); }, []);
  const etags = useRef<Record<string, string>>({});

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────
  const read = useCallback(async (url: string, opts: { poll?: boolean; etag?: string } = {}): Promise<Api | null> => {
    try {
      const r = await fetch(url, { cache: "no-store", headers: { ...(opts.poll ? { "x-station-poll": "1" } : {}), ...(opts.etag && etags.current[opts.etag] ? { "If-None-Match": etags.current[opts.etag] } : {}) } });
      setOnline(true);
      if (r.status === 401) { await signOut(onDevice ? "ended" : undefined); return null; }
      if (r.status === 403) { const j = await r.json().catch(() => ({})); setUnauth(localizeApiError(j, lang) ?? ""); return null; }
      if (r.status === 304) return { status: 304, body: null };
      const j = await r.json().catch(() => ({}));
      if (opts.etag && r.ok) etags.current[opts.etag] = r.headers.get("ETag") ?? "";
      return { status: r.status, body: j };
    } catch {
      setOnline(false);
      return null;
    }
  }, [signOut, onDevice, lang]);

  const load = useCallback(async (force = false, poll = false) => {
    const allowed = tabs ?? [];
    const jobs: Promise<void>[] = [];
    if (allowed.includes("packaging")) jobs.push(read("/api/station/packaging/queue", { poll, etag: force ? undefined : "pack" }).then((r) => { if (r?.status === 200) setPackQ(r.body); }));
    if (allowed.includes("preparation")) jobs.push(read("/api/station/prep/queue", { poll, etag: force ? undefined : "prep" }).then((r) => { if (r?.status === 200) setPrepQ(r.body); }));
    await Promise.all(jobs);
    setUpdated(clock(Date.now()));
  }, [tabs, read]);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- which tabs this person may work in is read once
  useEffect(() => { void read("/api/station/packaging/tabs").then((r) => { if (r?.status === 200) { const t = r.body.tabs as Tab[]; setTabs(t); if (t.length && !t.includes(tab)) setTabState(t[0]); } }); }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- the queues are read once the tabs are known
  useEffect(() => { if (tabs) void load(true); }, [tabs]);
  useEffect(() => { if (!tabs) return; const id = setInterval(() => { void load(false, true); }, online ? 15000 : 5000); return () => clearInterval(id); }, [tabs, load, online]);
  useEffect(() => {
    const off = () => setOnline(false);
    const on = () => { setOnline(true); void load(true); };
    window.addEventListener("offline", off); window.addEventListener("online", on);
    return () => { window.removeEventListener("offline", off); window.removeEventListener("online", on); };
  }, [load]);

  // ── Writes (the key stays with the action until the answer is conclusive: a retry replays) ──
  const keys = useRef<Record<string, string>>({});
  const post = useCallback(async (slot: string, url: string, body: unknown, keyed = true): Promise<Api | null> => {
    const key = keyed ? (keys.current[slot] ??= newRequestKey()) : null;
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
      setOnline(true);
      const j = await r.json().catch(() => ({}));
      if (isConclusiveResponse(r.status)) delete keys.current[slot];
      if (r.status === 401) { await signOut(onDevice ? "ended" : undefined); return null; }
      return { status: r.status, body: j };
    } catch {
      setOnline(false);
      return null;
    }
  }, [signOut, onDevice]);
  const refusal = useCallback((body: unknown) => localizeApiError(body, lang) ?? L("تعذّر تنفيذ الإجراء.", "The action could not be completed."), [lang, L]);

  // ── Chrome ────────────────────────────────────────────────────────────────────────────────
  const conn = !online ? { tone: "er" as const, label: st("offline", lang) } : busy ? { tone: "in" as const, label: st("connectedWaiting", lang) } : { tone: "ok" as const, label: st("connected", lang) };
  const packCount = packQ?.batches.length ?? 0;
  const prepCount = prepQ?.orders.filter((o) => o.state === "ready" || o.state === "preparing" || o.state === "prepared").length ?? 0;
  const tabBar = tabs && tabs.length ? (
    <div className="ws-tabs" role="tablist" aria-label={L("محطة التعبئة والتجهيز", "Packaging station")}>
      {(["preparation", "packaging"] as Tab[]).map((t) => (
        <button key={t} type="button" role="tab" className="ws-tab" aria-selected={tab === t} disabled={!tabs.includes(t)} onClick={() => setTab(t)} data-testid={`station-tab-${t}`}
          title={!tabs.includes(t) ? L("لا تملك صلاحية هذا التبويب.", "You do not hold this tab's privilege.") : undefined}>
          {t === "preparation" ? L("تجهيز الطلبات", "Order preparation") : L("التعبئة", "Packaging")}<span className="n">{t === "preparation" ? prepCount : packCount}</span>
        </button>
      ))}
    </div>
  ) : null;
  const bar = (
    <StationBar station={station?.name ?? L("محطة التعبئة والتجهيز", "Packaging & preparation station")} location={station?.place ?? undefined}
      site={packQ?.site ? L(packQ.site.nameAr, packQ.site.nameEn || packQ.site.nameAr) : null}
      siteTitle={packQ?.site && packQ.site.source !== "station" ? L(`لا موقع للمحطة: يُعبَّأ في موقع تحميص الدفعة (افتراضيًا ${packQ.site.nameAr})`, `No site set on the station: packed at the batch's roasting site (default ${packQ.site.nameEn || packQ.site.nameAr})`) : null}
      conn={conn} updated={updated || "—"} updatedWord={st("lastUpdate", lang)}
      emp={{ name: user.name, tag: onDevice ? st("stationSession", lang) : st("personalSession", lang) }}
      lockLabel={st("lock", lang)} switchLabel={st("switchEmployee", lang)} onLock={() => void lock()} onSwitch={() => switchEmployee()} extra={tabBar} />
  );
  const offlineBox = !online ? <Info tone="err" title={st("offlineTitle", lang)} testId="station-offline">{st("offlineBody", lang, { time: updated || "—" })}</Info> : null;

  if (unauth !== false || (tabs && tabs.length === 0)) {
    return (<>{bar}
      <Sheet plain testId="station-unauth" foot={<><Primary onClick={() => void signOut()} testId="station-signout">{onDevice ? st("s7Back", lang) : st("signOut", lang)}</Primary><Note>{onDevice ? st("s7Note", lang) : st("unauthNote", lang)}</Note></>}>
        <div className="ws-done" style={{ maxWidth: 640 }}>
          <span className="ws-mark-warn" aria-hidden="true">!</span>
          <h1 className="ws-t2" style={{ fontSize: 28, lineHeight: "38px" }}>{unauth || L("لا تملك صلاحية العمل في هذه المحطة.", "You do not hold this station's privilege.")}</h1>
        </div>
      </Sheet></>);
  }
  if (!tabs) return (<>{bar}<Sheet plain><span role="status">{st("loading", lang)}</span></Sheet></>);

  const shared = { lang, L, user, post, read, load, refusal, online, busy, setBusy, offlineBox, bar, onDevice, now };
  const nBlocked = (packQ?.blocked.length ?? 0) + (prepQ?.blocked.length ?? 0);

  if (blockedOpen) {
    const rows: ReactNode[] = [];
    for (const b of packQ?.blocked ?? []) {
      const nm = lang === "ar" ? b.nameAr || b.nameEn : b.nameEn;
      rows.push(<Row key={`p-${b.id}-${b.kind}`} testId={`blocked-pack-${b.batchNumber}`} title={<><bdi>{nm}</bdi> · <Bid>{b.batchNumber}</Bid></>}
        sub={b.kind === "MATERIAL_SHORT" ? L(`نقص ${b.material}: يلزم ${b.required} والمتوفر ${b.available} · يحرره المخزون بعد الاستلام`, `${b.material} short: ${b.required} needed, ${b.available} on hand · released by inventory once received`) : b.kind === "QC_HOLD" ? L("محجوزة بقرار الجودة · لا تُعبّأ · يقرر التصرف فيها شخص آخر في النظام", "Held by QC · not packed · its disposition is decided in the ERP by another person") : L("مرفوضة ومحجورة · لا تُعبّأ · القرار في النظام", "Rejected and quarantined · not packed · decided in the ERP")}
        right={<span className={`st ws-st ${b.kind === "MATERIAL_SHORT" ? "wa" : "er"}`}>{b.kind === "MATERIAL_SHORT" ? L("مواد ناقصة", "Materials short") : b.kind === "QC_HOLD" ? L("محجوزة", "Held") : L("محجورة", "Quarantined")}</span>} />);
    }
    for (const o of prepQ?.blocked ?? []) {
      const cust = lang === "ar" ? o.customer.nameAr || o.customer.name : o.customer.name;
      rows.push(<Row key={`o-${o.id}`} testId={`blocked-order-${o.orderNumber}`} title={<><bdi>{cust}</bdi> · <Bid>#{o.orderNumber}</Bid></>}
        sub={L("معلّق مؤقتاً · لا يُجهَّز حتى يُستأنف من النظام", "On hold · not prepared until it is resumed in the ERP")}
        right={<span className="st ws-st wa">{L("طلب موقوف", "Order on hold")}</span>} />);
    }
    return (<>{bar}
      <Sheet testId="station-pblocked"
        head={<Head title={L("المتوقفة في التعبئة والتجهيز", "Blocked in packaging and preparation")} sub={L("لكل عنصر سببه ومن يحرره. لا يُحرَّر شيء من المحطة.", "Each item shows why and who releases it. Nothing is released at the station.")} status={{ tone: rows.length ? "er" : "", label: L(`${rows.length} عناصر`, `${rows.length} items`) }} />}
        foot={<><Primary onClick={() => setBlockedOpen(false)} testId="blocked-back">{L("العودة للطابور", "Back to the queue")}</Primary><Note>{L("يعود العنصر تلقائيًا عند زوال السبب. حجز الجودة على مستوى اللوت قدرة مخططة (J-17).", "An item returns by itself once the reason clears. Lot-level quality holds are a planned capability (J-17).")}</Note></>}>
        <div className="ws-rows" style={{ gap: 12 }}>
          {rows.length ? rows : <Info tone="muted" title={L("لا شيء متوقف الآن.", "Nothing is blocked now.")} />}
        </div>
      </Sheet></>);
  }

  // One tab on screen at a time (they never share a queue); switching back re-opens its queue.
  if (tab === "packaging" && tabs.includes("packaging")) {
    return <PackTab {...shared} active q={packQ} nBlocked={nBlocked} onBlocked={() => setBlockedOpen(true)} toPrep={tabs.includes("preparation") ? () => setTab("preparation") : null} />;
  }
  return <PrepTab {...shared} active q={prepQ} nBlocked={nBlocked} onBlocked={() => setBlockedOpen(true)} />;
}

type Shared = {
  lang: "ar" | "en"; L: (ar: string, en: string) => string; user: { id: string; name: string; permissions: Record<string, unknown> };
  post: (slot: string, url: string, body: unknown, keyed?: boolean) => Promise<Api | null>;
  read: (url: string, opts?: { poll?: boolean; etag?: string }) => Promise<Api | null>;
  load: (force?: boolean, poll?: boolean) => Promise<void>;
  refusal: (body: unknown) => string; online: boolean; busy: boolean; setBusy: (b: boolean) => void; offlineBox: ReactNode; bar: ReactNode; onDevice: boolean;
  active: boolean; nBlocked: number; onBlocked: () => void; now: number;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// «التعبئة» — PA1 · PA2 (+ shortage) · PA3
// ════════════════════════════════════════════════════════════════════════════════════════════════
type PlanRow = { id: string; skuCode: string; name: string; weightGrams: number; hasBom: boolean; suggested: number; outstandingUnits: number; forOrders: number[] };
type TaskData = {
  batchNumber: string; status: string; availableGrams: number; plan: { ok: true; rows: PlanRow[]; productNameEn: string; productNameAr: string | null } | { ok: false; error: string };
  batch: { id: string; batchNumber: string; status: string; productId: string | null; nameEn: string; nameAr: string | null; availableKg: number; order: { orderNumber: number } | null; releasedAt: string };
  owner: { orderItemId: string; orderNumber: number; productSkuId: string | null; outstandingUnits: number } | null;
};
type Preview = { availableGrams: number; remainingGrams: number; standardUnits: number; materials: { materialItemId: string; label: string; required: number; available: number; missing: number }[]; problems: string[]; maxPackages: number; shortage: { material: string; required: number; available: number } | null };
type PackDone = { batchNumber: string; skuCode: string; units: number; reservedUnits: number; orderNumber: number | null; remainingKg: number; materials: { label: string; quantity: number }[]; at: string; replayed: boolean; productId: string | null; productLabel: string; batchId: string };

function PackTab(p: Shared & { q: PackQueue | null; toPrep: (() => void) | null }) {
  const { lang, L, post, read, load, refusal, online, setBusy, offlineBox, bar, q, user, now } = p;
  const [view, setView] = useState<{ v: "queue" } | { v: "task"; id: string; startedAt: string } | { v: "done"; r: PackDone }>({ v: "queue" });
  const [task, setTask] = useState<TaskData | null>(null);
  const [skuId, setSkuId] = useState<string | null>(null);
  const [count, setCount] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const nm = (x: { nameEn: string; nameAr: string | null } | null | undefined) => (x ? (lang === "ar" ? x.nameAr || x.nameEn : x.nameEn) : "");

  async function openTask(id: string) {
    setErr(""); setPreview(null); setTask(null);
    const r = await read(`/api/station/packaging/batches/${encodeURIComponent(id)}`);
    if (!r) return;
    if (r.status !== 200) { setErr(refusal(r.body)); return; }
    const t = r.body as TaskData;
    setTask(t);
    const rows = t.plan.ok ? t.plan.rows.filter((x) => x.hasBom) : [];
    const first = rows.find((x) => x.suggested > 0) ?? rows[0] ?? null;
    setSkuId(first?.id ?? null);
    setCount(first ? String(first.suggested > 0 ? first.suggested : Math.max(0, Math.floor(t.availableGrams / first.weightGrams))) : "");
    setView({ v: "task", id, startedAt: new Date().toISOString() });
  }

  // The material check: the pack route's own preview, asked again whenever the size or the count changes.
  const n = Number(count);
  useEffect(() => {
    if (view.v !== "task" || !skuId || !(n > 0)) return;
    let stale = false;
    const t = setTimeout(async () => {
      const r = await post("preview", "/api/station/packaging/preview", { batchId: view.id, productSkuId: skuId, packages: n }, false);
      if (stale || !r) return;
      if (r.status === 200) { setPreview(r.body as Preview); setErr(""); } else { setPreview(null); setErr(refusal(r.body)); }
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [view, skuId, n, post, refusal]);

  async function commit(packages: number) {
    if (view.v !== "task" || !task || !skuId || sending || !online) return;
    setSending(true); setBusy(true); setErr("");
    const slot = `pack:${view.id}:${skuId}:${packages}`;
    const r = await post(slot, "/api/station/packaging/pack", { batchId: view.id, productSkuId: skuId, packages });
    setSending(false); setBusy(false);
    if (!r) return; // offline: the key is kept for this exact action; pressing again replays it
    if (r.status === 200 || r.status === 201) {
      const b = r.body;
      const row = task.plan.ok ? task.plan.rows.find((x) => x.id === skuId) : null;
      setView({ v: "done", r: {
        batchNumber: b.batchNumber, skuCode: b.lots?.[0]?.skuCode ?? row?.skuCode ?? "", units: b.standardUnitsCreated ?? packages, reservedUnits: b.reservedUnits ?? 0,
        orderNumber: b.reservedUnits > 0 ? task.owner?.orderNumber ?? null : null, remainingKg: (b.remainingGrams ?? 0) / 1000,
        materials: b.materialsConsumed ?? [], at: clock(Date.now()), replayed: r.status === 200, productId: task.batch.productId, productLabel: nm(task.batch), batchId: task.batch.id,
      } });
      void load(true);
      return;
    }
    setErr(refusal(r.body));
  }

  const batches = q?.batches ?? [];
  const next = batches[0] ?? null;

  // ── PA1 ─────────────────────────────────────────────────────────────────────────────────
  if (view.v === "queue" || (view.v === "task" && !task)) {
    const rows: ReactNode[] = batches.map((b, i) => (
      <Row key={b.id} on={i === 0} testId={`pack-row-${b.batchNumber}`} onClick={() => void openTask(b.id)}
        title={<><bdi>{nm(b)}</bdi> · <Bid>{b.batchNumber}</Bid></>}
        sub={<>{L("مقبولة", "Released")} <Num>{clock(b.releasedAt, false)}</Num> · <Num>{kg2(b.availableKg)}</Num> {L("كغ", "kg")}{b.plan ? <> · {L("إلى", "into")} <Bid>{b.plan.skuCode}</Bid></> : null} {b.order ? <>{L("للطلب", "for order")} <Bid>#{b.order.orderNumber}</Bid></> : L("للمخزون", "for stock")}{b.shortage ? <> · {L(`نقص ${b.shortage.material}`, `${b.shortage.material} short`)}</> : null}</>}
        right={<span className={`st ws-st ${b.shortage ? "wa" : "ok"}`}>{b.shortage ? L("مواد ناقصة", "Materials short") : L("جاهزة للتعبئة", "Ready to pack")}</span>} />
    ));
    for (const b of q?.pending ?? []) rows.push(
      <Row key={b.id} dim testId={`pack-pending-${b.batchNumber}`} title={<><bdi>{nm(b)}</bdi> · <Bid>{b.batchNumber}</Bid></>}
        sub={L("بانتظار الجودة · لا تُعبّأ قبل الإفراج", "Waiting for QC · not packed before release")} right={<span className="st ws-st">{L("غير متاحة", "Not available")}</span>} />,
    );
    return (<>{bar}
      <Sheet testId="station-pack-queue"
        head={<Head title={L("دفعات جاهزة للتعبئة", "Batches ready to pack")} sub={L("الدفعات المقبولة فقط. المحجورة وبانتظار الجودة لا تُعبّأ.", "Released batches only. Quarantined batches and those waiting for QC are not packed.")}
          status={{ tone: batches.length ? "ok" : "", label: L(`${batches.length} جاهزة`, `${batches.length} ready`) }} since={<>{st("lastUpdate", lang)} <Num>{clock(q?.serverTime ?? now)}</Num></>} />}
        foot={<>
          <Primary disabled={!next || !online} onClick={() => next && void openTask(next.id)} testId="pack-open-next">{next ? L(`فتح المهمة التالية · ${nm(next)}`, `Open the next task · ${nm(next)}`) : L("لا دفعات جاهزة للتعبئة", "No batch ready to pack")}</Primary>
          <Secondary onClick={p.onBlocked} testId="pack-blocked">{L(`المتوقفة · ${p.nBlocked}`, `Blocked · ${p.nBlocked}`)}</Secondary>
          <Note>{L("التعبئة تنشئ منتجًا تامًا. التجهيز للطلبات في التبويب الآخر.", "Packaging creates finished goods. Preparing orders is in the other tab.")}</Note>
        </>}>
        <div className="ws-col" style={{ gap: 12 }}>
          {offlineBox}
          {err ? <Info tone="err" title={err} testId="station-error" /> : null}
          {!q ? <span role="status">{st("loading", lang)}</span> : rows.length ? <div className="ws-rows">{rows}</div> : <Info tone="muted" title={L("لا دفعات مقبولة بانتظار التعبئة.", "No released batch is waiting to be packed.")} testId="pack-empty" />}
        </div>
      </Sheet></>);
  }

  // ── PA3 ─────────────────────────────────────────────────────────────────────────────────
  if (view.v === "done") {
    const r = view.r;
    const nextOther = batches.find((b) => b.batchNumber !== r.batchNumber) ?? batches[0] ?? null;
    return (<>{bar}
      <Sheet plain testId="station-pack-done" foot={<>
        {nextOther ? <Primary onClick={() => void openTask(nextOther.id)} testId="pack-done-next">{L(`المهمة التالية · ${nm(nextOther)}`, `Next task · ${nm(nextOther)}`)}</Primary>
          : <Primary onClick={() => setView({ v: "queue" })} testId="pack-done-next">{L("العودة للطابور", "Back to the queue")}</Primary>}
        <Note>{r.replayed ? L("أُعيد الإرسال بالمفتاح نفسه: هذه النتيجة نفسها، لم تتكرر الحركة.", "Sent again with the same key: this is the same result; nothing moved twice.") : L("لم تتكرر الحركة: إعادة الضغط تعرض النتيجة نفسها.", "Nothing moved twice: pressing again shows the same result.")}</Note>
      </>}>
        <div className="ws-done">
          <DoneMark />
          <div className="ws-done-t">{L("سُجّلت التعبئة", "Packaging recorded")}</div>
          <div className="ws-done-n" data-testid="pack-done-units">{r.units} × {r.skuCode}</div>
          <span className="st ws-st ok">{r.reservedUnits > 0 ? L("منتج تام · محجوز للطلب", "Finished goods · reserved for the order") : L("منتج تام · للمخزون", "Finished goods · for stock")}</span>
          <div className="ws-sumgrid" style={{ marginTop: 12 }}>
            <div><div className="lbl">{L("المنتج التام", "Finished goods")}</div><div className="v"><Num>{r.units}</Num> × <Bid>{r.skuCode}</Bid></div></div>
            <div><div className="lbl">{L("اللوت", "Lot")}</div><div className="v"><Bid>{r.batchNumber}</Bid></div></div>
            <div><div className="lbl">{L("محجوز لـ", "Reserved for")}</div><div className="v">{r.orderNumber ? <><Bid>#{r.orderNumber}</Bid>{r.reservedUnits < r.units ? <> · <Num>{r.reservedUnits}</Num></> : null}</> : L("المخزون", "Stock")}</div></div>
            <div><div className="lbl">{L("المواد", "Materials")}</div><div className="v">{r.materials.length ? r.materials.map((m, i) => <span key={i}>{i ? " · " : ""}<bdi>{m.label}</bdi> <bdi dir="ltr" className="n">−{m.quantity}</bdi></span>) : "—"}</div></div>
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
            {L(`أكّد النظام ${r.at}. `, `Confirmed by the system at ${r.at}. `)}
            {r.remainingKg >= 0.05 ? L(`يبقى ${kg2(r.remainingKg)} كغ على الدفعة «مُعبّأة جزئيًا».`, `${kg2(r.remainingKg)} kg stays on the batch, «partially packaged».`) : L("عُبّئت الدفعة بالكامل.", "The batch is fully packed.")}
            <BatchLabelPrint permissions={user.permissions as never} productId={r.productId} productLabel={r.productLabel} batch={{ id: r.batchId, batchNumber: r.batchNumber }}
              buttonLabel={L("طباعة الملصق", "Print label")} unavailable={<> · {L("الملصقات غير متاحة", "Labels unavailable")}</>} className="btn" testId="pack-print-label" />
          </div>
        </div>
      </Sheet></>);
  }

  // ── PA2 (and its shortage state) ────────────────────────────────────────────────────────
  const t = task!;
  const rows = t.plan.ok ? t.plan.rows.filter((x) => x.hasBom) : [];
  const row = rows.find((x) => x.id === skuId) ?? null;
  // «كولمبيا ويلا · 1 كغ»: the size's own name when it already says the coffee, else coffee · size.
  const title = row ? (row.name.includes(nm(t.batch)) ? row.name : `${nm(t.batch)} · ${row.name || row.skuCode}`) : nm(t.batch);
  const short = !!preview && preview.maxPackages < n;
  const otherProblems = preview ? preview.problems.filter((x) => !/^Not enough /.test(x)) : [];
  const ok = !!preview && n > 0 && preview.problems.length === 0;
  const owned = t.owner && row && t.owner.productSkuId === row.id ? t.owner : null;
  const steps = [L("اختيار الصنف", "Choose the size"), L("التحقق من المواد", "Check materials"), L("تسجيل الكمية", "Record the count"), L("تأكيد المنتج التام", "Confirm finished goods")];
  const onKey = (k: string) => setCount((c) => (k === "del" ? c.slice(0, -1) : digitsOnly(c + k, 4)));
  return (<>{bar}
    <Sheet testId={short ? "station-pack-short" : "station-pack-task"}
      head={<Head title={<bdi>{title}</bdi>} steps={{ items: steps, cur: 2 }}
        sub={<>{L("الدفعة", "Batch")} <Bid>{t.batchNumber}</Bid>{row ? <> · <Bid>{row.skuCode}</Bid></> : null} · {owned ? <>{L("للطلب", "for order")} <Bid>#{owned.orderNumber}</Bid></> : t.batch.order ? <>{L("للطلب", "for order")} <Bid>#{t.batch.order.orderNumber}</Bid></> : L("للمخزون", "for stock")}</>}
        status={{ tone: "ok", label: t.status === "Partially Packaged" ? L("مُعبّأة جزئيًا · جاهزة", "Partly packed · ready") : L("مقبولة · جاهزة", "Released · ready") }}
        since={<>{L("بدأت", "Started")} <Num>{clock(view.startedAt, false)}</Num> · {user.name}</>} />}
      foot={short ? <>
        <Primary disabled testId="pack-confirm">{L(`لا يمكن تأكيد ${n} · نقص مواد`, `Cannot confirm ${n} · materials short`)}</Primary>
        {preview!.maxPackages > 0 ? <Secondary onClick={() => { setCount(String(preview!.maxPackages)); void commit(preview!.maxPackages); }} disabled={sending || !online} testId="pack-possible">{L(`تعبئة ${preview!.maxPackages} الآن`, `Pack ${preview!.maxPackages} now`)}</Secondary> : <Secondary onClick={() => setView({ v: "queue" })} testId="pack-back">{L("العودة للطابور", "Back to the queue")}</Secondary>}
        <Note>{L("يُرسل التأكيد مرة واحدة بمفتاح تكرار. لا يُحسب شيء في المحطة.", "The confirmation is sent once with an idempotency key. Nothing is calculated at the station.")}</Note>
      </> : <>
        <Primary disabled={!ok || !online} wait={sending} onClick={() => void commit(n)} testId="pack-confirm">{n > 0 ? L(`تأكيد تعبئة ${n} عبوات`, `Confirm ${n} packages`) : L("أدخل عدد العبوات", "Enter the package count")}</Primary>
        <Secondary onClick={() => { setErr(""); setView({ v: "queue" }); }} testId="pack-back">{L("العودة للطابور", "Back to the queue")}</Secondary>
        <Note>{L("يُرسل التأكيد مرة واحدة بمفتاح تكرار. لا يُحسب شيء في المحطة.", "The confirmation is sent once with an idempotency key. Nothing is calculated at the station.")}</Note>
      </>}>
      <div className="ws-split">
        <div className="ws-col" style={{ gap: 12 }}>
          {rows.length > 1 ? <div className="ws-chips-sm"><Chips label={L("الصنف", "Size")} value={skuId} options={rows.map((x) => ({ value: x.id, label: `${x.skuCode}${x.suggested ? ` · ${x.suggested}` : ""}` }))} onChange={(v) => { setSkuId(v); const x = rows.find((r) => r.id === v); if (x) setCount(String(x.suggested || Math.max(0, Math.floor(t.availableGrams / x.weightGrams)))); }} testId="pack-sku" /></div> : null}
          {!t.plan.ok ? <Info tone="err" title={refusal({ error: t.plan.error })} /> : rows.length === 0 ? <Info tone="err" title={L("لا صنف لهذه القهوة بمكونات معرّفة. عرّف مكونات الصنف في النظام أولًا.", "No size of this coffee has its components defined. Define them in the ERP first.")} /> : null}
          <div className="ws-fields" style={{ marginTop: 0 }}>
            <BigField id="ws-pack-count" testId="pack-count" label={L("عدد العبوات", "Packages")} value={count} unit={L("عبوة", "pkg")} focus off={sending} bad={short}
              hint={preview ? L(`من ${kg2(t.availableGrams / 1000)} كغ · المتبقي على الدفعة ${kg2(preview.remainingGrams / 1000)} كغ`, `Of ${kg2(t.availableGrams / 1000)} kg · ${kg2(preview.remainingGrams / 1000)} kg left on the batch`) : L(`من ${kg2(t.availableGrams / 1000)} كغ`, `Of ${kg2(t.availableGrams / 1000)} kg`)}
              onChange={(v) => setCount(digitsOnly(v, 4))} />
          </div>
          <div className="ws-lab-s">{L("مواد التعبئة", "Packaging materials")}</div>
          <div className="ws-mats" data-testid="pack-materials">
            {(preview?.materials ?? []).map((m) => {
              const bad = m.missing > 0;
              return (
                <div key={m.materialItemId} className={`ws-mat${bad ? " bad" : ""}`}>
                  <div style={{ flex: 1 }}><div className="ws-mat-t"><bdi>{m.label}</bdi></div><div className="ws-mat-s">{L("يلزم", "Needed")} <Num>{m.required}</Num> · {L("المتوفر", "On hand")} <Num>{m.available.toLocaleString("en-US")}</Num></div></div>
                  <span className={`st ws-st ${bad ? "er" : "ok"}`}>{bad ? L("غير كافٍ", "Not enough") : L("كافٍ", "Enough")}</span>
                </div>
              );
            })}
            {!preview && n > 0 ? <span className="ws-mat-s" role="status">{st("loading", lang)}</span> : null}
          </div>
          {short && preview?.shortage ? (
            <Info tone="err" title={L(`نقص ${preview.shortage.material}: يلزم ${preview.shortage.required} والمتوفر ${preview.shortage.available}.`, `${preview.shortage.material} short: ${preview.shortage.required} needed, ${preview.shortage.available} on hand.`)} testId="pack-shortage">
              {preview.maxPackages > 0 ? L(`لا يمكن تأكيد ${n} عبوة. يمكنك تعبئة ${preview.maxPackages} الآن، ويبقى الباقي على الدفعة.`, `${n} packages cannot be confirmed. You can pack ${preview.maxPackages} now; the rest stays on the batch.`) : L("لا يمكن تعبئة أي عبوة حتى تصل المواد.", "No package can be packed until the materials arrive.")}
            </Info>
          ) : owned ? (
            <Info tone="muted" title={<>{L("تُحجز العبوات تلقائيًا لبند الطلب", "The packages are reserved automatically to the line of order")} <Bid>#{owned.orderNumber}</Bid>.</>} testId="pack-owner">
              {L(`الطلب يحتاج ${owned.outstandingUnits} عبوة أخرى؛ هذه الدفعة تغطي ${Math.min(n || 0, owned.outstandingUnits)}.`, `The order needs ${owned.outstandingUnits} more; this batch covers ${Math.min(n || 0, owned.outstandingUnits)}.`)}
            </Info>
          ) : row && row.forOrders.length ? (
            <Info tone="muted" title={L("تُحجز العبوات للطلبات الأقدم من هذا الصنف بعد التأكيد.", "The packages go to the oldest open orders of this size after confirming.")}>{L("الطلبات:", "Orders:")} {row.forOrders.map((o, i) => <span key={o}>{i ? " · " : " "}<Bid>#{o}</Bid></span>)}</Info>
          ) : null}
          {otherProblems.length && !short ? <Info tone="err" title={refusal({ error: otherProblems[0] })} testId="pack-problem" /> : null}
          {offlineBox}{err ? <Info tone="err" title={err} testId="station-error" /> : null}
        </div>
        <div style={{ flex: "none" }}>
          <Keypad label={L("تُدخل في: عدد العبوات", "Enters into: packages")} onKey={onKey} off={sending} decimal={false} delLabel={L("حذف", "Delete")} />
        </div>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// «تجهيز الطلبات» — P1 · P2/P3 · P7 · P4 · P6
// ════════════════════════════════════════════════════════════════════════════════════════════════
type PrepView =
  | { v: "queue" }
  | { v: "order"; id: string }
  | { v: "partial"; id: string; lineId: string }
  | { v: "prepared"; id: string }
  | { v: "handed"; h: HandoffView; order: PrepOrder };

function PrepTab(p: Shared & { q: PrepQueue | null }) {
  const { lang, L, post, read, load, refusal, online, setBusy, offlineBox, bar, q, user, now } = p;
  const [view, setView] = useState<PrepView>({ v: "queue" });
  const [order, setOrder] = useState<PrepOrder | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [match, setMatch] = useState<MatchAnswer | null>(null);
  /** P3: once four characters were ambiguous, the full number is required (its length). */
  const [needFull, setNeedFull] = useState<{ len: number; candidates: string[] } | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [decision, setDecision] = useState<"keep" | "release">("keep");
  const [staging, setStaging] = useState("");
  const [parcels, setParcels] = useState(1);
  const [choose, setChoose] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const cust = (o: { customer: { name: string; nameAr: string | null } }) => (lang === "ar" ? o.customer.nameAr || o.customer.name : o.customer.name);
  const lineName = (l: { nameEn: string; nameAr: string | null } | null | undefined) => (l ? (lang === "ar" ? l.nameAr || l.nameEn : l.nameEn) : "");

  const refreshOrder = useCallback(async (id: string) => {
    const r = await read(`/api/station/prep/orders/${encodeURIComponent(id)}`);
    if (!r) return null;
    if (r.status !== 200) { setErr(refusal(r.body)); return null; }
    setOrder(r.body as PrepOrder);
    return r.body as PrepOrder;
  }, [read, refusal]);

  const nextLine = (o: PrepOrder, after?: string | null) => {
    const open = o.lines.filter((l) => l.remaining > 0 && l.readyToPick > 0 && !l.blocked);
    if (!after) return open[0] ?? null;
    const i = o.lines.findIndex((l) => l.id === after);
    return open.find((l) => o.lines.indexOf(l) > i) ?? null;
  };

  function goLine(o: PrepOrder, id: string | null) {
    setEntry(""); setMatch(null); setNeedFull(null); setErr("");
    if (!id) { setView({ v: "prepared", id: o.id }); setStaging(o.lastHandoff?.stagingNote ?? ""); setChoose(false); setChosen([]); return; }
    setLineId(id); setView({ v: "order", id: o.id });
  }

  async function start(o: PrepOrder) {
    if (sending || !online) return;
    setErr("");
    if (o.state === "prepared") { const f = await refreshOrder(o.id); if (f) goLine(f, null); return; }
    setSending(true); setBusy(true);
    const r = await post(`start:${o.id}`, "/api/station/prep/start", { orderId: o.id });
    setSending(false); setBusy(false);
    if (!r) return;
    if (r.status !== 200 && r.status !== 201) { setErr(refusal(r.body)); void load(true); return; }
    const f = (r.body.order as PrepOrder) ?? (await refreshOrder(o.id));
    if (!f) return;
    setOrder(f);
    goLine(f, nextLine(f)?.id ?? null);
    void load(true);
  }

  /** Typing changes the entry; a previous answer no longer applies. */
  const typeEntry = (v: string) => { setEntry(v); setMatch(null); };

  // W1: the entry is matched by the server against THIS line's reserved lots (no guessing here).
  const line = order?.lines.find((l) => l.id === lineId) ?? null;
  useEffect(() => {
    if (view.v !== "order" || !line) return;
    const e = entry;
    // Four characters, or — once they were ambiguous — the whole number; nothing in between is asked.
    if (needFull ? e.length < needFull.len : e.length !== 4) return;
    let stale = false;
    const t = setTimeout(async () => {
      const r = await post("match", "/api/station/lots/match", { orderItemId: line.id, entry: e }, false);
      if (stale || !r) return;
      if (r.status !== 200) { setErr(refusal(r.body)); return; }
      const m = r.body as MatchAnswer;
      setErr("");
      if (m.kind === "ambiguous") { setNeedFull({ len: m.fullLength ?? 10, candidates: m.candidates }); setEntry(""); setMatch(null); return; }
      setMatch(m);
    }, 200);
    return () => { stale = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked again only when the entry or the line changes
  }, [entry, line?.id, view.v, needFull]);

  async function confirmPick() {
    if (!line || !match || match.kind !== "unique" || sending || !online) return;
    setSending(true); setBusy(true); setErr("");
    const units = Math.min(match.pickable, line.remaining);
    const r = await post(`pick:${line.id}:${match.batchNumber}:${units}`, "/api/station/picks", { orderItemId: line.id, entry, units });
    setSending(false); setBusy(false);
    if (!r) return;
    if (r.status !== 200 && r.status !== 201) {
      setErr(refusal(r.body));
      if (r.body?.code === "LOT_AMBIGUOUS") { setNeedFull({ len: 10, candidates: (r.body.candidates as string[]) ?? [] }); setEntry(""); }
      if (r.body?.code === "LOT_AMBIGUOUS" || r.body?.code === "LOT_NOT_RESERVED") setMatch(null);
      return;
    }
    const f = await refreshOrder(order!.id);
    if (!f) return;
    const same = f.lines.find((l) => l.id === line.id);
    if (same && same.remaining > 0 && same.readyToPick > 0) { setEntry(""); setMatch(null); setNeedFull(null); return; }
    goLine(f, nextLine(f)?.id ?? null);
    void load(true);
  }

  async function saveDecision() {
    if (view.v !== "partial" || sending || !online) return;
    setSending(true); setBusy(true); setErr("");
    const r = await post(`decision:${view.id}:${decision}`, "/api/station/prep/decision", { orderId: view.id, decision });
    setSending(false); setBusy(false);
    if (!r) return;
    if (r.status !== 200 && r.status !== 201) { setErr(refusal(r.body)); return; }
    void load(true);
    if (decision === "release") { setView({ v: "queue" }); return; }
    const f = await refreshOrder(view.id);
    if (!f) return;
    goLine(f, nextLine(f, view.lineId)?.id ?? null);
  }

  async function handOff() {
    if (view.v !== "prepared" || !order || sending || !online) return;
    setSending(true); setBusy(true); setErr("");
    const ids = choose ? chosen : null;
    const r = await post(`handoff:${order.id}:${(ids ?? []).join(",")}`, "/api/station/handoffs", { orderId: order.id, orderItemIds: ids, stagingNote: staging, packages: parcels });
    setSending(false); setBusy(false);
    if (!r) return;
    if (r.status !== 200 && r.status !== 201) { setErr(refusal(r.body)); return; }
    setView({ v: "handed", h: r.body.handoff as HandoffView, order });
    void load(true);
  }

  const orders = q?.orders ?? [];
  const startable = orders.filter((o) => (o.state === "ready" || o.state === "prepared" || (o.state === "preparing" && (!o.claim || o.claim.byId === user.id))));
  const first = startable[0] ?? null;
  const steps = [L("التحقق من الحجز", "Check the reservation"), L("الالتقاط والتحقق", "Pick and verify"), L("تأكيد الكمية", "Confirm the count"), L("التسليم للشحن", "Hand to dispatch")];
  const errBox = err ? <Info tone="err" title={err} testId="station-error" /> : null;
  const orderSub = (o: PrepOrder) => <>{L("الطلب", "Order")} <Bid>#{o.orderNumber}</Bid> · {L("من المخزون الجاهز · محجوز", "From finished stock · reserved")}{o.legacyLines ? <> · {L(`${o.legacyLines} بند بالكيلو يُسلَّم من النظام`, `${o.legacyLines} kg line(s) handled in the ERP`)}</> : null}</>;
  const claimSince = (o: PrepOrder) => (o.claim ? <>{L("بدأ", "Started")} <Num>{clock(o.claim.at, false)}</Num> · {o.claim.byName}</> : null);

  // ── P1 ──────────────────────────────────────────────────────────────────────────────────
  if (view.v === "queue") {
    const rows = orders.map((o) => {
      const mine = o.claim?.byId === user.id;
      const takenByOther = !!o.claim && !mine;
      const dim = o.state === "partial" || o.state === "waiting" || takenByOther;
      const isFirst = first?.id === o.id;
      const label = o.state === "preparing" ? (takenByOther ? L(`قيد التجهيز · ${o.claim!.byName}`, `Being prepared · ${o.claim!.byName}`) : L("قيد التجهيز · أنت", "Being prepared · you"))
        : o.state === "prepared" ? L("جُهّز · بانتظار التسليم", "Prepared · awaiting handoff")
        : o.state === "ready" ? L("جاهز للتجهيز", "Ready to prepare") : L("غير متاح", "Not available");
      const tone = o.state === "ready" || o.state === "prepared" ? "ok" : o.state === "preparing" ? (takenByOther ? "wa" : "in") : "";
      const sub = o.state === "partial" || o.state === "waiting"
        ? <>{L(`${o.totals.readyToPick + o.totals.prepared} من ${o.totals.outstanding} جاهزة · الباقي بانتظار الإنتاج`, `${o.totals.readyToPick + o.totals.prepared} of ${o.totals.outstanding} ready · the rest is waiting for production`)}</>
        : <><Num>{o.totals.outstanding}</Num> {L("وحدة", "units")}{o.lines.length > 1 ? <> · {L(`${o.lines.length} بنود`, `${o.lines.length} lines`)}</> : null} · {L("من المخزون الجاهز", "from finished stock")}{o.totals.prepared ? <> · {L(`جُهّز ${o.totals.prepared}`, `${o.totals.prepared} prepared`)}</> : null}{o.status === "Preparing" && o.lastHandoff ? <> · {L("سُلّم جزء للشحن", "part handed to dispatch")}</> : null}</>;
      return <Row key={o.id} on={isFirst} dim={dim} testId={`prep-row-${o.orderNumber}`} onClick={() => { if (!dim) void start(o); }}
        title={<><bdi>{cust(o)}</bdi> · <Bid>#{o.orderNumber}</Bid></>} sub={sub} right={<span className={`st ws-st ${tone}`}>{label}</span>} />;
    });
    const readyN = orders.filter((o) => o.state === "ready" || o.state === "prepared").length;
    return (<>{bar}
      <Sheet testId="station-prep-queue"
        head={<Head title={L("طلبات للتجهيز", "Orders to prepare")} sub={L("الأقدم أولًا. البنود المحجوزة من المخزون الجاهز فقط.", "Oldest first. Only lines reserved from finished stock.")}
          status={{ tone: readyN ? "ok" : "", label: L(`${readyN} جاهز`, `${readyN} ready`) }} since={<>{st("lastUpdate", lang)} <Num>{clock(q?.serverTime ?? now)}</Num></>} />}
        foot={<>
          <Primary disabled={!first || !online} wait={sending} onClick={() => first && void start(first)} testId="prep-open-next">{first ? (first.state === "prepared" ? L(`تسليم #${first.orderNumber}`, `Hand off #${first.orderNumber}`) : L(`بدء تجهيز #${first.orderNumber}`, `Start preparing #${first.orderNumber}`)) : L("لا طلبات جاهزة للتجهيز", "No order ready to prepare")}</Primary>
          <Secondary onClick={p.onBlocked} testId="prep-blocked">{L(`المتوقفة · ${p.nBlocked}`, `Blocked · ${p.nBlocked}`)}</Secondary>
          <Note>{L("لا يتحول الطلب إلى تحميص من هنا. قرار المخزون أو الإنتاج من النظام.", "Nothing is sent to roasting from here. Stock or production is decided in the ERP.")}</Note>
        </>}>
        <div className="ws-col" style={{ gap: 12 }}>
          {offlineBox}{errBox}
          {!q ? <span role="status">{st("loading", lang)}</span> : rows.length ? <div className="ws-rows">{rows}</div> : <Info tone="muted" title={L("لا طلبات محجوزة بانتظار التجهيز.", "No reserved order is waiting to be prepared.")} testId="prep-empty" />}
          {q && q.handed.length ? <Note>{L(`سُلّم للشحن وينتظر التسليم في النظام: ${q.handed.map((h) => `#${h.orderNumber}`).join(" · ")}`, `Handed to dispatch, waiting for the delivery in the ERP: ${q.handed.map((h) => `#${h.orderNumber}`).join(" · ")}`)}</Note> : null}
        </div>
      </Sheet></>);
  }

  // ── P6 ──────────────────────────────────────────────────────────────────────────────────
  if (view.v === "handed") {
    const h = view.h;
    const nextO = orders.find((o) => o.id !== h.orderId && (o.state === "ready" || o.state === "prepared")) ?? null;
    return (<>{bar}
      <Sheet plain testId="station-prep-handed" foot={<>
        <Primary onClick={() => { setView({ v: "queue" }); if (nextO) void start(nextO); }} testId="handed-next">{nextO ? L("الطلب التالي", "Next order") : L("العودة للطابور", "Back to the queue")}</Primary>
        <Note>{L("التسليم الجزئي يُسجَّل لكل بند بكمياته ومراجعه.", "A partial handoff is recorded per line with its quantities and references.")}</Note>
      </>}>
        <div className="ws-done">
          <DoneMark />
          <div className="ws-done-t">{h.partial ? L("سُلّم جزء الطلب للشحن", "Part of the order was handed to dispatch") : L("سُلّم الطلب للشحن", "The order was handed to dispatch")}</div>
          <div className="ws-done-n" data-testid="handed-order">#{h.orderNumber}</div>
          <span className="st ws-st ok">{h.partial ? L("مُجهّز جزئيًا · مُسلَّم لفريق الشحن", "Partly prepared · with the dispatch team") : L("مُجهّز · مُسلَّم لفريق الشحن", "Prepared · with the dispatch team")}</span>
          <div className="ws-sumgrid" style={{ marginTop: 12 }}>
            <div><div className="lbl">{L("البنود", "Lines")}</div><div className="v"><Num>{h.lines.length}</Num> · <Num>{h.units}</Num> {L("وحدة", "units")}</div></div>
            <div><div className="lbl">{L("الطرود", "Parcels")}</div><div className="v">{h.packages != null ? <><Num>{h.packages}</Num> {L("كراتين", "cartons")}</> : "—"}</div></div>
            <div><div className="lbl">{L("المكان", "Place")}</div><div className="v"><bdi>{h.stagingNote || "—"}</bdi></div></div>
            <div><div className="lbl">{L("سلّمته", "Handed by")}</div><div className="v">{h.preparedByName} · <Num>{clock(h.createdAt)}</Num></div></div>
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{L("سُجّل التسليم مرة واحدة. يخرج المخزون عند تأكيد الشحن في النظام، لا هنا.", "The handoff was recorded once. Stock leaves when dispatch confirms the delivery in the ERP, not here.")}</div>
        </div>
      </Sheet></>);
  }

  if (!order) return (<>{bar}<Sheet plain>{errBox ?? <span role="status">{st("loading", lang)}</span>}</Sheet></>);
  const o = order;

  // ── P4 prepared (+ partial handoff per line) ────────────────────────────────────────────
  if (view.v === "prepared") {
    const ready = o.lines.filter((l) => l.picked > 0);
    const sel = choose ? ready.filter((l) => chosen.includes(l.id)) : ready;
    const units = sel.reduce((s, l) => s + l.picked, 0);
    const partial = o.totals.outstanding - o.totals.handedOff - units > 0;
    return (<>{bar}
      <Sheet testId="station-prep-prepared"
        head={<Head title={<bdi>{cust(o)}</bdi>} sub={orderSub(o)} steps={{ items: steps, cur: 3 }} status={{ tone: "ok", label: partial ? L("جُهّز جزئيًا · بانتظار التسليم", "Partly prepared · awaiting handoff") : L("جُهّز · بانتظار التسليم", "Prepared · awaiting handoff") }} since={claimSince(o)} />}
        foot={<>
          <Primary disabled={units <= 0 || !online} wait={sending} onClick={() => void handOff()} testId="handoff-confirm">{choose ? L(`تسليم البنود المختارة · ${units} وحدة`, `Hand off the chosen lines · ${units} units`) : L(`تسليم للشحن · ${units} وحدة`, `Hand to dispatch · ${units} units`)}</Primary>
          {ready.length > 1 ? <Secondary onClick={() => { setChoose(!choose); setChosen([]); }} testId="handoff-partial">{choose ? L("تسليم الكل", "Hand off everything") : L("تسليم جزئي", "Partial handoff")}</Secondary>
            : <Secondary onClick={() => setView({ v: "queue" })} testId="handoff-later">{L("لاحقًا", "Later")}</Secondary>}
          <Note>{partial ? L("تسليم جزئي: يبقى الباقي في الطابور ويُسلَّم لاحقًا.", "Partial handoff: the rest stays in the queue and is handed off later.") : ((n) => (n === 0 ? L("لا طلبات أخرى بانتظار التجهيز.", "No other order is waiting to be prepared.") : n === 1 ? L("طلب آخر بانتظار التجهيز.", "One other order is waiting to be prepared.") : n === 2 ? L("طلبان آخران بانتظار التجهيز.", "Two other orders are waiting to be prepared.") : L(`${n} طلبات أخرى بانتظار التجهيز.`, `${n} other orders are waiting to be prepared.`)))(orders.filter((x) => x.id !== o.id && x.state === "ready").length)}</Note>
        </>}>
        <div className="ws-split">
          <div className="ws-col" style={{ gap: 16 }}>
            <div className="ws-okhead"><DoneMark /><div><b>{L("جُهّز الطلب وسُجّل", "The order is prepared and recorded")}</b><span>{L(`أكّد النظام ${o.totals.picked} وحدة. لم تُضف أي حركة مخزون جديدة.`, `The system confirmed ${o.totals.picked} units. No stock movement was added.`)}</span></div></div>
            <div className="ws-plines" data-testid="prepared-lines">
              {o.lines.map((l) => {
                const can = l.picked > 0;
                const on = chosen.includes(l.id);
                return (
                  <div key={l.id} className={`ws-pline${choose && can ? " pick" : ""}`} role={choose && can ? "checkbox" : undefined} aria-checked={choose && can ? on : undefined} tabIndex={choose && can ? 0 : undefined}
                    onClick={() => choose && can && setChosen((c) => (c.includes(l.id) ? c.filter((x) => x !== l.id) : [...c, l.id]))} data-testid={`prepared-line-${l.skuCode}`}>
                    {choose ? <span className={`ws-check${on ? " on" : ""}`} aria-hidden="true">{on ? <CheckIco size="s" /> : null}</span> : <span style={{ color: "var(--status-success)" }}>{can ? <CheckIco size="s" /> : null}</span>}
                    <span className="ws-pline-t"><bdi>{lineName(l)}</bdi></span>
                    <Bid>{l.skuCode}</Bid>
                    <span className="ws-pline-lots">{l.lots.filter((x) => x.picked > 0).length ? <>{L("لوت", "Lot")} {l.lots.filter((x) => x.picked > 0).map((x, i) => <span key={x.batchNumber}>{i ? " · " : " "}<Bid>{x.batchNumber}</Bid></span>)}</> : null}</span>
                    <span className="ws-pline-q"><b className="n">{l.picked + l.handedOff}</b> {L("من", "of")} <Num>{l.outstanding}</Num>{l.handedOff ? <> · {L(`سُلّم ${l.handedOff}`, `${l.handedOff} handed`)}</> : null}</span>
                  </div>
                );
              })}
            </div>
            <div className="ws-fields" style={{ marginTop: 0, alignItems: "flex-end" }}>
              <div className="ws-field" style={{ flex: 2 }}>
                <label className="ws-field-l" htmlFor="ws-staging">{L("مكان التجهيز", "Staging place")}</label>
                <input id="ws-staging" className="ws-in" value={staging} maxLength={120} onChange={(e) => setStaging(e.target.value)} placeholder={L("مثال: رف التسليم ب", "e.g. handoff shelf B")} data-testid="handoff-staging" />
                <div className="ws-field-h">{L("ملاحظة توضيحية حتى يوجد نموذج للمواقع.", "A free note until a location model exists.")}</div>
              </div>
              <div className="ws-field" style={{ flex: "none" }}>
                <div className="ws-field-l">{L("الطرود", "Parcels")}</div>
                <div className="ws-stepper" role="group" aria-label={L("الطرود", "Parcels")}>
                  <button type="button" onClick={() => setParcels((v) => Math.min(999, v + 1))} aria-label={L("زيادة", "Increase")} data-testid="handoff-parcels-plus">+</button>
                  <span className="n" data-testid="handoff-parcels">{parcels}</span>
                  <button type="button" onClick={() => setParcels((v) => Math.max(0, v - 1))} aria-label={L("إنقاص", "Decrease")}>−</button>
                </div>
                <div className="ws-field-h">{L("كراتين", "cartons")}</div>
              </div>
            </div>
            <div className="ws-facts plain"><div><div className="lbl">{L("جهّزه", "Prepared by")}</div><div className="ws-fact-v">{user.name} · <Num>{clock(now, false)}</Num></div></div></div>
            {offlineBox}{errBox}
          </div>
          <aside className="ws-side ws-wide-only" style={{ width: 352, alignSelf: "stretch" }}>
            <b>{L("قبل التسليم", "Before the handoff")}</b>
            <div className="ws-side-l">{L("يُسلَّم الطلب كاملًا أو بندًا بندًا. كل تسليم يُسجَّل مرة واحدة بكمياته ومراجعه.", "The order is handed off whole or line by line. Each handoff is recorded once with its quantities and references.")}</div>
            <div className="ws-side-l">{L("«جاهز للشحن» في الطلب يعني أن المخزون محجوز. التسليم هنا يعني أنه جُهّز وسُلّم لفريق الشحن.", "«Ready for shipping» on the order means the stock is reserved. A handoff here means it was prepared and given to the dispatch team.")}</div>
          </aside>
        </div>
      </Sheet></>);
  }

  if (!line) { setTimeout(() => goLine(o, nextLine(o)?.id ?? null), 0); return null; }
  const done = line.prepared;
  const pct = line.outstanding ? Math.round((done / line.outstanding) * 1000) / 10 : 0;
  const nums = (
    <div className="ws-nums">
      <div><div className="lbl">{L("مطلوب", "Required")}</div><div className="big"><Num>{line.outstanding}</Num></div></div>
      <div><div className="lbl">{L("تم التحقق", "Verified")}</div><div className="big ok" data-testid="prep-verified"><Num>{done}</Num></div></div>
      <div><div className="lbl">{L("متبقٍ", "Remaining")}</div><div className="big rest" data-testid="prep-remaining"><Num>{line.remaining}</Num></div></div>
      <div className="ws-prog" aria-hidden="true"><div><i style={{ width: `${pct}%` }} /></div></div>
    </div>
  );
  const lineHead = (
    <div className="ws-line-h">
      <b><bdi>{lineName(line)}</bdi></b><Bid>{line.skuCode}</Bid>
      {o.lines.length > 1 ? <span className="ws-line-n">{L("البند", "Line")} <Num>{o.lines.indexOf(line) + 1}</Num> {L("من", "of")} <Num>{o.lines.length}</Num></span> : null}
    </div>
  );

  // ── P7 partial ──────────────────────────────────────────────────────────────────────────
  if (view.v === "partial") {
    const verifiedLots = line.lots.filter((x) => x.picked > 0);
    const until = clock(now + 2 * 3600_000, false);
    return (<>{bar}
      <Sheet testId="station-prep-partial"
        head={<Head title={<bdi>{cust(o)}</bdi>} sub={orderSub(o)} steps={{ items: steps, cur: 2 }} status={{ tone: "wa", label: L("جزئي", "Partial") }} since={claimSince(o)} />}
        foot={<>
          <Primary onClick={() => void saveDecision()} wait={sending} disabled={!online} testId="partial-save">{L("حفظ الجزء المنجز", "Save the work done")}</Primary>
          <Secondary onClick={() => setView({ v: "order", id: o.id })} testId="partial-continue">{L("متابعة التجهيز", "Continue preparing")}</Secondary>
          <Note>{L("لا يظهر الحفظ كمكتمل قبل تأكيد النظام.", "Saving never shows as done before the system confirms it.")}</Note>
        </>}>
        <div className="ws-col" style={{ gap: 16 }}>
          {lineHead}{nums}
          <Option on={decision === "keep"} onClick={() => setDecision("keep")} testId="partial-keep" title={L("إبقاء المتبقي محجوزًا لي", "Keep the rest reserved for me")} desc={L(`أتابع ${line.remaining} وحدات بعد العودة. الحجز حتى ${until}.`, `I continue ${line.remaining} units when I am back. Kept until ${until}.`)} />
          <Option on={decision === "release"} onClick={() => setDecision("release")} testId="partial-release" title={L("تحرير المتبقي لزميل", "Release the rest to a colleague")} desc={L("يتابعه أي موظف في محطة التجهيز من حيث توقفتُ.", "Anyone at the preparation station continues from where I stopped.")} />
          <Info tone="muted" title={verifiedLots.length ? <>{L(`يُسجَّل ما تحقق منه فقط: ${line.picked + line.handedOff} وحدة من اللوت`, `Only what was verified is recorded: ${line.picked + line.handedOff} units from lot`)} {verifiedLots.map((x, i) => <span key={x.batchNumber}>{i ? " · " : ""}<Bid>{x.batchNumber}</Bid></span>)}.</> : L("لم يُتحقق من أي وحدة في هذا البند بعد.", "No unit of this line was verified yet.")}>
            {L("لا تتكرر أي حركة عند المتابعة. الطلب يبقى غير مكتمل في النظام.", "Nothing is repeated when you continue. The order stays open in the ERP.")}
          </Info>
          {offlineBox}{errBox}
        </div>
      </Sheet></>);
  }

  // ── P2 / P3 picking and lot verification ────────────────────────────────────────────────
  const ambiguous = needFull && match?.kind !== "unique" ? needFull : null;
  const wrong = match?.kind === "wrong" ? match : null;
  const unique = match?.kind === "unique" ? match : null;
  const fullLen = needFull?.len ?? 10;
  const units = unique ? Math.min(unique.pickable, line.remaining) : 0;
  const nxt = nextLine(o, line.id);
  const onKey = (k: string) => typeEntry(k === "del" ? entry.slice(0, -1) : lotChars(entry + k));
  return (<>{bar}
    <Sheet testId={ambiguous ? "station-prep-ambiguous" : wrong ? "station-prep-wrong" : "station-prep-pick"}
      head={<Head title={<bdi>{cust(o)}</bdi>} sub={orderSub(o)} steps={{ items: steps, cur: 1 }} status={{ tone: "in", label: L("قيد التجهيز", "Being prepared") }} since={claimSince(o)} />}
      foot={<>
        {ambiguous && entry.length < fullLen
          ? <Primary disabled testId="pick-confirm">{L("تحقق من الرقم الكامل", "Check the full number")}</Primary>
          : <Primary disabled={!unique || units <= 0 || !online || sending} wait={sending} onClick={() => void confirmPick()} testId="pick-confirm">{unique ? L(`تأكيد ${units} وحدات من اللوت`, `Confirm ${units} units from the lot`) : L("أدخل رقم اللوت", "Enter the lot number")}</Primary>}
        <Secondary onClick={() => { setErr(""); setDecision("keep"); setView({ v: "partial", id: o.id, lineId: line.id }); }} testId="pick-short">{L("نقص في اللوت", "Lot short")}</Secondary>
        <Note>{ambiguous ? L("يُفعَّل التحقق بعد إدخال الرقم كاملًا.", "Checking is enabled once the full number is entered.") : L("يُسجَّل المتحقق منه فقط. يمكن إكمال الباقي لاحقًا دون تكرار أي حركة.", "Only what is verified is recorded. The rest can be finished later without repeating anything.")}</Note>
      </>}>
      <div className="ws-split">
        <div className="ws-col" style={{ gap: 16 }}>
          {lineHead}{nums}
          <div className="ws-lots" data-testid="prep-lots">
            {line.lots.map((x) => {
              const isMatch = unique?.batchNumber === x.batchNumber;
              const isCand = ambiguous?.candidates.includes(x.batchNumber);
              return (
                <div key={x.batchNumber} className={`ws-lot${isMatch ? " on" : wrong && x.pickable > 0 && !x.picked ? "" : ""}`} data-testid={`prep-lot-${x.batchNumber}`}>
                  <span className="ws-lot-l">{L("لوت", "Lot")}</span><span className="ws-lot-n">{x.batchNumber}</span>
                  <span className="ws-lot-u"><span className="n">{x.picked > 0 ? x.picked : x.pickable}</span> {L("وحدة", "units")}</span>
                  <span style={{ flex: 1 }} />
                  {x.pickable === 0 && x.picked > 0 ? <span className="st ws-st ok">{L("تم التحقق", "Verified")} · <Num>{x.verifiedAt ? clock(x.verifiedAt, false) : ""}</Num></span>
                    : isMatch ? <span className="st ws-st ok">{L("مطابق", "Match")}</span>
                    : isCand ? <span className="st ws-st">{L("بانتظار التحقق", "Waiting to verify")}</span>
                    : x.picked > 0 ? <span className="st ws-st in">{L(`تحقق ${x.picked}`, `${x.picked} verified`)}</span> : null}
                </div>
              );
            })}
          </div>
          {unique ? (
            <Info tone="muted" title={<>{L("مطابق:", "Match:")} <bdi>{lineName(unique)}</bdi> · <Bid>{unique.skuCode}</Bid></>} testId="match-unique">
              {L("لوت", "Lot")} <Bid>{unique.batchNumber}</Bid> · {L(`${units} وحدات محجوزة لهذا البند. أكّد بعد العدّ.`, `${units} units reserved for this line. Confirm after counting.`)}
            </Info>
          ) : wrong ? (
            <Info tone="err" title={wrong.other ? <>{L("لوت مختلف:", "Different lot:")} <Bid>{wrong.other}</Bid> {wrong.reason === "OTHER_SKU" ? L("لصنف آخر، ليس محجوزًا لهذا البند.", "is another product, not reserved for this line.") : L("ليس محجوزًا لهذا البند.", "is not reserved for this line.")}</> : L("لا يطابق أي لوت محجوز لهذا البند.", "It matches no lot reserved for this line.")} testId="match-wrong">
              {L("أعد إدخال الرقم من العلبة الصحيحة. لم يُسجَّل شيء.", "Enter the number from the right box again. Nothing was recorded.")}
            </Info>
          ) : ambiguous ? (
            <Info tone="warn" title={L(`آخر 4 أرقام تطابق ${ambiguous.candidates.length === 2 ? "لوتين محجوزين" : `${ambiguous.candidates.length} لوتات محجوزة`} لهذا البند.`, `The last 4 digits match ${ambiguous.candidates.length} lots reserved for this line.`)} testId="match-ambiguous">
              {L("أدخل رقم اللوت كاملًا كما هو مطبوع على العلبة. لا يُقبل تطابق غير فريد.", "Enter the full lot number as printed on the box. A non-unique match is never accepted.")}
            </Info>
          ) : null}
          {nxt ? <div className="ws-next"><span aria-hidden="true" /><span>{L("التالي:", "Next:")} <bdi>{lineName(nxt)}</bdi> · <Num>{nxt.remaining}</Num> {L("وحدات", "units")} · {L(nxt.lots.length === 1 ? "لوت محجوز" : nxt.lots.length === 2 ? "لوتان محجوزان" : `${nxt.lots.length} لوتات محجوزة`, `${nxt.lots.length} reserved lot(s)`)}</span></div> : null}
          {offlineBox}{errBox}
        </div>
        <div className="ws-entry-col">
          <div className="ws-entry-l">{ambiguous ? L(`رقم اللوت كاملًا · ${fullLen} أرقام`, `Full lot number · ${fullLen} digits`) : L("آخر 4 أرقام من رقم اللوت · المسح غير مفعّل بعد", "Last 4 digits of the lot number · scanning is not enabled yet")}</div>
          <div className={`ws-entry${wrong ? " bad" : ""}`}>
            <input value={entry} onChange={(e) => typeEntry(lotChars(e.target.value))} inputMode="numeric" autoComplete="off" dir="ltr" aria-label={L("رقم اللوت", "Lot number")} data-testid="lot-entry" autoFocus />
          </div>
          <Keypad onKey={onKey} off={sending} decimal={false} delLabel={L("حذف", "Delete")} />
        </div>
      </div>
    </Sheet></>);
}
