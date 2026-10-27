"use client";
/**
 * The two record labels (20261114090000_green_lot_labels), laid out in millimetres and points like LabelView — the same
 * component for the preview and the print:
 *
 *   · «لوت البن الأخضر» (GREEN_LOT) — the bean in both languages, origin, process, variety, altitude, then the lot and its
 *     receipt (serial, supplier, supplier invoice no., received date, received weight), «كيس 3 من 15» on a per-sack
 *     label, a QR code of the lot's trace page and the Code 128 barcode of the lot code «GL-00042»;
 *   · «ملصق رف» (MATERIAL_SHELF) — a stock material's name, category, unit, item code and the barcode «MT-00007».
 *
 * On the 50 × 30 class only the essentials print: name, the sack, the barcode. Every value comes from the server
 * (/api/print/label-data, /api/print/jobs); the QR address is the application's own origin + the lot path.
 */
import type { CSSProperties, ReactNode } from "react";
import { MISSING, needsLtrIsolation, shown, type PrintLang } from "@/lib/print/bidi";
import type { GreenLotData, MaterialData } from "@/lib/print/content";
import { labelMetrics, logoPrints } from "@/lib/print/content";
import { LOGO_SRC } from "@/lib/print/logo";
import { FIELD_DEFS, isShown, type FieldKey } from "@/lib/print/templates";
import { cssMm, cssPt } from "@/lib/print/units";
import { lotPagePath } from "@/lib/scan/codes";
import { ArText, type LabelOptions } from "./LabelView";
import { Barcode, QrCode } from "./Codes";

const sidesOf = (lang: PrintLang): ("en" | "ar")[] => (lang === "BI" ? ["en", "ar"] : lang === "AR" ? ["ar"] : ["en"]);
const kg = (v: number) => (Math.round(v * 100) / 100).toString();

function Val({ v, side }: { v: string | null | undefined; side: "en" | "ar" }) {
  const s = shown(v);
  if (side === "ar") return needsLtrIsolation(s) ? <bdi dir="ltr">{s}</bdi> : <ArText text={s} />;
  return <>{s}</>;
}

/** «Sack 3 of 15 · 60 kg» / «كيس 3 من 15 · 60 كغ». */
export function sackText(sack: { no: number; of: number; kg: number | null }, side: "en" | "ar"): string {
  return side === "ar"
    ? `كيس ${sack.no} من ${sack.of}${sack.kg ? ` · ${kg(sack.kg)} كغ` : ""}`
    : `Sack ${sack.no} of ${sack.of}${sack.kg ? ` · ${kg(sack.kg)} kg` : ""}`;
}

const UNIT: Record<string, [string, string]> = { KG: ["كغ", "kg"], GRAM: ["غ", "g"], PIECE: ["قطعة", "piece"], UNIT: ["وحدة", "unit"], LITER: ["لتر", "litre"] };

