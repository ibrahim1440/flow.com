"use client";

// Accounting A5 — a financial statement or the VAT return working paper on the shared A4 document (DocumentSheet; the
// same print / «Save as PDF» path as the invoice), behind the document gate (PRINT_DOCUMENTS_ENABLED). ?report=income|
// balance|cashflow|vat plus the report's own query; ?lang=ar|en.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet, type DocRow } from "@/components/print/document/DocumentSheet";
import { DocumentPrintPage } from "@/components/print/document/DocumentPrintPage";
import { useI18n } from "@/lib/i18n/context";
import type { DocCell, DocColumn, DocLang } from "@/lib/print/quote-document";

type Section = { key: string; ar: string; en: string; lines: { code: string; name: string; nameEn: string; amounts: string[] }[]; totals: string[] };
type Payload = { report: "income" | "balance" | "cashflow" | "vat"; seller: { name?: string | null; nameEn?: string | null; vatNumber?: string | null; crNumber?: string | null }; printedAt: string; data: Record<string, unknown> };

const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const m = (v: unknown) => (v === null || v === undefined || v === "" ? "" : nf.format(Number(v)));
const TITLES: Record<Payload["report"], [string, string]> = { income: ["قائمة الدخل", "Income statement"], balance: ["قائمة المركز المالي", "Statement of financial position"], cashflow: ["قائمة التدفقات النقدية", "Statement of cash flows"], vat: ["إقرار ضريبة القيمة المضافة · ورقة عمل", "VAT return · working paper"] };

function body(p: Payload, lang: DocLang): { columns: DocColumn[]; rows: DocCell[][]; meta: DocRow[] } {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const d = p.data as Record<string, never>;
  if (p.report === "income" || p.report === "balance") {
    const cols = (d.columns as { from?: string; to?: string; asOf?: string }[]);
    const head = cols.map((c, i) => ({ key: `c${i}`, label: c.asOf ? `${L("كما في", "As of")} ${c.asOf}` : `${c.from} – ${c.to}`, numeric: true }));
    const rows: DocCell[][] = [];
    for (const s of d.sections as Section[]) {
      rows.push([{ main: L(s.ar, s.en) }, ...cols.map(() => ({ main: "" }))]);
      for (const l of s.lines) rows.push([{ main: `${l.code} ${ar ? l.name : l.nameEn}` }, ...l.amounts.map((a) => ({ main: m(a) }))]);
      rows.push([{ main: L(`مجموع ${s.ar}`, `Total ${s.en.toLowerCase()}`) }, ...s.totals.map((a) => ({ main: m(a) }))]);
    }
    const t = d.totals as Record<string, (string | null)[]>;
    const add = (label: string, v: (string | null)[] | undefined, pct = false) => v && rows.push([{ main: label }, ...v.map((x) => ({ main: pct ? (x === null ? "—" : `${x}%`) : m(x) }))]);
    if (p.report === "income") { add(L("مجمل الربح", "Gross profit"), t.grossProfit); add(L("هامش مجمل الربح", "Gross margin"), t.grossMarginPct, true); add(L("الربح التشغيلي", "Operating profit"), t.operatingProfit); add(L("صافي الربح", "Net profit"), t.netProfit); }
    else { const e = d.earnings as Record<string, string[]>; add(L("أرباح السنة الحالية غير المقفلة", "Current-year profit not closed"), e.currentYear); add(L("مجموع الأصول", "Total assets"), t.assets); add(L("مجموع الالتزامات وحقوق الملكية", "Total liabilities and equity"), t.liabilitiesAndEquity); }
    return { columns: [{ key: "a", label: L("البند", "Item"), numeric: false }, ...head], rows, meta: [{ label: L("الأساس", "Basis"), value: L("القيود المرحّلة · أساس الاستحقاق · ر.س", "Posted entries · accrual basis · SAR") }] };
  }
  if (p.report === "cashflow") {
    const rows: DocCell[][] = [[{ main: L("صافي الربح", "Net profit") }, { main: m(d.netProfit) }]];
    for (const [k, a, e] of [["nonCash", "بنود غير نقدية", "Non-cash items"], ["workingCapital", "تغيرات رأس المال العامل", "Working capital"]] as const) for (const l of (d[k] as { lines: { code: string; name: string; amount: string }[] }).lines) rows.push([{ main: `${L(a, e)}: ${l.code} ${l.name}` }, { main: m(l.amount) }]);
    rows.push([{ main: L("صافي النقد من الأنشطة التشغيلية", "Net cash from operating activities") }, { main: m(d.operating) }]);
    rows.push([{ main: L("صافي النقد من الأنشطة الاستثمارية", "Net cash from investing activities") }, { main: m((d.investing as { total: string }).total) }]);
    rows.push([{ main: L("صافي النقد من الأنشطة التمويلية", "Net cash from financing activities") }, { main: m((d.financing as { total: string }).total) }]);
    for (const [k, a, e] of [["netChange", "صافي التغير في النقد", "Net change in cash"], ["cashStart", "النقد أول المدة", "Cash at the start"], ["cashEnd", "النقد آخر المدة", "Cash at the end"], ["difference", "فرق المطابقة", "Reconciling difference"]] as const) rows.push([{ main: L(a, e) }, { main: m(d[k]) }]);
    return { columns: [{ key: "a", label: L("البند", "Item"), numeric: false }, { key: "v", label: `${d.from} – ${d.to}`, numeric: true }], rows, meta: [{ label: L("الطريقة", "Method"), value: L("غير المباشرة", "Indirect") }] };
  }
  const boxes = [...(d.sales as { box: number; ar: string; en: string; amount: string; adjustment: string; vat: string }[]), ...(d.purchases as { box: number; ar: string; en: string; amount: string; adjustment: string; vat: string }[])];
  const s = d.summary as Record<string, string>;
  const rows: DocCell[][] = boxes.map((b) => [{ main: String(b.box) }, { main: L(b.ar, b.en) }, { main: m(b.amount) }, { main: m(b.adjustment) }, { main: m(b.vat) }]);
  rows.push([{ main: "13" }, { main: L("إجمالي الضريبة المستحقة", "Total VAT due") }, { main: "" }, { main: "" }, { main: m(s.totalVatDue) }]);
  rows.push([{ main: "16" }, { main: L("صافي الضريبة المستحقة", "Net VAT due") }, { main: "" }, { main: "" }, { main: m(s.netVatDue) }]);
  const disc = d.disclaimer as { ar: string; en: string };
  return {
    columns: [{ key: "b", label: L("الخانة", "Box"), numeric: false, muted: true }, { key: "d", label: L("البيان", "Description"), numeric: false }, { key: "a", label: L("المبلغ", "Amount"), numeric: true }, { key: "j", label: L("التعديلات", "Adjustments"), numeric: true }, { key: "v", label: L("الضريبة", "VAT"), numeric: true }],
    rows, meta: [{ label: L("الفترة", "Period"), value: `${d.year}-Q${d.quarter} · ${d.from} – ${d.to}` }, { label: L("تنبيه", "Note"), value: L(disc.ar, disc.en) }],
  };
}

