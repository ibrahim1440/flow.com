"use client";

import { use, useEffect, useState } from "react";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet, type DocRow } from "@/components/print/document/DocumentSheet";
import { DocumentPrintPage } from "@/components/print/document/DocumentPrintPage";
import { useI18n } from "@/lib/i18n/context";
import { longDate, type DocLang } from "@/lib/print/quote-document";
import {
  ROAST_SHEET_BLANK_ROWS, batchStatusText, blankRoastSheetCells, clockRange, expectedRoastedKg, kgText, lossPercent,
  roastSheetCells, roastSheetColumns, roastSheetDocNumber, roastSheetTotals, type RoastSheetData, type RoastSheetRoaster,
} from "@/lib/print/roast-sheet";

/**
 * «ورقة التحميص» — the printed roast sheet (feat/print-docs). No Figma frame exists for it: the page
 * follows the quotation document's A4 layout (QP-05 1295:987) through DocumentSheet.
 *
 *   ?date=YYYY-MM-DD[&roaster=<id>]  the day of «جدول التحميص» («طباعة ورقة التحميص» on the day board):
 *                                    one sheet per production roaster, or the one picked;
 *   ?batch=<id>                      one recorded batch («طباعة» on Production → Batches);
 *   ?lang=ar|en                      the document's language (default: the interface's).
 *
 * Not the data-entry «Record roast sheet» (production/_parts/roast-sheet.tsx): this page writes
 * nothing. Its data endpoint (/api/print/documents/roast-sheet) follows the document gate.
 */
type Seller = { nameAr: string | null; nameEn: string | null; addressAr: string | null; addressEn: string | null; phone: string | null; crNumber: string | null };
type Data = RoastSheetData & { seller: Seller };
type Search = { date?: string; roaster?: string; batch?: string; lang?: string };

const NO_SEARCH: Promise<Search> = Promise.resolve({});

export default function RoastSheetPrintPage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  const { lang } = useI18n();
  const ar = lang === "ar";
  const docLang: DocLang = sp.lang === "en" || sp.lang === "ar" ? sp.lang : lang === "en" ? "en" : "ar";
  const batch = sp.batch ?? null;
  const query = new URLSearchParams();
  if (batch) query.set("batch", batch);
  else {
    if (sp.date) query.set("date", sp.date);
    if (sp.roaster) query.set("roaster", sp.roaster);
  }
  const href = (over: Record<string, string | null>) => {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(over)) if (v === null) q.delete(k); else q.set(k, v);
    return `/dashboard/production/schedule/print?${q.toString()}`;
  };

  useD21Title(ar ? "ورقة التحميص" : "Roast sheet");
  useD21Phone({ title: ar ? "ورقة التحميص" : "Roast sheet", back: batch ? "/dashboard/production?tab=batches" : `/dashboard/production/schedule${sp.date ? `?date=${sp.date}` : ""}` });

  return (
    <DocumentPrintPage
      testId="roast-sheet-page"
      back={batch
        ? { href: "/dashboard/production?tab=batches", label: ar ? "الدفعات" : "Batches" }
        : { href: `/dashboard/production/schedule${sp.date ? `?date=${sp.date}` : ""}`, label: ar ? "جدول التحميص" : "Roasting schedule" }}
      title={ar ? "ورقة التحميص" : "Roast sheet"}
      docLang={docLang}
      otherLanguageHref={href({ lang: docLang === "ar" ? "en" : "ar" })}
    >
      {() => <RoastSheet batch={batch} date={sp.date ?? null} roaster={sp.roaster ?? null} docLang={docLang} pickHref={(id) => href({ roaster: id })} />}
    </DocumentPrintPage>
  );
}

