"use client";

import { use, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet, type DocRow, type DocTotal } from "@/components/print/document/DocumentSheet";
import { DocumentPrintPage } from "@/components/print/document/DocumentPrintPage";
import { useI18n } from "@/lib/i18n/context";
import { longDate, type DocLang } from "@/lib/print/quote-document";
import { addressLine, amount, documentTitle, invoiceCells, invoiceColumns, legalLine, type InvoicePrintLine } from "@/lib/print/invoice-document";

/**
 * The printed tax invoice / credit / debit note (Figma ZT-04 AR / EN, ZT-05, ZT-06a; draft preview ZT-02) on the shared
 * A4 DocumentSheet. ?lang=ar|en. An issued document prints its frozen snapshot with a QR — the Phase-1 QR (tags 1–5)
 * in A2, the cleared / signed QR once A4 stores it; a draft prints «معاينة · ليست فاتورة» with no number and no QR.
 * Behind the document gate (PRINT_DOCUMENTS_ENABLED) like every A4 document.
 */
type Seller = { name?: string | null; nameEn?: string | null; vatNumber?: string | null; crNumber?: string | null; phone?: string | null; address?: string | null; addressEn?: string | null; city?: string | null; postalCode?: string | null; district?: string | null; street?: string | null; buildingNo?: string | null; bank?: { name: string | null; accountName: string | null; iban: string | null } };
type Data = {
  id: string; kind: string; family: string; status: string; number: string | null; issueDate: string | null; issueTime: string | null; supplyDate: string | null; dueDate: string | null; paymentTermsDays: number | null;
  originalInvoice: { number: string | null; issueDate: string | null } | null; reasonCode: string | null; reason: string | null;
  buyer: { name: string; vatNumber?: string | null; crNumber?: string | null; city?: string | null; postalCode?: string | null; district?: string | null; street?: string | null; buildingNo?: string | null; address?: string | null };
  seller: Seller; notes: string | null; lines: InvoicePrintLine[];
  totals: { taxable: string; tax: string; grand: string; discount: string };
  taxBreakdown: { category: string; rate: string; taxable: string; tax: string; exemptionReason: string | null }[] | null;
  qr: string | null; qrPhase: 1 | 2 | null; orderNumber: number | null;
  zatca: { environment: string; status: string; flow: string; icv: string; cleared: boolean; notShareable: boolean; testCopy: boolean } | null;
};
type Search = { lang?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});

export default function InvoicePrintPage({ params, searchParams = NO_SEARCH }: { params: Promise<{ id: string }>; searchParams?: Promise<Search> }) {
  const { id } = use(params);
  const sp = use(searchParams);
  const { lang } = useI18n();
  const ar = lang === "ar";
  const docLang: DocLang = sp.lang === "en" || sp.lang === "ar" ? sp.lang : lang === "en" ? "en" : "ar";
  useD21Title(ar ? "طباعة الفاتورة" : "Print invoice");
  useD21Phone({ title: ar ? "طباعة الفاتورة" : "Print invoice", back: `/dashboard/sales/invoices/${id}` });
  return (
    <DocumentPrintPage testId="invoice-print-page" back={{ href: `/dashboard/sales/invoices/${id}`, label: ar ? "الفاتورة" : "Invoice" }}
      title={ar ? "طباعة الفاتورة" : "Print invoice"} docLang={docLang}
      otherLanguageHref={`/dashboard/sales/invoices/${id}/print?lang=${docLang === "ar" ? "en" : "ar"}`}>
      {() => <InvoiceDoc id={id} lang={docLang} />}
    </DocumentPrintPage>
  );
}

