"use client";
/**
 * One printed label, laid out in millimetres and points (never screen pixels), for both the
 * preview and the print output — the same component, so what is previewed is what prints.
 *
 * Design: Figma 1JbZgpMqmPkUVne8ms9Ozz «Print/Label · Coffee Origin» 1646:5655 and
 * «Print/Label · Cupping Results» 1646:6432 (Size × Language × Traceability / State).
 */
import type { CSSProperties, ReactNode } from "react";
import { descriptorLabel } from "@/app/dashboard/cupping/CuppingForm";
import { MISSING, needsLtrIsolation, scoreText, shown, splitLtrRuns, type PrintLang } from "@/lib/print/bidi";
import { labelGapMm, labelMetrics, logoPrints, notesText, printedNotes, type CupData, type LabelData, type OriginData } from "@/lib/print/content";
import { LEGACY_CAVEAT, NO_APPROVED_SCORE, finalMeta, finalMetaShort, legacyMeta, stateMarker } from "@/lib/print/cupping";
import { LOGO_SRC } from "@/lib/print/logo";
import { FIELD_DEFS, compactOmitsNotes, isShown, notesMaxLines, type FieldConfig, type FieldKey, type TemplateKey } from "@/lib/print/templates";
import { cssMm, cssPt } from "@/lib/print/units";

export type LabelOptions = {
  template: TemplateKey;
  lang: PrintLang;
  fields: FieldConfig;
  notesLines: number | null;
  /** Show the untruncated notes (expanded preview, B-6). Never used for printing. */
  fullNotes?: boolean;
};

const translate = (tag: string, l: "ar" | "en") => descriptorLabel(tag, l);

/**
 * Arabic text with every number and Latin run LTR-isolated in its own <bdi> (§5.1, A-6): «أكمل 2 من 3»,
 * «· كوب 1», «ياسمين 3/4», «مقيّم 1: Lemon», free-text product data. A run starts and ends on a
 * letter or digit and may hold spaces and . , : / % × – - + inside.
 */
export function ArText({ text }: { text: string }) {
  return <>{splitLtrRuns(text).map((r, i) => (r.ltr ? <bdi key={i} dir="ltr">{r.text}</bdi> : r.text))}</>;
}

/** A value: «—» when missing; Latin / numeric runs LTR-isolated inside Arabic (A-6, §5.1). */
function V({ v, side }: { v: string | null | undefined; side: "en" | "ar" }) {
  const s = shown(v);
  if (side === "ar") return needsLtrIsolation(s) ? <bdi dir="ltr">{s}</bdi> : <ArText text={s} />;
  return <>{s}</>;
}
const T = ({ s, text }: { s: "en" | "ar"; text: string | null }) => (text === null ? null : s === "ar" ? <ArText text={text} /> : <>{text}</>);

const FOOTER_EN = "HIQBAH COFFEE ROASTERS";
const FOOTER_AR = "محمصة حِقبة";

function Footer({ lang }: { lang: PrintLang }) {
  return (
    <div className="pl-footer">
      {lang !== "AR" ? <span className="pl-f-en">{FOOTER_EN}</span> : null}
      {lang === "BI" ? <span className="pl-f-sep"> · </span> : null}
      {lang !== "EN" ? <span className="pl-f-ar" lang="ar" dir="rtl">{FOOTER_AR}</span> : null}
    </div>
  );
}

function Logo({ heightMm }: { heightMm: number }) {
  // Ratio kept: height fixed, width auto from the SVG's viewBox (A-7).
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="pl-logo" src={LOGO_SRC} alt="HIQBAH" style={{ height: cssMm(heightMm) }} />;
}

type Row = { key: FieldKey; en: ReactNode; ar: ReactNode; notes?: boolean; kEn?: string; kAr?: string };

/**
 * Cupping Results rows as in «Print/Label · Cupping Results» 1646:6432: sensory attributes in
 * pairs («ACIDITY · BODY  8.00 · 7.75») and batch + roast date in one row («BATCH · ROASTED»),
 * so a bilingual 99.1 × 67.7 label holds the panel without overflowing.
 */