function RoastSheet({ batch, date, roaster, docLang, pickHref }: { batch: string | null; date: string | null; roaster: string | null; docLang: DocLang; pickHref: (id: string | null) => string }) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    const url = batch ? `/api/print/documents/roast-sheet?batchId=${encodeURIComponent(batch)}` : `/api/print/documents/roast-sheet${date ? `?date=${encodeURIComponent(date)}` : ""}`;
    fetch(url, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (off) return;
      if (r.ok) { setData(b as Data); setError(null); }
      else setError((ar ? b.errorAr : b.error) || b.error || (ar ? "تعذّر تحميل ورقة التحميص." : "Could not load the roast sheet."));
    }).catch(() => { if (!off) setError(ar ? "تعذّر الاتصال بالخادم." : "Could not reach the server."); });
    return () => { off = true; };
  }, [batch, date, ar]);

  if (error) return <p className="notice er dsh-err" role="alert" data-testid="alert-error">{error}</p>;
  if (!data) return <p className="dsh-wrap dsh-wait" role="status">{ar ? "جارٍ التحميل…" : "Loading…"}</p>;

  const shown = roaster ? data.roasters.filter((r) => r.id === roaster) : data.roasters;
  return (
    <>
      {data.mode === "day" && data.roasters.length > 1 ? (
        <div className="dsh-bar">
          <label htmlFor="rs-roaster" className="ttl">{ar ? "المحمصة" : "Roaster"}</label>
          <select
            id="rs-roaster" data-testid="roast-sheet-roaster" value={roaster ?? ""}
            onChange={(e) => { window.location.assign(pickHref(e.target.value || null)); }}
          >
            <option value="">{ar ? "كل المحامص (ورقة لكل محمصة)" : "All roasters (one sheet each)"}</option>
            {data.roasters.map((r) => <option key={r.id ?? "none"} value={r.id ?? ""}>{r.name ?? "—"}</option>)}
          </select>
        </div>
      ) : null}
      <div className="dsh-wrap">
        {(shown.length ? shown : [{ id: null, name: null, window: null, maintenance: [], entries: [] } as RoastSheetRoaster]).map((r, i) => (
          <RoasterSheet key={r.id ?? `n${i}`} data={data} roaster={r} lang={docLang} multi={shown.length > 1} />
        ))}
      </div>
    </>
  );
}