function InvoiceDoc({ id, lang }: { id: string; lang: DocLang }) {
  const { lang: uiLang } = useI18n();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/print/documents/invoice?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (off) return;
      if (r.ok) setData(b as Data); else setError((uiLang === "ar" ? b.errorAr || b.error : b.errorEn || b.error) || "Error");
    }).catch(() => { if (!off) setError(uiLang === "ar" ? "تعذّر الاتصال بالخادم." : "Could not reach the server."); });
    return () => { off = true; };
  }, [id, uiLang]);
  if (error) return <p className="notice er dsh-err" role="alert" data-testid="alert-error">{error}</p>;
  if (!data) return <p className="dsh-wrap dsh-wait" role="status">{uiLang === "ar" ? "جارٍ التحميل…" : "Loading…"}</p>;

  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const draft = data.status !== "ISSUED";
  const t = documentTitle(data.kind, data.family, lang);
  const s = data.seller;
  const sellerName = (ar ? s.name || s.nameEn : s.nameEn || s.name) || null;
  const sellerAddr = addressLine(s, lang) ?? (ar ? s.address : s.addressEn || s.address);
  const sellerLines = [
    sellerAddr && <bdi key="a">{sellerAddr}</bdi>,
    s.vatNumber && <>{L("الرقم الضريبي ", "VAT No. ")}<bdi dir="ltr" className="n">{s.vatNumber}</bdi></>,
    s.crNumber && <>{L("السجل التجاري ", "CR ")}<bdi dir="ltr" className="n">{s.crNumber}</bdi></>,
  ].filter(Boolean);
  const b = data.buyer;
  const docNo = data.number ?? L("مسودة", "Draft");
  const metaStart: DocRow[] = [
    { label: L("رقم المستند", "Document no."), value: <bdi className="mono" dir="ltr">{docNo}</bdi>, testId: "inv-number" },
    { label: L("تاريخ ووقت الإصدار", "Issue date & time"), value: data.issueDate ? <>{longDate(data.issueDate, lang)} · <bdi dir="ltr">{data.issueTime?.slice(0, 5)}</bdi></> : "—", testId: "inv-issue" },
  ];
  if (data.kind !== "INVOICE" && data.originalInvoice) {
    metaStart.push({ label: L("الفاتورة الأصلية", "Original invoice"), value: <><bdi className="mono" dir="ltr">{data.originalInvoice.number}</bdi> · {longDate(data.originalInvoice.issueDate, lang)}</>, testId: "inv-original" });
    metaStart.push({ label: L("سبب الإصدار", "Reason"), value: <bdi>{data.reason}</bdi>, testId: "inv-reason" });
  } else {
    metaStart.push({ label: L("تاريخ التوريد", "Supply date"), value: longDate(data.supplyDate, lang), testId: "inv-supply" });
    if (data.dueDate) metaStart.push({ label: L("تاريخ الاستحقاق", "Due date"), value: <>{longDate(data.dueDate, lang)}{data.paymentTermsDays ? L(` · صافي ${data.paymentTermsDays} يومًا`, ` · net ${data.paymentTermsDays} days`) : ""}</>, testId: "inv-due" });
  }
  const metaEnd: DocRow[] = [{ label: L("المشتري", "Buyer"), value: <bdi>{b.name}</bdi>, testId: "inv-buyer" }];
  const bAddr = addressLine(b, lang);
  if (bAddr) metaEnd.push({ label: L("عنوان المشتري", "Buyer address"), value: <bdi>{bAddr}</bdi> });
  if (b.vatNumber) metaEnd.push({ label: L("الرقم الضريبي للمشتري", "Buyer VAT No."), value: <bdi className="mono" dir="ltr">{b.vatNumber}</bdi>, testId: "inv-buyer-vat" });
  if (data.orderNumber) metaEnd.push({ label: L("رقم الطلب", "Order no."), value: <bdi className="mono" dir="ltr">#{data.orderNumber}</bdi> });

  const totals: DocTotal[] = [
    { label: L("الإجمالي قبل الضريبة", "Total before VAT"), value: amount(data.totals.taxable) },
    ...(data.taxBreakdown ?? []).map((r) => ({ label: r.category === "S" ? L(`ضريبة القيمة المضافة ${Number(r.rate)}%`, `VAT ${Number(r.rate)}%`) : `${L("ضريبة", "VAT")} 0% · ${r.exemptionReason ?? r.category}`, value: amount(r.tax) })),
    { label: L("الإجمالي شامل الضريبة · ر.س", "Total incl. VAT · SAR"), value: amount(data.totals.grand), grand: true, testId: "inv-grand" },
  ];
  const bank = s.bank && data.family === "STANDARD" && data.kind === "INVOICE" ? [
    s.bank.name && { label: L("البنك", "Bank"), value: <bdi>{s.bank.name}</bdi> },
    s.bank.accountName && { label: L("اسم الحساب", "Account name"), value: <bdi>{s.bank.accountName}</bdi> },
    s.bank.iban && { label: L("رقم الآيبان", "IBAN"), value: <bdi dir="ltr">{s.bank.iban.replace(/(.{4})/g, "$1 ").trim()}</bdi>, mono: true },
  ].filter(Boolean) as DocRow[] : [];

  return (
    <div className="dsh-wrap">
      <DocumentSheet
        lang={lang} testId="invoice-document"
        logo={{ src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"), width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54 }}
        seller={{ name: sellerName, lines: sellerLines, testId: "doc-seller" }}
        title={{ main: t.main, lines: [<span key="alt" className="alt" lang={ar ? "en" : "ar"} dir={ar ? "ltr" : "rtl"}>{t.alt}</span>] }}
        banner={draft ? { tone: "warning", title: L("مسودة — ليست فاتورة ضريبية", "Draft — not a tax invoice"), text: L("مسودة غير صادرة: لا رقم ولا رمز QR، ولا تُسلَّم للعميل. يُعطى الرقم عند الإصدار.", "An unissued draft: no number and no QR; not to be given to the customer. The number is given at issue."), testId: "inv-draft-banner" }
          : data.zatca?.notShareable ? { tone: "warning", title: L("لم تعتمدها الهيئة بعد · لا تُسلَّم للعميل", "Not cleared by ZATCA yet · not for the customer"), text: L("الفاتورة الضريبية تُسلَّم بعد اعتماد الهيئة فقط؛ يظهر رمز QR المعتمد عند الاعتماد.", "A tax invoice is shared only once ZATCA clears it; the cleared QR appears then."), testId: "inv-not-cleared-banner" }
          : data.zatca?.testCopy ? { tone: "warning", title: L("نسخة اختبار · غير صالحة للعميل", "Test copy · not valid for the customer"), text: L(`صدرت في بيئة ${data.zatca.environment === "SANDBOX" ? "التجربة (بوابة المطورين)" : "المحاكاة"} لدى الهيئة.`, `Issued in ZATCA's ${data.zatca.environment === "SANDBOX" ? "developer portal (sandbox)" : "simulation"} environment.`), testId: "inv-test-banner" } : null}
        watermark={draft ? L("مسودة — ليست فاتورة ضريبية", "DRAFT — NOT A TAX INVOICE") : null}
        metaStart={metaStart} metaEnd={metaEnd}
        columns={invoiceColumns(lang)}
        rows={data.lines.map((l, i) => invoiceCells(l, i + 1, lang))}
        totals={totals}
        extra={!draft ? (
          <section className="dsh-extra" data-testid="inv-qr" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {data.qr ? <span data-testid="inv-qr-code" data-qr={data.qr} data-qr-phase={data.qrPhase ?? ""}><QRCodeSVG value={data.qr} size={data.qrPhase === 2 ? 132 : 112} level="M" /></span> : null}
            <p style={{ margin: 0, fontSize: "9pt", color: "#6e6a61", maxWidth: 260 }}>
              {data.qrPhase === 2 ? (data.zatca?.cleared ? L("رمز QR المعتمد من هيئة الزكاة والضريبة والجمارك (فاتورة معتمدة).", "The QR code of the invoice as cleared by ZATCA.") : L("رمز QR الموقّع (المرحلة الثانية) — يُبلَّغ للهيئة خلال 24 ساعة.", "The signed (Phase 2) QR code — reported to ZATCA within 24 hours.")) : data.zatca?.notShareable ? L("يظهر رمز QR بعد اعتماد الهيئة.", "The QR appears once ZATCA clears the invoice.") : L("رمز QR (المرحلة الأولى: اسم البائع، الرقم الضريبي، الوقت، الإجمالي، الضريبة). يحل محله رمز المرحلة الثانية بعد الربط مع الهيئة.", "QR code (Phase 1: seller, VAT number, time, total, VAT). Replaced by the Phase 2 code once integrated with ZATCA.")}
            </p>
          </section>
        ) : null}
        notes={data.notes ? { label: L("ملاحظات", "Notes"), text: data.notes, testId: "inv-notes" } : null}
        bank={bank.length ? { label: L("بيانات التحويل البنكي", "Bank transfer details"), rows: bank, testId: "inv-bank" } : null}
        footer={{ legal: legalLine(lang, data.lines.some((l) => l.taxCategory === "S")), page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), after: "" }, docNumber: docNo }}
      />
    </div>
  );
}
