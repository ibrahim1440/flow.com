"use client";
/**
 * «محطة التحميص v2» — the floor (D12, Figma 1868:2, frames R1–R13, APPROVED). Three columns, right to left as the coffee
 * moves: 🔥 الدرام → ❄️ التبريد → 🧺 السلّة. One main action per column (≥ 88pt), keys ≥ 64pt, a full-column flash and a
 * loud cue on every outcome. The server decides everything (it refuses what is not allowed); this screen sends raw
 * inputs, shows what the server confirmed, and keeps the floor's writes in an offline queue with their keys.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useStation } from "../../_ui/context";
import { cleanWeight, manualScale, type ScaleAdapter } from "@/lib/station/v2/scale";
import { cue, setSound, soundOn } from "@/lib/station/v2/cues";
import { coffeeColor, coffeeLetter } from "@/lib/station/v2/coffee";
import { V2, floorQueue, getJson, postJson, queuedWrite, queuedWrites, type ApiResult, type QueuedResult } from "./api";
import { writesHoldingIdle, type FlushReport, type QueuedOp } from "@/lib/station/v2/offline-queue";
import { LOSS_REASONS } from "@/lib/station/shared";
import { useV2T, v2t, type V2Key, type V2Lang } from "./i18n";
import { LanguageToggle } from "@/components/shell/LanguageToggle";
import { LotLabel, PrintLabel, labelDate, type LotLabelData } from "./labels";
import "./v2.css";

type Product = { id: string; productNameEn: string; productNameAr: string | null };
type Bucket = { id: string; barcode: string; seqNo: number; actualKg: string | number; colorKey: string | null; productId?: string | null; product?: Product | null };
type Run = {
  id: string; serial: string; status: string; chargedAt: string; droppedAt: string | null; basketId: string | null; productId: string;
  bucket: Bucket; product: Product; basket?: { id: string; status: string; single: boolean } | null;
  /** D16: charged while a minor report was open (the report's id). */
  problemId?: string | null;
};
type Floor = {
  roaster: { id: string; name: string; manufacturerModel: string | null; status: string; stationMode: string; defaultTargetKg: number };
  drum: Run | null; dropped: Run[]; baskets: { id: string; status: string; single: boolean; productId: string | null; runIds: string[] }[];
  unweighed: number; openProblem: { id: string; kind: string; reason: string; note: string | null; reportedAt: string; reportedByName: string | null; ageMinutes: number; blocking: boolean; markedRuns: number } | null;
  /** D16: the person at the station is a report supervisor (decided on the server). */
  canResolve?: boolean;
  prepared: Bucket[]; next: Bucket | null; plan: { productId: string; product: Product | null; remaining: number; totalKg: number } | null;
  undoable: { kind: "CHARGE" | "DROP"; runId: string; at: string } | null; canCharge: boolean; serverTime: string;
  lotsToday?: { id: string; batchNumber: string; at: string; roastedKg: number; greenKg: number; product: Product | null; corrected: boolean; inUse: boolean }[];
};
type Fix = { id: string; lot: string; kg: number; green: number; value: string; reason: string };
type Flash = { col: "drum" | "cool" | "basket"; tone: "ok" | "err" | "warn"; at: number } | null;
type Recorded = { basketId: string; batchId: string; batchNumber: string; roastedKg: number; label: LotLabelData };
type Combined = { dropRunId: string; chargeRunId: string; dropBucket: number; chargeBucket: number; at: string } | null;

const TZ = "Asia/Riyadh";
const REASONS = ["BURNER_STOPPED", "IRREGULAR_HEAT", "COOLING_PROBLEM", "OTHER"] as const;
const kg = (v: string | number) => Number(v);
const k2 = (v: number) => v.toFixed(2);
const time = (d: string | number | Date) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false });
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
/** The reason of a refusal in the screen's language (the server sends both), when the server's own text is missing. */
const REFUSAL_TEXT: Record<string, { ar: string; en: string }> = {
  ROASTER_PROBLEM_OPEN: { ar: "يوجد بلاغ مفتوح على الحمّاصة؛ لم يُحمَّل الدلو.", en: "A problem is open on the roaster; the bucket was not charged." },
  BASKET_NEEDS_WEIGHING: { ar: "يلزم وزن التحميصات المفرَّغة قبل التحميل.", en: "Weigh the dropped roasts before charging." },
  DRUM_BUSY: { ar: "في الدرام تحميصة لم تُفرَّغ بعد.", en: "A roast is still in the drum." },
  LOSS_REASON_REQUIRED: { ar: "الفاقد فوق الحد: اختر سبب الفاقد.", en: "The loss is above the limit: choose the loss reason." },
  BUCKET_NOT_PREPARED: { ar: "الدلو ليس جاهزًا أو شُحن مسبقًا.", en: "The bucket is not prepared or was already charged." },
};
const refusalText = (op: QueuedOp, lang: V2Lang) => (lang === "en" ? op.refusal?.messageEn : op.refusal?.message) || (op.refusal?.code && REFUSAL_TEXT[op.refusal.code]?.[lang]) || op.refusal?.message || v2t(lang, "serverRefused");
const opTitle = (op: QueuedOp, lang: V2Lang) => (lang === "en" ? op.titleEn || op.title : op.title) || v2t(lang, "anAction");
/** The column an operation belongs to: the drum's actions there, the weighing in the basket. */
const opCol = (op: QueuedOp): "drum" | "basket" => (op.label === "record" ? "basket" : "drum");
type Keypad = { basketId: string; value: string; needReason?: boolean; reason?: string };

function RunCard({ run, line, coffee }: { run: Run; line: string; coffee: string }) {
  const { t } = useV2T();
  const c = coffeeColor(run.bucket.colorKey);
  return (
    <div className="rv2-card" style={{ background: c.tint }} data-testid={`rv2-run-${run.bucket.seqNo}`}>
      <div className="rv2-card-body">
        <b>{t("bucketCoffee", { n: run.bucket.seqNo, coffee })}</b>
        <span>{line}</span>
        <small>{t("droppedAt", { at: run.droppedAt ? time(run.droppedAt) : "—" })} <bdi dir="ltr">{run.serial}</bdi></small>
        {run.problemId ? <small className="rv2-minor-mark" data-testid={`rv2-minor-${run.bucket.seqNo}`}>{t("minorMark")}</small> : null}
      </div>
      <i style={{ background: c.strong }} />
    </div>
  );
}

/**
 * `otherRoasters`: a personal operator's V1 roasters — in the same switcher; choosing one opens the V1 screen (`onPickOther`).
 */