function mergeCupRows(rows: Row[]): Row[] {
  const out: Row[] = [];
  let pending: Row | null = null;
  for (const r of rows) {
    if (r.key.startsWith("attr_")) {
      if (pending) {
        const a = FIELD_DEFS[pending.key], b = FIELD_DEFS[r.key];
        out.push({ key: pending.key, kEn: `${a.en.toUpperCase()} · ${b.en.toUpperCase()}`, kAr: `${a.ar} · ${b.ar}`, en: <>{pending.en} · {r.en}</>, ar: <>{pending.ar} · {r.ar}</> });
        pending = null;
      } else pending = r;
      continue;
    }
    if (pending) { out.push(pending); pending = null; }
    out.push(r);
  }
  if (pending) out.push(pending);
  const bi = out.findIndex((r) => r.key === "batchNumber"), ri = out.findIndex((r) => r.key === "roastDate");
  if (bi >= 0 && ri >= 0) {
    const b = out[bi], rd = out[ri];
    out[Math.min(bi, ri)] = { key: "batchNumber", kEn: "BATCH · ROASTED", kAr: "الدفعة · التحميص", en: <><span className="pl-date">{b.en}</span> · <span className="pl-date">{rd.en}</span></>, ar: <bdi dir="ltr"><span className="pl-date">{b.ar}</span> · <span className="pl-date">{rd.ar}</span></bdi> };
    out.splice(Math.max(bi, ri), 1);
  }
  return out;
}

function rowsFor(d: LabelData, o: LabelOptions, w: number, h: number): Row[] {
  const rows: Row[] = [];
  const lines = notesMaxLines(labelMetrics(w, h, o.lang).cls, o.notesLines, o.lang);
  const notes = (side: "en" | "ar") => {
    const raw = notesText(d, side, o.template, o.fields, translate);
    if (o.fullNotes) return raw ?? MISSING;
    return printedNotes(raw, w, h, o.lang, lines, side).text ?? MISSING;
  };
  for (const f of o.fields) {
    if (!f.show) continue;
    const k = f.key;
    if (d.kind === "origin") {
      const od = d as OriginData;
      if (k === "country" || k === "region" || k === "variety" || k === "process" || k === "roastPath") {
        rows.push({ key: k, en: <V v={od[k].en} side="en" />, ar: <V v={od[k].ar} side="ar" /> });
      } else if (k === "altitude") {
        // A-6: altitude is shown on the Arabic side too, LTR-isolated.
        rows.push({ key: k, en: <V v={od.altitude} side="en" />, ar: <V v={od.altitude} side="ar" /> });
      } else if (k === "cupNotes") {
        rows.push({ key: k, en: notes("en"), ar: <V v={notes("ar")} side="ar" />, notes: true });
      } else if ((k === "roastDate" || k === "batchNumber" || k === "lotRef") && od.trace[k]) {
        // B-7: a missing traceability value is omitted (with a warning), never invented.
        rows.push({ key: k, en: <V v={od.trace[k]} side="en" />, ar: <V v={od.trace[k]} side="ar" /> });
      }
    } else {
      const cd = d as CupData;
      if (k.startsWith("attr_") && cd.result.attributes) {
        const v = cd.result.attributes[k.slice(5) as keyof typeof cd.result.attributes];
        if (typeof v === "number") rows.push({ key: k, en: <V v={scoreText(v)} side="en" />, ar: <V v={scoreText(v)} side="ar" /> });
      } else if ((k === "sharedNotes" && cd.result.state === "FINAL") || (k === "scorerNotes" && cd.result.scorerNotes)) {
        const one = { ...o, fields: o.fields.map((x) => ({ ...x, show: x.key === k || (FIELD_DEFS[x.key].kind === "option" && x.show) })) };
        const raw = (side: "en" | "ar") => notesText(cd, side, o.template, one.fields, translate, o.lang === "BI");
        const t = (side: "en" | "ar") => (o.fullNotes ? raw(side) : printedNotes(raw(side), w, h, o.lang, lines, side).text) ?? MISSING;
        rows.push({ key: k, en: t("en"), ar: <V v={t("ar")} side="ar" />, notes: true });
      } else if (k === "session") {
        // Design §P2-8 (823d5ae7): «Session · 2026-10-06» / «جلسة · 2026-10-06», the date ISO and
        // LTR-isolated in both halves (B-7).
        const date = <bdi dir="ltr" className="pl-date">{shown(cd.session.date)}</bdi>;
        rows.push({ key: k, en: <>Session · {date}</>, ar: <>جلسة · {date}</> });
      } else if ((k === "roastDate" || k === "batchNumber") && cd.trace[k]) {
        rows.push({ key: k, en: <V v={cd.trace[k]} side="en" />, ar: <V v={cd.trace[k]} side="ar" /> });
      }
    }
  }
  return rows;
}

