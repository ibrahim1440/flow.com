"use client";
// QC station (Phase 9 W3, Figma page 630:2): Q1 the queue by the 48 h deadline, Q2 the batch and its
// earlier records, Q3 inspect (whole + ground readings with device and scale, defects, sensory,
// «حقول إضافية», the standard measuring method), Q4 the confirmed result (released / held / waiting
// for another evaluator) and the exception request, Q5 the held batches (view only), Q6 the history.
// Owner decisions of 23 Oct 2026 win over the frames: colour reads «أفتح من الهدف / مطابق / أغمق من
// الهدف» (no development inferred from colour), the loss is information only, «المواصفة قيد
// المعايرة» shows no numbers, and an out-of-spec batch is HELD — never rejected at the station.
// The server decides everything (H12); every write carries an Idempotency-Key kept until the answer
// is conclusive. Nothing here releases, disposes or destroys: those are ERP decisions by another person.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useStation } from "../../_ui/context";
import { st } from "@/lib/i18n/station";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { newRequestKey, isConclusiveResponse } from "@/lib/request-key";
import { StationBar, Sheet, Head, Primary, Secondary, Note, Info, Row, Side, Chips, DoneMark, Bid, Num, CheckIco } from "../../_ui/blocks";
import {
  DEFAULT_DEVICE, DEFAULT_SCALE, DEFECT_KEYS, DEFECT_WORD, EXCEPTION_REASONS, EXCEPTION_REASON_WORD, HOLD_REASON_WORD, MEASURE_CHECKLIST, NO_DEFECTS, PERMITTED_USES, PERMITTED_USE_WORD,
  SENSORY_RESULTS, SENSORY_WHY_WORD, SENSORY_WORD, VERDICT_WORD, colorVerdict, judgeInspection, parseReading, sensoryRequirement,
  type Defects, type ExceptionReason, type HoldReason, type PermittedUse, type SensoryResult, type SpecSnapshot, type Verdict,
} from "@/lib/qc/spec";
import type { HeldBatch, InspectionResult, QueueBatch } from "@/lib/services/qc/inspection";

type Api = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- API bodies are read field by field
type Queue = { pending: QueueBatch[]; held: HeldBatch[]; history: HistoryRow[]; minEvaluators: number; serverTime: string };
type HistoryRow = { id: string; at: string; outcome: string | null; reasons: HoldReason[]; whole: number | null; ground: number | null; wholeVerdict: Verdict | null; groundVerdict: Verdict | null; inspector: string | null; batchId: string; batchNumber: string; nameEn: string; nameAr: string | null };
type RecordRow = {
  id: string; kind: string | null; at: string; decision: string; outcome: string | null; whole: number | null; ground: number | null; wholeVerdict: Verdict | null; groundVerdict: Verdict | null;
  defects: Defects; sensory: SensoryResult | null; sensoryNotes: string | null; reasons: HoldReason[]; manualDecision: string | null; manualNote: string | null; by: string | null; cleaningNote: string | null; remarks: string | null;
};
type Detail = {
  batch: {
    id: string; batchNumber: string; status: string; nameEn: string; nameAr: string | null; roastedKg: number; greenKg: number; availableKg: number; lossPct: number | null; roastedAt: string; qcDeadline: string | null;
    orderNumber: number | null; roaster: string | null; isBlend: boolean; hold: { at: string | null; recordId: string | null; foreign: boolean } | null;
  };
  spec: SpecSnapshot; sensoryDueFirstOfDay: boolean; minEvaluators: number; records: RecordRow[];
  exceptions: { id: string; number: string; status: string; reason: string; requestedByName: string; decidedByName: string | null; createdAt: string }[];
  dispositions: { id: string; number: string; kind: string; status: string; createdAt: string }[];
};
type View =
  | { v: "queue" } | { v: "held" } | { v: "history" }
  | { v: "batch"; id: string } | { v: "inspect"; id: string }
  | { v: "result"; r: InspectionResult } | { v: "exception"; id: string } | { v: "excDone"; number: string; batchNumber: string; at: string };

const TZ = "Asia/Riyadh";
const kg2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const clock = (d: string | number | Date, sec = false) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}), hour12: false });
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