export function StationV2({ roasterIds, roasterNames, otherRoasters = [], onPickOther, scale = manualScale }: { roasterIds: string[]; roasterNames: Record<string, string>; otherRoasters?: string[]; onPickOther?: (id: string) => void; scale?: ScaleAdapter }) {
  const { user, switchEmployee, holdIdle, mode } = useStation();
  const { t, lang, dir, coffee: coffeeOf, err: errOf } = useV2T();
  const errText = useCallback((r: ApiResult) => errOf(r.body), [errOf]);
  const [roasterId, setRoasterId] = useState(roasterIds[0]);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [flash, setFlash] = useState<Flash>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);              // the bucket to charge next (pre-selected, scan, grid)
  const [scanFailed, setScanFailed] = useState(false);
  const [coffeeAsk, setCoffeeAsk] = useState<Bucket | null>(null);        // R7 أ: confirm a coffee change once
  const [gateTap, setGateTap] = useState<string | null>(null);            // R6: the first refused tap (the real charge time)
  const [keypad, setKeypad] = useState<Keypad | null>(null);
  const [ops, setOps] = useState<QueuedOp[]>([]);                         // the queue as stored (the tray reads it)
  const [authLost, setAuthLost] = useState(false);                         // a queued write got 401/403: sign in again
  const [delAsk, setDelAsk] = useState<string | null>(null);               // «حذف» asks first
  const [switchBlocked, setSwitchBlocked] = useState(false);               // «توجد عمليات لم تُرسل»
  const [gateOp, setGateOp] = useState<string | null>(null);               // a queued charge refused by the weighing gate
  const [fix, setFix] = useState<Fix | null>(null);                        // «تصحيح الوزن» (the roaster's own, same day)
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [printing, setPrintingJob] = useState<{ label: LotLabelData; at: number } | null>(null);
  const setPrinting = (label: LotLabelData) => setPrintingJob({ label, at: Date.now() });
  const [burnAsk, setBurnAsk] = useState<string | null>(null);
  const [problemOpen, setProblemOpen] = useState(false);
  const [problem, setProblem] = useState<{ kind: string; reason: string; note: string }>({ kind: "MALFUNCTION", reason: "", note: "" });
  // D16 P2: right after «إرسال» — stop or keep roasting (the report's id and the choice); P6: ending it (cause + fix).
  const [afterReport, setAfterReport] = useState<{ id: string; kind: string; reason: string; at: string; choice: "stop" | "keep" | null } | null>(null);
  const [ending, setEnding] = useState<{ cause: string; fix: string } | null>(null);
  // D16 P4 (owner: option 2) — the note after a charge under a minor report; it never stops anything and goes by itself.
  const [minorToast, setMinorToast] = useState("");
  useEffect(() => {
    if (!minorToast) return;
    const id = setTimeout(() => setMinorToast(""), 8000);
    return () => clearTimeout(id);
  }, [minorToast]);
  const [combined, setCombined] = useState<Combined>(null);
  const [sound, setSoundState] = useState(() => soundOn());
  const [notice, setNotice] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);

  // ── Reads ────────────────────────────────────────────────────────────────────────────────
  // The queue sends only the signed-in employee's operations (never replayed as somebody else).
  useEffect(() => { floorQueue().setOwner(user.id, user.name); }, [user.id, user.name]);

  const refreshOps = useCallback(async () => {
    const all = await floorQueue().pending();
    setOps(all);
    setPending(all.filter((o) => o.state !== "refused").length);
    return all;
  }, []);

  const load = useCallback(async (poll = false): Promise<Floor | null> => {
    let f: Floor | null = null;
    try {
      const r = await getJson<Floor>(`${V2}/roasters/${roasterId}/floor`, { poll });
      if (r.ok) { f = r.body; setFloor(r.body); setOnline(true); }
      else setErr(errText(r as ApiResult));
    } catch { setOnline(false); }
    await refreshOps();
    return f;
  }, [roasterId, refreshOps, errText]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const doFlash = useCallback((col: NonNullable<Flash>["col"], tone: NonNullable<Flash>["tone"]) => { setFlash({ col, tone, at: Date.now() }); cue(tone); setTimeout(() => setFlash((f) => (f && Date.now() - f.at > 900 ? null : f)), 1000); }, []);

  /**
   * What a background flush found. A refusal is never silent: it stays in «عمليات لم تُرسل» on its column, with a flash and
   * the reason; a charge refused by the weighing gate keeps its first-tap time and opens the weigh keypad (R6).
   */
  const settle = useCallback(async (rep: FlushReport, poll = false) => {
    setAuthLost(rep.authRequired);
    if (rep.stoppedOnNetwork) setOnline(false);
    const gate = rep.refused.find((o) => o.label === "charge" && o.refusal?.code === "BASKET_NEEDS_WEIGHING");
    if (rep.refused.length) {
      const first = rep.refused[0];
      setErr(t("notSent", { title: opTitle(first, lang), reason: refusalText(first, lang) }));
      doFlash(opCol(first), "err");
    }
    if (gate) {
      const tapped = typeof gate.body.tappedAt === "string" ? gate.body.tappedAt : new Date(gate.createdAt).toISOString();
      setGateTap((t) => t ?? tapped);
      setGateOp(gate.id);
    }
    const f = await load(poll);
    if (gate && f) {
      const target = f.baskets.find((b) => b.status === "SEALED") ?? f.baskets[0];
      if (target) setKeypad((k) => k ?? { basketId: target.id, value: "" });
    }
  }, [doFlash, load, t, lang]);

  const flushNow = useCallback(async (poll = false) => {
    if (!(await floorQueue().mine()).some((o) => o.state !== "refused")) { await load(poll); return null; }
    const rep = await floorQueue().flush();
    await settle(rep, poll);
    return rep;
  }, [load, settle]);

  useEffect(() => {
    const t = setInterval(() => { void flushNow(true); }, 5000);
    const on = () => { setOnline(true); void flushNow(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { clearInterval(t); window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [flushNow]);

  // No idle lock while a roast is in the drum or waits for the scale (D12 R11).
  // …nor while writes wait to be sent (the idle lock would switch the employee under them). A refused write does not hold
  // it (the tray reminds the operator), and the shell caps every hold at 3 × the idle policy; past it the queued writes
  // stay bound to their employee and go when they sign in again.
  const mineLeft = ops.filter((o) => !o.owner || o.owner === user.id).length;
  const mineToSend = writesHoldingIdle(ops, user.id);
  useEffect(() => { holdIdle?.((!!floor && (!!floor.drum || floor.unweighed > 0)) || mineToSend > 0); return () => holdIdle?.(false); }, [floor, holdIdle, mineToSend]);
  // The hidden scanner input keeps the focus (a Bluetooth HID scanner types the code and Enter).
  // The scanner field takes the focus back after every render — except while a dialog needs the keyboard. D16 fix (owner,
  // 9 Nov 2026): «إنهاء البلاغ» (cause + fix) and the stop/keep choice are such dialogs too; without them here the iPad
  // keyboard typed into the hidden scanner field, not the text box.
  const dialogOpen = !!(keypad || problemOpen || coffeeAsk || burnAsk || delAsk || switchBlocked || fix || ending || afterReport);
  useEffect(() => { if (!dialogOpen) scanRef.current?.focus(); });

  // ── Derived ──────────────────────────────────────────────────────────────────────────────
  const drum = floor?.drum ?? null;
  const prepared = useMemo(() => floor?.prepared ?? [], [floor]);
  const nextBucket = useMemo(() => prepared.find((b) => b.id === chosen) ?? floor?.next ?? null, [prepared, chosen, floor]);
  const coolRun = floor?.dropped.length ? floor.dropped[floor.dropped.length - 1] : null;
  const basketRuns = useMemo(() => {
    if (!floor) return [] as { basket: Floor["baskets"][number]; runs: Run[] }[];
    return floor.baskets.map((b) => ({ basket: b, runs: floor.dropped.filter((r) => b.runIds.includes(r.id)) }));
  }, [floor]);
  const readyBasket = basketRuns.find((x) => x.basket.status === "SEALED") ?? null;
  const openSingle = basketRuns.find((x) => x.basket.status === "OPEN" && x.runs.length === 1 && x.runs[0].id !== coolRun?.id) ?? null;
  const colorOf = (b: { colorKey: string | null } | null | undefined) => coffeeColor(b?.colorKey);
  const mismatch = coolRun && basketRuns.find((x) => x.basket.status === "SEALED" && x.basket.single && x.runs[0]?.productId !== coolRun.productId);

  // ── Actions ──────────────────────────────────────────────────────────────────────────────
  /** One answer on the screen: queued (offline, or the session lapsed) → a warning flash; a refusal → its reason. */
  const show = useCallback(async <T,>(col: NonNullable<Flash>["col"], r: QueuedResult<T>): Promise<ApiResult<T> | null> => {
    if ("skipped" in r) return null;
    if ("queued" in r) { if (r.auth) setAuthLost(true); else setOnline(false); doFlash(col, "warn"); await refreshOps(); return null; }
    if (!r.ok) { setErr(errText(r as ApiResult)); doFlash(col, "err"); }
    return r;
  }, [doFlash, refreshOps, errText]);

  const handle = useCallback(async <T,>(col: NonNullable<Flash>["col"], fn: () => Promise<QueuedResult<T>>): Promise<ApiResult<T> | null> => {
    setBusy(true); setErr("");
    try {
      return await show(col, await fn());
    } catch {
      setOnline(false); return null;
    } finally {
      setBusy(false);
    }
  }, [show]);

  // Every charge carries the time of its tap: a queued one is sent later, and the drum was charged at the tap (R6/R11).
  const chargeSpec = useCallback((b: Bucket, tappedAt: string) => ({ label: "charge", url: `${V2}/charge`, roasterId, title: v2t("ar", "tCharge", { n: b.seqNo }), titleEn: v2t("en", "tCharge", { n: b.seqNo }), body: { roasterId, bucketId: b.id, productId: b.productId ?? undefined, tappedAt } }), [roasterId]);

  const afterCharge = useCallback((r: ApiResult<Run & { code?: string }> | null, tappedAt: string) => {
    if (r && !r.ok && r.body.code === "BASKET_NEEDS_WEIGHING") {
      // R6: the charge waits for the scale; the first refused tap is when the drum was really charged.
      setGateTap((t) => t ?? tappedAt);
      doFlash("basket", "err");
      const target = readyBasket ?? basketRuns[0];
      if (target) setKeypad({ basketId: target.basket.id, value: "" });
      return null;
    }
    if (r?.ok) {
      setGateTap(null); setGateOp(null); setChosen(null); doFlash("drum", "ok");
      // D16 P4 (owner: option 2): a short note that never stops the charge — the roast carries the minor report's mark.
      const m = (r.body as Run & { minorProblem?: { reason: string; markedRuns: number } | null }).minorProblem;
      const n = (r.body as Run).bucket?.seqNo;
      if (m) setMinorToast(t("minorToast", { n: n ?? "", reason: (REASONS as readonly string[]).includes(m.reason) ? t(`r${m.reason}` as V2Key) : m.reason, count: m.markedRuns }));
    }
    return r;
  }, [doFlash, readyBasket, basketRuns, t]);

  const charge = useCallback(async (b: Bucket, tappedAt: string = new Date().toISOString()) => {
    const r = await handle<Run & { code?: string }>("drum", () => queuedWrite(chargeSpec(b, tappedAt)));
    return afterCharge(r, tappedAt);
  }, [handle, chargeSpec, afterCharge]);

  const drop = useCallback(async (run: Run) => {
    const r = await handle("cool", () => queuedWrite({ label: "drop", url: `${V2}/runs/${run.id}/drop`, body: {}, roasterId, title: v2t("ar", "tDrop", { n: run.bucket.seqNo }), titleEn: v2t("en", "tDrop", { n: run.bucket.seqNo }) }));
    if (r?.ok) doFlash("cool", "ok");
    return r;
  }, [handle, doFlash, roasterId]);

  /** «تفريغ وتحميل الدلو N» — the drum's main action (a coffee change asks once first, R7 أ). */
  const dropAndCharge = useCallback(async (b: Bucket | null, confirmed = false) => {
    if (!drum) { if (b) await charge(b, gateTap ?? undefined); await load(); return; }
    if (b && !confirmed && b.productId && b.productId !== drum.productId) { setCoffeeAsk(b); return; }
    if (!b || floor?.openProblem?.blocking) {
      await drop(drum);
      setRecorded(null);
      await load();
      return;
    }
    // One tap, two writes, queued together and in order: the charge (its own key and tap time) waits for the drop, so an
    // offline «تفريغ وتحميل» is replayed whole — never the drop alone.
    const tapped = new Date().toISOString();
    setBusy(true); setErr("");
    try {
      const [dr, cr] = await queuedWrites<Run & { code?: string }>([
        { label: "drop", url: `${V2}/runs/${drum.id}/drop`, body: {}, roasterId, title: v2t("ar", "tDrop", { n: drum.bucket.seqNo }), titleEn: v2t("en", "tDrop", { n: drum.bucket.seqNo }) },
        chargeSpec(b, tapped),
      ]);
      const d = await show("cool", dr);
      if (d?.ok) {
        doFlash("cool", "ok");
        const c = afterCharge(await show("drum", cr), tapped);
        if (c?.ok) setCombined({ dropRunId: drum.id, chargeRunId: (c.body as Run).id, dropBucket: drum.bucket.seqNo, chargeBucket: b.seqNo, at: tapped });
      }
    } catch {
      setOnline(false);
    } finally {
      setBusy(false);
    }
    setRecorded(null);
    await load();
  }, [drum, drop, charge, floor, gateTap, load, roasterId, chargeSpec, show, afterCharge, doFlash]);

  /** «تراجع» — undoes the last step (a combined «تفريغ وتحميل» is undone together: the charge, then the drop). */
  const undo = useCallback(async () => {
    if (!floor?.undoable) return;
    const u = floor.undoable;
    if (combined && u.kind === "CHARGE" && u.runId === combined.chargeRunId) {
      const a = await handle("drum", () => postJson(`${V2}/runs/${combined.chargeRunId}/undo`, { expect: "CHARGE" }));
      if (a?.ok) await handle("drum", () => postJson(`${V2}/runs/${combined.dropRunId}/undo`, { expect: "DROP" }));
      setCombined(null);
    } else {
      await handle("drum", () => postJson(`${V2}/runs/${u.runId}/undo`, { expect: u.kind }));
    }
    doFlash("drum", "warn");
    await load();
  }, [floor, combined, handle, load, doFlash]);

  const record = useCallback(async () => {
    if (!keypad || !floor) return;
    const n = scale.manual(keypad.value);
    if (!n) { setErr(t("enterRoasted")); doFlash("basket", "err"); return; }
    if (keypad.needReason && !keypad.reason) { setErr(t("chooseLoss")); doFlash("basket", "err"); return; }
    const entry = basketRuns.find((x) => x.basket.id === keypad.basketId);
    const r = await handle<{ batch: { id: string; batchNumber: string; roastedBeanQuantity: number }; runs: string[]; code?: string }>("basket", () => queuedWrite({
      label: "record", url: `${V2}/baskets/${keypad.basketId}/record`, roasterId, title: v2t("ar", "tRecord", { kg: k2(n.kg) }), titleEn: v2t("en", "tRecord", { kg: k2(n.kg) }),
      body: { roastedKg: n.kg, ...(keypad.reason ? { lossReason: keypad.reason } : {}) },
    }));
    if (r?.ok && entry) {
      const runs = entry.runs;
      const label: LotLabelData = {
        letter: coffeeLetter(runs[0].product), coffee: runs[0].product.productNameAr || runs[0].product.productNameEn, coffeeEn: runs[0].product.productNameEn || runs[0].product.productNameAr || "", batchNumber: r.body.batch.batchNumber, roastedKg: n.kg,
        runs: runs.map((x) => x.serial), buckets: runs.map((x) => x.bucket.seqNo), greenKg: runs.reduce((s, x) => s + kg(x.bucket.actualKg), 0),
        at: labelDate(new Date(), true), roaster: floor.roaster.name,
      };
      setRecorded({ basketId: keypad.basketId, batchId: r.body.batch.id, batchNumber: r.body.batch.batchNumber, roastedKg: n.kg, label });
      setPrinting(label);
      setKeypad(null);
      doFlash("basket", "ok");
      await load();
      // R6: a charge that waited for the scale goes now, with the time of its first tap — the queued one itself (same key)
      // when it was refused by the gate on replay.
      if (gateOp) { await floorQueue().retry(gateOp); setGateOp(null); await flushNow(); }
      else if (gateTap && nextBucket && !floor.drum) { await charge(nextBucket, gateTap); await load(); }
    } else if (r && !r.ok && r.body.code === "LOSS_REASON_REQUIRED") {
      setKeypad((k) => k && { ...k, needReason: true });
    }
  }, [keypad, floor, scale, basketRuns, handle, doFlash, load, gateTap, gateOp, nextBucket, charge, roasterId, flushNow, t]);

  // ── The tray «عمليات لم تُرسل» ─────────────────────────────────────────────────────────────────────
  const retryOp = useCallback(async (op: QueuedOp) => {
    setErr("");
    if (op.refusal?.code === "LOSS_REASON_REQUIRED" && op.label === "record") {
      // A retry needs the reason: the weighing is asked again with the weight it had, then sent as a new write.
      const basketId = /\/baskets\/([^/]+)\/record/.exec(op.url)?.[1];
      await floorQueue().discard(op.id);
      if (basketId) setKeypad({ basketId, value: String(op.body.roastedKg ?? ""), needReason: true });
      await refreshOps();
      return;
    }
    await floorQueue().retry(op.id);
    await flushNow();
  }, [flushNow, refreshOps]);

  const deleteOp = useCallback(async (id: string) => {
    await floorQueue().discard(id, { withDependents: true });   // a refused drop takes its chained charge with it
    if (id === gateOp) { setGateOp(null); setGateTap(null); }
    setDelAsk(null);
    await flushNow();
  }, [flushNow, gateOp]);

  /** «تبديل الموظف»: send first; what is left blocks the switch (it would otherwise wait for this employee to return). */
  const trySwitch = useCallback(async () => {
    const rep = await flushNow();
    if (rep?.authRequired) { switchEmployee(); return; }   // the session lapsed: signing in again is how they get sent
    if ((await floorQueue().mine()).length) { setSwitchBlocked(true); return; }
    switchEmployee();
  }, [flushNow, switchEmployee]);

  const single = useCallback(async (basketId: string) => {
    const r = await handle("basket", () => postJson(`${V2}/baskets/${basketId}/single`, {}));
    if (r?.ok) { setKeypad({ basketId, value: "" }); doFlash("basket", "ok"); }
    await load();
  }, [handle, load, doFlash]);

  /** «تصحيح الوزن»: the roaster corrects his own weighing the same business day (a reason; the supervisors are told). */
  const saveFix = useCallback(async () => {
    if (!fix) return;
    const n = scale.manual(fix.value);
    if (!n) { setErr(t("enterRoasted")); doFlash("basket", "err"); return; }
    if (fix.reason.trim().length < 3) { setErr(t("correctNeedReason")); doFlash("basket", "err"); return; }
    const r = await handle<{ batch: { id: string; batchNumber: string } }>("basket", async () => postJson(`${V2}/lots/${fix.id}/station-correct`, { roastedKg: n.kg, reason: fix.reason.trim() }));
    if (r?.ok) {
      setFix(null);
      if (recorded && recorded.batchId === fix.id) {
        const label = { ...recorded.label, batchNumber: r.body.batch.batchNumber, roastedKg: n.kg };
        setRecorded({ ...recorded, batchId: r.body.batch.id, batchNumber: r.body.batch.batchNumber, roastedKg: n.kg, label });
        setPrinting(label);
      }
      setErr("");
      doFlash("basket", "ok");
      setNotice(t("correctDone", { lot: r.body.batch.batchNumber }));
      await load();
    }
  }, [fix, scale, t, doFlash, handle, recorded, load]);

  const burn = useCallback(async (runId: string) => {
    const r = await handle("cool", () => postJson(`${V2}/runs/${runId}/discard`, { reason: t("burntReason") }));
    if (r?.ok) doFlash("cool", "warn");
    setBurnAsk(null);
    await load();
  }, [handle, load, doFlash, t]);

  const sendProblem = useCallback(async () => {
    if (!problem.reason) { setErr(t("chooseReason")); return; }
    const r = await handle("drum", () => postJson<{ problem: { id: string; kind: string; reason: string; reportedAt: string } }>(`${V2}/roasters/${roasterId}/problems`, { kind: problem.kind, reason: problem.reason, note: problem.note || undefined, runId: drum?.id }));
    if (r?.ok) {
      setProblemOpen(false); setProblem({ kind: "MALFUNCTION", reason: "", note: "" }); doFlash("drum", "warn");
      // D16 P2: anything but a PAUSE asks right away — stop roasting (the default, already in force) or keep roasting.
      const p = r.body.problem;
      if (p && p.kind !== "PAUSE") setAfterReport({ id: p.id, kind: p.kind, reason: p.reason, at: p.reportedAt, choice: null });
    }
    await load();
  }, [handle, problem, roasterId, drum, load, doFlash, t]);

  /** D16 P2 «تأكيد»: «متابعة التحميص» makes the report minor; «إيقاف التحميص» keeps it as it is (blocking). */
  const confirmAfterReport = useCallback(async () => {
    if (!afterReport) return;
    if (!afterReport.choice) { setErr(t("chooseFirst")); return; }
    if (afterReport.choice === "keep") {
      const r = await handle("drum", () => postJson(`${V2}/roasters/${roasterId}/problems/${afterReport.id}/mode`, { blocking: false }));
      if (!r?.ok) { await load(); return; }
    }
    setAfterReport(null);
    await load();
  }, [afterReport, handle, roasterId, load, t]);

  const resume = useCallback(async () => {
    if (!floor?.openProblem) return;
    await handle("drum", () => postJson(`${V2}/roasters/${roasterId}/problems/${floor.openProblem!.id}/resume`, {}));
    await load();
  }, [handle, floor, roasterId, load]);

  /** Gate M1 (safety): anyone at the roaster turns a minor report back into «إيقاف التحميص» (audited on the server). */
  const stopRoasting = useCallback(async () => {
    if (!floor?.openProblem) return;
    const r = await handle("drum", () => postJson(`${V2}/roasters/${roasterId}/problems/${floor.openProblem!.id}/mode`, { blocking: true }));
    if (r?.ok) { doFlash("drum", "warn"); setNotice(t("stopNowDone")); }
    await load();
  }, [handle, floor, roasterId, load, doFlash, t]);

  /** D16 P6 «إنهاء البلاغ»: the supervisor writes the cause and the fix (both required). */
  const endProblem = useCallback(async () => {
    if (!floor?.openProblem || !ending) return;
    if (!ending.cause.trim() || !ending.fix.trim()) { setErr(t("endNeedBoth")); return; }
    const r = await handle("drum", () => postJson(`${V2}/roasters/${roasterId}/problems/${floor.openProblem!.id}/resume`, { cause: ending.cause, fix: ending.fix }));
    if (r?.ok) { setEnding(null); doFlash("drum", "ok"); }
    await load();
  }, [handle, floor, ending, roasterId, load, doFlash, t]);

  // Scanner (HID keyboard wedge): the code, then Enter. A bucket of staging is confirmed as the next one; anything else
  // opens the grid of the remaining bucket numbers (R8).
  const onScan = useCallback((code: string) => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    const hit = prepared.find((b) => b.barcode === c);
    if (hit) { setChosen(hit.id); setScanFailed(false); doFlash("drum", "ok"); }
    else { setScanFailed(true); doFlash("drum", "err"); }
  }, [prepared, doFlash]);

  // ── Render helpers ───────────────────────────────────────────────────────────────────────
  if (!floor) return <div className="rv2 rv2-loading" role="status" dir={dir}>{t("loading")}</div>;
  const plan = floor.plan;
  const flashCls = (col: NonNullable<Flash>["col"]) => (flash && flash.col === col ? ` rv2-flash-${flash.tone}` : "");
  const drumColor = drum ? colorOf(drum.bucket) : nextBucket ? colorOf(nextBucket) : colorOf(null);
  const gridBuckets = prepared.filter((b) => !nextBucket?.productId || b.productId === nextBucket.productId).sort((a, b) => a.seqNo - b.seqNo);
  const problemBlocks = !!floor.openProblem?.blocking;
  const reasonText = (r: string) => ((REASONS as readonly string[]).includes(r) ? t(`r${r}` as V2Key) : r);
  const kindText = (k: string) => (k === "MALFUNCTION" ? t("kindMalfunction") : t("kindPause"));
  /** The writes chained after `op` (a drop's charge), deleted with it. */
  const dependentsOf = (op: QueuedOp) => {
    const keys = new Set([op.key]);
    const out: QueuedOp[] = [];
    for (const o of ops) if (o.after && keys.has(o.after)) { keys.add(o.key); out.push(o); }
    return out;
  };
  const liveRefused = new Set(ops.filter((o) => o.state === "refused").map((o) => o.key));
  /** «عمليات لم تُرسل» on a column: refused writes, writes waiting behind them, and another employee's writes. */
  const tray = (col: "drum" | "basket") => {
    const rows = ops.filter((o) => (!o.roasterId || o.roasterId === roasterId) && opCol(o) === col
      && (o.state === "refused" || (o.owner && o.owner !== user.id) || (o.after && liveRefused.has(o.after))));
    if (!rows.length) return null;
    return (
      <div className="rv2-tray" role="alert" data-testid={`rv2-tray-${col}`}>
        <b>{t("trayTitle")}</b>
        {rows.map((o) => {
          const foreign = !!o.owner && o.owner !== user.id;
          return (
            <div key={o.id} className="rv2-tray-op" data-testid="rv2-tray-op">
              <b>{opTitle(o, lang)} · <bdi dir="ltr">{time(o.createdAt)}</bdi></b>
              <span data-testid="rv2-tray-reason">{foreign ? t("foreignOp", { name: o.ownerName || t("anotherEmployee") }) : o.state === "refused" ? refusalText(o, lang) : t("waitsPrevious")}</span>
              {delAsk === o.id ? (
                <div data-testid="rv2-tray-delete-ask"><b>{t("deleteAsk")}{(() => { const deps = dependentsOf(o); return deps.length ? t("deleteWith", { list: deps.map((d) => opTitle(d, lang)).join(lang === "en" ? ", " : "، ") }) : ""; })()}</b><button className="rv2-mid rv2-danger" onClick={() => void deleteOp(o.id)} data-testid="rv2-tray-delete-yes">{t("deleteYes")}</button><button className="rv2-mid" onClick={() => setDelAsk(null)}>{t("cancel")}</button></div>
              ) : (
                <div>
                  {!foreign && o.state === "refused" && <button className="rv2-mid" onClick={() => void retryOp(o)} disabled={busy} data-testid="rv2-tray-retry">{t("retry")}</button>}
                  <button className="rv2-mid rv2-danger-outline" onClick={() => setDelAsk(o.id)} data-testid="rv2-tray-delete">{t("delete")}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="rv2" dir={dir} lang={lang} data-testid="rv2">
      <input ref={scanRef} className="rv2-scan" aria-label={t("scanAria")} data-testid="rv2-scan" autoComplete="off"
        onKeyDown={(e) => { if (e.key === "Enter") { onScan(e.currentTarget.value); e.currentTarget.value = ""; } }} />

      {/* ── St/StationBar ── */}
      <header className="rv2-bar">
        <div className="rv2-bar-station"><b>{t("stationName")}</b><small>{floor.roaster.manufacturerModel || floor.roaster.name}</small></div>
        {roasterIds.length + otherRoasters.length > 1 && (
          <div className="rv2-switch" role="tablist" aria-label={t("roasterTabs")}>
            {roasterIds.map((id) => (
              <button key={id} role="tab" aria-selected={id === roasterId} className={id === roasterId ? "on" : ""} onClick={() => { if (id === roasterId) return; setFloor(null); setChosen(null); setRecorded(null); setKeypad(null); setCombined(null); setGateTap(null); setRoasterId(id); }} data-testid={`rv2-roaster-${id}`}>{roasterNames[id] ?? id}</button>
            ))}
            {otherRoasters.map((id) => (
              <button key={id} role="tab" aria-selected={false} onClick={() => onPickOther?.(id)} data-testid={`rv2-roaster-${id}`} title={t("previousScreenTitle")}>{roasterNames[id] ?? id} · {t("previousScreen")}</button>
            ))}
          </div>
        )}
        {plan && (
          <div className="rv2-plan" style={{ background: colorOf(floor.next).tint, color: colorOf(floor.next).strong }}>
            <i style={{ background: colorOf(floor.next).strong }} />
            {t("planPill", { coffee: coffeeOf(plan.product), kg: Math.round(plan.totalKg), n: plan.remaining })}
          </div>
        )}
        <span className="rv2-grow" />
        <span className={`rv2-net ${online ? "ok" : "off"}`}><i />{online ? t("online") : t("offlineShort")}</span>
        <button className="rv2-user" onClick={() => void trySwitch()} data-testid="rv2-user" title={t("switchEmployee")}>
          <span className="rv2-avatar">{[...user.name].slice(0, 2).join("")}</span>{user.name}
        </button>
        <button className="rv2-sound" aria-pressed={sound} title={sound ? t("soundOff") : t("soundOn")} onClick={() => { setSound(!sound); setSoundState(!sound); }}>{sound ? "🔔" : "🔕"}</button>
        <LanguageToggle testId="rv2-lang" className="rv2-lang" />
        <Link className="rv2-link" href="/station/roasting/prep">{t("prepLink")}</Link>
        <button className="rv2-report" onClick={() => setProblemOpen(true)} data-testid="rv2-report">{t("report")}</button>
      </header>

      {!online && (
        <div className="rv2-offline" role="status" data-testid="rv2-offline">{t("offlineBanner", { n: pending })}</div>
      )}
      {floor.openProblem && (() => {
        const p = floor.openProblem!;
        const minor = !p.blocking;
        // D16: a PAUSE is resumed by the roaster (as before); anything else is ended by a supervisor, with cause and fix.
        const action = p.kind === "PAUSE"
          ? <button className="rv2-mid" onClick={() => void resume()} data-testid="rv2-resume">{t("resume")}</button>
          : floor.canResolve
            ? <button className="rv2-mid rv2-end" onClick={() => setEnding({ cause: "", fix: "" })} data-testid="rv2-end-problem">{t("endProblem")}</button>
            : <span className="rv2-wait" data-testid="rv2-await-supervisor">{t("awaitSupervisor")}</span>;
        return (
          <div className={`rv2-problem${minor ? " rv2-problem-minor" : ""}`} role="alert" data-testid="rv2-problem-banner" data-blocking={p.blocking ? "1" : "0"}>
            <div>
              <b>{minor ? t("problemMinorOpen", { kind: kindText(p.kind), min: p.ageMinutes }) : t("problemOpen", { kind: kindText(p.kind), min: p.ageMinutes })}</b>
              <small>{minor ? t("problemMinorSub", { reason: reasonText(p.reason), at: time(p.reportedAt), n: p.markedRuns }) : t("problemReason", { reason: reasonText(p.reason), at: time(p.reportedAt) })}{p.kind === "PAUSE" ? "" : floor.canResolve ? t("youMayEnd") : t("supervisorCloses")}</small>
            </div>
            {minor ? <button className="rv2-mid rv2-stop" onClick={() => void stopRoasting()} disabled={busy} data-testid="rv2-stop-roasting">{t("stopNow")}</button> : null}
            {action}
          </div>
        );
      })()}
      {authLost && (
        <div className="rv2-session" role="alert" data-testid="rv2-session-lost">
          <span>{t("sessionLost", { n: mineLeft })}</span>
          <button className="rv2-mid" onClick={() => switchEmployee()}>{t("signIn")}</button>
        </div>
      )}
      {err && <div className="rv2-err" role="alert" data-testid="rv2-error" onClick={() => setErr("")}>{err}</div>}
      {notice && !err && <div className="rv2-notice" role="status" data-testid="rv2-notice" onClick={() => setNotice("")}>{notice}</div>}
      {minorToast && <div className="rv2-notice rv2-notice-minor" role="status" aria-live="polite" data-testid="rv2-minor-toast" onClick={() => setMinorToast("")}>{minorToast}</div>}

      <main className="rv2-cols">
        {/* ── 🔥 الدرام ── */}
        <section className={`rv2-col rv2-drum${flashCls("drum")}`} style={{ borderColor: drum ? drumColor.strong : undefined }} data-testid="rv2-col-drum">
          <div className="rv2-head"><b>{t("drum")}</b><span>{drum ? t("roasting") : floor.unweighed > 2 ? t("emptyAwaitWeight") : t("empty")}</span></div>
          {drum ? (
            <>
              <p className="rv2-title" style={{ color: drumColor.strong }} data-testid="rv2-drum-title">{t("bucketCoffee", { n: drum.bucket.seqNo, coffee: coffeeOf(drum.product) })}</p>
              <div className="rv2-timer" style={{ background: drumColor.tint }}>
                <span>{t("roastTime")}</span>
                <b data-testid="rv2-timer">{mmss(now - +new Date(drum.chargedAt))}</b>
                <small>{t("startedAt", { at: time(drum.chargedAt) })} <bdi dir="ltr">{drum.serial}</bdi></small>
              </div>
            </>
          ) : nextBucket ? (
            <div className="rv2-nextbig" style={{ background: colorOf(nextBucket).tint, borderColor: colorOf(nextBucket).strong }}>
              <span>{t("next")}</span><b>{t("bucketN", { n: nextBucket.seqNo })}</b><small>{t("greenKg", { coffee: coffeeOf(nextBucket.product), kg: k2(kg(nextBucket.actualKg)) })}</small>
            </div>
          ) : <p className="rv2-empty">{t("noBuckets")}</p>}

          {scanFailed ? (
            <div className="rv2-grid-wrap" data-testid="rv2-scan-grid">
              <div className="rv2-scanfail">{t("scanFailed")}</div>
              <div className="rv2-grid">
                {gridBuckets.map((b) => (
                  <button key={b.id} className={b.id === nextBucket?.id ? "on" : ""} onClick={() => { setChosen(b.id); setScanFailed(false); }} data-testid={`rv2-grid-${b.seqNo}`}>{b.seqNo}</button>
                ))}
              </div>
            </div>
          ) : drum && nextBucket ? (
            <div className="rv2-next" data-testid="rv2-next"><i style={{ background: colorOf(nextBucket).strong }} />{t("nextLine", { n: nextBucket.seqNo, coffee: coffeeOf(nextBucket.product) })}<button className="rv2-text" onClick={() => setScanFailed(true)}>{t("otherBucket")}</button></div>
          ) : null}

          {tray("drum")}
          {gateTap && !drum && (
            <div className="rv2-lock" data-testid="rv2-gate-note"><b>{t("gateTitle")}</b><span>{t("gateBody", { n: nextBucket?.seqNo ?? "", at: time(gateTap) })}</span></div>
          )}
          {problemBlocks && <div className="rv2-lock"><b>{t("problemLockTitle")}</b><span>{t("problemLockBody")}</span></div>}
          <span className="rv2-grow" />
          {floor.undoable && (
            <div className="rv2-undo" data-testid="rv2-undo-box">
              <b>{combined && floor.undoable.runId === combined.chargeRunId ? t("undoCombined", { a: combined.dropBucket, b: combined.chargeBucket }) : floor.undoable.kind === "DROP" ? t("undoDrop") : t("undoCharge")} <bdi dir="ltr">{time(floor.undoable.at)}</bdi></b>
              <button className="rv2-mid rv2-white" onClick={() => void undo()} disabled={busy} data-testid="rv2-undo">{t("undo")}</button>
              <small>{t("undoUntil")}</small>
            </div>
          )}
          {drum ? (
            problemBlocks ? (
              <>
                <button className="rv2-big rv2-disabled" disabled>{t("chargeLocked", { n: nextBucket?.seqNo ?? "" })}</button>
                <button className="rv2-big" onClick={() => void dropAndCharge(null)} disabled={busy} data-testid="rv2-drop-only">{t("drop")}</button>
              </>
            ) : nextBucket ? (
              <button className="rv2-big" onClick={() => void dropAndCharge(nextBucket)} disabled={busy} data-testid="rv2-main">{t("dropCharge", { n: nextBucket.seqNo })}</button>
            ) : (
              <button className="rv2-mid rv2-warning rv2-wide" onClick={() => void dropAndCharge(null)} disabled={busy} data-testid="rv2-drop-only">{t("dropOnly")}</button>
            )
          ) : nextBucket ? (
            gateTap || !floor.canCharge
              ? <button className={`rv2-big${floor.canCharge ? "" : " rv2-disabled"}`} onClick={() => void charge(nextBucket, gateTap ?? new Date().toISOString()).then(() => load())} disabled={busy || problemBlocks} data-testid="rv2-main">{t("charge", { n: nextBucket.seqNo })}{floor.canCharge ? "" : problemBlocks ? t("locked") : t("afterWeighing")}</button>
              : <button className="rv2-big" onClick={() => void charge(nextBucket).then(() => load())} disabled={busy} data-testid="rv2-main">{t("charge", { n: nextBucket.seqNo })}</button>
          ) : null}
        </section>

        {/* ── ❄️ التبريد ── */}
        <section className={`rv2-col${flashCls("cool")}`} data-testid="rv2-col-cool">
          <div className="rv2-head"><b>{t("cooler")}</b><span>{coolRun ? t("oneRoast") : t("empty")}</span></div>
          {coolRun ? (
            <>
              <RunCard coffee={coffeeOf(coolRun.product)} run={coolRun} line={t("cooling", { t: mmss(now - +new Date(coolRun.droppedAt!)) })} />
              {(() => {
                const mate = coolRun.basketId ? floor.dropped.find((r) => r.basketId === coolRun.basketId && r.id !== coolRun.id) : null;
                if (mismatch) return <div className="rv2-pill rv2-pill-danger">{t("noLink")}</div>;
                return mate ? <div className="rv2-pill rv2-pill-ok">{t("pairedWith", { n: mate.bucket.seqNo })}</div> : null;
              })()}
              <span className="rv2-grow" />
              {burnAsk === coolRun.id ? (
                <div className="rv2-confirm" data-testid="rv2-burn-confirm">
                  <b>{t("burntAsk", { n: coolRun.bucket.seqNo })}</b>
                  <div><button className="rv2-mid rv2-danger" onClick={() => void burn(coolRun.id)} data-testid="rv2-burn-yes">{t("burntYes")}</button><button className="rv2-mid" onClick={() => setBurnAsk(null)}>{t("cancel")}</button></div>
                </div>
              ) : <button className="rv2-mid rv2-danger-outline rv2-wide" onClick={() => setBurnAsk(coolRun.id)} data-testid="rv2-burn">{t("burnt")}</button>}
            </>
          ) : (
            <div className="rv2-emptycol"><b>{t("coolerEmpty")}</b><span>{t("coolerHint")}</span></div>
          )}
        </section>

        {/* ── 🧺 السلّة ── */}
        <section className={`rv2-col${flashCls("basket")}${readyBasket && !keypad && !recorded ? " rv2-ready" : ""}${gateTap ? " rv2-gate" : ""}`} data-testid="rv2-col-basket">
          <div className="rv2-head"><b>{t("basket")}</b><span>{recorded ? t("recordedTag") : t("unweighed", { n: floor.unweighed })}</span></div>
          {tray("basket")}
          {recorded && !keypad ? (
            <div className="rv2-recorded" data-testid="rv2-recorded">
              <b className="rv2-kg">✓ {t("kgShort", { kg: k2(recorded.roastedKg) })}</b>
              <span>{t("lot")}</span>
              <b className="rv2-lotno" data-testid="rv2-lot-number"><bdi dir="ltr">{recorded.batchNumber}</bdi></b>
              <small>{lang === "en" ? recorded.label.coffeeEn : recorded.label.coffee} · {recorded.label.buckets.map((n) => t("bucketN", { n })).join(" + ")}</small>
              <div className="rv2-pill rv2-pill-ok">{t("labelPrinted")}</div>
              <button className="rv2-mid rv2-wide" onClick={() => setPrinting(recorded.label)} data-testid="rv2-reprint">{t("reprint")}</button>
              <button className="rv2-mid rv2-wide" onClick={() => setFix({ id: recorded.batchId, lot: recorded.batchNumber, kg: recorded.roastedKg, green: recorded.label.greenKg, value: "", reason: "" })} data-testid="rv2-correct-recorded">{t("correct")}</button>
              <span className="rv2-grow" />
              <small>{t("basketClears")}</small>
            </div>
          ) : keypad ? (
            <div className="rv2-weigh" data-testid="rv2-keypad">
              {gateTap && <div className="rv2-gatebox"><b>{t("weighFirst")}</b></div>}
              {(() => { const e = basketRuns.find((x) => x.basket.id === keypad.basketId); return e ? <div className="rv2-weigh-what">{e.runs.length === 2 ? t("twoRoasts") : t("singleRoast")} · {e.runs.map((r) => t("bucketN", { n: r.bucket.seqNo })).join(" + ")} · {t("kgGreen", { kg: k2(e.runs.reduce((s, r) => s + kg(r.bucket.actualKg), 0)) })}</div> : null; })()}
              <div className="rv2-field"><b data-testid="rv2-kg">{keypad.value || "0.00"}</b><span>{t("kgRoasted")}</span></div>
              <div className="rv2-keys">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((k) => (
                  <button key={k} onClick={() => setKeypad((p) => p && { ...p, value: k === "⌫" ? p.value.slice(0, -1) : cleanWeight(p.value + k) })} data-testid={`rv2-key-${k === "." ? "dot" : k === "⌫" ? "del" : k}`}>{k}</button>
                ))}
              </div>
              {keypad.needReason && (
                <div data-testid="rv2-loss-reasons">
                  <b>{t("lossAbove")}</b>
                  <div className="rv2-reasons">
                    {LOSS_REASONS.map((k) => (
                      <button key={k} className={keypad.reason === k ? "on" : ""} onClick={() => setKeypad((p) => p && { ...p, reason: k })} data-testid={`rv2-loss-${k}`}>{keypad.reason === k ? "✓ " : ""}{t(`l${k}` as V2Key)}</button>
                    ))}
                  </div>
                </div>
              )}
              <span className="rv2-grow" />
              <button className="rv2-big" onClick={() => void record()} disabled={busy} data-testid="rv2-record">{t("recordWeight")}</button>
              <button className="rv2-text" onClick={() => setKeypad(null)}>{t("cancel")}</button>
            </div>
          ) : basketRuns.length ? (
            <>
              {mismatch && (
                <div className="rv2-danger-box" data-testid="rv2-coffee-mismatch"><b>{t("noReturn")}</b><span>{t("mismatchBody", { a: coffeeOf(mismatch.runs[0].product), b: coffeeOf(coolRun!.product) })}</span></div>
              )}
              {readyBasket && !mismatch && (
                <div className="rv2-pair"><b>{readyBasket.runs.length === 2 ? t("pairReady") : t("singleReady")}</b><span>{t("oneLot", { coffee: coffeeOf(readyBasket.runs[0].product), kg: k2(readyBasket.runs.reduce((s, r) => s + kg(r.bucket.actualKg), 0)) })}</span></div>
              )}
              {basketRuns.flatMap((x) => x.runs).filter((r) => r.id !== coolRun?.id || basketRuns.some((x) => x.runs.length === 2 && x.runs.includes(r))).map((r) => (
                <RunCard key={r.id} coffee={coffeeOf(r.product)} run={r} line={r.id === coolRun?.id ? t("inCoolerReturn", { n: basketRuns.find((x) => x.runs.includes(r))?.runs.find((o) => o.id !== r.id)?.bucket.seqNo ?? "" }) : basketRuns.find((x) => x.runs.includes(r))?.basket.single ? t("singleNoMate") : t("inBasket")} />
              ))}
              {mismatch && <small className="rv2-danger-text">{t("recordSingleFirst")}</small>}
              <span className="rv2-grow" />
              {readyBasket ? (
                <button className="rv2-big" onClick={() => setKeypad({ basketId: readyBasket.basket.id, value: "" })} data-testid="rv2-weigh">{readyBasket.basket.single ? t("recordSingle") : t("recordWeight")}</button>
              ) : openSingle ? (
                <button className="rv2-mid rv2-wide" onClick={() => void single(openSingle.basket.id)} data-testid="rv2-single">{t("recordSingle")}</button>
              ) : null}
            </>
          ) : (
            <div className="rv2-emptycol"><b>{t("basketEmpty")}</b></div>
          )}
          {!keypad && (floor.lotsToday ?? []).length > 0 && (
            <div className="rv2-lots" data-testid="rv2-lots-today">
              <b>{t("lotsToday")}</b>
              {(floor.lotsToday ?? []).slice(0, 5).map((l) => (
                <div key={l.id} className="rv2-lotrow" data-testid={`rv2-lot-${l.batchNumber}`}>
                  <span><bdi dir="ltr">{l.batchNumber}</bdi>{l.corrected ? ` · ${t("lotCorrected")}` : ""}<small>{t("lotLine", { coffee: coffeeOf(l.product), kg: k2(l.roastedKg), at: time(l.at).slice(0, 5) })}</small></span>
                  {l.inUse ? <small>{t("lotInUse")}</small> : <button className="rv2-text" onClick={() => setFix({ id: l.id, lot: l.batchNumber, kg: l.roastedKg, green: l.greenKg, value: "", reason: "" })} data-testid="rv2-lot-correct">{t("correct")}</button>}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* R7 أ — a coffee change, confirmed once. */}
      {coffeeAsk && drum && (
        <div className="rv2-modal" role="dialog" aria-modal data-testid="rv2-coffee-confirm">
          <div className="rv2-sheet">
            <h2>{t("coffeeChange")}</h2>
            <p>{t("coffeeChangeBody", { a: coffeeOf(drum.product), b: coffeeOf(coffeeAsk.product) })}</p>
            <p>{t("coffeeChangeNote")}</p>
            <div className="rv2-row">
              <button className="rv2-big" onClick={() => { const b = coffeeAsk; setCoffeeAsk(null); void dropAndCharge(b, true); }} data-testid="rv2-coffee-yes">{t("coffeeChangeYes", { coffee: coffeeOf(coffeeAsk.product) })}</button>
              <button className="rv2-mid" onClick={() => setCoffeeAsk(null)}>{t("cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {fix && (
        <div className="rv2-modal" role="dialog" aria-modal data-testid="rv2-correct-sheet">
          <div className="rv2-sheet">
            <h2>{t("correctTitle", { lot: fix.lot })}</h2>
            <small>{t("correctWas", { kg: k2(fix.kg), green: k2(fix.green) })}</small>
            <div className="rv2-field"><b data-testid="rv2-correct-kg">{fix.value || "0.00"}</b><span>{t("kgRoasted")}</span></div>
            <div className="rv2-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((k) => (
                <button key={k} onClick={() => setFix((p) => p && { ...p, value: k === "⌫" ? p.value.slice(0, -1) : cleanWeight(p.value + k) })} data-testid={`rv2-fix-key-${k === "." ? "dot" : k === "⌫" ? "del" : k}`}>{k}</button>
              ))}
            </div>
            <input className="rv2-note" placeholder={t("correctReason")} value={fix.reason} maxLength={300} onChange={(e) => setFix((p) => p && { ...p, reason: e.target.value })} data-testid="rv2-correct-reason" />
            <small>{t("correctNote")}</small>
            <div className="rv2-row">
              <button className="rv2-big" onClick={() => void saveFix()} disabled={busy} data-testid="rv2-correct-save">{t("correctSave")}</button>
              <button className="rv2-mid" onClick={() => setFix(null)}>{t("cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {switchBlocked && (
        <div className="rv2-modal" role="dialog" aria-modal data-testid="rv2-switch-blocked">
          <div className="rv2-sheet">
            <h2>{t("switchBlockedTitle")}</h2>
            <p>{t("switchBlockedBody", { n: mineLeft, name: user.name, offline: !online ? "1" : "" })}</p>
            <div className="rv2-row"><button className="rv2-big" onClick={() => setSwitchBlocked(false)} data-testid="rv2-switch-blocked-ok">{t("ok")}</button></div>
          </div>
        </div>
      )}

      {/* R12 — the problem report. */}
      {problemOpen && (
        <div className="rv2-modal" role="dialog" aria-modal data-testid="rv2-problem-sheet">
          <div className="rv2-sheet">
            <h2>{t("reportTitle")}</h2>
            <small>{floor.roaster.name}{drum ? t("reportSub", { n: drum.bucket.seqNo, at: time(drum.chargedAt) }) : ""}</small>
            <label>{t("kind")}</label>
            <div className="rv2-opts">
              {[["MALFUNCTION", t("kindMalfunction")], ["PAUSE", t("kindPause")]].map(([k, l]) => (
                <button key={k} className={problem.kind === k ? "on" : ""} onClick={() => setProblem((p) => ({ ...p, kind: k }))} data-testid={`rv2-pk-${k}`}>{problem.kind === k ? "✓ " : ""}{l}</button>
              ))}
            </div>
            <label>{t("reason")}</label>
            <div className="rv2-opts rv2-opts-2">
              {REASONS.map((k) => [k, t(`r${k}` as V2Key)]).map(([k, l]) => (
                <button key={k} className={problem.reason === k ? "on" : ""} onClick={() => setProblem((p) => ({ ...p, reason: k }))} data-testid={`rv2-pr-${k}`}>{problem.reason === k ? "✓ " : ""}{l}</button>
              ))}
            </div>
            <input className="rv2-note" placeholder={t("notePlaceholder")} value={problem.note} maxLength={300} onChange={(e) => setProblem((p) => ({ ...p, note: e.target.value }))} />
            <div className="rv2-row">
              <button className="rv2-big" onClick={() => void sendProblem()} disabled={busy} data-testid="rv2-problem-send">{t("send")}</button>
              <button className="rv2-mid" onClick={() => setProblemOpen(false)}>{t("cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {/* D16 P2 — right after «إرسال»: stop or keep roasting. */}
      {afterReport && (
        <div className="rv2-modal" role="dialog" aria-modal data-testid="rv2-after-report">
          <div className="rv2-sheet">
            <h2>{t("afterReportTitle")}</h2>
            <small>{t("afterReportSub", { kind: kindText(afterReport.kind), reason: reasonText(afterReport.reason), at: time(afterReport.at) })}</small>
            <div className="rv2-choices">
              <button className={afterReport.choice === "stop" ? "on stop" : "stop"} aria-pressed={afterReport.choice === "stop"} onClick={() => setAfterReport({ ...afterReport, choice: "stop" })} data-testid="rv2-choice-stop">
                <b>{t("stopRoasting")}</b><span>{t("stopRoastingBody")}</span>
              </button>
              <button className={afterReport.choice === "keep" ? "on" : ""} aria-pressed={afterReport.choice === "keep"} onClick={() => setAfterReport({ ...afterReport, choice: "keep" })} data-testid="rv2-choice-keep">
                <b>{t("keepRoasting")}</b><span>{t("keepRoastingBody")}</span>
              </button>
            </div>
            <small>{t("afterReportNote")}</small>
            <button className={`rv2-big${afterReport.choice ? "" : " rv2-disabled"}`} onClick={() => void confirmAfterReport()} disabled={busy || !afterReport.choice} data-testid="rv2-after-confirm">
              {afterReport.choice === "keep" ? t("confirmKeep") : t("confirmStop")}
            </button>
          </div>
        </div>
      )}

      {/* D16 P6 — ending the report: what the problem was, and the fix (both required). */}
      {ending && floor.openProblem && (
        <div className="rv2-modal rv2-modal-center" role="dialog" aria-modal data-testid="rv2-end-sheet">
          <div className="rv2-sheet">
            <h2>{t("endTitle")}</h2>
            <small>{t("endSub", { kind: kindText(floor.openProblem.kind), reason: reasonText(floor.openProblem.reason), at: time(floor.openProblem.reportedAt), min: floor.openProblem.ageMinutes, by: floor.openProblem.reportedByName ?? "" })}</small>
            <label htmlFor="rv2-end-cause">{t("endCause")}</label>
            <textarea id="rv2-end-cause" className="rv2-text" rows={3} maxLength={500} placeholder={t("endCausePh")} value={ending.cause} onChange={(e) => setEnding({ ...ending, cause: e.target.value })} data-testid="rv2-end-cause" />
            <label htmlFor="rv2-end-fix">{t("endFix")}</label>
            <textarea id="rv2-end-fix" className="rv2-text" rows={3} maxLength={500} placeholder={t("endFixPh")} value={ending.fix} onChange={(e) => setEnding({ ...ending, fix: e.target.value })} data-testid="rv2-end-fix" />
            <small>{t("endHelp")}</small>
            <div className="rv2-row">
              <button className={`rv2-big${ending.cause.trim() && ending.fix.trim() ? "" : " rv2-disabled"}`} onClick={() => void endProblem()} disabled={busy || !ending.cause.trim() || !ending.fix.trim()} data-testid="rv2-end-confirm">{t("endConfirm")}</button>
              <button className="rv2-mid" onClick={() => setEnding(null)}>{t("back")}</button>
            </div>
          </div>
        </div>
      )}

      {printing && <PrintLabel key={printing.at}><LotLabel d={printing.label} /></PrintLabel>}
      {mode === "personal" && <span hidden data-testid="rv2-personal" />}
    </div>
  );
}