function qrUrl(code: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${lotPagePath(code)}`;
}

function styleFor(wMm: number, hMm: number, lang: PrintLang) {
  const m = labelMetrics(wMm, hMm, lang);
  const t = m.t;
  const style = {
    width: cssMm(wMm), height: cssMm(hMm), padding: cssMm(t.padMm),
    "--pl-name-en": cssPt(t.nameEn), "--pl-name-ar": cssPt(t.nameAr), "--pl-value": cssPt(t.value), "--pl-value-ar": cssPt(t.valueAr),
    "--pl-label-en": cssPt(t.labelEn), "--pl-label-ar": cssPt(t.labelAr), "--pl-footer-en": cssPt(t.footerEn), "--pl-footer-ar": cssPt(t.footerAr),
    "--pl-labelcol": cssMm(m.labelCol), "--pl-gap": cssMm(m.cls === "standard" ? 0.8 : 0.5),
  } as CSSProperties;
  return { m, style };
}

function Names({ name, lang }: { name: { en: string | null; ar: string | null }; lang: PrintLang }) {
  return (
    <div className="pl-names">
      {lang !== "AR" ? <div className="pl-name-en" data-essential="">{shown(name.en)}</div> : null}
      {lang !== "EN" ? <div className="pl-name-ar" dir="rtl" lang="ar" data-essential=""><Val v={name.ar ?? (lang === "AR" ? name.en : null)} side="ar" /></div> : null}
    </div>
  );
}

function Head({ name, lang, logo, logoMm }: { name: { en: string | null; ar: string | null }; lang: PrintLang; logo: boolean; logoMm: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  const img = logo ? <img className="pl-logo" src={LOGO_SRC} alt="HIQBAH" style={{ height: cssMm(logoMm) }} /> : null;
  return (
    <div className="pl-head">
      {lang === "BI" ? img : null}
      <div className="pl-headtext"><Names name={name} lang={lang} /></div>
      {lang !== "BI" ? img : null}
    </div>
  );
}

/** A key in the printed language(s): «LOT · اللوت» bilingual. */
function Key({ k, lang }: { k: FieldKey; lang: PrintLang }) {
  const d = FIELD_DEFS[k];
  if (lang === "EN") return <span className="pl-k">{d.en.toUpperCase()}</span>;
  if (lang === "AR") return <span className="pl-k" lang="ar">{d.ar}</span>;
  return <span className="pl-k"><span>{d.en.toUpperCase()}</span> · <span lang="ar">{d.ar}</span></span>;
}

type Cell = { key: FieldKey; v: ReactNode };

/** Language-neutral values (codes, dates, weights, a supplier's name) in a two-column grid of key + value cells. */
function Cells({ cells, lang }: { cells: Cell[]; lang: PrintLang }) {
  if (!cells.length) return null;
  return (
    <div className="pl-rec-cells" dir={lang === "AR" ? "rtl" : "ltr"}>
      {cells.map((c) => (
        <div key={c.key} className="pl-rec-cell" data-field={c.key}>
          <Key k={c.key} lang={lang} />
          <span className="pl-v">{c.v}</span>
        </div>
      ))}
    </div>
  );
}

/** A bilingual value (country, process): the English half and the Arabic half, as on the origin label. */
function BiRow({ k, en, ar, lang }: { k: FieldKey; en: string | null; ar: string | null; lang: PrintLang }) {
  const def = FIELD_DEFS[k];
  if (lang === "BI") {
    return (
      <div className="pl-row is-bi" data-field={k}>
        <div className="pl-half" dir="ltr"><span className="pl-k">{def.en.toUpperCase()}</span><span className="pl-v"><Val v={en} side="en" /></span></div>
        <div className="pl-half" dir="rtl" lang="ar"><span className="pl-k">{def.ar}</span><span className="pl-v"><Val v={ar ?? en} side="ar" /></span></div>
      </div>
    );
  }
  const side = lang === "AR" ? "ar" : "en";
  return (
    <div className="pl-row" data-field={k} lang={side} dir={side === "ar" ? "rtl" : "ltr"}>
      <span className="pl-k">{side === "ar" ? def.ar : def.en.toUpperCase()}</span>
      <span className="pl-v"><Val v={side === "ar" ? ar ?? en : en} side={side} /></span>
    </div>
  );
}

function SackLine({ sack, lang }: { sack: { no: number; of: number; kg: number | null }; lang: PrintLang }) {
  return (
    <div className="pl-sack" data-field="sack" data-essential="" data-testid="pl-sack">
      {sidesOf(lang).map((s) => <span key={s} className="pl-sack-part" dir={s === "ar" ? "rtl" : "ltr"} lang={s}>{s === "ar" ? <ArText text={sackText(sack, s)} /> : sackText(sack, s)}</span>)}
    </div>
  );
}

export function GreenLotLabel({ data, opts, wMm, hMm, refAttr }: { data: GreenLotData; opts: LabelOptions; wMm: number; hMm: number; refAttr?: string }) {
  const { m, style } = styleFor(wMm, hMm, opts.lang);
  const f = opts.fields;
  const lang = opts.lang;
  const compact = m.cls === "compact";
  const large = m.cls === "large";
  const cls = `pl-label pl-${m.cls} pl-lang-${lang.toLowerCase()} pl-record`;
  const dir = lang === "AR" ? "rtl" : "ltr";
  const barcode = isShown(f, "barcode");
  const inner = m.inner;
  if (compact) {
    return (
      <div className={cls} style={style} dir={dir} data-label-ref={refAttr} data-testid="print-label" data-kind="green">
        <div className="pl-inner">
          {isShown(f, "name") ? <Names name={data.name} lang={lang} /> : null}
          <div className="pl-c-line" data-field="lotCode"><bdi dir="ltr">{data.serial}</bdi></div>
          {data.sack && isShown(f, "sack") ? <SackLine sack={data.sack} lang={lang === "BI" ? "AR" : lang} /> : null}
          {barcode ? <div className="pl-codes is-compact"><Barcode value={data.code} widthMm={inner} heightMm={Math.min(11, m.innerHeight * 0.42)} testId="pl-barcode" /></div> : null}
        </div>
      </div>
    );
  }
  const qr = isShown(f, "qr");
  const logo = isShown(f, "logo") && logoPrints(m.cls, wMm, true);
  const t = m.t;
  const sideMain: "en" | "ar" = lang === "AR" ? "ar" : "en";
  const join = (a: string | null, b: string | null, s: "en" | "ar") => [a, b].filter((x) => x && x.trim()).join(s === "ar" ? "، " : ", ") || null;
  const bi: ReactNode[] = [];
  const cells: Cell[] = [];
  for (const x of f) {
    if (!x.show) continue;
    switch (x.key) {
      case "country": bi.push(<BiRow key="country" k="country" lang={lang} en={join(data.country.en, data.region.en, "en")} ar={join(data.country.ar ?? data.country.en, data.region.ar ?? data.region.en, "ar")} />); break;
      case "process": bi.push(<BiRow key="process" k="process" lang={lang} en={data.process.en} ar={data.process.ar} />); break;
      case "variety": cells.push({ key: "variety", v: <Val v={data.variety} side={sideMain} /> }); break;
      case "altitude": cells.push({ key: "altitude", v: <bdi dir="ltr">{shown(data.altitude)}</bdi> }); break;
      case "lotCode": cells.push({ key: "lotCode", v: <bdi dir="ltr" className="pl-mono">{data.serial}</bdi> }); break;
      case "supplier": if (data.supplier) cells.push({ key: "supplier", v: <Val v={data.supplier} side={sideMain} /> }); break;
      case "invoiceRef": if (data.invoiceRef) cells.push({ key: "invoiceRef", v: <bdi dir="ltr" className="pl-mono">{data.invoiceRef}</bdi> }); break;
      case "receivedDate": cells.push({ key: "receivedDate", v: <bdi dir="ltr" className="pl-date">{shown(data.receivedDate)}</bdi> }); break;
      case "receivedWeight": {
        const w = data.receivedKg;
        const sacks = data.sacks ? ` (${data.sacks.count}${data.sacks.kg ? ` × ${kg(data.sacks.kg)}` : ""})` : "";
        if (w !== null || data.sacks) cells.push({ key: "receivedWeight", v: <bdi dir="ltr">{w !== null ? `${kg(w)} kg` : MISSING}{sacks}</bdi> });
        break;
      }
      default: break;
    }
  }
  const qrMm = large ? 32 : Math.min(17, m.innerHeight * 0.3);
  const barH = large ? 22 : Math.min(11, m.innerHeight * 0.18);
  return (
    <div className={cls} style={style} dir={dir} data-label-ref={refAttr} data-testid="print-label" data-kind="green">
      <div className="pl-inner">
        {isShown(f, "name") || logo ? <Head name={data.name} lang={lang} logo={logo} logoMm={Math.max(t.logoMm, 8)} /> : null}
        <div className={`pl-rec-body${qr ? " has-qr" : ""}`}>
          <div className="pl-rec-main">
            <div className="pl-rows">{bi}</div>
            <Cells cells={cells} lang={lang} />
          </div>
          {qr ? <QrCode value={qrUrl(data.code)} sizeMm={qrMm} testId="pl-qr" /> : null}
        </div>
        {data.sack && isShown(f, "sack") ? <SackLine sack={data.sack} lang={lang} /> : null}
        {barcode ? <div className="pl-codes"><Barcode value={data.code} widthMm={Math.min(inner, large ? 110 : 64)} heightMm={barH} testId="pl-barcode" /></div> : null}
      </div>
    </div>
  );
}

export function MaterialLabel({ data, opts, wMm, hMm, refAttr }: { data: MaterialData; opts: LabelOptions; wMm: number; hMm: number; refAttr?: string }) {
  const { m, style } = styleFor(wMm, hMm, opts.lang);
  const f = opts.fields;
  const lang = opts.lang;
  const cls = `pl-label pl-${m.cls} pl-lang-${lang.toLowerCase()} pl-record`;
  const dir = lang === "AR" ? "rtl" : "ltr";
  const compact = m.cls === "compact";
  const sideMain: "en" | "ar" = lang === "AR" ? "ar" : "en";
  const unit = UNIT[data.unit] ?? [data.unit, data.unit];
  const barH = compact ? Math.min(11, m.innerHeight * 0.45) : m.cls === "large" ? 22 : Math.min(12, m.innerHeight * 0.22);
  const cells: Cell[] = [];
  if (!compact) {
    for (const x of f) {
      if (!x.show) continue;
      if (x.key === "category") cells.push({ key: "category", v: <Val v={sideMain === "ar" ? data.category.ar ?? data.category.en : data.category.en ?? data.category.ar} side={sideMain} /> });
      if (x.key === "unit") cells.push({ key: "unit", v: lang === "BI" ? <>{unit[1]} · <span lang="ar">{unit[0]}</span></> : sideMain === "ar" ? unit[0] : unit[1] });
      if (x.key === "materialCode") cells.push({ key: "materialCode", v: <bdi dir="ltr" className="pl-mono">{data.itemCode}</bdi> });
    }
  }
  const logo = !compact && isShown(f, "logo") && logoPrints(m.cls, wMm, true);
  return (
    <div className={cls} style={style} dir={dir} data-label-ref={refAttr} data-testid="print-label" data-kind="material">
      <div className="pl-inner">
        {compact ? (isShown(f, "name") ? <Names name={data.name} lang={lang} /> : null)
          : isShown(f, "name") || logo ? <Head name={data.name} lang={lang} logo={logo} logoMm={Math.max(m.t.logoMm, 8)} /> : null}
        <Cells cells={cells} lang={lang} />
        {isShown(f, "barcode") ? <div className={`pl-codes${compact ? " is-compact" : ""}`}><Barcode value={data.code} widthMm={Math.min(m.inner, compact ? m.inner : 64)} heightMm={barH} testId="pl-barcode" /></div> : null}
      </div>
    </div>
  );
}