function Doc({ lang }: { lang: DocLang }) {
  const sp = useSearchParams();
  const { lang: ui } = useI18n();
  const [p, setP] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = sp.toString();
  useEffect(() => {
    let off = false;
    fetch(`/api/print/documents/statement?${q}`, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (off) return;
      if (r.ok) setP(b as Payload); else setError((ui === "ar" ? b.error || b.errorAr : b.errorEn || b.error) || "Error");
    }).catch(() => { if (!off) setError(ui === "ar" ? "تعذّر الاتصال بالخادم." : "Could not reach the server."); });
    return () => { off = true; };
  }, [q, ui]);
  if (error) return <p className="notice er dsh-err" role="alert" data-testid="alert-error">{error}</p>;
  if (!p) return <p className="dsh-wrap dsh-wait" role="status">{ui === "ar" ? "جارٍ التحميل…" : "Loading…"}</p>;
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const b = body(p, lang);
  const [ta, te] = TITLES[p.report];
  const sellerName = (ar ? p.seller.name || p.seller.nameEn : p.seller.nameEn || p.seller.name) || null;
  return (
    <div className="dsh-wrap">
      <DocumentSheet lang={lang} testId="statement-document"
        logo={{ src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"), width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54 }}
        seller={{ name: sellerName, lines: [p.seller.vatNumber && <>{L("الرقم الضريبي ", "VAT No. ")}<bdi dir="ltr">{p.seller.vatNumber}</bdi></>, p.seller.crNumber && <>{L("الرقم الوطني الموحد ", "Unified No. ")}<bdi dir="ltr">{p.seller.crNumber}</bdi></>].filter(Boolean) }}
        title={{ main: L(ta, te), lines: [<span key="alt" className="alt" lang={ar ? "en" : "ar"} dir={ar ? "ltr" : "rtl"}>{ar ? te : ta}</span>] }}
        metaStart={b.meta} metaEnd={[{ label: L("طُبع", "Printed"), value: <bdi dir="ltr">{new Date(p.printedAt).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" })}</bdi> }]}
        columns={b.columns} rows={b.rows}
        footer={{ legal: L("قائمة داخلية من دفاتر النظام — غير مدققة", "Internal statement from the system's books — unaudited"), page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), after: "" }, docNumber: L(ta, te) }}
      />
    </div>
  );
}

function PrintPage() {
  const sp = useSearchParams();
  const { lang } = useI18n();
  const ar = lang === "ar";
  const docLang: DocLang = sp.get("lang") === "en" || sp.get("lang") === "ar" ? (sp.get("lang") as DocLang) : ar ? "ar" : "en";
  useD21Title(ar ? "طباعة القائمة" : "Print statement");
  const back = sp.get("report") === "vat" ? "/dashboard/accounting/tax" : `/dashboard/accounting/reports?view=${sp.get("report") ?? "income"}`;
  useD21Phone({ title: ar ? "طباعة القائمة" : "Print statement", back });
  const other = new URLSearchParams(sp.toString()); other.set("lang", docLang === "ar" ? "en" : "ar");
  return (
    <DocumentPrintPage testId="statement-print-page" back={{ href: back, label: ar ? "التقارير" : "Reports" }} title={ar ? "طباعة القائمة" : "Print statement"} docLang={docLang} otherLanguageHref={`/dashboard/accounting/reports/print?${other}`}>
      {() => <Doc lang={docLang} />}
    </DocumentPrintPage>
  );
}

export default function StatementPrint() {
  return <Suspense fallback={null}><PrintPage /></Suspense>;
}
