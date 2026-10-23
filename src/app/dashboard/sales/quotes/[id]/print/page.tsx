"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useLang, Spinner, api, formatMoney, QUOTE_STATUS_SPECS } from "../../../_components/ui";
import { useD21Title, useD21Phone } from "@/components/shell/page-context";
import { usePrintDocuments } from "@/components/print/Certification";
import { PRINT_PHASE1_NOTE, QUOTATION_PDF_WHEN_PRINT_OFF } from "@/lib/print/certification";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet, type DocRow, type DocTotal } from "@/components/print/document/DocumentSheet";
import {
  formatIban, formatPercent, longDate, quoteDocumentNotice, quoteLineCells, quoteLineColumns, uniformTaxRate,
  type DocLang, type QuoteDocLine,
} from "@/lib/print/quote-document";

/**
 * The quotation as a document (Figma QP-05 1295:987; the draft QP-03 1295:754; English 1373:791).
 *
 * ── An issued quotation renders its SNAPSHOT, not the live rows ──
 * An issued quotation is what the customer was sent. `QuoteLine` tracks the live catalogue,
 * so a SKU renamed next month would silently rewrite the document; `issuedSnapshot` holds
 * the lines, names, prices, parties and bank details exactly as they were frozen at issue.
 *
 * ── A draft renders its saved lines, marked «مسودة — غير صادر» ──
 * Owner decision D-3: a draft may be previewed and printed with a prominent draft banner and the
 * draft status in the footer. Printing does not issue it, does not pass the discount approval
 * and does not change its status. Its figures are the server's saved ones
 * (GET …/[id] → liveDocument), the same the screen's totals show; nothing is recomputed here.
 *
 * ── Why there is no PDF library ──
 * Every browser prints to PDF, and the print stylesheet (DocumentSheet) is what decides how that
 * PDF looks. The sheet on screen is the same component, so the preview is the document.
 *
 * ── Language ──
 * The document follows the user's language; `?lang=en` / `?lang=ar` prints it in the other one
 * (an English quotation for a customer who reads English), without changing the app's language.
 */

type Seller = {
  sellerLegalNameAr: string | null; sellerLegalNameEn: string | null; sellerAddressAr: string | null;
  sellerAddressEn: string | null; sellerVatNumber: string | null; sellerCrNumber: string | null; sellerPhone: string | null;
  /** Since the bank transfer details: absent on snapshots frozen before them. */
  sellerBankName?: string | null; sellerBankAccountName?: string | null; sellerIban?: string | null;
};
type DocCustomer = {
  name: string; nameAr: string | null; phone: string | null; email: string | null; address: string | null;
  city?: string | null; vatNumber?: string | null; commercialRegNo?: string | null;
};

type Totals = {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  effectiveDiscountPercent: string;
};

type Snapshot = {
  frozenAt: string;
  quoteNumber: string;
  revision: number;
  currency: string;
  validUntil: string;
  totals: Totals;
  lines: QuoteDocLine[];
  /** Since batch "Sales" track A: frozen at issue. Absent on older snapshots. */
  customerNotes?: string | null;
  customer?: DocCustomer | null;
  seller?: Seller | null;
};

type Quote = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: string;
  currency: string;
  validUntil: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  issuedAt: string | null;
  issuedSnapshot: Snapshot | null;
  customerNotes: string | null;
  customer: ({ id: string } & DocCustomer) | null;
  opportunity: { id: string; title: string; owner: { id: string; name: string } | null };
};
type QuoteResponse = {
  quote: Quote;
  discount?: { state: string };
  liveDocument: { lines: QuoteDocLine[]; effectiveDiscountPercent: string } | null;
};

/**
 * What the application chrome does on paper: it is not part of a customer document. Kept beside
 * the page it shapes; the sheet's own print rules (page size, margins, running footer) are in
 * DocumentSheet. A plain <style> element: React 19 hoists it.
 */
const PRINT_CSS = `
@media print {
  nav, aside, button { display: none !important; }
  a[href]:not([data-doc]) { display: none !important; }
  body { background: #fff !important; }
  /* The sheet owns the page: no shell gutter around it and no canvas tint behind it (a PDF saved
     with background graphics on would otherwise show the beige canvas at the page edges). */
  .d21, .d21-app, .d21-main, .d21-sheet, .d21-body { background: #fff !important; }
  .pg { padding: 0 !important; background: #fff !important; }
}
`;

/** For a caller that hands no search params (the UI harness). One promise, so `use` settles once. */
const NO_SEARCH: Promise<{ lang?: string }> = Promise.resolve({});