function Names({ d, lang }: { d: LabelData; lang: PrintLang }) {
  const cupEn = d.kind === "cup" && d.cupNo ? ` · cup ${d.cupNo}` : "";
  const cupAr = d.kind === "cup" && d.cupNo ? <> · كوب <bdi dir="ltr">{d.cupNo}</bdi></> : null;
  const extEn = d.kind === "cup" && d.external ? "External sample: " : "";
  const extAr = d.kind === "cup" && d.external ? "عيّنة خارجية: " : "";
  return (
    <div className="pl-names">
      {lang !== "AR" ? <div className="pl-name-en" data-essential="">{extEn}{shown(d.name.en)}{cupEn}</div> : null}
      {lang !== "EN" ? <div className="pl-name-ar" dir="rtl" lang="ar" data-essential="">{extAr}<V v={d.name.ar ?? (lang === "AR" ? d.name.en : null)} side="ar" />{cupAr}</div> : null}
    </div>
  );
}

/** «الإيحاءات (حسب المقيّم)» breaks before the bracket, as in 1646:6432. */
const keyAr = (k: string) => k.replace(/\((\S+) (\S+)\)/, "($1\u00a0$2)");

const SIDES = (lang: PrintLang): ("en" | "ar")[] => (lang === "BI" ? ["en", "ar"] : lang === "AR" ? ["ar"] : ["en"]);
const dirOf = (s: "en" | "ar") => (s === "ar" ? "rtl" : "ltr");

/** «/ 100 · SCA» (English) or «من 100 · SCA» (Arabic), numbers LTR-isolated. */
function OutOf({ side }: { side: "en" | "ar" }) {
  return side === "ar" ? <span dir="rtl" lang="ar">من <bdi dir="ltr">100 · SCA</bdi></span> : <bdi dir="ltr" className="pl-outof">/ 100 · SCA</bdi>;
}

