"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import {
  useLang, Spinner, api, formatMoney, num, formatDay,
} from "../../../_components/ui";
import { useD21Title, useD21Phone } from "@/components/shell/page-context";
import { usePrintCertified } from "@/components/print/Certification";
import { PRINT_PHASE1_NOTE, QUOTATION_PDF_WHEN_PRINT_OFF } from "@/lib/print/certification";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";

/**
 * The quotation as a document.
 *
 * ── It renders the SNAPSHOT, not the live rows ──
 * An issued quotation is what the customer was sent. `QuoteLine` tracks the live catalogue,
 * so a SKU renamed next month would silently rewrite the document; `issuedSnapshot` holds
 * the lines, names and prices exactly as they were frozen at issue. A draft has no snapshot
 * and says so rather than pretending to be a document.
 *
 * ── Why there is no PDF library ──
 * Every browser prints to PDF, and the print stylesheet below is what decides how that PDF
 * looks. Adding a renderer would put a second layout in the codebase that nobody looks at
 * until a customer complains the total is in the wrong place.
 *
 * ── Layout ──
 * Built to GX A-12 (Figma 1230:139687, EN 1233:78380): a screen toolbar (number, what the current
 * version leaves out, the gated action) over an A4 sheet. Only the sheet reaches paper.
 */

type SnapshotLine = {
  position: number;
  skuCode: string | null;
  name: string | null;
  nameAr: string | null;
  description: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  gross: string;
  discountAmount: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
};

type Snapshot = {
  frozenAt: string;
  quoteNumber: string;
  revision: number;
  currency: string;
  validUntil: string;
  totals: {
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    grandTotal: string;
    effectiveDiscountPercent: string;
  };
  lines: SnapshotLine[];
};

type Quote = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: string;
  currency: string;
  validUntil: string | null;
  issuedAt: string | null;
  issuedSnapshot: Snapshot | null;
  customer: { id: string; name: string; nameAr: string | null; phone: string | null; email: string | null; address: string | null } | null;
  opportunity: { id: string; title: string; owner: { id: string; name: string } | null };
};

/**
 * What the printed document looks like.
 *
 * Kept beside the page it shapes rather than in a global sheet, where nobody would connect
 * the two while looking at a printing bug. A plain <style> element rather than styled-jsx:
 * React 19 hoists it, and it keeps this page free of a dependency question.
 */