function RoasterSheet({ data, roaster, lang, multi }: { data: Data; roaster: RoastSheetRoaster; lang: DocLang; multi: boolean }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const s = data.seller;
  const sellerName = (ar ? s.nameAr || s.nameEn : s.nameEn || s.nameAr) || null;
  const sellerLines = [(ar ? s.addressAr || s.addressEn : s.addressEn || s.addressAr), s.phone].filter((x): x is string => !!x)
    .map((x, i) => <bdi key={i} dir={i === 1 ? "ltr" : undefined}>{x}</bdi>);
  const dayText = longDate(`${data.day}T12:00:00+03:00`, lang);
  // A figure is its own LTR run; the unit and the words around it stay in the document's direction.
  const kgOf = (v: number | null) => <><bdi dir="ltr">{kgText(v)}</bdi> {L("كغ", "kg")}</>;
  const pct = (v: number | string) => <bdi dir="ltr">{`${v}%`}</bdi>;
  const isBatch = data.mode === "batch";
  const entry = isBatch ? roaster.entries[0] ?? null : null;
  const totals = roastSheetTotals(roaster.entries);

  const metaStart: DocRow[] = [];
  const metaEnd: DocRow[] = [];
  if (isBatch && entry?.actual) {
    const a = entry.actual;
    const loss = lossPercent(a.greenKg, a.roastedKg);
    metaStart.push({ label: L("الدفعة", "Batch"), value: <bdi className="mono" dir="ltr">{a.batchNumber}</bdi>, testId: "rs-batch" });
    metaStart.push({ label: L("تاريخ التسجيل", "Recorded"), value: <>{longDate(a.recordedAt, lang)} · <bdi dir="ltr">{clockRange(a.recordedAt, null)}</bdi></> });
    metaStart.push({ label: L("القهوة", "Coffee"), value: <bdi>{ar ? entry.coffee.ar : entry.coffee.en}</bdi>, testId: "rs-coffee" });
    if (entry.greenLot) metaStart.push({ label: L("اللوت الأخضر", "Green lot"), value: <><bdi className="mono" dir="ltr">{entry.greenLot.serial}</bdi>{entry.greenLot.name ? <> · <bdi>{entry.greenLot.name}</bdi></> : null}</>, testId: "rs-lot" });
    if (roaster.name) metaStart.push({ label: L("المحمصة", "Roaster"), value: <bdi>{roaster.name}</bdi> });
    metaStart.push({ label: L("الغرض", "For"), value: entry.orderNumber !== null ? <>{L("طلب", "Order")} <bdi dir="ltr">#{entry.orderNumber}</bdi></> : entry.purpose === "STOCK" ? L("للمخزون", "Stock") : L("للطلبات", "Orders") });
    metaEnd.push({ label: L("أخضر فعلي", "Actual green"), value: kgOf(a.greenKg), testId: "rs-actual-green" });
    metaEnd.push({ label: L("محمص فعلي", "Actual roasted"), value: kgOf(a.roastedKg), testId: "rs-actual-roasted" });
    metaEnd.push({ label: L("الفاقد", "Loss"), value: <>{loss === null ? "—" : pct(loss.toFixed(1))}{entry.expectedLossPct !== null ? <> · {L("المتوقع", "expected")} {pct(entry.expectedLossPct)}</> : null}</>, testId: "rs-loss" });
    if (entry.plannedGreenKg !== null) metaEnd.push({ label: L("أخضر مخطط", "Planned green"), value: <>{kgOf(entry.plannedGreenKg)} · <bdi dir="ltr">{clockRange(entry.startsAt, entry.endsAt)}</bdi></> });
    metaEnd.push({ label: L("حالة الدفعة", "Batch status"), value: batchStatusText(a.batchStatus, lang) });
    if (a.roastProfile) metaEnd.push({ label: L("ملف التحميص", "Roast profile"), value: <bdi>{a.roastProfile}</bdi> });
  } else {
    metaStart.push({ label: L("اليوم", "Day"), value: dayText, testId: "rs-day" });
    if (roaster.name) metaStart.push({ label: L("المحمصة", "Roaster"), value: <bdi>{roaster.name}</bdi>, testId: "rs-roaster" });
    if (roaster.window) metaStart.push({ label: L("ساعات العمل", "Working hours"), value: <bdi dir="ltr">{clockRange(roaster.window.start, roaster.window.end)}</bdi> });
    if (roaster.maintenance.length) metaStart.push({ label: L("صيانة", "Maintenance"), value: roaster.maintenance.map((m, i) => <span key={i}>{i ? "، " : ""}<bdi>{m.title}</bdi> <bdi dir="ltr">{clockRange(m.startsAt, m.endsAt)}</bdi></span>) });
    metaEnd.push({ label: L("الخانات", "Slots"), value: <bdi dir="ltr">{totals.slots}</bdi>, testId: "rs-slots" });
    metaEnd.push({ label: L("الأخضر المخطط", "Planned green"), value: kgOf(totals.plannedGreenKg), testId: "rs-planned-total" });
    const exp = roaster.entries.reduce((acc, e) => acc + (expectedRoastedKg(e.plannedGreenKg, e.expectedLossPct) ?? 0), 0);
    if (exp > 0) metaEnd.push({ label: L("المحمص المتوقع", "Expected roasted"), value: kgOf(Math.round(exp * 100) / 100) });
    if (totals.recorded) metaEnd.push({ label: L("المسجّل", "Recorded"), value: <bdi dir="ltr">{totals.recorded} / {totals.rows}</bdi> });
  }

  const rows = roaster.entries.map((e, i) => roastSheetCells(e, i + 1, lang));
  if (!isBatch) for (let k = 0; k < ROAST_SHEET_BLANK_ROWS; k++) rows.push(blankRoastSheetCells(roaster.entries.length + k + 1));
  const docNumber = roastSheetDocNumber(data, entry);

  return (
    <DocumentSheet
      lang={lang}
      testId={isBatch ? "roast-sheet-batch" : "roast-sheet-day"}
      logo={{ src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"), width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54 }}
      seller={sellerName || sellerLines.length ? { name: sellerName, lines: sellerLines, testId: "doc-seller" } : null}
      title={{
        main: L("ورقة التحميص", "Roast sheet"),
        lines: [
          isBatch ? <>{L("دفعة مسجّلة", "Recorded batch")}</> : <>{dayText}</>,
          <span key="alt" className="alt" lang={ar ? "en" : "ar"} dir={ar ? "ltr" : "rtl"}>{ar ? "Roast sheet" : "ورقة التحميص"}</span>,
        ],
      }}
      metaStart={metaStart}
      metaEnd={metaEnd}
      columns={roastSheetColumns(lang)}
      rows={rows}
      grid
      extra={
        <section className="dsh-extra" data-testid="rs-guide">
          <p>{isBatch
            ? L("الأوزان الفعلية كما سُجّلت في النظام. اكتب زمن التحميص ووقّع.", "Actual weights as recorded in the system. Write the roast time and sign.")
            : L("اكتب الأوزان الفعلية وزمن التحميص لكل دفعة ثم وقّع. اللوت المذكور هو ما يختاره النظام اليوم؛ يُسجَّل الفعلي في النظام عبر «تسجيل دفعة» بعد التحميص. السطور الفارغة لدفعة غير مخططة.",
              "Write the actual weights and the roast time for each batch, then sign. The lot shown is the one the system picks today; the actual figures are recorded in the system («Record batch») after the roast. Blank rows are for an unplanned batch.")}</p>
        </section>
      }
      signatures={[
        { label: L("المشغّل", "Operator"), lines: [L("الاسم", "Name"), L("التوقيع", "Signature")], testId: "rs-sign-operator" },
        { label: L("المشرف", "Supervisor"), lines: [L("الاسم", "Name"), L("التوقيع", "Signature")], testId: "rs-sign-supervisor" },
      ]}
      footer={{
        legal: L("ورقة تشغيل داخلية · المخطط من جدول التحميص، والفعلي من الدفعة المسجّلة.", "Internal operating sheet · planned from the roasting schedule, actual from the recorded batch."),
        page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), // The running footer is one @page rule for the whole print: name the roaster only on a single sheet.
        after: roaster.name && !multi ? ` · ${roaster.name}` : "" },
        docNumber,
      }}
    />
  );
}