export function QualityStation() {
  const { user, signOut, mode, station, lock, switchEmployee } = useStation();
  const onDevice = mode === "device";
  const lang: "ar" | "en" = user.preferredLanguage === "en" ? "en" : "ar";
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [q, setQ] = useState<Queue | null>(null);
  const [view, setView] = useState<View>({ v: "queue" });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState("");
  const [unauth, setUnauth] = useState<string | false>(false);
  const [err, setErr] = useState<string | null>(null);

  // «اليوم / غدًا / 8 أكتوبر» + time, in Riyadh.
  const when = useCallback((iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso), now = new Date();
    const tomorrow = new Date(now.getTime() + 86400_000), yesterday = new Date(now.getTime() - 86400_000);
    const day = dayKey(d) === dayKey(now) ? L("اليوم", "today") : dayKey(d) === dayKey(tomorrow) ? L("غدًا", "tomorrow") : dayKey(d) === dayKey(yesterday) ? L("أمس", "yesterday")
      : d.toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: TZ, day: "numeric", month: "long" });
    return `${day} ${clock(d)}`;
  }, [L, lang]);

  // ── Reads / writes (the W4 pattern) ──────────────────────────────────────────────────────
  const read = useCallback(async (url: string, poll = false): Promise<Api | null> => {
    try {
      const r = await fetch(url, { cache: "no-store", headers: poll ? { "x-station-poll": "1" } : {} });
      setOnline(true);
      if (r.status === 401) { await signOut(onDevice ? "ended" : undefined); return null; }
      if (r.status === 403) { const j = await r.json().catch(() => ({})); setUnauth(localizeApiError(j, lang) ?? ""); return null; }
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch { setOnline(false); return null; }
  }, [signOut, onDevice, lang]);
  const keys = useRef<Record<string, string>>({});
  const post = useCallback(async (slot: string, url: string, body: unknown): Promise<Api | null> => {
    const key = (keys.current[slot] ??= newRequestKey());
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
      setOnline(true);
      const j = await r.json().catch(() => ({}));
      if (isConclusiveResponse(r.status)) delete keys.current[slot];
      if (r.status === 401) { await signOut(onDevice ? "ended" : undefined); return null; }
      return { status: r.status, body: j };
    } catch { setOnline(false); return null; }
  }, [signOut, onDevice]);
  const refusal = useCallback((b: unknown) => localizeApiError(b, lang) ?? L("تعذّر تنفيذ الإجراء.", "The action could not be completed."), [lang, L]);

  const load = useCallback(async (poll = false) => {
    const r = await read("/api/station/quality/queue", poll);
    if (r?.status === 200) { setQ(r.body); setUpdated(clock(Date.now(), true)); }
  }, [read]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the queue is an external system read on mount
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = setInterval(() => { void load(true); }, online ? 15000 : 5000); return () => clearInterval(id); }, [load, online]);
  useEffect(() => {
    const off = () => setOnline(false), on = () => { setOnline(true); void load(); };
    window.addEventListener("offline", off); window.addEventListener("online", on);
    return () => { window.removeEventListener("offline", off); window.removeEventListener("online", on); };
  }, [load]);

  const openBatch = useCallback(async (id: string, next: "batch" | "inspect" | "exception" = "batch") => {
    setErr(null);
    const r = await read(`/api/station/quality/batches/${encodeURIComponent(id)}`);
    if (r?.status === 200) { setDetail(r.body); setView({ v: next, id } as View); }
    else if (r) setErr(refusal(r.body));
  }, [read, refusal]);
  // A deep link from the ERP QC page: /station/quality?batch=<id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("batch");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is read once on mount
    if (id) void openBatch(id);
  }, [openBatch]);

  // ── Chrome ──────────────────────────────────────────────────────────────────────────────
  const conn = !online ? { tone: "er" as const, label: st("offline", lang) } : busy ? { tone: "in" as const, label: st("connectedWaiting", lang) } : { tone: "ok" as const, label: st("connected", lang) };
  const bar = (
    <StationBar station={station?.name ?? L("محطة الجودة", "QC station")} location={station?.place ?? undefined} conn={conn} updated={updated || "—"} updatedWord={st("lastUpdate", lang)}
      emp={{ name: user.name, tag: onDevice ? st("stationSession", lang) : st("personalSession", lang) }}
      lockLabel={st("lock", lang)} switchLabel={st("switchEmployee", lang)} onLock={() => void lock()} onSwitch={() => switchEmployee()} />
  );
  const offlineBox = !online ? <Info tone="err" title={st("offlineTitle", lang)} testId="station-offline">{st("offlineBody", lang, { time: updated || "—" })}</Info> : null;
  const errBox = err ? <Info tone="err" title={err} testId="qc-error" /> : null;
  const nm = (x: { nameEn: string; nameAr: string | null }) => (lang === "ar" ? x.nameAr || x.nameEn : x.nameEn);
  const owner = (x: { orderNumber: number | null }) => (x.orderNumber ? <>{L("للطلب", "For order")} <b className="n">#{x.orderNumber}</b></> : L("للمخزون", "For stock"));

  if (unauth !== false) {
    return (<>{bar}
      <Sheet plain testId="station-unauth" foot={<><Primary onClick={() => void signOut()} testId="station-signout">{onDevice ? st("s7Back", lang) : st("signOut", lang)}</Primary><Note>{onDevice ? st("s7Note", lang) : st("unauthNote", lang)}</Note></>}>
        <div className="ws-done" style={{ maxWidth: 640 }}>
          <span className="ws-mark-warn" aria-hidden="true">!</span>
          <h1 className="ws-t2" style={{ fontSize: 28, lineHeight: "38px" }}>{unauth || L("لا تملك صلاحية العمل في محطة الجودة.", "You do not hold the QC station's privilege.")}</h1>
        </div>
      </Sheet></>);
  }
  if (!q) return (<>{bar}<Sheet plain><span role="status">{st("loading", lang)}</span></Sheet></>);

  const shared = { lang, L, q, detail, post, refusal, busy, setBusy, bar, offlineBox, errBox, nm, owner, when, setView, openBatch, load, setErr, online };

  if (view.v === "held") return <HeldList {...shared} />;
  if (view.v === "history") return <History {...shared} />;
  if (view.v === "batch" && detail) return <BatchDetail {...shared} d={detail} />;
  if (view.v === "inspect" && detail) return <Inspect {...shared} d={detail} />;
  if (view.v === "exception" && detail) return <ExceptionRequest {...shared} d={detail} />;
  if (view.v === "result") return <Result {...shared} r={view.r} />;
  if (view.v === "excDone") return <ExceptionSent {...shared} number={view.number} batchNumber={view.batchNumber} at={view.at} />;
  return <QueueView {...shared} />;
}

type Shared = {
  lang: "ar" | "en"; L: (ar: string, en: string) => string; q: Queue; detail: Detail | null;
  post: (slot: string, url: string, body: unknown) => Promise<Api | null>; refusal: (b: unknown) => string;
  busy: boolean; setBusy: (b: boolean) => void; bar: ReactNode; offlineBox: ReactNode; errBox: ReactNode;
  nm: (x: { nameEn: string; nameAr: string | null }) => string; owner: (x: { orderNumber: number | null }) => ReactNode; when: (iso: string | null) => string;
  setView: (v: View) => void; openBatch: (id: string, next?: "batch" | "inspect" | "exception") => Promise<void>; load: (poll?: boolean) => Promise<void>; setErr: (e: string | null) => void; online: boolean;
};

