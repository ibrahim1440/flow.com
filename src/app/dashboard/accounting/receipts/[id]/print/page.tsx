"use client";

// «سند قبض» — the printed customer receipt voucher (BATCH22 WP-D) on the shared A4 document (DocumentSheet; the same print /
// «Save as PDF» path as the invoice), behind the document gate (PRINT_DOCUMENTS_ENABLED). A reversed receipt keeps its
// number and prints «معكوس». ?lang=ar|en.
import { Suspense, use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { BRAND_PRIMARY_SRC, BRAND_PRIMARY_VIEWBOX } from "@/components/brand/BrandMark";
import { DocumentSheet } from "@/components/print/document/DocumentSheet";
import { DocumentPrintPage } from "@/components/print/document/DocumentPrintPage";
import { useI18n } from "@/lib/i18n/context";
import type { DocLang } from "@/lib/print/quote-document";

type Payload = {
  receipt: {
    id: string; receiptNumber: string | null; status: string; source: string; amountGross: string; amountTax: string; amountNet: string; paymentMethod: string; collectedAt: string;
    referenceNumber: string | null; receiptMemo: string | null; decidedAt: string | null;
    customer: { name: string; nameAr: string | null; vatNumber: string | null } | null;
    submittedBy: { name: string }; decidedBy: { name: string } | null;
    depositAccount: { code: string; nameAr: string | null; nameEn: string } | null;
    invoice: { number: string | null } | null; quote: { quoteNumber: string } | null;
    arApplications: { id: string; amount: string; appliedDate: string; invoice: { number: string | null } }[];
  };
  seller: { name?: string | null; nameEn?: string | null; vatNumber?: string | null; crNumber?: string | null };
  printedAt: string;
};
const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const m = (v: string | number) => nf.format(Number(v));
const METHOD: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"], POS_CARD: ["بطاقة (مدى)", "Card (mada)"], OTHER: ["أخرى", "Other"] };
const day = (s: string | null) => (s ? new Date(new Date(s).getTime() + 3 * 3600_000).toISOString().slice(0, 10) : "");

function Doc({ id, lang }: { id: string; lang: DocLang }) {
  const { lang: ui } = useI18n();
  const [p, setP] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/accounting/receipts/${encodeURIComponent(id)}?print=1`, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (off) return;
      if (r.ok) setP(b as Payload); else setError((ui === "ar" ? b.error || b.errorAr : b.errorEn || b.error) || "Error");
    }).catch(() => { if (!off) setError(ui === "ar" ? "تعذّر الاتصال بالخادم." : "Could not reach the server."); });
    return () => { off = true; };
  }, [id, ui]);
  if (error) return <p className="notice er dsh-err" role="alert" data-testid="alert-error">{error}</p>;
  if (!p) return <p className="dsh-wrap dsh-wait" role="status">{ui === "ar" ? "جارٍ التحميل…" : "Loading…"}</p>;
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const r = p.receipt;
  if (!r.receiptNumber) return <p className="notice er dsh-err" role="alert">{L("لم يُؤكَّد هذا السند بعد؛ لا رقم له.", "This receipt is not confirmed yet; it has no number.")}</p>;
  const sellerName = (ar ? p.seller.name || p.seller.nameEn : p.seller.nameEn || p.seller.name) || null;
  const cust = r.customer ? (ar ? r.customer.nameAr || r.customer.name : r.customer.name) : "—";
  const rows = r.arApplications.length
    ? r.arApplications.map((a) => [{ main: a.invoice.number ?? "—" }, { main: a.appliedDate }, { main: m(a.amount) }])
    : [[{ main: L("رصيد دائن للعميل (دفعة مقدمة)", "Customer credit (advance)") }, { main: day(r.collectedAt) }, { main: m(r.amountGross) }]];
  const applied = r.arApplications.reduce((s, a) => s + Number(a.amount), 0);
  if (r.arApplications.length && Number(r.amountGross) - applied > 0.004) rows.push([{ main: L("رصيد دائن للعميل (دفعة مقدمة)", "Customer credit (advance)") }, { main: day(r.collectedAt) }, { main: m(Number(r.amountGross) - applied) }]);
  return (
    <div className="dsh-wrap">
      <DocumentSheet lang={lang} testId="receipt-document"
        logo={{ src: BRAND_PRIMARY_SRC, alt: L("حِقبة", "Hiqbah"), width: Math.round(54 * BRAND_PRIMARY_VIEWBOX.w / BRAND_PRIMARY_VIEWBOX.h), height: 54 }}
        seller={{ name: sellerName, lines: [p.seller.vatNumber && <>{L("الرقم الضريبي ", "VAT No. ")}<bdi dir="ltr">{p.seller.vatNumber}</bdi></>, p.seller.crNumber && <>{L("الرقم الوطني الموحد ", "Unified No. ")}<bdi dir="ltr">{p.seller.crNumber}</bdi></>].filter(Boolean) }}
        title={{ main: L("سند قبض", "Receipt voucher"), lines: [<span key="n" dir="ltr">{r.receiptNumber}</span>] }}
        banner={r.status === "REVERSED" ? { tone: "danger", title: L("معكوس", "Reversed"), text: L("عُكس هذا السند وقيده؛ يبقى رقمه في السلسلة.", "This receipt and its entry are reversed; its number stays in the series."), testId: "receipt-reversed" } : null}
        metaStart={[
          { label: L("استلمنا من", "Received from"), value: cust },
          ...(r.customer?.vatNumber ? [{ label: L("الرقم الضريبي للعميل", "Customer VAT No."), value: <bdi dir="ltr">{r.customer.vatNumber}</bdi>, muted: true }] : []),
          { label: L("مبلغ وقدره", "The sum of"), value: `${m(r.amountGross)} ${L("ر.س", "SAR")}` },
          { label: L("طريقة الدفع", "Method"), value: `${L(METHOD[r.paymentMethod]?.[0] ?? r.paymentMethod, METHOD[r.paymentMethod]?.[1] ?? r.paymentMethod)}${r.referenceNumber ? ` · ${r.referenceNumber}` : ""}` },
          ...(r.receiptMemo ? [{ label: L("البيان", "Description"), value: r.receiptMemo }] : []),
        ]}
        metaEnd={[
          { label: L("رقم السند", "Receipt no."), value: <bdi dir="ltr">{r.receiptNumber}</bdi>, mono: true, testId: "receipt-number" },
          { label: L("تاريخ التحصيل", "Date"), value: <bdi dir="ltr">{day(r.collectedAt)}</bdi> },
          ...(r.depositAccount ? [{ label: L("أُودع في", "Deposited to"), value: `${r.depositAccount.code} ${ar ? r.depositAccount.nameAr || r.depositAccount.nameEn : r.depositAccount.nameEn}` }] : []),
          { label: L("أكّده", "Confirmed by"), value: r.decidedBy?.name ?? "—" },
        ]}
        columns={[{ key: "i", label: L("الفاتورة", "Invoice"), numeric: false }, { key: "d", label: L("التاريخ", "Date"), numeric: false }, { key: "a", label: L("المبلغ", "Amount"), numeric: true }]}
        rows={rows}
        totals={[{ label: L("الإجمالي", "Total"), value: m(r.amountGross), grand: true }]}
        signatures={[{ label: L("المستلم", "Received by"), lines: [r.decidedBy?.name ?? ""] }, { label: L("الدافع", "Paid by"), lines: [cust] }]}
        footer={{ legal: L("سند قبض داخلي — ليس فاتورة ضريبية", "Internal receipt voucher — not a tax invoice"), page: { before: L("الصفحة ", "Page "), between: L(" من ", " of "), after: "" }, docNumber: r.receiptNumber }}
      />
    </div>
  );
}

function PrintPage({ id }: { id: string }) {
  const sp = useSearchParams();
  const { lang } = useI18n();
  const ar = lang === "ar";
  const docLang: DocLang = sp.get("lang") === "en" || sp.get("lang") === "ar" ? (sp.get("lang") as DocLang) : ar ? "ar" : "en";
  const back = `/dashboard/accounting/receipts?id=${encodeURIComponent(id)}`;
  useD21Title(ar ? "طباعة سند قبض" : "Print receipt");
  useD21Phone({ title: ar ? "طباعة سند قبض" : "Print receipt", back });
  return (
    <DocumentPrintPage testId="receipt-print-page" back={{ href: back, label: ar ? "سندات العملاء" : "Customer receipts" }} title={ar ? "طباعة سند قبض" : "Print receipt"} docLang={docLang}
      otherLanguageHref={`/dashboard/accounting/receipts/${encodeURIComponent(id)}/print?lang=${docLang === "ar" ? "en" : "ar"}`}>
      {() => <Doc id={id} lang={docLang} />}
    </DocumentPrintPage>
  );
}

export default function ReceiptPrint({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={null}><PrintPage id={id} /></Suspense>;
}