export default function QuotePrintPage({
  params, searchParams = NO_SEARCH,
}: { params: Promise<{ id: string }>; searchParams?: Promise<{ lang?: string }> }) {
  const { id } = use(params);
  const { lang: langParam } = use(searchParams);
  const uiLang = useLang();
  const ar = uiLang === "ar";
  const docLang: DocLang = langParam === "en" || langParam === "ar" ? langParam : uiLang;

  const [data, setData] = useState<QuoteResponse | null>(null);
  const [liveSeller, setLiveSeller] = useState<Seller | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Owner decision D1: printing is out of Phase 1 (document-printing gate (PRINT_DOCUMENTS_ENABLED), unknown counts as off).
  // D1-Q (decided: strict): «Save as PDF» opens the print dialog, so with QUOTATION_PDF_WHEN_PRINT_OFF
  // false it is disabled like every other print action while printing is off; the document stays.
  const printing = usePrintDocuments();
  const pdfOnly = printing !== true && QUOTATION_PDF_WHEN_PRINT_OFF;
  const actionOn = printing === true || pdfOnly;

  useEffect(() => {
    api<QuoteResponse>(`/api/sales/quotes/${id}`).then((res) => {
      if (res.ok) setData(res.data);
      else setError(res.data.error ?? (ar ? "تعذّر تحميل العرض." : "Could not load the quotation."));
      setLoading(false);
    });
  }, [id, ar]);
  // The seller block for a draft, and for a document issued before it was frozen into the snapshot.
  useEffect(() => {
    api<{ seller: Seller }>("/api/settings/quotation").then((res) => { if (res.ok) setLiveSeller(res.data.seller); });
  }, []);

  const quote = data?.quote ?? null;
  // The last crumb of the top bar is the quotation number, as on the quotation itself.
  useD21Title(quote?.quoteNumber);
  useD21Phone({
    title: ar ? "مستند العرض" : "Quotation document",
    sub: quote?.quoteNumber,
    back: `/dashboard/sales/quotes/${id}`,
  });

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!quote || !data) return <div className="pg"><p className="notice er" role="alert" data-testid="alert-error">{error}</p></div>;

  const snap = quote.issuedSnapshot;
  const seller: Seller | null = snap?.seller ?? liveSeller;
  const L = (a: string, e: string) => (docLang === "ar" ? a : e);
  const isDraft = !snap;
  // A snapshot frozen before the bank details existed has no such keys: those read the live
  // settings, as the seller block always did for snapshots older than it.
  const bankSource: Seller | null = snap?.seller && "sellerIban" in snap.seller ? snap.seller : liveSeller;

  return (
    <div className="pg">
      {/* Screen-only chrome (A-12 toolbar). None of this appears on paper. */}
      <div className="q-doc-bar print:hidden">
        <Link href={`/dashboard/sales/quotes/${quote.id}`} className="num">{quote.quoteNumber}</Link>
        <span className="sp" />
        <span className="why">
          {seller?.sellerVatNumber
            ? (ar ? "بلا QR (الفوترة الإلكترونية) في النسخة الحالية" : "No e-invoicing QR in the current version")
            : (ar ? "بلا رقم ضريبي ولا QR في النسخة الحالية · أضف بيانات المنشأة من الإعدادات" : "No VAT number or QR in the current version · add the company details in Settings")}
        </span>
        <Link
          href={`/dashboard/sales/quotes/${quote.id}/print?lang=${docLang === "ar" ? "en" : "ar"}`}
          className="btn" data-doc data-testid="doc-other-language"
        >
          {docLang === "ar" ? "English" : "العربية"}
        </Link>
        <button
          type="button"
          className="btn p"
          onClick={() => { if (actionOn) window.print(); }}
          data-testid={printing === true ? "print-quote" : "save-quote-pdf"}
          disabled={!actionOn}
        >
          {printing === true ? (ar ? "طباعة / حفظ PDF" : "Print / save as PDF") : (ar ? "حفظ كملف PDF" : "Save as PDF")}
        </button>
      </div>
      {printing === false && (
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

      <div className="q-doc-wrap">
        <QuoteDocument
          lang={docLang}
          quote={quote}
          snap={snap}
          live={data.liveDocument}
          discountPending={isDraft && data.discount?.state === "PENDING"}
          seller={seller}
          bank={bankSource}
          L={L}
        />
      </div>

      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
    </div>
  );
}

/**
 * The quotation → the document sheet. Every figure is read from the snapshot (issued) or the
 * saved draft (live); the sheet only lays them out.
 */
function QuoteDocument({
  lang, quote, snap, live, discountPending, seller, bank, L,
}: {
  lang: DocLang;
  quote: Quote;
  snap: Snapshot | null;
  live: QuoteResponse["liveDocument"];
  discountPending: boolean;
  seller: Seller | null;
  bank: Seller | null;
  L: (ar: string, en: string) => string;
}) {
  const ar = lang === "ar";
  const lines: QuoteDocLine[] = snap?.lines ?? live?.lines ?? [];
  const totals: Totals = snap?.totals ?? {
    subtotal: quote.subtotal, discountTotal: quote.discountTotal, taxTotal: quote.taxTotal,
    grandTotal: quote.grandTotal, effectiveDiscountPercent: live?.effectiveDiscountPercent ?? "0",
  };
  const number = snap?.quoteNumber ?? quote.quoteNumber;
  const revision = snap?.revision ?? quote.revision;
  const validUntil = snap?.validUntil ?? quote.validUntil;
  const isDraft = !snap;
  const spec = QUOTE_STATUS_SPECS[quote.status];
  const statusWord = spec ? (ar ? spec.ar : spec.en.toLowerCase()) : quote.status;
  const footStatus = isDraft ? L("مسودة — غير صادر", "Draft — not issued") : (spec ? (ar ? spec.ar : spec.en) : quote.status);

  // Parties: the snapshot's (frozen at issue) or, for a draft and older snapshots, the live ones.
  const cust: DocCustomer | null = snap?.customer ?? quote.customer;
  const customerName = cust ? (ar ? (cust.nameAr || cust.name) : cust.name) : null;
  const place = [cust?.city, cust?.address].filter(Boolean).join(" · ");
  const sellerName = seller ? (ar ? (seller.sellerLegalNameAr || seller.sellerLegalNameEn) : (seller.sellerLegalNameEn || seller.sellerLegalNameAr)) : null;
  const sellerAddress = seller ? (ar ? (seller.sellerAddressAr || seller.sellerAddressEn) : (seller.sellerAddressEn || seller.sellerAddressAr)) : null;
  const notes = snap ? (snap.customerNotes ?? (snap.customer === undefined ? quote.customerNotes : null)) : quote.customerNotes?.trim() || null;

  const money = (v: string) => formatMoney(v);
  const vat = uniformTaxRate(lines);
  const hasDiscount = Number(totals.discountTotal) > 0;
  // The base VAT is charged on. A tax document that jumps from a subtotal to a tax figure leaves
  // the customer to work out which number it was 15% of.
  const taxable = (Number(totals.subtotal) - Number(totals.discountTotal)).toFixed(2);

  const metaStart: DocRow[] = [
    {
      label: L("رقم العرض", "Quotation number"),
      value: <><bdi className="mono" dir="ltr">{number}</bdi> · {statusWord}</>,
      testId: "doc-number",
    },
    { label: L("صالح حتى", "Valid until"), value: longDate(validUntil, lang), testId: "doc-valid-until" },
  ];
  // Gap P (P-01, P-06): an issued document states when it was issued — the snapshot's freeze time.
  const issuedOn = snap?.frozenAt ?? quote.issuedAt;
  if (!isDraft && issuedOn) metaStart.splice(1, 0, { label: L("تاريخ الإصدار", "Issued on"), value: longDate(issuedOn, lang), testId: "doc-issued-on" });
  const metaEnd: DocRow[] = [];
  if (cust) {
    metaEnd.push({ label: L("العميل", "Customer"), value: <bdi>{customerName}</bdi>, testId: "quote-customer" });
    if (place) metaEnd.push({ label: L("العنوان", "Address"), value: <bdi>{place}</bdi>, testId: "quote-customer-address" });
    if (cust.vatNumber) metaEnd.push({ label: L("الرقم الضريبي", "VAT number"), value: <bdi dir="ltr">{cust.vatNumber}</bdi>, mono: true, muted: true, testId: "quote-customer-vat" });
  } else {
    metaEnd.push({ label: L("العميل", "Customer"), value: "—", testId: "quote-customer" });
  }

  const tot: DocTotal[] = [
    { label: L("المجموع قبل الخصم", "Subtotal before discount"), value: money(totals.subtotal) },
  ];
  if (hasDiscount) {
    tot.push({
      label: <>{L("الخصم", "Discount")} <bdi>{formatPercent(totals.effectiveDiscountPercent)}</bdi></>,
      value: `−${money(totals.discountTotal)}`,
      testId: "doc-total-discount",
    });
  }
  tot.push({ label: L("الوعاء الخاضع للضريبة", "Taxable amount"), value: money(taxable) });
  tot.push({ label: <>{L("ضريبة القيمة المضافة", "VAT")}{vat && <> <bdi>{vat}</bdi></>}</>, value: money(totals.taxTotal) });
  tot.push({ label: L("الإجمالي شامل الضريبة · ر.س", "Total incl. VAT · SAR"), value: money(totals.grandTotal), grand: true, testId: "doc-grand-total" });

  const bankRows: DocRow[] = [];
  if (bank?.sellerBankName) bankRows.push({ label: L("البنك", "Bank"), value: <bdi>{bank.sellerBankName}</bdi> });
  if (bank?.sellerBankAccountName) bankRows.push({ label: L("اسم الحساب", "Account name"), value: <bdi>{bank.sellerBankAccountName}</bdi> });
  if (bank?.sellerIban) bankRows.push({ label: L("رقم الآيبان", "IBAN"), value: <bdi dir="ltr">{formatIban(bank.sellerIban)}</bdi>, mono: true, testId: "doc-iban" });

  const sellerLines = [
    sellerAddress && <bdi key="a">{sellerAddress}</bdi>,
    seller?.sellerVatNumber && <>{L("الرقم الضريبي ", "VAT number ")}<bdi dir="ltr" className="n">{seller.sellerVatNumber}</bdi></>,
  ].filter(Boolean);

  let banner: { tone: "warning" | "danger"; title: string; text: string; testId: string } | null = null;
  const notice = quoteDocumentNotice({ isDraft, status: quote.status, validUntil });
  if (notice === "draft") {
    banner = {
      tone: "warning",
      title: L("مسودة — غير صادر", "Draft — not issued"),
      text: discountPending
        ? L("نسخة مسودة للمراجعة، وليست عرض سعر صادرًا. الخصم يحتاج اعتمادًا قبل الإصدار، وقد تتغيّر الأسعار حتى ذلك.",
          "A draft for review, not an issued quotation. The discount needs approval before issue, and prices may change until then.")
        : L("نسخة مسودة للمراجعة، وليست عرض سعر صادرًا. قد تتغيّر الأسعار حتى الإصدار.",
          "A draft for review, not an issued quotation. Prices may change until it is issued."),
      testId: "doc-draft-banner",
    };
  } else if (notice === "superseded") {
    banner = {
      tone: "danger",
      title: L("مستبدَل بمراجعة أحدث", "Superseded by a later revision"),
      text: L("استُبدل هذا العرض بمراجعة أحدث. لا تُرسله إلى العميل.", "This quotation has been superseded by a later revision. Do not send it to the customer."),
      testId: "doc-superseded-banner",
    };
  } else if (notice === "expired") {
    // Gap P P-06b: an expired offer says so in red, with the date it lapsed.
    banner = {
      tone: "danger",
      title: `${L("منتهي الصلاحية منذ ", "Expired since ")}${longDate(validUntil, lang)}`,
      text: L("انتهت صلاحية هذا العرض. لا تُرسله إلى العميل عرضًا قائمًا؛ أصدر مراجعة جديدة عند الحاجة.", "This quotation has expired. Do not send it to the customer as a live offer; issue a new revision if needed."),
      testId: "doc-expired-banner",
    };
  }

  return (
    <DocumentSheet
      lang={lang}
      testId="quote-document"
      logo={{
        src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"),
        width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54,
      }}
      seller={sellerName || sellerLines.length ? { name: sellerName, lines: sellerLines, testId: "quote-seller" } : null}
      title={{
        main: L("عرض سعر", "Quotation"),
        lines: [
          <>{L("المراجعة ", "Revision ")}<bdi>{revision}</bdi></>,
          <span key="alt" className="alt" lang={ar ? "en" : "ar"} dir={ar ? "ltr" : "rtl"}>{ar ? "Quotation" : "عرض سعر"}</span>,
        ],
      }}
      banner={banner}
      metaStart={metaStart}
      metaEnd={metaEnd}
      columns={quoteLineColumns(lang)}
      rows={lines.map((l, i) => quoteLineCells(l, i + 1, lang))}
      totals={tot}
      notes={notes ? { label: L("ملاحظات", "Notes"), text: notes, testId: "quote-doc-notes" } : null}
      bank={bankRows.length ? { label: L("بيانات التحويل البنكي", "Bank transfer details"), rows: bankRows, testId: "doc-bank" } : null}
      footer={{
        legal: vat
          ? L(`المبالغ بالريال السعودي. ضريبة القيمة المضافة ${vat} على كل سطر بعد الخصم.`, `Amounts in Saudi riyals. VAT ${vat} on each line after the discount.`)
          : L("المبالغ بالريال السعودي. ضريبة القيمة المضافة على كل سطر بعد الخصم.", "Amounts in Saudi riyals. VAT on each line after the discount."),
        page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), after: ` · ${footStatus}` },
        docNumber: number,
      }}
    />
  );
}