const PRINT_CSS = `
@media print {
  /* The application chrome is not part of a customer document. */
  nav, aside, button { display: none !important; }
  a[href]:not([data-doc]) { display: none !important; }
  body { background: #fff !important; }
}
@page { margin: 16mm; }
`;
export default function QuotePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const lang = useLang();
  const ar = lang === "ar";

  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Owner decision D1: printing is out of Phase 1 (PRINT_CERTIFIED gate, unknown counts as off).
  // D1-Q (decided: strict): «Save as PDF» opens the print dialog, so with QUOTATION_PDF_WHEN_PRINT_OFF
  // false it is disabled like every other print action while printing is off; the document stays.
  const printing = usePrintCertified();
  const pdfOnly = printing !== true && QUOTATION_PDF_WHEN_PRINT_OFF;
  const actionOn = printing === true || pdfOnly;

  useEffect(() => {
    api<{ quote: Quote }>(`/api/sales/quotes/${id}`).then((res) => {
      if (res.ok) setQuote(res.data.quote);
      else setError(res.data.error ?? (ar ? "تعذّر تحميل العرض." : "Could not load the quotation."));
      setLoading(false);
    });
  }, [id, ar]);

  // The last crumb of the top bar is the quotation number, as on the quotation itself.
  useD21Title(quote?.quoteNumber);
  useD21Phone({
    title: ar ? "مستند العرض" : "Quotation document",
    sub: quote?.quoteNumber,
    back: `/dashboard/sales/quotes/${id}`,
  });

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!quote) return <div className="pg"><p className="notice er" role="alert" data-testid="alert-error">{error}</p></div>;

  const snap = quote.issuedSnapshot;
  /** Every figure on the document: Latin digits, grouped, two places; the currency is stated once. */
  const money = (v: string) => formatMoney(v);
  const issuedOn = formatDay(quote.issuedAt ?? snap?.frozenAt ?? null, lang);
  const customerName = quote.customer ? (ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name) : null;
  const contactLine = [quote.customer?.address, quote.customer?.phone].filter(Boolean);

  return (
    <div className="pg">
      {/* Screen-only chrome (A-12 toolbar). None of this appears on paper. */}
      <div className="q-doc-bar print:hidden">
        <Link href={`/dashboard/sales/quotes/${quote.id}`} className="num">{quote.quoteNumber}</Link>
        <span className="sp" />
        {snap && (
          <>
            <span className="why">
              {ar ? "بلا رقم ضريبي ولا QR في النسخة الحالية" : "No VAT number or QR in the current version"}
            </span>
            <button
              type="button"
              className="btn p"
              onClick={() => { if (actionOn) window.print(); }}
              data-testid={printing === true ? "print-quote" : "save-quote-pdf"}
              disabled={!actionOn}
            >
              {printing === true ? (ar ? "طباعة / حفظ PDF" : "Print / save as PDF") : (ar ? "حفظ كملف PDF" : "Save as PDF")}
            </button>
          </>
        )}
      </div>
      {snap && printing === false && (
        <div className="q-doc-wrap print:hidden" data-testid="print-phase1-note" style={{ marginBottom: 16 }}>
          <p className="notice">
            {ar ? PRINT_PHASE1_NOTE.ar : PRINT_PHASE1_NOTE.en}
            {" — "}
            {pdfOnly
              ? (ar
                ? "لإرسال العرض إلى العميل: «حفظ كملف PDF» ثم اختر «حفظ كـ PDF» وجهةً في النافذة."
                : "To send the quotation to the customer: «Save as PDF», then choose «Save as PDF» as the destination in the dialog.")
              : (ar ? "يعود الزر بعد اعتماد الطباعة." : "The action returns once printing is approved.")}
          </p>
        </div>
      )}

      {!snap ? (
        <div className="q-doc-wrap print:hidden">
          <p className="notice">
            {ar
              ? "لا يوجد مستند بعد: العرض ما زال مسودة. المستند يُثبَّت عند الإصدار، وهو ما يضمن أن المطبوع هو ما أُرسل للعميل فعلاً."
              : "There is no document yet: this quotation is still a draft. The document is frozen at issue, which is what makes the printed copy the thing the customer was actually sent."}
          </p>
        </div>
      ) : (
        <div className="q-doc-wrap">
          <article data-testid="quote-document" className="q-doc">
            {/* The brand logo (guideline v003 primary, olive-clay, for white paper): an <img>, so it
                reaches paper and «Save as PDF» without "print backgrounds". */}
            <div className="q-doc-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={BRAND_PRIMARY_SRC} alt={ar ? "حِقبة" : "Hiqbah"} data-testid="quote-logo"
                width={Math.round(64 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h)} height={64} />
            </div>
            <header>
              <div>
                <h1>{ar ? "عرض سعر" : "Quotation"}</h1>
                <p className="ref">
                  <bdi className="id">{snap.quoteNumber}</bdi>
                  {snap.revision > 1 && <> · {ar ? "مراجعة" : "revision"} {snap.revision}</>}
                </p>
              </div>
              <dl className="facts">
                <div>
                  <dt>{ar ? "التاريخ:" : "Issued:"}</dt>
                  <dd>{issuedOn}</dd>
                </div>
                <div>
                  <dt>{ar ? "صالح حتى:" : "Valid until:"}</dt>
                  <dd>{formatDay(snap.validUntil, lang)}</dd>
                </div>
                <div>
                  <dt>{ar ? "العملة:" : "Currency:"}</dt>
                  <dd>{ar ? "ريال سعودي (SAR)" : `Saudi riyal (${snap.currency})`}</dd>
                </div>
              </dl>
            </header>

            <section className="parties">
              <div>
                <h2>{ar ? "إلى" : "To"}</h2>
                {quote.customer ? (
                  <address>
                    <b>{customerName}</b>
                    {contactLine.length > 0 && (
                      <span className="sub" style={{ display: "block" }}>
                        {quote.customer.address}
                        {quote.customer.address && quote.customer.phone && " · "}
                        {quote.customer.phone && <bdi dir="ltr">{quote.customer.phone}</bdi>}
                      </span>
                    )}
                    {quote.customer.email && <span className="sub" style={{ display: "block" }}><bdi dir="ltr">{quote.customer.email}</bdi></span>}
                  </address>
                ) : (
                  <p style={{ margin: 0 }}>—</p>
                )}
              </div>
              <div>
                <h2>{ar ? "أعدّه" : "Prepared by"}</h2>
                <b>{quote.opportunity.owner?.name ?? "—"}</b>
              </div>
            </section>

            {/* On paper the table has the page's full width; on a phone it does not, so it
                scrolls inside its own box rather than dragging the document sideways. */}
            <div className="q-doc-table">
              <table>
                <thead>
                  <tr>
                    <th>{ar ? "البند" : "Item"}</th>
                    <th className="num">{ar ? "الكمية" : "Qty"}</th>
                    <th className="num">{ar ? "السعر" : "Price"}</th>
                    <th className="num">{ar ? "خصم" : "Disc."}</th>
                    <th className="num">{ar ? "ضريبة" : "Tax"}</th>
                    <th className="num">{ar ? "الإجمالي" : "Total"}</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.lines.map((l) => (
                    <tr key={l.position}>
                      <td className="item">
                        {/* The name as it stood when the offer was made. */}
                        <b>{(ar ? l.nameAr : null) ?? l.name ?? l.description ?? "—"}</b>
                        {l.skuCode && <span className="id">{l.skuCode}</span>}
                      </td>
                      <td className="num">{num(Number(l.quantity), lang)}</td>
                      <td className="num">{money(l.unitPrice)}</td>
                      <td className="num">{Number(l.discountAmount) > 0 ? money(l.discountAmount) : "—"}</td>
                      <td className="num">{Number(l.lineTax) > 0 ? money(l.lineTax) : "—"}</td>
                      <td className="num">{money(l.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="tot">
              <Row label={ar ? "الإجمالي قبل الخصم" : "Subtotal"} value={money(snap.totals.subtotal)} />
              {Number(snap.totals.discountTotal) > 0 && (
                <Row label={ar ? "الخصم" : "Discount"} value={`-${money(snap.totals.discountTotal)}`} />
              )}
              {/* The base VAT is charged on. A tax document that jumps from a subtotal to a
                  tax figure leaves the customer to work out which number it was 15% of. */}
              <Row
                label={ar ? "الوعاء الخاضع للضريبة" : "Taxable base"}
                value={money((Number(snap.totals.subtotal) - Number(snap.totals.discountTotal)).toFixed(2))}
              />
              <Row label={ar ? "ضريبة القيمة المضافة" : "VAT"} value={money(snap.totals.taxTotal)} />
              <dt className="due">{ar ? "الإجمالي المستحق" : "Total due"}</dt>
              <dd className="due">{money(snap.totals.grandTotal)}</dd>
            </dl>

            <div className="terms">
              <p>
                {ar
                  ? "الشروط: الأسعار بالريال السعودي وتشمل التسليم داخل المدينة. العرض صالح حتى التاريخ المذكور. تُحتسب ضريبة القيمة المضافة وفق النظام السعودي."
                  : "Terms: prices are in Saudi riyals and include delivery within the city. The offer holds until the date above. VAT is charged under the Saudi regime."}
              </p>
              <p>
                {ar
                  ? `الأسعار مثبّتة كما صدرت في ${issuedOn} وتبقى سارية حتى ${formatDay(snap.validUntil, lang)}.`
                  : `Prices are as issued on ${issuedOn} and hold until ${formatDay(snap.validUntil, lang)}.`}
              </p>
              {quote.status === "SUPERSEDED" && (
                <p className="er">
                  {ar
                    ? "استُبدل هذا العرض بمراجعة أحدث. لا تُرسله إلى العميل."
                    : "This quotation has been superseded by a later revision. Do not send it to the customer."}
                </p>
              )}
            </div>

            {/* The two signature blocks the design ends on: a quotation is signed back. */}
            <div className="sign">
              <div>{ar ? "عن المؤسسة" : "For the company"}</div>
              <div>{ar ? "توقيع العميل" : "Customer signature"}</div>
            </div>
          </article>
        </div>
      )}

{/* The print rules, kept with the document they shape rather than in a global sheet where
    nobody would connect the two. A plain <style> element rather than styled-jsx: React 19
    hoists it, and it keeps this page free of a dependency question nobody wants to answer
    while looking at a printing bug. */}
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
