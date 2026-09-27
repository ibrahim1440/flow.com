"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import {
  useLang, Alert, Spinner, Button, api, moneyText, num, formatDay,
} from "../../../_components/ui";

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
 * PROVISIONAL INTERFACE — the banner is deliberately screen-only; a customer document does
 * not carry our internal review notes.
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

  useEffect(() => {
    api<{ quote: Quote }>(`/api/sales/quotes/${id}`).then((res) => {
      if (res.ok) setQuote(res.data.quote);
      else setError(res.data.error ?? (ar ? "تعذّر تحميل العرض." : "Could not load the quotation."));
      setLoading(false);
    });
  }, [id, ar]);

  if (loading) return <Spinner />;
  if (!quote) return <Alert kind="error">{error}</Alert>;

  const snap = quote.issuedSnapshot;
  /** Every figure on the document, in the reader's own numerals and currency word. */
  const money = (v: string) => moneyText(v, quote.currency, lang);

  return (
    <div className="space-y-4">
      {/* Screen-only chrome. None of this appears on paper. */}
      <div className="print:hidden flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/dashboard/sales/quotes/${quote.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-bold text-oo-text-secondary hover:text-oo-action-primary"
        >
          <ArrowLeft size={15} className="rtl:rotate-180" aria-hidden />
          {quote.quoteNumber}
        </Link>
        {snap && (
          <Button onClick={() => window.print()} testId="print-quote">
            <Printer size={15} aria-hidden /> {ar ? "طباعة / حفظ PDF" : "Print / save as PDF"}
          </Button>
        )}
      </div>

      {!snap ? (
        <div className="print:hidden">
          <Alert kind="info">
            {ar
              ? "لا يوجد مستند بعد: العرض ما زال مسودة. المستند يُثبَّت عند الإصدار، وهو ما يضمن أن المطبوع هو ما أُرسل للعميل فعلاً."
              : "There is no document yet: this quotation is still a draft. The document is frozen at issue, which is what makes the printed copy the thing the customer was actually sent."}
          </Alert>
        </div>
      ) : (
        <article
          data-testid="quote-document"
          className="bg-oo-bg-default text-oo-text-primary rounded-2xl border border-oo-border-default p-8 print:border-0 print:rounded-none print:p-0"
        >
          <header className="flex items-start justify-between gap-6 flex-wrap border-b-2 border-oo-text-primary pb-4 mb-6">
            <div>
              <h1 className="text-2xl font-extrabold">{ar ? "عرض سعر" : "Quotation"}</h1>
              <p className="text-sm font-bold mt-1 tabular-nums">
                {snap.quoteNumber}
                {snap.revision > 1 && (
                  <span className="text-oo-text-secondary">
                    {" "}
                    · {ar ? "مراجعة" : "revision"} {snap.revision}
                  </span>
                )}
              </p>
            </div>
            <dl className="text-xs space-y-0.5 text-end">
              <div>
                <dt className="inline font-bold text-oo-text-secondary">{ar ? "التاريخ: " : "Issued: "}</dt>
                <dd className="inline">{formatDay(quote.issuedAt ?? snap.frozenAt, lang)}</dd>
              </div>
              <div>
                <dt className="inline font-bold text-oo-text-secondary">{ar ? "صالح حتى: " : "Valid until: "}</dt>
                <dd className="inline">{formatDay(snap.validUntil, lang)}</dd>
              </div>
              <div>
                <dt className="inline font-bold text-oo-text-secondary">{ar ? "العملة: " : "Currency: "}</dt>
                <dd className="inline">{ar ? "ريال سعودي (SAR)" : snap.currency}</dd>
              </div>
            </dl>
          </header>

          <section className="grid sm:grid-cols-2 gap-6 mb-6 text-sm">
            <div>
              <h2 className="text-[11px] uppercase font-bold text-oo-text-muted tracking-wide mb-1">
                {ar ? "إلى" : "For"}
              </h2>
              {quote.customer ? (
                <address className="not-italic">
                  <p className="font-bold">{ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name}</p>
                  {quote.customer.address && <p className="text-oo-text-secondary">{quote.customer.address}</p>}
                  {quote.customer.phone && <p className="text-oo-text-secondary tabular-nums" dir="ltr">{quote.customer.phone}</p>}
                  {quote.customer.email && <p className="text-oo-text-secondary" dir="ltr">{quote.customer.email}</p>}
                </address>
              ) : (
                <p className="text-oo-text-muted">—</p>
              )}
            </div>
            <div className="sm:text-end">
              <h2 className="text-[11px] uppercase font-bold text-oo-text-muted tracking-wide mb-1">
                {ar ? "جهة الاتصال" : "Prepared by"}
              </h2>
              <p className="font-bold">{quote.opportunity.owner?.name ?? "—"}</p>
            </div>
          </section>

          {/* On paper the table has the page's full width; on a phone it does not, so it
              scrolls inside its own box rather than dragging the document sideways. */}
          <div className="mb-6 overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b-2 border-oo-text-primary text-[11px] uppercase font-bold text-oo-text-secondary">
                <th className="pe-4 text-start py-2">{ar ? "البند" : "Item"}</th>
                <th className="pe-4 text-end py-2">{ar ? "الكمية" : "Qty"}</th>
                <th className="pe-4 text-end py-2">{ar ? "السعر" : "Unit price"}</th>
                <th className="pe-4 text-end py-2">{ar ? "خصم" : "Disc"}</th>
                <th className="pe-4 text-end py-2">{ar ? "ضريبة" : "Tax"}</th>
                <th className="pe-4 text-end py-2">{ar ? "الإجمالي" : "Total"}</th>
              </tr>
            </thead>
            <tbody>
              {snap.lines.map((l) => (
                <tr key={l.position} className="border-b border-oo-border-default align-top">
                  <td className="pe-4 py-2.5">
                    {/* The name as it stood when the offer was made. */}
                    <span className="font-semibold">
                      {(ar ? l.nameAr : null) ?? l.name ?? l.description ?? "—"}
                    </span>
                    {l.skuCode && (
                      <span className="block text-[11px] text-oo-text-muted font-mono">{l.skuCode}</span>
                    )}
                  </td>
                  <td className="pe-4 py-2.5 text-end tabular-nums">
                    {num(Number(l.quantity), lang)} <span className="text-[10px] text-oo-text-muted">{l.unit}</span>
                  </td>
                  <td className="pe-4 py-2.5 text-end tabular-nums">{money(l.unitPrice)}</td>
                  <td className="pe-4 py-2.5 text-end tabular-nums">
                    {Number(l.discountAmount) > 0 ? money(l.discountAmount) : "—"}
                  </td>
                  <td className="pe-4 py-2.5 text-end tabular-nums">
                    {Number(l.lineTax) > 0 ? money(l.lineTax) : "—"}
                  </td>
                  <td className="pe-4 py-2.5 text-end tabular-nums font-bold">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="flex justify-end">
            <dl className="w-full sm:w-72 space-y-1.5 text-sm">
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
              <Row
                label={ar ? "ضريبة القيمة المضافة" : "VAT"}
                value={money(snap.totals.taxTotal)}
              />
              <div className="flex items-baseline justify-between gap-3 border-t-2 border-oo-text-primary pt-2 mt-1">
                <dt className="font-extrabold">{ar ? "الإجمالي المستحق" : "Total due"}</dt>
                <dd className="font-extrabold tabular-nums text-lg">
                  {money(snap.totals.grandTotal)}
                </dd>
              </div>
            </dl>
          </div>

          <footer className="mt-8 pt-4 border-t border-oo-border-default text-[11px] text-oo-text-secondary leading-relaxed">
            <p>
              {ar
                ? `هذه الأسعار مثبّتة كما صدرت في ${formatDay(quote.issuedAt ?? snap.frozenAt, lang)} وتبقى سارية حتى ${formatDay(snap.validUntil, lang)}.`
                : `These prices are as issued on ${formatDay(quote.issuedAt ?? snap.frozenAt, lang)} and hold until ${formatDay(snap.validUntil, lang)}.`}
            </p>
            {quote.status === "SUPERSEDED" && (
              <p className="font-bold text-oo-status-rejected mt-1">
                {ar
                  ? "استُبدل هذا العرض بمراجعة أحدث. لا تُرسله إلى العميل."
                  : "This quotation has been superseded by a later revision. Do not send it to the customer."}
              </p>
            )}
            <p className="mt-2">
              {ar
                ? "الشروط: الأسعار بالريال السعودي وتشمل التسليم داخل المدينة. العرض صالح حتى التاريخ المذكور. تُحتسب ضريبة القيمة المضافة وفق النظام السعودي."
                : "Terms: prices are in Saudi riyals and include delivery within the city. The offer holds until the date above. VAT is charged under the Saudi regime."}
            </p>

            {/* The two signature blocks the design ends on: a quotation is signed back. */}
            <div className="mt-8 grid grid-cols-2 gap-10">
              {[ar ? "عن المؤسسة" : "For the company", ar ? "توقيع العميل" : "Customer signature"].map((l) => (
                <div key={l}>
                  <p className="text-oo-text-secondary">{l}</p>
                  <div className="mt-8 border-t border-oo-border-strong" />
                </div>
              ))}
            </div>
          </footer>
        </article>
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-oo-text-secondary">{label}</dt>
      <dd className="tabular-nums font-semibold">{value}</dd>
    </div>
  );
}
