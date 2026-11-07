"use client";
/**
 * «تحضير الدلاء» — D12 P1 (choose a plan line: N buckets × kg, editable), P2 (weigh each bucket: the planned weight
 * pre-filled, «مطابق · طباعة» saves it — a real transfer to «منطقة التحميص» — prints L1 and moves to the next), P3 (the
 * session's buckets and the leftovers in staging, stale ones marked). Works on the iPad and on a phone beside the scale.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStation } from "../../_ui/context";
import { cleanWeight, manualScale } from "@/lib/station/v2/scale";
import { cue } from "@/lib/station/v2/cues";
import { coffeeColor, coffeeLetter } from "@/lib/station/v2/coffee";
import { V2, getJson, postJson, type ApiResult } from "./api";
import { BucketLabel, PrintLabel, labelDate, type BucketLabelData } from "./labels";
import { useV2T } from "./i18n";
import { LanguageToggle } from "@/components/shell/LanguageToggle";
import "./v2.css";

type Line = { productId: string; nameAr: string; nameEn: string; demandKg: number; greenKg: number; orders: number[]; green: { id: string; serialNumber: string; quantityKg: number } | null; bucketKg: number; buckets: number; lastKg: number; preparedToday: number; preparedKgToday: number; colorKey: string };
type SBucket = { id: string; barcode: string; seqNo: number; actualKg: string | number; plannedKg: string | number | null; status: string; colorKey: string | null; createdAt: string; product: { productNameAr: string | null; productNameEn: string } | null; greenBean?: { serialNumber: string }; runs?: { status: string; serial: string }[]; stale?: boolean; ageHours?: number };
type Step = { s: "plan" } | { s: "weigh"; line: Line; sessionId: string; count: number; kg: number; index: number } | { s: "list"; sessionId: string };

const k2 = (n: number) => n.toFixed(2);
const today = () => labelDate();

export function Prep() {
  const { user, switchEmployee } = useStation();
  const { t, lang, dir, err: errOf } = useV2T();
  const err = (r: ApiResult) => errOf(r.body);
  const nameOf = (l: Line) => (lang === "en" ? l.nameEn || l.nameAr : l.nameAr || l.nameEn);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [perKg, setPerKg] = useState(0);
  const [step, setStep] = useState<Step>({ s: "plan" });
  const [weight, setWeight] = useState("");
  const [pad, setPad] = useState(false);
  const [printed, setPrinted] = useState<{ seqNo: number; kg: number }[]>([]);
  const [printing, setPrintingJob] = useState<{ label: BucketLabelData; at: number } | null>(null);
  const setPrinting = (label: BucketLabelData) => setPrintingJob({ label, at: Date.now() });
  const [list, setList] = useState<{ buckets: SBucket[]; leftovers: SBucket[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void getJson<Line[]>(`${V2}/prep/plan`).then((r) => setLines(r.ok ? (r.body as unknown as Line[]) : [])); }, []);
  const line = useMemo(() => lines?.find((l) => l.productId === sel) ?? null, [lines, sel]);

  const loadList = useCallback(async (sessionId: string) => {
    const r = await getJson<{ buckets: SBucket[]; leftovers: SBucket[] }>(`${V2}/prep/sessions/${sessionId}/buckets`);
    if (r.ok) setList(r.body);
  }, []);

  const start = async () => {
    if (!line) return;
    if (!line.green) { setMsg(t("noGreenLot")); return; }
    setBusy(true);
    const r = await postJson<{ id: string }>(`${V2}/prep/sessions`, {}, null);
    setBusy(false);
    if (!r.ok) { setMsg(err(r as ApiResult)); return; }
    const first: Step = { s: "weigh", line, sessionId: r.body.id, count, kg: perKg, index: 1 };
    setStep(first);
    setWeight(k2(plannedOf(first)));
  };

  const plannedOf = (st: Step) => (st.s === "weigh" ? (st.index === st.count ? Math.max(0.1, +(st.line.greenKg - st.kg * (st.count - 1)).toFixed(2)) : st.kg) : 0);
  const planned = plannedOf(step);

  const save = async () => {
    if (step.s !== "weigh") return;
    const w = manualScale.manual(weight);
    if (!w) { setMsg(t("enterWeight")); return; }
    setBusy(true); setMsg("");
    const r = await postJson<{ id: string; seqNo: number; barcode: string; actualKg: string }>(`${V2}/buckets`, { sessionId: step.sessionId, greenBeanId: step.line.green!.id, actualKg: w.kg, plannedKg: planned, productId: step.line.productId });
    setBusy(false);
    if (!r.ok) { setMsg(err(r as ApiResult)); cue("err"); return; }
    cue("ok");
    const label: BucketLabelData = { letter: coffeeLetter({ productNameAr: step.line.nameAr, productNameEn: step.line.nameEn }), coffee: step.line.nameAr || step.line.nameEn, coffeeEn: step.line.nameEn || step.line.nameAr, seqNo: r.body.seqNo, kg: w.kg, date: today(), session: `P${step.sessionId.slice(-4).toUpperCase()}`, lot: step.line.green!.serialNumber, barcode: r.body.barcode };
    setPrinting(label);
    void postJson(`${V2}/buckets/${r.body.id}/label`, {}, null);
    setPrinted((p) => [{ seqNo: r.body.seqNo, kg: w.kg }, ...p].slice(0, 5));
    if (step.index >= step.count) { setStep({ s: "list", sessionId: step.sessionId }); void loadList(step.sessionId); }
    else { const nxt: Step = { ...step, index: step.index + 1 }; setStep(nxt); setWeight(k2(plannedOf(nxt))); }
  };

  const bar = (title: string) => (
    <header className="rv2-bar">
      <div className="rv2-bar-station"><b>{title}</b><small>{t("roastingArea")}</small></div>
      <span className="rv2-grow" />
      <button className="rv2-user" onClick={() => switchEmployee()} title={t("switchEmployee")}><span className="rv2-avatar">{[...user.name].slice(0, 2).join("")}</span>{user.name}</button>
      <LanguageToggle testId="rv2-lang" className="rv2-lang" />
      <Link className="rv2-link" href="/station/roasting">{t("roastLink")}</Link>
    </header>
  );

  // The print layer stays mounted across the steps: the last bucket's label (saved → the list) still prints.
  const printLayer = printing ? <PrintLabel key={printing.at}><BucketLabel d={printing.label} /></PrintLabel> : null;

  if (step.s === "weigh") {
    const c = coffeeColor(step.line.colorKey);
    const preview: BucketLabelData = { letter: coffeeLetter({ productNameAr: step.line.nameAr, productNameEn: step.line.nameEn }), coffee: step.line.nameAr || step.line.nameEn, coffeeEn: step.line.nameEn || step.line.nameAr, seqNo: printed[0] ? printed[0].seqNo + 1 : step.index, kg: Number(weight) || 0, date: today(), session: `P${step.sessionId.slice(-4).toUpperCase()}`, lot: step.line.green!.serialNumber, barcode: "GB-000000" };
    return (
      <div className="rv2 rv2-prep" dir={dir} lang={lang} data-testid="rv2-prep-weigh">
        {bar(t("prepTitle"))}
        <main className="rv2-cols">
          <section className="rv2-col">
            <div className="rv2-head"><b style={{ fontSize: 32 }} data-testid="rv2-prep-count">{t("bucketOf", { i: step.index, n: step.count })}</b><span style={{ color: c.strong }}>{t("coffeeKg", { coffee: nameOf(step.line), kg: Math.round(step.line.greenKg) })}</span></div>
            <div className="rv2-progress"><i style={{ width: `${((step.index - 1) / step.count) * 100}%`, background: c.strong }} /></div>
            <div className="rv2-scale" style={{ background: c.tint, borderColor: c.strong }}>
              <span>{t("weightHint")}</span>
              <b data-testid="rv2-prep-weight">{t("kgShort", { kg: weight || "0.00" })}</b>
            </div>
            <div className="rv2-steps">
              {[0.05, 0.01, -0.01, -0.05].map((d, i) => (
                <button key={d} className="rv2-mid" data-testid={`rv2-step-${i}`} onClick={() => setWeight((v) => k2(Math.max(0, (Number(v) || 0) + d)))}>{d > 0 ? `+${d.toFixed(2)}` : `−${Math.abs(d).toFixed(2)}`}</button>
              ))}
            </div>
            <button className="rv2-mid rv2-wide" onClick={() => setPad((p) => !p)}>{t("keypad")}</button>
            {pad && (
              <div className="rv2-keys">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((k) => (
                  <button key={k} onClick={() => setWeight((v) => (k === "⌫" ? v.slice(0, -1) : cleanWeight((v === k2(planned) ? "" : v) + k)))}>{k}</button>
                ))}
              </div>
            )}
            {msg && <div className="rv2-err">{msg}</div>}
            <span className="rv2-grow" />
            <button className="rv2-big" onClick={() => void save()} disabled={busy} data-testid="rv2-prep-save">{t("matchPrint")}</button>
          </section>
          <section className="rv2-col rv2-prep-side">
            <div className="rv2-head"><b style={{ fontSize: 15 }}>{t("labelToPrint")}</b></div>
            <div className="rv2-label-preview"><BucketLabel d={preview} /></div>
            <div className="rv2-head"><b style={{ fontSize: 15 }}>{t("lastPrinted")}</b></div>
            {printed.map((p) => <div key={p.seqNo} className="rv2-printed"><b>{t("bucketN", { n: p.seqNo })} · {t("kgShort", { kg: k2(p.kg) })}</b><span>{t("printedTick")}</span></div>)}
            <span className="rv2-grow" />
            <small className="rv2-scalenote">{t("scaleNote")}</small>
          </section>
        </main>
        {printLayer}
      </div>
    );
  }

  if (step.s === "list") {
    const b = list?.buckets ?? [];
    const kgSum = b.reduce((s, x) => s + Number(x.actualKg), 0);
    return (
      <div className="rv2 rv2-prep" dir={dir} lang={lang} data-testid="rv2-prep-list">
        {bar(t("prepTitle"))}
        <main className="rv2-cols">
          <section className="rv2-col" style={{ flex: 2 }}>
            <div className="rv2-head"><b>{t("preparedSum", { n: b.length, kg: k2(kgSum) })}</b></div>
            <div className="rv2-bgrid">
              {b.map((x) => {
                const run = x.runs?.[0];
                const st = run?.status === "CHARGED" ? "drum" : x.status === "CHARGED" ? "done" : x.status === "PREPARED" ? "ready" : "gone";
                const short = x.plannedKg !== null && Number(x.actualKg) < Number(x.plannedKg) - 0.5;
                return (
                  <div key={x.id} className={`rv2-bcell rv2-bcell-${st}${short ? " short" : ""}`} data-testid={`rv2-bucket-${x.seqNo}`}>
                    <b>{x.seqNo}</b><span>{st === "drum" ? t("inDrum") : st === "done" ? t("roastedTick") : st === "gone" ? (x.status === "RETURNED" ? t("returned") : t("writtenOff")) : `${t("kgShort", { kg: k2(Number(x.actualKg)) })}${short ? t("short") : ""}`}</span>
                  </div>
                );
              })}
            </div>
            <small>{t("gridNote")}</small>
            <span className="rv2-grow" />
            <div className="rv2-row"><button className="rv2-mid" onClick={() => setStep({ s: "plan" })}>{t("anotherLine")}</button><Link className="rv2-big rv2-linkbtn" href="/station/roasting">{t("toRoasting")}</Link></div>
          </section>
          <section className="rv2-col rv2-leftover">
            <div className="rv2-head"><b style={{ color: "var(--status-warning,#946200)" }}>{t("leftoverTitle")}</b></div>
            <b style={{ fontSize: 22 }}>{(list?.leftovers ?? []).length ? t("leftoverCount", { n: (list?.leftovers ?? []).length }) : t("noLeftover")}</b>
            {(list?.leftovers ?? []).map((x) => (
              <div key={x.id} className="rv2-card" data-testid={`rv2-leftover-${x.barcode}`}>
                <div className="rv2-card-body"><b style={{ fontSize: 18 }}>{(lang === "en" ? x.product?.productNameEn : x.product?.productNameAr) || x.product?.productNameEn} · {t("bucketN", { n: x.seqNo })}</b><small>{t("kgShort", { kg: k2(Number(x.actualKg)) })}{x.stale ? t("staleSince", { h: x.ageHours ?? 0 }) : ""}</small></div>
                <i style={{ background: coffeeColor(x.colorKey).strong }} />
                <button className="rv2-mid" onClick={async () => { const r = await postJson(`${V2}/buckets/${x.id}/return`, { reason: t("returnReason") }, null); if (r.ok) void loadList(step.sessionId); else setMsg(err(r as ApiResult)); }}>{t("returnToStock")}</button>
              </div>
            ))}
            {msg && <div className="rv2-err">{msg}</div>}
          </section>
        </main>
        {printLayer}
      </div>
    );
  }

  return (
    <div className="rv2 rv2-prep" dir={dir} lang={lang} data-testid="rv2-prep-plan">
      {bar(t("prepTitle"))}
      <main className="rv2-cols">
        <section className="rv2-col" style={{ flex: 1.4 }}>
          <div className="rv2-head"><b style={{ fontSize: 26 }}>{t("prepHeading")}</b></div>
          <small>{t("pickLine")}</small>
          {lines === null ? <p>…</p> : lines.length === 0 ? <p className="rv2-empty">{t("noDemand")}</p> : lines.map((l) => {
            const c = coffeeColor(l.colorKey);
            return (
              <button key={l.productId} className={`rv2-planline${sel === l.productId ? " on" : ""}`} style={sel === l.productId ? { borderColor: c.strong, background: c.tint } : undefined} onClick={() => { setSel(l.productId); setCount(l.buckets); setPerKg(l.bucketKg); }} data-testid={`rv2-plan-${l.productId}`}>
                <div><b>{t("planLine", { coffee: nameOf(l), kg: Math.round(l.greenKg), n: l.buckets, per: k2(l.bucketKg) })}</b><small>{l.orders.length ? t("forOrders", { list: l.orders.join(lang === "en" ? ", #" : "، #") }) : t("forStock")} · {l.preparedToday ? t("preparedToday", { n: l.preparedToday }) : t("readyToPrep")}</small></div>
                <i style={{ background: c.strong }} />
              </button>
            );
          })}
        </section>
        <section className="rv2-col">
          <div className="rv2-head"><b style={{ fontSize: 15 }}>{t("chosenLine")}</b></div>
          {line ? (
            <>
              <b style={{ fontSize: 28, color: coffeeColor(line.colorKey).strong }}>{t("coffeeKg", { coffee: nameOf(line), kg: Math.round(line.greenKg) })}</b>
              <div className="rv2-suggest"><span>{t("suggestion")}</span><b data-testid="rv2-prep-suggest">{t("bucketsTimes", { n: count, per: k2(perKg) })}</b><small>{t("fromGreen", { lot: line.green?.serialNumber ?? "—" })}</small></div>
              <div className="rv2-row">
                <label className="rv2-numfield">{t("bucketCount")}<input type="number" min={1} max={60} value={count} onChange={(e) => setCount(Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1))))} data-testid="rv2-prep-n" /></label>
                <label className="rv2-numfield">{t("kgPerBucket")}<input type="number" min={0.5} step={0.01} value={perKg} onChange={(e) => setPerKg(Math.max(0.5, Number(e.target.value) || 0.5))} data-testid="rv2-prep-kg" /></label>
              </div>
              <small>{t("stagingNote")}</small>
            </>
          ) : <p className="rv2-empty">{t("pickFromList")}</p>}
          {msg && <div className="rv2-err">{msg}</div>}
          <span className="rv2-grow" />
          <button className="rv2-big" disabled={!line || busy} onClick={() => void start()} data-testid="rv2-prep-start">{t("startPrep")}</button>
        </section>
      </main>
      {printLayer}
    </div>
  );
}