/** The pre-policy disclosure box; Arabic first when bilingual (1655:10543, 1656:11400). */
function CaveatBox({ lang, tail }: { lang: PrintLang; tail?: Partial<Record<"en" | "ar", ReactNode>> }) {
  const order: ("en" | "ar")[] = lang === "BI" ? ["ar", "en"] : SIDES(lang);
  return (
    <span className="pl-legacy-caveat" data-testid="pl-legacy-caveat">
      {order.map((s) => (
        <span key={s} className={`pl-cv pl-cv-${s}`} dir={dirOf(s)} lang={s}>
          <span className="pl-cv-text">{LEGACY_CAVEAT[s]}</span>
          {tail?.[s] ? <span className="pl-cv-tail">{tail[s]}</span> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * The score row of a Cupping Results label, per set 1646:6432 (design §P2-4 / §P2-7):
 * - FINAL: bilingual «/ 100 · SCA · 3/3 complete · أكمل 3 من 3» then the score at the end; single
 *   language: the score first (physical left) then «/ 100 · SCA · 3 of 3 scorers completed all cups»;
 * - pre-policy (decision 2.3): the exact disclosure in a boxed rule spanning the row (Arabic first when
 *   bilingual), «/ 100 · SCA» after its English line, the recorded score beside it; single language
 *   adds «3 scorers · recorded score». No staff score → «No finalized score», nothing computed;
 * - OPEN / INCOMPLETE: a large state word and a small meta line, never a score.
 */
function ScoreBlock({ d, lang, compact }: { d: CupData; lang: PrintLang; compact: boolean }) {
  const r = d.result;
  const sides = SIDES(lang);
  const bi = lang === "BI";
  const one: "en" | "ar" = lang === "AR" ? "ar" : "en";
  const num = (suffix = "") => r.score !== null ? <bdi dir="ltr" className="pl-score-num">{scoreText(r.score)}{suffix}</bdi> : null;
  const noScore = (inline: boolean) => (
    <span className={`pl-noscore${inline ? " is-inline" : ""}`} data-testid="pl-no-score">
      {(inline ? sides : bi ? (["ar", "en"] as const) : sides).map((s, i) => <span key={s} className="pl-part">{inline && i ? " · " : ""}<span dir={dirOf(s)} lang={s}>{NO_APPROVED_SCORE[s]}</span></span>)}
    </span>
  );

  if (r.state === "CLOSED_LEGACY") {
    if (compact) {
      return (
        <div className={`pl-legacy is-compact`} data-essential="" data-state={r.state} data-testid="pl-legacy">
          {r.score !== null ? num(" · SCA") : noScore(true)}
          <CaveatBox lang={lang} />
        </div>
      );
    }
    if (r.score === null) {
      // 1667:182009 / 182130 / 182236: «No finalized score» at the start, the disclosure beside it.
      return (
        <div className={`pl-score pl-legacy is-noscore${bi ? " is-bi" : ""}`} data-essential="" data-state={r.state} data-testid="pl-legacy">
          {bi ? <><CaveatBox lang={lang} />{noScore(false)}</> : <>{noScore(false)}<CaveatBox lang={lang} /></>}
        </div>
      );
    }
    const scorers = r.cupScorers;
    const tail = bi
      ? { en: <> · <OutOf side="en" /></> }
      : { [one]: <><OutOf side={one} /> · <T s={one} text={legacyMeta(scorers, one)} /></> };
    return (
      <div className={`pl-score pl-legacy${bi ? " is-bi" : " is-single"}`} data-essential="" data-state={r.state} data-testid="pl-legacy" dir={bi ? undefined : "ltr"}>
        {bi ? <><CaveatBox lang={lang} tail={tail} />{num()}</> : <>{num()}<CaveatBox lang={lang} tail={tail} /></>}
      </div>
    );
  }
  if (r.score !== null && r.state === "FINAL") {
    if (compact) return <div className="pl-score" data-essential="" data-state={r.state}>{num(" · SCA")}</div>;
    if (bi) {
      return (
        <div className="pl-score is-bi" data-essential="" data-state={r.state}>
          <span className="pl-score-meta"><span><OutOf side="en" />{sides.map((s) => <span key={s}> · <bdi dir={dirOf(s)}><T s={s} text={finalMetaShort(r, s)} /></bdi></span>)}</span></span>
          {num()}
        </div>
      );
    }
    // Single language: the score sits at the physical left in both languages (1646:6082 / 1646:5882).
    return (
      <div className="pl-score is-single" data-essential="" data-state={r.state} dir="ltr">
        {num()}
        <span className="pl-score-meta" dir={dirOf(one)} lang={one}><span><OutOf side={one} /> · <T s={one} text={finalMeta(r, one)} /></span></span>
      </div>
    );
  }
  if (compact) {
    return (
      <div className="pl-marker is-compact" data-essential="" data-state={r.state} data-testid="pl-not-final">
        {sides.map((s, i) => <span key={s}>{i ? " · " : ""}<span dir={dirOf(s)} lang={s}>{stateMarker(r, s, "compact").text}</span></span>)}
      </div>
    );
  }
  if (bi) {
    return (
      <div className="pl-marker is-bi" data-essential="" data-state={r.state} data-testid="pl-not-final">
        <span className="pl-marker-meta">{sides.map((s, i) => <span key={s}>{i ? " · " : ""}<span dir={dirOf(s)} lang={s}><T s={s} text={stateMarker(r, s, "bi").meta} /></span></span>)}</span>
        <span className="pl-marker-word">{sides.map((s, i) => <span key={s}>{i ? " · " : ""}<span dir={dirOf(s)} lang={s}>{stateMarker(r, s, "bi").text}</span></span>)}</span>
      </div>
    );
  }
  const m = stateMarker(r, one, "single");
  return (
    <div className="pl-marker is-single" data-essential="" data-state={r.state} data-testid="pl-not-final">
      <span className="pl-marker-word" lang={one}>{m.text}</span>
      <span className="pl-marker-meta" lang={one}><T s={one} text={m.meta} /></span>
    </div>
  );
}

export function LabelView({ data, opts, wMm, hMm, refAttr }: { data: LabelData; opts: LabelOptions; wMm: number; hMm: number; refAttr?: string }) {
  const m = labelMetrics(wMm, hMm, opts.lang);
  const t = m.t;
  const compact = m.cls === "compact";
  const style = {
    width: cssMm(wMm), height: cssMm(hMm), padding: cssMm(t.padMm),
    "--pl-name-en": cssPt(t.nameEn), "--pl-name-ar": cssPt(t.nameAr), "--pl-value": cssPt(t.value), "--pl-value-ar": cssPt(t.valueAr),
    "--pl-label-en": cssPt(t.labelEn), "--pl-label-ar": cssPt(t.labelAr), "--pl-footer-en": cssPt(t.footerEn), "--pl-footer-ar": cssPt(t.footerAr),
    "--pl-score": cssPt(t.score), "--pl-labelcol": cssMm(m.labelCol),
    "--pl-notes-lines": String(opts.fullNotes ? 99 : notesMaxLines(m.cls, opts.notesLines, opts.lang)),
    "--pl-gap": cssMm(labelGapMm(data, opts.lang, m.cls, opts.fields)),
  } as CSSProperties;
  const showLogo = isShown(opts.fields, "logo") && logoPrints(m.cls, wMm, true);
  const footer = isShown(opts.fields, "footer") && !compact;
  const dir = opts.lang === "AR" ? "rtl" : "ltr";
  const cls = `pl-label pl-${m.cls} pl-lang-${opts.lang.toLowerCase()}`;

  if (compact) return <CompactLabel data={data} opts={opts} wMm={wMm} hMm={hMm} style={style} cls={cls} dir={dir} refAttr={refAttr} />;

  const rows = data.kind === "cup" ? mergeCupRows(rowsFor(data, opts, wMm, hMm)) : rowsFor(data, opts, wMm, hMm);
  return (
    <div className={cls} style={style} dir={dir} data-label-ref={refAttr} data-testid="print-label">
      <div className="pl-inner">
        {/* Bilingual: logo at the left, names at the right; single language: names at the start and
            the logo at the end (1646:5656 / 1646:6082 / 1646:5882). */}
        <div className="pl-head">
          {showLogo && opts.lang === "BI" ? <Logo heightMm={Math.max(t.logoMm, 8)} /> : null}
          <div className="pl-headtext">
            {data.kind === "cup" ? <div className="pl-kicker">{opts.lang !== "AR" ? "CUPPING RESULTS" : null}{opts.lang === "BI" ? " · " : null}{opts.lang !== "EN" ? <span dir="rtl" lang="ar">نتائج التذوق</span> : null}</div> : null}
            {isShown(opts.fields, "name") ? <Names d={data} lang={opts.lang} /> : null}
          </div>
          {showLogo && opts.lang !== "BI" ? <Logo heightMm={Math.max(t.logoMm, 8)} /> : null}
        </div>
        {data.kind === "cup" && isShown(opts.fields, "score") ? <ScoreBlock d={data} lang={opts.lang} compact={false} /> : null}
        <div className="pl-rows">
          {rows.map((r) => {
            const def = FIELD_DEFS[r.key];
            if (opts.lang === "BI") {
              return (
                <div key={r.key} className={`pl-row is-bi${r.notes ? " is-notes" : ""}`} data-field={r.key}>
                  <div className="pl-half" dir="ltr"><span className="pl-k">{r.kEn ?? def.en.toUpperCase()}</span><span className="pl-v">{r.en}</span></div>
                  <div className="pl-half" dir="rtl" lang="ar"><span className="pl-k">{keyAr(r.kAr ?? def.ar)}</span><span className="pl-v">{r.ar}</span></div>
                </div>
              );
            }
            const side = opts.lang === "AR" ? "ar" : "en";
            return (
              <div key={r.key} className={`pl-row${r.notes ? " is-notes" : ""}`} data-field={r.key} lang={side}>
                <span className="pl-k">{side === "ar" ? keyAr(r.kAr ?? def.ar) : r.kEn ?? def.en.toUpperCase()}</span>
                <span className="pl-v">{side === "ar" ? r.ar : r.en}</span>
              </div>
            );
          })}
        </div>
        {footer ? <Footer lang={opts.lang} /> : null}
      </div>
    </div>
  );
}

/** 50 × 30 class (A-4 / P2-1): no field labels, priority order, logo omitted. */
function CompactLabel({ data, opts, wMm, hMm, style, cls, dir, refAttr }: { data: LabelData; opts: LabelOptions; wMm: number; hMm: number; style: CSSProperties; cls: string; dir: "rtl" | "ltr"; refAttr?: string }) {
  const sides: ("en" | "ar")[] = opts.lang === "BI" ? ["en", "ar"] : opts.lang === "AR" ? ["ar"] : ["en"];
  const notesAllowed = !compactOmitsNotes(opts.lang);
  const notesFieldShown = opts.template === "COFFEE_ORIGIN" ? isShown(opts.fields, "cupNotes") : isShown(opts.fields, "sharedNotes") || isShown(opts.fields, "scorerNotes");
  const side = sides[0];
  const notes = notesAllowed && notesFieldShown ? (() => {
    const raw = notesText(data, side, opts.template, opts.fields, translate);
    return opts.fullNotes ? raw : printedNotes(raw, wMm, hMm, opts.lang, 2, side).text;
  })() : null;
  const trace = [data.trace.batchNumber && isShown(opts.fields, "batchNumber") ? data.trace.batchNumber : null, data.trace.roastDate && isShown(opts.fields, "roastDate") ? data.trace.roastDate : null].filter(Boolean).join(" · ");
  const origin = data.kind === "origin" && (isShown(opts.fields, "country") || isShown(opts.fields, "region"))
    ? sides.map((s) => [isShown(opts.fields, "country") ? data.country[s] : null, isShown(opts.fields, "region") ? data.region[s] : null].filter(Boolean).join(s === "ar" ? "، " : ", ")).filter(Boolean)
    : [];
  const blocks: ReactNode[] = [];
  for (const p of (opts.template === "COFFEE_ORIGIN" ? ["name", "notes", "origin", "trace"] : ["name", "score", "notes", "trace"])) {
    if (p === "name" && isShown(opts.fields, "name")) blocks.push(<Names key="n" d={data} lang={opts.lang} />);
    if (p === "score" && data.kind === "cup" && isShown(opts.fields, "score")) blocks.push(<ScoreBlock key="s" d={data} lang={opts.lang} compact />);
    if (p === "notes" && notes) blocks.push(<div key="t" className="pl-c-notes" dir={side === "ar" ? "rtl" : "ltr"} data-field="notes">{side === "ar" ? <V v={notes} side="ar" /> : notes}</div>);
    if (p === "origin" && origin.length) blocks.push(<div key="o" className="pl-c-line" data-field="origin">{origin.map((o, i) => <span key={i}>{i ? " · " : ""}<span dir={sides[i] === "ar" ? "rtl" : "ltr"}><T s={sides[i]} text={o} /></span></span>)}</div>);
    if (p === "trace" && trace) blocks.push(<div key="r" className="pl-c-line" data-field="trace"><bdi dir="ltr">{trace}</bdi></div>);
  }
  return (
    <div className={cls} style={style} dir={dir} data-label-ref={refAttr} data-testid="print-label">
      <div className="pl-inner">{blocks}</div>
    </div>
  );
}