const verdictTone = (v: Verdict | null) => (v === "ON_TARGET" ? "ok" : v ? "wa" : "");
function specLine(spec: SpecSnapshot, L: Shared["L"]) {
  if (spec.state !== "APPROVED") return null;
  return `${spec.profileName} · ${L("الإصدار", "v")} ${spec.version} · ${L("حبوب", "whole")} ${spec.whole.target} ± ${spec.whole.tol} · ${L("مطحون", "ground")} ${spec.ground.target} ± ${spec.ground.tol} · ${spec.scale} · ${spec.device}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q1 · the queue
// ════════════════════════════════════════════════════════════════════════════════════════════════
function QueueView(p: Shared) {
  const { L, q, bar, offlineBox, errBox, nm, owner, when, openBatch, setView } = p;
  const next = q.pending[0] ?? null;
  const serverNow = new Date(q.serverTime).getTime();
  const overdue = q.held.filter((h) => h.heldAt && serverNow - new Date(h.heldAt).getTime() > 48 * 3600_000).length;
  return (<>{bar}
    <Sheet testId="qc-queue"
      head={<Head title={L("بانتظار الفحص", "Awaiting inspection")} sub={L("مرتبة حسب المهلة · 48 ساعة من التسجيل", "By deadline · 48 hours from recording")} status={{ tone: "in", label: L(`${q.pending.length} دفعات`, `${q.pending.length} batches`) }} since={<>{L("آخر تحديث", "Updated")} {clock(q.serverTime, true)}</>} />}
      foot={<>
        <Primary onClick={() => next && void openBatch(next.id)} disabled={!next} testId="qc-open-next">{next ? <>{L("فتح الأقرب مهلة", "Open the nearest deadline")} · <Bid>{next.batchNumber}</Bid></> : L("لا دفعات بانتظار الفحص", "No batch awaits inspection")}</Primary>
        <Secondary onClick={() => setView({ v: "held" })} testId="qc-held-open">{L("المحجوزة", "Held")} · <Num>{q.held.length}</Num></Secondary>
        <Secondary onClick={() => setView({ v: "history" })} testId="qc-history-open">{L("السجل", "History")}</Secondary>
        <Note>{L("المس أي دفعة لفتحها.", "Touch any batch to open it.")}</Note>
      </>}>
      {offlineBox}{errBox}
      <div className="ws-split">
        <div className="ws-rows" data-testid="qc-rows">
          {q.pending.length === 0 ? <Info tone="muted" title={L("لا شيء بانتظار الفحص الآن.", "Nothing awaits inspection now.")} /> : null}
          {q.pending.map((b, i) => (
            <Row key={b.id} on={i === 0} onClick={() => void openBatch(b.id)} testId={`qc-row-${b.batchNumber}`}
              title={<><bdi>{nm(b)}</bdi> · <Bid>{b.batchNumber}</Bid></>}
              sub={<>{owner(b)} · {kg2(b.roastedKg)} {L("كغ", "kg")}{b.records ? <> · {b.accepts === 1 ? L("سجل قبول واحد", "one accept record") : L(`${b.records} سجلات`, `${b.records} records`)}</> : null}{b.specState === "CALIBRATING" ? <> · {L("المواصفة قيد المعايرة", "Spec under calibration")}</> : null}{b.isBlend ? <> · {L("خلطة", "blend")}</> : null}</>}
              right={<div style={{ textAlign: "end" }}><div className="lbl">{L("المهلة", "Deadline")}</div><div className="ws-row-time">{when(b.qcDeadline)}</div></div>} />
          ))}
        </div>
        <Side title={L("المحجوزة", "Held")}>
          <div className="ws-side-l">{L(`${q.held.length} دفعة`, `${q.held.length} batch(es)`)}{overdue ? L(` · ${overdue} تجاوزت 48 ساعة`, ` · ${overdue} over 48 hours`) : ""}</div>
          <div className="ws-side-l">{L("القرار فيها يتم في النظام، لا في المحطة.", "They are decided in the ERP, not at the station.")}</div>
          <div className="ws-side-l">{L("الحد الأدنى للمقيّمين:", "Minimum evaluators:")} <Num>{q.minEvaluators}</Num></div>
        </Side>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q2 · the batch and its earlier records
// ════════════════════════════════════════════════════════════════════════════════════════════════
function Facts2({ d, p }: { d: Detail; p: Shared }) {
  const { L, when } = p;
  const b = d.batch;
  return (
    <div className="ws-facts" data-testid="qc-facts">
      <div><div className="lbl">{L("المحمص", "Roasted")}</div><div className="ws-fact-v"><Num>{kg2(b.roastedKg)}</Num> {L("كغ", "kg")}</div></div>
      <div><div className="lbl">{L("الفاقد · للمرجع فقط", "Loss · reference only")}</div><div className="ws-fact-v" data-testid="qc-loss">{b.lossPct === null ? "—" : <Num>{b.lossPct.toFixed(1)}%</Num>}</div></div>
      <div><div className="lbl">{L("حُمّصت", "Roasted at")}</div><div className="ws-fact-v">{when(b.roastedAt)}</div></div>
      {b.roaster ? <div><div className="lbl">{L("المحمصة", "Roaster")}</div><div className="ws-fact-v">{b.roaster}</div></div> : null}
    </div>
  );
}

function SpecBox({ spec, L }: { spec: SpecSnapshot; L: Shared["L"] }) {
  if (spec.state === "APPROVED") {
    return <div className="ws-spec" data-testid="qc-spec"><b>{L("المواصفة المعتمدة", "Approved spec")}</b><span>{specLine(spec, L)}</span></div>;
  }
  return (
    <div className="ws-spec cal" data-testid="qc-spec-calibrating">
      <b>{L("المواصفة قيد المعايرة", "Specification under calibration")}</b>
      <span>{spec.profileName ? L(`${spec.profileName}${spec.draftVersion ? ` · الإصدار ${spec.draftVersion} قيد التطوير` : ""} · `, `${spec.profileName}${spec.draftVersion ? ` · v${spec.draftVersion} in development` : ""} · `) : ""}{L("لا مطابقة رقمية: القبول يدوي وموثّق.", "No numeric conformity: acceptance is manual and documented.")}</span>
    </div>
  );
}

function BatchDetail(p: Shared & { d: Detail }) {
  const { L, d, bar, offlineBox, errBox, nm, owner, when, setView, openBatch } = p;
  const b = d.batch;
  const held = b.status === "QC Hold";
  const open = d.exceptions.find((e) => e.status === "PENDING") ?? d.dispositions.find((x) => x.status === "PENDING" || x.status === "APPROVED") ?? null;
  const canException = held && !b.hold?.foreign && d.spec.state === "APPROVED" && !open;
  const lastInspection = d.records.find((r) => r.kind === "INSPECTION");
  const holdSpecApproved = held && !!lastInspection && d.records.length > 0;
  return (<>{bar}
    <Sheet testId="qc-batch"
      head={<Head title={nm(b)} sub={<>{L("الدفعة", "Batch")} <Bid>{b.batchNumber}</Bid> · {owner(b)}</>} steps={{ items: [L("فتح الدفعة", "Open"), L("تسجيل الفحص", "Inspect"), L("القرار", "Decision"), L("تأكيد النتيجة", "Confirmed")], cur: 0 }}
        status={held ? { tone: "er", label: L("محجوزة", "Held") } : b.status === "Pending QC" ? { tone: "in", label: L("بانتظار الجودة", "Awaiting QC") } : { tone: "ok", label: b.status }}
        since={b.qcDeadline && !held ? <>{L("المهلة", "Deadline")} {when(b.qcDeadline)}</> : held && b.hold?.at ? <>{L("حُجزت", "Held")} {when(b.hold.at)}</> : null} />}
      foot={<>
        {b.status === "Pending QC" || (held && !open) ? (
          <Primary onClick={() => void openBatch(b.id, "inspect")} testId="qc-start-inspection">{held ? L("إعادة الفحص", "Re-inspect") : L("تسجيل فحص", "Record an inspection")}</Primary>
        ) : <Primary disabled testId="qc-start-inspection">{held ? L("قيد القرار في النظام", "Being decided in the ERP") : L("قُرّرت جودتها", "QC decided")}</Primary>}
        {canException && holdSpecApproved ? <Secondary onClick={() => setView({ v: "exception", id: b.id })} testId="qc-ask-exception">{L("طلب استثناء", "Request an exception")}</Secondary> : null}
        <Secondary onClick={() => setView(held ? { v: "held" } : { v: "queue" })} testId="qc-back">{L("العودة للطابور", "Back to the queue")}</Secondary>
        <Note>{L("لا يتغير شيء حتى تسجّل الفحص ويؤكده النظام.", "Nothing changes until you record the inspection and the system confirms it.")}</Note>
      </>}>
      {offlineBox}{errBox}
      <div style={{ display: "grid", gap: 16 }}>
        <Facts2 d={d} p={p} />
        <SpecBox spec={d.spec} L={L} />
        {held ? (
          <Info tone={b.hold?.foreign ? "err" : "warn"} title={b.hold?.foreign ? L("محجوزة لأجسام غريبة / تلوث", "Held for foreign objects / contamination") : L("محجوزة · لا تُعبّأ ولا تُجهّز", "Held · not packed or picked")} testId="qc-hold-info">
            {b.hold?.foreign ? L("لا يُفرج عنها باستثناء تجاري. الطريق: إعادة الفحص بعد التنظيف، أو الإتلاف بقرار في النظام.", "No commercial exception can release it. Re-inspect after cleaning, or destroy it by an ERP decision.") : L("التصرف فيها (استثناء، تحويل، خلط بوصفة، إتلاف) يقرره شخص آخر في النظام.", "Its disposition (exception, conversion, recipe blend, destruction) is decided by another person in the ERP.")}
            {open ? <> · {L("قيد القرار:", "Pending:")} <Bid>{open.number}</Bid></> : null}
          </Info>
        ) : null}
        <div>
          <div className="ws-lab">{L("السجلات السابقة", "Earlier records")}</div>
          {d.records.length === 0 ? <div className="ws-side-l">{L("لا سجلات بعد.", "No records yet.")}</div> : d.records.map((r) => (
            <div key={r.id} className="ws-rec" data-testid="qc-record">
              <span><b>{r.by ?? "—"}</b> · {r.kind === "INSPECTION" ? (r.outcome === "HELD" ? L("حجز", "Held") : r.outcome === "RELEASED" ? L("إفراج", "Released") : L("مطابقة · بانتظار مقيّم", "Conforming · awaiting evaluator")) : r.decision === "Accept" ? L("قبول", "Accept") : L("رفض", "Reject")}
                {r.whole !== null || r.ground !== null ? <> · {L("حبوب", "whole")} <Num>{r.whole ?? "—"}</Num> / {L("مطحون", "ground")} <Num>{r.ground ?? "—"}</Num></> : null}
                {r.reasons.length ? <> · {r.reasons.map((x) => HOLD_REASON_WORD[x][p.lang]).join("، ")}</> : null}
                {r.cleaningNote ? <> · {L("تنظيف:", "Cleaning:")} {r.cleaningNote}</> : null}</span>
              <span className="n">{when(r.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q3 · inspect (record + the outcome the server will confirm)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function Inspect(p: Shared & { d: Detail }) {
  const { L, lang, d, bar, offlineBox, errBox, nm, owner, when, post, refusal, setBusy, setView, q, openBatch, setErr, load, busy } = p;
  const b = d.batch;
  const spec = d.spec;
  const held = b.status === "QC Hold";
  const devDefault = spec.state === "APPROVED" ? spec.device : DEFAULT_DEVICE;
  const scaleDefault = spec.state === "APPROVED" ? spec.scale : DEFAULT_SCALE;
  const [whole, setWhole] = useState("");
  const [ground, setGround] = useState("");
  const [dev, setDev] = useState({ wholeDevice: devDefault, wholeScale: scaleDefault, groundDevice: devDefault, groundScale: scaleDefault });
  const [defects, setDefects] = useState<Defects>(NO_DEFECTS);
  const [sensory, setSensory] = useState<SensoryResult | null>(null);
  const [sensoryNotes, setSensoryNotes] = useState("");
  const [manual, setManual] = useState<"ACCEPT" | "HOLD" | null>(null);
  const [manualNote, setManualNote] = useState("");
  const [extra, setExtra] = useState({ cuppingScore: "", moisturePct: "", densityGL: "" });
  const [cleaningNote, setCleaningNote] = useState("");
  const wv = parseReading(whole), gv = parseReading(ground);
  const wNum = wv.ok ? wv.value : null, gNum = gv.ok ? gv.value : null;
  const approved = spec.state === "APPROVED";
  const wVerdict = approved && wNum !== null ? colorVerdict(wNum, spec.whole.target, spec.whole.tol) : null;
  const gVerdict = approved && gNum !== null ? colorVerdict(gNum, spec.ground.target, spec.ground.tol) : null;
  const sensoryWhy = sensoryRequirement({ firstOfDay: d.sensoryDueFirstOfDay, verdicts: [wVerdict, gVerdict], defects });
  const judged = judgeInspection(spec, { whole: wNum, ground: gNum, defects, sensory, manual, manualNote: manualNote.trim() || null }, { firstOfDay: d.sensoryDueFirstOfDay });
  const needsCleaning = held && b.hold?.foreign && cleaningNote.trim().length < 3;
  const ready = judged.ok && !needsCleaning && wv.ok && gv.ok;
  const verdictText = (v: Verdict | null) => v ? <span className={`st ${verdictTone(v)} ws-verdict`} data-testid="qc-verdict">{VERDICT_WORD[v][lang]}</span> : null;

  async function submit() {
    if (!ready) return;
    setBusy(true); setErr(null);
    const r = await post(`inspect-${b.id}`, "/api/station/quality/inspections", {
      batchId: b.id, whole: wNum, ground: gNum, ...dev, defects, sensory, sensoryNotes: sensoryNotes.trim() || null, manual: approved ? null : manual, manualNote: approved ? null : manualNote.trim() || null,
      cuppingScore: extra.cuppingScore || null, moisturePct: extra.moisturePct || null, densityGL: extra.densityGL || null, cleaningNote: held ? cleaningNote.trim() || null : null,
    });
    setBusy(false);
    if (!r) return;
    if (r.status === 200 || r.status === 201) { void load(); setView({ v: "result", r: r.body }); return; }
    setErr(refusal(r.body));
  }
  const outcomeText = !judged.ok
    ? judged.code === "READINGS_REQUIRED" ? L("أدخل قراءتي الحبوب والمطحون.", "Enter both readings.")
      : judged.code === "SENSORY_REQUIRED" ? L(`التقييم الحسي مطلوب: ${SENSORY_WHY_WORD[judged.why ?? "DEVIATION"].ar}.`, `Sensory evaluation required: ${SENSORY_WHY_WORD[judged.why ?? "DEVIATION"].en}.`)
      : judged.code === "MANUAL_DECISION_REQUIRED" ? L("المواصفة قيد المعايرة: اختر القبول أو الحجز يدويًا.", "Spec under calibration: choose accept or hold.")
      : L("اكتب سبب قرارك اليدوي.", "Document your manual decision.")
    : judged.hold ? L(`عند التأكيد تُحجز الدفعة: ${judged.holdReasons.map((x) => HOLD_REASON_WORD[x].ar).join("، ")}.`, `On confirmation the batch is HELD: ${judged.holdReasons.map((x) => HOLD_REASON_WORD[x].en).join(", ")}.`)
    : L(`عند التأكيد يُسجَّل فحصك${d.records.length + 1 >= d.minEvaluators ? " ويُفرج عن الدفعة للتعبئة" : " وتبقى الدفعة بانتظار مقيّم آخر (الحد الأدنى " + d.minEvaluators + ")"}.`, `On confirmation your inspection is recorded${d.records.length + 1 >= d.minEvaluators ? " and the batch is released for packing" : `; the batch waits for another evaluator (minimum ${d.minEvaluators})`}.`);
  return (<>{bar}
    <Sheet testId="qc-inspect"
      head={<Head title={nm(b)} sub={<>{L("الدفعة", "Batch")} <Bid>{b.batchNumber}</Bid> · {owner(b)}</>} steps={{ items: [L("فتح الدفعة", "Open"), L("تسجيل الفحص", "Inspect"), L("القرار", "Decision"), L("تأكيد النتيجة", "Confirmed")], cur: wNum !== null && gNum !== null ? 2 : 1 }}
        status={held ? { tone: "er", label: L("محجوزة · إعادة فحص", "Held · re-inspection") } : { tone: "in", label: L("بانتظار الجودة", "Awaiting QC") }} since={b.qcDeadline && !held ? <>{L("المهلة", "Deadline")} {when(b.qcDeadline)}</> : null} />}
      foot={<>
        <Primary onClick={() => void submit()} disabled={!ready || !p.online} wait={busy} danger={judged.ok && judged.hold} testId="qc-confirm">{judged.ok && judged.hold ? L("تأكيد الفحص والحجز", "Confirm and hold") : L("تأكيد الفحص", "Confirm the inspection")}</Primary>
        <Secondary onClick={() => void openBatch(b.id)} testId="qc-cancel">{L("تراجع", "Back")}</Secondary>
        <Note>{L("لا يُعرض القرار كمكتمل قبل تأكيد النظام. يُرسل مرة واحدة بمفتاح تكرار.", "The result is not shown as done before the system confirms it. Sent once with an idempotency key.")}</Note>
      </>}>
      {offlineBox}{errBox}
      <div className="ws-split">
        <div className="ws-col">
          <Facts2 d={d} p={p} />
          <div style={{ marginTop: 12 }}><SpecBox spec={spec} L={L} /></div>
          {/* Colour: whole and ground, each with its device and scale; the verdict as text */}
          <div className="ws-qrow" data-testid="qc-row-color">
            <div className="ws-ql"><b>{L("درجة التحميص", "Roast colour")}</b><span>{approved ? `${spec.scale}` : L("قراءات دون هدف معتمد", "Readings without an approved target")}</span></div>
            <div className="ws-qv">
              <div className="ws-read"><label htmlFor="qc-whole">{L("حبوب", "Whole")}</label>
                <div><input id="qc-whole" data-testid="qc-whole" inputMode="decimal" autoComplete="off" value={whole} onChange={(e) => setWhole(e.target.value)} aria-invalid={!wv.ok || undefined} />
                  <div className="ws-dev">{dev.wholeDevice} · {dev.wholeScale}{approved ? ` · ${L("الهدف", "target")} ${spec.whole.target} ± ${spec.whole.tol}` : ""}</div></div>
                {verdictText(wVerdict)}</div>
              <div className="ws-read"><label htmlFor="qc-ground">{L("مطحون", "Ground")}</label>
                <div><input id="qc-ground" data-testid="qc-ground" inputMode="decimal" autoComplete="off" value={ground} onChange={(e) => setGround(e.target.value)} aria-invalid={!gv.ok || undefined} />
                  <div className="ws-dev">{dev.groundDevice} · {dev.groundScale}{approved ? ` · ${L("الهدف", "target")} ${spec.ground.target} ± ${spec.ground.tol}` : ""}</div></div>
                {verdictText(gVerdict)}</div>
            </div>
          </div>
          <div className="ws-qrow" data-testid="qc-row-defects">
            <div className="ws-ql"><b>{L("عيوب ظاهرة", "Visible defects")}</b><span>{L("أي عيب يحجز الدفعة", "Any defect holds the batch")}</span></div>
            <div className="ws-qv">
              {DEFECT_KEYS.map((k) => (
                <button key={k} type="button" className={`ws-chk${k === "foreign" ? " dz" : ""}`} aria-pressed={defects[k]} onClick={() => setDefects({ ...defects, [k]: !defects[k] })} data-testid={`qc-defect-${k}`}>
                  <span className="ws-box" aria-hidden="true">{defects[k] ? <CheckIco size="s" /> : null}</span>{DEFECT_WORD[k][lang]}
                </button>
              ))}
            </div>
          </div>
          <div className="ws-qrow" data-testid="qc-row-sensory">
            <div className="ws-ql"><b>{L("التقييم الحسي", "Sensory")}{sensoryWhy ? <span className="ws-req"> *</span> : null}</b><span data-testid="qc-sensory-why">{sensoryWhy ? L(`مطلوب: ${SENSORY_WHY_WORD[sensoryWhy].ar}`, `Required: ${SENSORY_WHY_WORD[sensoryWhy].en}`) : L("اختياري لهذه الدفعة", "Optional for this batch")}</span></div>
            <div className="ws-qv" style={{ display: "grid", gap: 10 }}>
              <Chips options={SENSORY_RESULTS.map((v) => ({ value: v, label: SENSORY_WORD[v][lang] }))} value={sensory} onChange={(v) => setSensory(sensory === v ? null : v)} label={L("التقييم الحسي", "Sensory")} testId="qc-sensory" />
              {sensory ? <textarea className="ws-text" rows={2} placeholder={L("ملاحظات التقييم الحسي", "Sensory notes")} value={sensoryNotes} onChange={(e) => setSensoryNotes(e.target.value)} data-testid="qc-sensory-notes" /> : null}
            </div>
          </div>
          {!approved && !(judged.ok && judged.hold && !judged.holdReasons.includes("MANUAL_HOLD")) ? (
            <div className="ws-qrow" data-testid="qc-row-manual">
              <div className="ws-ql"><b>{L("القرار اليدوي", "Manual decision")}<span className="ws-req"> *</span></b><span>{L("المواصفة قيد المعايرة · يُوثّق", "Spec under calibration · documented")}</span></div>
              <div className="ws-qv" style={{ display: "grid", gap: 10 }}>
                <Chips options={[{ value: "ACCEPT" as const, label: L("قبول يدوي", "Accept by hand") }, { value: "HOLD" as const, label: L("حجز", "Hold") }]} value={manual} onChange={setManual} label={L("القرار اليدوي", "Manual decision")} testId="qc-manual" />
                <textarea className="ws-text" rows={2} placeholder={L("سبب القرار (مطلوب)", "Why (required)")} value={manualNote} onChange={(e) => setManualNote(e.target.value)} data-testid="qc-manual-note" />
              </div>
            </div>
          ) : null}
          {held && b.hold?.foreign ? (
            <div className="ws-qrow" data-testid="qc-row-cleaning">
              <div className="ws-ql"><b>{L("التنظيف الذي أُجري", "Cleaning done")}<span className="ws-req"> *</span></b><span>{L("قبل إعادة الفحص بعد أجسام غريبة", "Before re-inspecting after foreign objects")}</span></div>
              <div className="ws-qv"><textarea className="ws-text" rows={2} value={cleaningNote} onChange={(e) => setCleaningNote(e.target.value)} data-testid="qc-cleaning" /></div>
            </div>
          ) : null}
          <details className="ws-more" data-testid="qc-extra">
            <summary>{L("حقول إضافية", "Additional fields")}</summary>
            <div>
              <div className="ws-grid3">
                <label>{L("درجة التذوق (0–100)", "Cupping score (0–100)")}<input inputMode="decimal" value={extra.cuppingScore} onChange={(e) => setExtra({ ...extra, cuppingScore: e.target.value })} data-testid="qc-cupping" /></label>
                <label>{L("الرطوبة %", "Moisture %")}<input inputMode="decimal" value={extra.moisturePct} onChange={(e) => setExtra({ ...extra, moisturePct: e.target.value })} data-testid="qc-moisture" /></label>
                <label>{L("الكثافة غ/ل", "Density g/L")}<input inputMode="decimal" value={extra.densityGL} onChange={(e) => setExtra({ ...extra, densityGL: e.target.value })} data-testid="qc-density" /></label>
              </div>
              <div className="ws-grid3">
                <label>{L("جهاز الحبوب", "Whole-bean device")}<input value={dev.wholeDevice} onChange={(e) => setDev({ ...dev, wholeDevice: e.target.value })} /></label>
                <label>{L("مقياس الحبوب", "Whole-bean scale")}<input value={dev.wholeScale} onChange={(e) => setDev({ ...dev, wholeScale: e.target.value })} /></label>
                <span />
                <label>{L("جهاز المطحون", "Ground device")}<input value={dev.groundDevice} onChange={(e) => setDev({ ...dev, groundDevice: e.target.value })} /></label>
                <label>{L("مقياس المطحون", "Ground scale")}<input value={dev.groundScale} onChange={(e) => setDev({ ...dev, groundScale: e.target.value })} /></label>
              </div>
            </div>
          </details>
          <details className="ws-more" data-testid="qc-method">
            <summary>{L("طريقة القياس الموحّدة (تحضير العينة · الطحن · التوقيت)", "Standard method (sample prep · grind · timing)")}</summary>
            <div>
              <ol>{MEASURE_CHECKLIST.map((c, i) => <li key={i}>{c[lang]}</li>)}</ol>
              <div className="ws-side-l">{L("المرجع: دليل جهاز DiFluid الرسمي (digitizefluid.com/pages/documents) لإعداد الجهاز ومعايرته وكمية العينة.", "Reference: the official DiFluid device guide (digitizefluid.com/pages/documents) for setup, calibration and sample amount.")}</div>
            </div>
          </details>
          <div style={{ marginTop: 12 }}><Info tone={judged.ok && judged.hold ? "warn" : "muted"} title={outcomeText} testId="qc-outcome-preview" /></div>
        </div>
        <Side title={<>{L("بانتظار الفحص", "Awaiting")} <Num>{q.pending.length}</Num></>}>
          {q.pending.slice(0, 4).map((x) => (
            <div key={x.id} className="ws-side-l" style={{ fontWeight: x.id === b.id ? 600 : 400 }}><bdi>{nm(x)}</bdi> · <Bid>{x.batchNumber}</Bid></div>
          ))}
          <div className="ws-side-l">{L("مرتبة حسب المهلة: 48 ساعة من التسجيل.", "By deadline: 48 hours from recording.")}</div>
        </Side>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q4 · the confirmed result
// ════════════════════════════════════════════════════════════════════════════════════════════════
function Result(p: Shared & { r: InspectionResult }) {
  const { L, lang, r, bar, q, openBatch, setView } = p;
  const next = q.pending.find((x) => x.id !== r.batchId) ?? null;
  const held = r.outcome === "HELD";
  return (<>{bar}
    <Sheet plain testId={held ? "qc-held-result" : r.outcome === "RELEASED" ? "qc-released" : "qc-awaiting"}
      foot={<>
        <Primary onClick={() => next ? void openBatch(next.id) : setView({ v: "queue" })} testId="qc-next">{next ? <>{L("الدفعة التالية", "Next batch")} · <Bid>{next.batchNumber}</Bid></> : L("عرض الطابور", "Show the queue")}</Primary>
        {held && !r.foreign && r.specState === "APPROVED" ? <Secondary onClick={() => void openBatch(r.batchId, "exception")} testId="qc-ask-exception">{L("طلب استثناء", "Request an exception")}</Secondary> : null}
        <Note>{held ? L("لا يُتلف شيء من المحطة. التصرف فيها يقرره شخص آخر في النظام.", "Nothing is destroyed at the station. Another person decides its disposition in the ERP.") : L("أكّد النظام القرار.", "The system confirmed the decision.")}</Note>
      </>}>
      <div className="ws-done">
        {held ? <span className="ws-mark-warn" aria-hidden="true">!</span> : <DoneMark />}
        <div className="ws-done-t" data-testid="station-title">{held ? L("حُجزت الدفعة", "The batch is held") : r.outcome === "RELEASED" ? L("أُفرج عن الدفعة للتعبئة", "Released for packing") : L("سُجّل الفحص · بانتظار مقيّم آخر", "Recorded · awaiting another evaluator")}</div>
        <div className="ws-done-n">{r.batchNumber}</div>
        <span className={`st ws-st ${held ? "er" : r.outcome === "RELEASED" ? "ok" : "in"}`} data-testid="qc-result-status">{held ? L("محجوزة · غير متاحة", "Held · not available") : r.outcome === "RELEASED" ? L("مقبولة · متاحة للتعبئة", "Passed · available for packing") : L(`مطابقة · ${r.records} من ${r.minEvaluators} مقيّمين`, `Conforming · ${r.records} of ${r.minEvaluators} evaluators`)}</span>
        <div className="ws-summary" style={{ minWidth: 520 }}>
          {r.specState === "APPROVED" ? <div className="ws-side-l">{L("حبوب", "Whole")}: {r.wholeVerdict ? VERDICT_WORD[r.wholeVerdict][lang] : "—"} · {L("مطحون", "Ground")}: {r.groundVerdict ? VERDICT_WORD[r.groundVerdict][lang] : "—"}</div> : <div className="ws-side-l">{L("المواصفة قيد المعايرة · قرار يدوي موثّق", "Spec under calibration · documented manual decision")}</div>}
          {held ? <div className="ws-side-l" data-testid="qc-hold-reasons">{L("السبب", "Why")}: {r.holdReasons.map((x) => HOLD_REASON_WORD[x][lang]).join("، ")}</div> : null}
          {r.foreign ? <div className="ws-side-l" style={{ color: "var(--status-danger)" }}>{L("أجسام غريبة / تلوث: لا استثناء تجاري. إعادة الفحص بعد التنظيف أو الإتلاف.", "Foreign objects / contamination: no commercial exception. Re-inspect after cleaning, or destroy.")}</div> : null}
          <div className="ws-side-l">{held ? L("المحمص", "Roasted") : L("المتاح", "Available")}: <Num>{kg2(r.availableKg)}</Num> {L("كغ", "kg")}{held ? L(" · غير متاح", " · not available") : ""}</div>
          <div className="ws-side-l">{L("فحصها", "Inspected by")} {r.inspector} · <Num>{clock(r.at, true)}</Num>{r.replayed ? L(" · (النتيجة نفسها، لم يتكرر التسجيل)", " · (same result, not recorded twice)") : ""}</div>
        </div>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q4 · exception request (reason row added at sign-off; owner: reason, quantity, permitted use)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function ExceptionRequest(p: Shared & { d: Detail }) {
  const { L, lang, d, bar, offlineBox, errBox, nm, post, refusal, setBusy, busy, setView, openBatch, setErr, load } = p;
  const b = d.batch;
  const [reason, setReason] = useState<ExceptionReason | null>(null);
  const [reasonNote, setReasonNote] = useState("");
  const [use, setUse] = useState<PermittedUse | null>(null);
  const [useNote, setUseNote] = useState("");
  const last = d.records.find((r) => r.kind === "INSPECTION");
  const ok = !!reason && !!use && (reason !== "OTHER" || reasonNote.trim()) && (use !== "CUSTOMER" || useNote.trim());
  async function send() {
    if (!ok) return;
    setBusy(true); setErr(null);
    const r = await post(`exc-${b.id}`, "/api/station/quality/exceptions", { batchId: b.id, reason, reasonNote: reasonNote.trim() || null, permittedUse: use, permittedUseNote: useNote.trim() || null, quantityKg: b.availableKg });
    setBusy(false);
    if (!r) return;
    if (r.status === 200 || r.status === 201) { void load(); setView({ v: "excDone", number: r.body.number, batchNumber: b.batchNumber, at: r.body.createdAt }); return; }
    setErr(refusal(r.body));
  }
  return (<>{bar}
    <Sheet testId="qc-exception"
      head={<Head title={nm(b)} sub={<>{L("الدفعة", "Batch")} <Bid>{b.batchNumber}</Bid></>} steps={{ items: [L("فتح الدفعة", "Open"), L("تسجيل الفحص", "Inspect"), L("القرار", "Decision"), L("تأكيد النتيجة", "Confirmed")], cur: 2 }} status={{ tone: "er", label: L("محجوزة · غير متاحة", "Held · not available") }} />}
      foot={<>
        <Primary onClick={() => void send()} disabled={!ok || !p.online} wait={busy} testId="qc-exception-send">{L("إرسال طلب الاستثناء", "Send the exception request")}</Primary>
        <Secondary onClick={() => void openBatch(b.id)} testId="qc-cancel">{L("تراجع", "Back")}</Secondary>
        <Note>{L("الاستثناء لا يحرر الدفعة. القرار لشخص آخر في النظام.", "The request releases nothing. Another person decides it in the ERP.")}</Note>
      </>}>
      {offlineBox}{errBox}
      <div style={{ display: "grid", gap: 4 }}>
        <SpecBox spec={d.spec} L={L} />
        {last ? <div className="ws-qrow"><div className="ws-ql"><b>{L("آخر فحص", "Last inspection")}</b><span>{last.by}</span></div>
          <div className="ws-qv">{L("حبوب", "Whole")} <Num>{last.whole ?? "—"}</Num> {last.wholeVerdict ? <span className={`st ${verdictTone(last.wholeVerdict)}`}>{VERDICT_WORD[last.wholeVerdict][lang]}</span> : null} · {L("مطحون", "Ground")} <Num>{last.ground ?? "—"}</Num> {last.groundVerdict ? <span className={`st ${verdictTone(last.groundVerdict)}`}>{VERDICT_WORD[last.groundVerdict][lang]}</span> : null}{last.reasons.length ? <> · {last.reasons.map((x) => HOLD_REASON_WORD[x][lang]).join("، ")}</> : null}</div></div> : null}
        <div className="ws-qrow"><div className="ws-ql"><b>{L("سبب الطلب", "Reason")}<span className="ws-req"> *</span></b><span>{L("مطلوب", "Required")}</span></div>
          <div className="ws-qv" style={{ display: "grid", gap: 10 }}>
            <Chips options={EXCEPTION_REASONS.map((v) => ({ value: v, label: EXCEPTION_REASON_WORD[v][lang] }))} value={reason} onChange={setReason} label={L("سبب الطلب", "Reason")} testId="qc-exc-reason" />
            <textarea className="ws-text" rows={2} placeholder={reason === "OTHER" ? L("اكتب السبب (مطلوب)", "Write the reason (required)") : L("ملاحظات مساندة", "Supporting notes")} value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} data-testid="qc-exc-note" />
          </div></div>
        <div className="ws-qrow"><div className="ws-ql"><b>{L("الاستخدام المسموح", "Permitted use")}<span className="ws-req"> *</span></b><span>{L("يُحفظ مع القرار", "Kept with the decision")}</span></div>
          <div className="ws-qv" style={{ display: "grid", gap: 10 }}>
            <Chips options={PERMITTED_USES.map((v) => ({ value: v, label: PERMITTED_USE_WORD[v][lang] }))} value={use} onChange={setUse} label={L("الاستخدام المسموح", "Permitted use")} testId="qc-exc-use" />
            {use === "CUSTOMER" ? <textarea className="ws-text" rows={2} placeholder={L("العميل وموافقته (مطلوب)", "The customer and their approval (required)")} value={useNote} onChange={(e) => setUseNote(e.target.value)} data-testid="qc-exc-use-note" /> : null}
          </div></div>
        <div className="ws-qrow"><div className="ws-ql"><b>{L("الكمية", "Quantity")}</b><span>{L("الكمية المحجوزة كلها", "The whole held quantity")}</span></div><div className="ws-qv"><Num>{kg2(b.availableKg)}</Num> {L("كغ", "kg")}</div></div>
        <div style={{ marginTop: 12 }}><Info tone="info" title={L("لا يُفرج عن نتيجة خارج الحدود إلا باستثناء معتمد من شخص آخر.", "An out-of-limits result is released only by an exception approved by another person.")}>{L("تبقى الدفعة «محجوزة · غير متاحة» حتى يقرر مسؤول الجودة. يُسجَّل طلبك وفحصك.", "The batch stays «held · not available» until the QC approver decides. Your request and inspection are recorded.")}</Info></div>
      </div>
    </Sheet></>);
}

function ExceptionSent(p: Shared & { number: string; batchNumber: string; at: string }) {
  const { L, bar, setView } = p;
  return (<>{bar}
    <Sheet plain testId="qc-exception-sent" foot={<><Primary onClick={() => setView({ v: "queue" })} testId="qc-next">{L("العودة للطابور", "Back to the queue")}</Primary><Note>{L("القرار في النظام: «الجودة» › «طلبات الاستثناء».", "Decided in the ERP: Quality › Exception requests.")}</Note></>}>
      <div className="ws-done">
        <DoneMark />
        <div className="ws-done-t" data-testid="station-title">{L("أُرسل طلب الاستثناء", "Exception request sent")}</div>
        <div className="ws-done-n" data-testid="qc-exception-number">{p.number}</div>
        <span className="st ws-st wa">{L("بانتظار القرار · الدفعة محجوزة", "Awaiting decision · batch held")}</span>
        <div className="ws-side-l"><Bid>{p.batchNumber}</Bid> · <Num>{clock(p.at, true)}</Num></div>
      </div>
    </Sheet></>);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q5 · held (view only) · Q6 · history (view only)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function HeldList(p: Shared) {
  const { L, lang, q, bar, offlineBox, nm, when, setView, openBatch } = p;
  return (<>{bar}
    <Sheet testId="qc-held"
      head={<Head title={L("الدفعات المحجوزة", "Held batches")} sub={L("للعرض. لا تُعبّأ ولا تُجهّز. التصرف يتم في النظام بقرار شخص آخر.", "View only. Not packed or picked. Their disposition is decided in the ERP by another person.")} status={{ tone: q.held.length ? "er" : "", label: L(`${q.held.length} دفعة`, `${q.held.length} batch(es)`) }} />}
      foot={<><Primary onClick={() => setView({ v: "queue" })} testId="qc-back">{L("العودة للطابور", "Back to the queue")}</Primary><Note>{L("لا إتلاف تلقائي ولا رفض تلقائي.", "No automatic destruction or rejection.")}</Note></>}>
      {offlineBox}
      <div className="ws-rows" style={{ gap: 12 }}>
        {q.held.length === 0 ? <Info tone="muted" title={L("لا دفعات محجوزة.", "No held batches.")} /> : q.held.map((h) => (
          <Row key={h.id} onClick={() => void openBatch(h.id)} testId={`qc-held-${h.batchNumber}`}
            title={<><bdi>{nm(h)}</bdi> · <Bid>{h.batchNumber}</Bid></>}
            sub={<>{L("حُجزت", "Held")} {when(h.heldAt)} · {h.reasons.map((x) => HOLD_REASON_WORD[x][lang]).join("، ") || "—"} · <Num>{kg2(h.availableKg)}</Num> {L("كغ", "kg")}{h.exception ? <> · <Bid>{h.exception.number}</Bid> {L("بانتظار القرار", "pending")}</> : null}{h.disposition ? <> · <Bid>{h.disposition.number}</Bid></> : null}</>}
            right={<span className={`st ws-st ${h.foreign ? "er" : "wa"}`}>{h.foreign ? L("أجسام غريبة", "Foreign objects") : L("محجوزة", "Held")}</span>} />
        ))}
      </div>
    </Sheet></>);
}

function History(p: Shared) {
  const { L, lang, q, bar, nm, when, setView } = p;
  return (<>{bar}
    <Sheet testId="qc-history"
      head={<Head title={L("سجل الجودة", "QC history")} sub={L("الفحوص المؤكدة فقط. للعرض. آخر 7 أيام.", "Confirmed inspections only. View only. Last 7 days.")} />}
      foot={<><Primary onClick={() => setView({ v: "queue" })} testId="qc-back">{L("العودة للطابور", "Back to the queue")}</Primary><Note>{L("السجل كامل ومحفوظ في النظام مع كل فحص.", "The full record is kept in the ERP with every inspection.")}</Note></>}>
      <div className="ws-rows">
        {q.history.length === 0 ? <Info tone="muted" title={L("لا فحوص بعد.", "No inspections yet.")} /> : q.history.map((h) => (
          <Row key={h.id} testId={`qc-hist-${h.batchNumber}`} title={<><bdi>{nm(h)}</bdi> · <Bid>{h.batchNumber}</Bid></>}
            sub={<>{h.inspector ?? "—"} · {when(h.at)}{h.reasons.length ? <> · {h.reasons.map((x) => HOLD_REASON_WORD[x][lang]).join("، ")}</> : null}</>}
            right={<span className={`st ws-st ${h.outcome === "HELD" ? "er" : h.outcome === "RELEASED" ? "ok" : "in"}`}>{h.outcome === "HELD" ? L("محجوزة", "Held") : h.outcome === "RELEASED" ? L("مقبولة", "Passed") : L("بانتظار مقيّم", "Awaiting evaluator")}</span>} />
        ))}
      </div>
    </Sheet></>);
}
