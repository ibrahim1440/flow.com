/**
 * What an automated customer e-mail looks like (batch 25). Every value that reaches the HTML is escaped: the message
 * text is rendered as PLAIN text first (renderTemplate), then escaped as a whole and split into paragraphs — no HTML
 * written by a user ever reaches the mail, and no variable can produce a link. Links are built from APP_BASE_URL only.
 *
 * Two kinds:
 *   - "text": a status notification or a rule step — the rendered text in the house layout (templates/shell.ts);
 *   - "quote": «عرض السعر صدر» — the existing quotation e-mail (templates/quotation.ts) with its PDF
 *     (templates/pdf/documents.ts), built from the quotation's issued SNAPSHOT (what the customer was offered).
 * Both carry the signed «إيقاف الإيميلات» footer, and in TEST mode a banner naming who it would have gone to.
 */
import { createHash } from "node:crypto";
import { renderQuotationEmail } from "@/lib/notify/templates/quotation";
import { esc, mailShell, para, subjectOf, textOf, TOKENS } from "@/lib/notify/templates/shell";
import type { CompanyInfo, QuoteEmailInput, RenderedEmail } from "@/lib/notify/templates/types";
import { companyInfoFrom } from "@/lib/notify/templates/demo";
import type { QuoteDocLine } from "@/lib/print/quote-document";
import { Decimal } from "@/lib/services/commissions/engine";
import { cleanSubject } from "./email-mode";

export type Wrap = {
  /** TEST mode: the real recipient it would have gone to (or null when it had no usable address). */
  test: { intended: string | null } | null;
  unsubscribeUrl: string | null;
};

function testBanner(intended: string | null): string {
  const who = intended ? `كانت ستروح إلى: <bdi dir="ltr">${esc(intended)}</bdi>` : "العميل ما عنده إيميل صالح، فوصلتك أنت فقط.";
  return `<div style="margin:0 auto;max-width:600px;padding:10px 14px;background:${TOKENS.warningTint};color:${TOKENS.warning};font-family:${TOKENS.font};font-size:13px;line-height:1.8;text-align:right" dir="rtl"><b>رسالة تجربة — وصلتك أنت فقط.</b> ${who}</div>`;
}

/** In TEST the customer's link is never built (a click would stop a REAL customer's e-mails): this note instead. */
export const TEST_UNSUB_NOTE = "في وضع التجربة رابط الإيقاف معطّل";

/** The footer line: the customer's signed link; in TEST the note; otherwise (a fixed staff address) nothing. */
function footer(w: Wrap): string {
  const line = w.test
    ? esc(TEST_UNSUB_NOTE)
    : w.unsubscribeUrl
      ? `ما تبي توصلك إيميلات منّا؟ <a href="${esc(w.unsubscribeUrl)}" style="color:${TOKENS.text2}">اضغط هنا</a>`
      : "";
  if (!line) return "";
  return `<div style="margin:8px auto 24px;max-width:600px;font-family:${TOKENS.font};font-size:12px;line-height:1.8;color:${TOKENS.muted};text-align:center" dir="rtl">${line}</div>`;
}

/** The test banner after <body …>, the unsubscribe line before </body>. */
export function wrapHtml(html: string, w: Wrap): string {
  let out = html;
  if (w.test) out = out.replace(/(<body[^>]*>)/, `$1${testBanner(w.test.intended)}`);
  return out.replace(/<\/body>/, `${footer(w)}</body>`);
}

export function wrapText(text: string, w: Wrap): string {
  const head = w.test ? [`[رسالة تجربة — كانت ستروح إلى: ${w.test.intended ?? "لا يوجد إيميل صالح"}]`, ""] : [];
  const foot = w.test ? ["", TEST_UNSUB_NOTE] : w.unsubscribeUrl ? ["", `لإيقاف الإيميلات: ${w.unsubscribeUrl}`] : [];
  return [...head, text, ...foot].join("\n");
}

export function wrapSubject(subject: string, w: Wrap): string {
  return cleanSubject(subjectOf(cleanSubject(subject), !!w.test));
}

/** A status notification or a rule step: the rendered plain text, escaped, in the house layout. */
export function renderTextEmail(o: { subject: string; bodyText: string; company: CompanyInfo }): RenderedEmail {
  const paragraphs = o.bodyText.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
  const title = cleanSubject(o.subject);
  return {
    version: "customer-automation-text/v1",
    subject: title,
    html: mailShell({ title, company: o.company, demo: false, body: paragraphs.map((p) => para(esc(p))).join("\n") }),
    text: textOf([o.bodyText], o.company, false),
  };
}

// ─── The quotation, from its issued snapshot ───────────────────────────────────

type SnapSeller = {
  sellerLegalNameAr?: string | null; sellerLegalNameEn?: string | null; sellerAddressAr?: string | null; sellerVatNumber?: string | null;
  sellerCrNumber?: string | null; sellerPhone?: string | null; sellerBankName?: string | null; sellerBankAccountName?: string | null; sellerIban?: string | null;
};
type Snapshot = {
  quoteNumber?: string; revision?: number; validUntil?: string | null; frozenAt?: string;
  totals?: { subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string; effectiveDiscountPercent: string };
  lines?: QuoteDocLine[];
  customerNotes?: string | null;
  customer?: { name: string; nameAr: string | null; address: string | null; vatNumber?: string | null } | null;
  seller?: SnapSeller | null;
};

export type QuoteForEmail = {
  id: string; quoteNumber: string; revision: number; status: string; customerId: string | null; issuedAt: Date | null; validUntil: Date | null;
  issuedSnapshot: unknown;
};

/** The quotation e-mail input from what was frozen at issue; null when the quotation has no usable snapshot. */
export function quoteEmailInput(q: QuoteForEmail, fallbackCompany: CompanyInfo, contact: string | null): QuoteEmailInput | null {
  const s = (q.issuedSnapshot && typeof q.issuedSnapshot === "object" ? q.issuedSnapshot : null) as Snapshot | null;
  if (!s || !Array.isArray(s.lines) || !s.totals || !q.issuedAt) return null;
  const seller = s.seller;
  const company = seller
    ? companyInfoFrom({
        name: seller.sellerLegalNameAr ?? null, nameEn: seller.sellerLegalNameEn ?? null, vatNumber: seller.sellerVatNumber ?? null,
        crNumber: seller.sellerCrNumber ?? null, phone: seller.sellerPhone ?? null, address: seller.sellerAddressAr ?? null,
        bank: { name: seller.sellerBankName ?? null, accountName: seller.sellerBankAccountName ?? null, iban: seller.sellerIban ?? null },
      })
    : fallbackCompany;
  const validUntil = s.validUntil ? new Date(s.validUntil) : q.validUntil ?? q.issuedAt;
  const validityDays = Math.max(0, Math.round((validUntil.getTime() - q.issuedAt.getTime()) / 86_400_000));
  const lines = s.lines;
  return {
    demo: false,
    company,
    customer: {
      name: s.customer ? (s.customer.nameAr || s.customer.name) : "",
      contact,
      address: s.customer?.address ?? null,
      vatNumber: s.customer?.vatNumber ?? null,
    },
    quoteNumber: s.quoteNumber ?? q.quoteNumber,
    revision: s.revision ?? q.revision,
    issueDate: q.issuedAt,
    validUntil,
    validityDays,
    priced: {
      lines: lines.map((l) => ({
        description: l.nameAr || l.name || l.description || "", skuCode: l.skuCode, quantity: l.quantity, unit: l.unit === "UNIT" ? "UNIT" : "KG",
        unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRatePercent: l.taxRatePercent, gross: l.gross, discountAmount: l.discountAmount,
        lineSubtotal: l.lineSubtotal, lineTax: l.lineTax, lineTotal: l.lineTotal,
      })),
      subtotal: s.totals.subtotal,
      discountTotal: s.totals.discountTotal,
      taxable: new Decimal(s.totals.subtotal).minus(new Decimal(s.totals.discountTotal)).toFixed(2),
      taxTotal: s.totals.taxTotal,
      grandTotal: s.totals.grandTotal,
      effectiveDiscountPercent: s.totals.effectiveDiscountPercent,
    },
    notes: s.customerNotes ?? null,
  };
}

/** The quotation e-mail with its PDF, and the sha256 of the PDF bytes (kept on the message and in the archive). */
export function renderQuoteEmail(input: QuoteEmailInput): RenderedEmail & { pdfSha256: string } {
  const r = renderQuotationEmail(input);
  const pdf = r.attachments?.[0];
  const sha = pdf ? createHash("sha256").update(Buffer.from(pdf.contentBase64, "base64")).digest("hex") : "";
  return { ...r, pdfSha256: sha };
}
