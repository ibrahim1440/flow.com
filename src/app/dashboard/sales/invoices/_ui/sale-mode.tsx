"use client";
// D22 (owner-approved Figma 2010:2 / workflow 2024:68, 11 Nov 2026): the tax invoice page — the SAME page and editor
// (invoices/new, _ui/editor.tsx) — opened from the «＋» menu as
//   · ?mode=direct-sale  «بيع مباشر (فاتورة ضريبية بدون عرض سعر)»: SKU lines at the list price, every figure editable,
//                        «الدفع» (كاش / شبكة / تحويل بنكي / آجل — D20: the receipt and the transfer number optional;
//                        only «آجل» without sales › collection_submit); «أرسل» = POST /api/sales/direct-sale (the order to
//                        the roastery, the deal won, the invoice request to the accountant, the collection or credit);
//   · ?mode=sample       «إرسال عيّنة»: SKU lines, one unit each, the 100 % discount pre-filled (editable), no payment;
//                        «أرسل» = POST /api/sales/sample-send (the samples to the warehouse — a repeat this year waits for a
//                        manager —, the deal kept open, the zero invoice's request to the accountant).
// Everything here renders ONLY in those modes; the manual invoice and the invoice from an order are untouched.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { prepareReceipt } from "@/lib/files/receipt-prep";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { money, useApi, useLang } from "./inv";
import { emptyLine, type EditLine } from "./editor";
import type { ComboSku } from "../../quotes/[id]/ProductCombo";
import { Select } from "@/components/ui/Select";
import { dealLabel } from "@/lib/sales/deal-label";

export type SaleMode = "direct-sale" | "sample";
export const isSaleMode = (v: unknown): v is SaleMode => v === "direct-sale" || v === "sample";
export type ModeSku = ComboSku & { productId: string | null };
type Payment = "CASH" | "CARD" | "BANK_TRANSFER" | "CREDIT";
type Can = { approveDiscount: boolean; collect: boolean; threshold: number; max: number; taxOverride?: boolean };
export type SampleDeal = { id: string; title: string; amount: string | null; createdAt: string; stageAr: string; stageEn: string; quotes: number; samples: number };
type Facts = { sampledProducts: { productId: string; at: string }[]; alert: { yearValue: string; threshold: string } | null; customerNames?: string[]; deals?: SampleDeal[]; taxOverride?: boolean };

/** A new line of the mode: one unit; a sample starts at 100 % off. */
export const modeLine = (mode: SaleMode) => (): EditLine => ({ ...emptyLine(), quantity: "1", discountPercent: mode === "sample" ? "100" : "0" });

/** «الخصم مو 100٪ — الفاتورة بـ X ⃁ والعميل يدفعها» (أبو فهد wording): a sample below 100 % is a sale the customer pays. */
export function samplePaidText(gross: number, L: (a: string, e: string) => string) {
  return L(`الخصم مو 100٪ — الفاتورة بـ ${money(gross.toFixed(2))} ⃁ والعميل يدفعها`, `The discount is not 100% — the invoice is ${money(gross.toFixed(2))} SAR and the customer pays it`);
}

export function ModeBadge({ mode, lockTax = true, gross = 0 }: { mode: SaleMode; lockTax?: boolean; gross?: number }) {
  const { L } = useLang();
  return (
    <p className="inv-mode" data-testid="invoice-mode-badge" data-mode={mode}>
      <span className={`inv-chip ${mode === "sample" ? "is-sand" : "is-mode"}`}>{mode === "sample" ? L("إرسال عيّنة", "Send a sample") : L("بيع مباشر (فاتورة ضريبية بدون عرض سعر)", "Direct sale (tax invoice without a quotation)")}</span>
      <span className="acct-hint" data-testid="invoice-mode-hint">{mode === "sample"
        ? (gross > 0
          ? <>{L("الخصم 100٪ يتعبّى تلقائي في كل صنف وتقدر تغيّره — ", "The 100% discount is filled on each line and you can change it — ")}<b data-testid="sample-paid">{samplePaidText(gross, L)}</b>{L("، والعيّنة تروح للمستودع يحضّرها.", "; the sample goes to the warehouse.")}</>
          : L("الخصم 100٪ يتعبّى تلقائي في كل صنف وتقدر تغيّره — الفاتورة بصفر تروح للمحاسب، والعيّنة تروح للمستودع يحضّرها.", "The 100% discount is filled on each line and you can change it — the zero invoice goes to the accountant, the sample to the warehouse."))
        : lockTax
          ? L("السعر والخصم تقدر تعدّلها — الضريبة 15٪ ثابتة، والمحاسب يراجع قبل ما يصدر", "You can change the price and the discount — VAT is a fixed 15%, and the accountant reviews before issue")
          : L("السعر والخصم والضريبة تقدر تعدّلها — المحاسب يراجع قبل ما يصدر", "You can change the price, discount and VAT — the accountant reviews before issue")}</span>
    </p>
  );
}

/** The SKUs (catalogue, in units, with a list price), the direct sale's abilities, and the sample facts of the customer. */
export function useModeData(mode: SaleMode | null, customerId: string | null) {
  const products = useApi<{ id: string; skuCode: string; name: string | null; nameAr: string | null; unitOfMeasure: string; price: number; availableUnits?: number; coffee?: { id: string } | null }[]>(mode ? "/api/products" : null);
  const options = useApi<{ can: Can; deals?: SampleDeal[]; customers?: { id: string; name: string; nameAr: string | null }[] }>(mode === "direct-sale" ? `/api/sales/direct-sale/options${customerId ? `?customerId=${encodeURIComponent(customerId)}` : ""}` : null);
  const facts = useApi<Facts>(mode === "sample" && customerId ? `/api/sales/sample-send?customerId=${encodeURIComponent(customerId)}` : null);
  const skus = useMemo<ModeSku[]>(() => (products.data ?? []).filter((s) => s.unitOfMeasure === "UNIT" && Number(s.price) > 0)
    .map((s) => ({ id: s.id, skuCode: s.skuCode, name: s.name, nameAr: s.nameAr, unitOfMeasure: s.unitOfMeasure, price: Number(s.price), availableUnits: s.availableUnits, productId: s.coffee?.id ?? null })), [products.data]);
  // أبو فهد B2: the chosen customer's open deals a direct sale may join (only once a customer is chosen).
  const directDeals = customerId ? options.data?.deals ?? [] : [];
  const c = customerId ? options.data?.customers?.find((x) => x.id === customerId) : undefined;
  const directNames = c ? [c.name, c.nameAr].filter((x): x is string => !!x) : [];
  return { skus, can: options.data?.can ?? null, facts: facts.data ?? null, directDeals, directNames, error: products.error ?? options.error ?? null };
}

/** The line a picked SKU makes (its list price; the mode's discount; one unit for a sample). */
export function lineForSku(mode: SaleMode, prev: EditLine, s: ModeSku | null, ar: boolean): EditLine {
  if (!s) return { ...prev, productSkuId: null, skuCode: null, description: "" };
  return { ...prev, productSkuId: s.id, skuCode: s.skuCode, description: (ar ? s.nameAr : null) ?? s.name ?? s.skuCode, descriptionEn: s.name ?? null,
    unit: "UNIT", unitPrice: s.price.toFixed(2), quantity: mode === "sample" ? "1" : prev.quantity || "1", discountPercent: prev.productSkuId ? prev.discountPercent : mode === "sample" ? "100" : prev.discountPercent };
}

/** The effective discount of each line against the list (1 − net ÷ list × units) — what the approval is decided on. */
export function effectiveDiscounts(lines: EditLine[], nets: (string | null)[], skus: ModeSku[]): number[] {
  return lines.map((l, i) => {
    const s = skus.find((x) => x.id === l.productSkuId);
    const listGross = s ? Math.round(s.price * Number(l.quantity || 0) * 100) / 100 : 0;
    const net = Number(nets[i] ?? NaN);
    if (!s || !(listGross > 0) || !Number.isFinite(net)) return 0;
    return Math.max(0, Math.round((1 - net / listGross) * 10000) / 100);
  });
}

export function PaymentSection({ can, payment, setPayment, reference, setReference, receipt, setReceipt, pending }: {
  can: Can | null; payment: Payment | null; setPayment: (p: Payment) => void; reference: string; setReference: (v: string) => void;
  receipt: File | null; setReceipt: (f: File | null) => void; pending: boolean;
}) {
  const { L } = useLang();
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [err, setErr] = useState("");
  const methods: Payment[] = can?.collect ? ["CASH", "CARD", "BANK_TRANSFER", "CREDIT"] : ["CREDIT"];
  const name = (m: Payment) => (m === "CASH" ? L("كاش", "Cash") : m === "CARD" ? L("شبكة", "Card") : m === "BANK_TRANSFER" ? L("تحويل بنكي", "Bank transfer") : L("آجل", "On account"));
  useEffect(() => { if (!can?.collect && payment !== "CREDIT") setPayment("CREDIT"); }, [can?.collect, payment, setPayment]);
  async function choose(f: File | null) {
    setErr("");
    if (!f) return;
    setPreparing(true);
    const r = await prepareReceipt(f);
    setPreparing(false);
    if (r.ok) setReceipt(r.file); else { setReceipt(null); setErr(L(r.ar, r.en)); }
  }
  return (
    <div className="acct-card inv-pay" data-testid="invoice-payment">
      <h2>{L("الدفع", "Payment")}</h2>
      <div className="inv-pay-row" role="radiogroup" aria-label={L("طريقة الدفع", "How the customer pays")}>
        {methods.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={payment === m} className={`inv-pay-opt${payment === m ? " on" : ""}`} onClick={() => setPayment(m)} data-testid={`pay-${m}`}>{name(m)}</button>
        ))}
      </div>
      {!can?.collect ? <p className="acct-hint" data-testid="pay-credit-only">{L("ما عندك صلاحية تسجيل التحصيل — البيع يمشي «آجل»، والتحصيل يسجله المحاسب أو المشرف.", "You may not record a collection — the sale goes on account; the accountant or a supervisor records the payment.")}</p> : null}
      {payment === "BANK_TRANSFER" ? (
        <div className="inv-bank" data-testid="pay-bank">
          {pending ? <p className="acct-hint">{L("الخصم يحتاج موافقة المشرف، فالتحصيل ما يتسجّل الحين — إيصال التحويل ترفعه من صفحة الصفقة بعد الموافقة.", "The discount needs your supervisor's approval, so the collection is not recorded yet — upload the transfer receipt from the deal page after the approval.")}</p> : (
            <div className="hr-field">
              <span className="hr-label">{L("إيصال التحويل", "Transfer receipt")} <small>{L("(اختياري)", "(optional)")}</small></span>
              <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" hidden data-testid="pay-receipt-input" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; void choose(f); }} />
              {receipt ? (
                <span className="inv-file" data-testid="pay-receipt-file"><bdi>{receipt.name}</bdi> <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setReceipt(null)}>{L("حذف", "Remove")}</button></span>
              ) : (
                <button type="button" className="inv-drop" disabled={preparing} onClick={() => input.current?.click()} data-testid="pay-receipt-pick">
                  <b>{preparing ? L("نجهّز الصورة…", "Preparing the photo…") : L("صوّر الإيصال أو اختر ملف", "Photograph the receipt or choose a file")}</b><small>{L("صورة أو PDF · لين 5 ميجا", "Photo or PDF · up to 5 MB")}</small>
                </button>
              )}
            </div>
          )}
          {err ? <p className="acct-hint is-warn" role="alert">{err}</p> : null}
          <label className="hr-field"><span className="hr-label">{L("رقم الحوالة", "Transfer number")} <small>{L("(اختياري)", "(optional)")}</small></span>
            <input className="hr-input" dir="ltr" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={L("مثال: FT26111045", "e.g. FT26111045")} data-testid="pay-reference" /></label>
          {!receipt && !pending ? <p className="acct-hint">{L("ما معك الإيصال الحين؟ أرسل عادي — ترفعه بعدين من صفحة الصفقة.", "No receipt yet? Send anyway — upload it later from the deal page.")}</p> : null}
        </div>
      ) : payment ? (
        <p className="acct-hint" data-testid="pay-what">{payment === "CREDIT" ? L("ما ينسجل تحصيل الحين — الفاتورة تنتظر الدفع حسب شروط العميل.", "No collection now — the invoice waits for payment on the customer's terms.") : L(`ينسجل التحصيل «${name(payment)}» وينتظر اعتماد المحاسب.`, `The ${name(payment).toLowerCase()} collection is recorded for the accountant to approve.`)}</p>
      ) : null}
    </div>
  );
}

/** The sample notes: a repeat of a product this year (manager's approval) and the deemed-supply alert. */
export function SampleNotes({ lines, skus, facts }: { lines: EditLine[]; skus: ModeSku[]; facts: Facts | null }) {
  const { L, lang } = useLang();
  if (!facts) return null;
  const day = (iso: string) => new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "long" }).format(new Date(iso));
  const repeats = lines.map((l, i) => {
    const s = skus.find((x) => x.id === l.productSkuId);
    const hit = s?.productId ? facts.sampledProducts.find((p) => p.productId === s.productId) : null;
    return hit ? { i, name: l.description, at: hit.at } : null;
  }).filter((x): x is { i: number; name: string; at: string } => !!x);
  const sendValue = lines.reduce((t, l) => t + (skus.find((x) => x.id === l.productSkuId)?.price ?? 0) * Number(l.quantity || 0), 0);
  const a = facts.alert;
  const yearValue = a ? Number(a.yearValue) + sendValue : 0;
  return (
    <>
      {repeats.map((r) => (
        <div key={r.i} className="hr-notice tone-warn" role="note" data-testid={`sample-repeat-${r.i}`}>
          <b>{L("تحتاج موافقة المدير", "Needs the manager's approval")}</b> · <bdi>{r.name}</bdi> — {L(`أخذها العميل ${day(r.at)}. الثانية تروح للمدير يوافق — الشحنة ما تتحضّر قبل الموافقة.`, `the customer had it on ${day(r.at)}. A second goes to the manager — it is not prepared before the approval.`)}
        </div>
      ))}
      {a && yearValue > Number(a.threshold) ? (
        <div className="hr-notice tone-warn" role="note" data-testid="sample-vat-alert">
          <b>⚠ {L("عيّنات هالعميل هالسنة تعدّت الحد", "This customer's samples this year passed the limit")}</b>
          <span> · {L("قيمتها بسعر القائمة:", "List value:")} <bdi className="hr-num">{money(yearValue.toFixed(2))}</bdi> {L("⃁", "SAR")} · {L("الحد:", "Limit:")} <bdi className="hr-num">{money(a.threshold)}</bdi> {L("⃁", "SAR")}</span>
          <p className="acct-hint">{L("الهدايا والعيّنات المجانية فوق الحد ممكن تُعتبر «توريد حكمي» وتستحق عليها ضريبة على القيمة — الفاتورة الصفرية ما تغطيها. بلّغ المحاسب. الحد من إعدادات الضريبة — تأكد من zatca.gov.sa", "Free samples above the limit may be a deemed supply with VAT on their value — the zero invoice does not cover it. Tell the accountant. The limit is in the tax settings — check zatca.gov.sa")}</p>
        </div>
      ) : null}
    </>
  );
}

export type ModeDone =
  | { mode: "direct-sale"; orderId: string; orderNumber: number; opportunityId: string | null; invoiceId: string | null; pending: boolean; gross: string; payment: Payment; uploadError: string; receiptUploaded: boolean; deal: { id: string; title: string; joined: boolean } | null; dealTitle: string | null }
  | { mode: "sample"; invoiceId: string; opportunityId: string; pending: boolean; gross: string };

/** «أرسل»: the direct sale or the sample send, under one request key per page; the receipt is a second request (D20). */
export async function sendMode(mode: SaleMode, body: Record<string, unknown>, receipt: File | null, L: (a: string, e: string) => string): Promise<{ ok: true; done: ModeDone } | { ok: false; error: string }> {
  const res = await fetch(mode === "sample" ? "/api/sales/sample-send" : "/api/sales/direct-sale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, error: L("تعذّر الاتصال.", "Could not connect.") };
  const b = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: localizeApiError(b) ?? b.error ?? L("ما انرسل — جرّب مرة ثانية.", "Not sent — try again.") };
  if (mode === "sample") return { ok: true, done: { mode, invoiceId: b.invoice.id, opportunityId: b.opportunityId, pending: !!b.pendingApproval, gross: b.totals.gross } };
  let uploadError = "";
  if (body.payment === "BANK_TRANSFER" && receipt && b.payment?.collectionId) {
    const form = new FormData();
    form.append("file", receipt);
    const up = await fetch(`/api/sales/collections/${b.payment.collectionId}/evidence`, { method: "POST", body: form }).catch(() => null);
    if (!up || !up.ok) uploadError = (up ? localizeApiError(await up.json().catch(() => ({}))) : null) ?? L("ما انرفع الإيصال — ارفعه من صفحة الصفقة.", "The receipt was not uploaded — attach it from the deal page.");
  }
  return { ok: true, done: { mode, orderId: b.order.id, orderNumber: b.order.orderNumber, opportunityId: b.opportunityId, invoiceId: b.invoice?.id ?? null, pending: b.discountApproval === "PENDING", gross: b.totals.gross, payment: b.payment.method, uploadError, receiptUploaded: body.payment === "BANK_TRANSFER" && !!receipt && !!b.payment?.collectionId && !uploadError, deal: b.deal ?? null, dealTitle: typeof body.dealTitle === "string" ? body.dealTitle : null } };
}

export function DoneCard({ done }: { done: ModeDone }) {
  const { L } = useLang();
  const rows = done.mode === "direct-sale"
    ? [
      [L("الطلب", "Order"), done.pending ? L(`#${done.orderNumber} · ينتظر موافقة المشرف على الخصم`, `#${done.orderNumber} · waits for the supervisor's discount approval`) : L(`#${done.orderNumber} · راح للتحضير`, `#${done.orderNumber} · sent to preparation`)],
      [L("الفاتورة", "Invoice"), done.pending ? L("تروح للمحاسب بعد الموافقة", "goes to the accountant after the approval") : L("مسودة · عند المحاسب يصدرها", "draft · with the accountant to issue")],
      [L("التحصيل", "Collection"), done.payment === "CREDIT" ? L("آجل", "On account") : done.pending ? L("ينسجل بعد الموافقة", "recorded after the approval")
        : done.payment === "BANK_TRANSFER" && !done.receiptUploaded ? L("تحويل بنكي · بدون إيصال — ارفعه من صفحة الصفقة", "Bank transfer · no receipt — upload it from the deal page")
        : done.payment === "BANK_TRANSFER" ? L("تحويل بنكي · ✓ الإيصال انرفع · ينتظر اعتماد المحاسب", "Bank transfer · ✓ receipt uploaded · awaiting the accountant")
        : L("ينتظر اعتماد المحاسب", "waits for the accountant")],
      // أبو فهد B2: where the sale landed — the open deal the rep chose, now won, or a new won deal.
      [L("الصفقة", "Deal"), done.deal
        ? (done.deal.joined ? L(`«${done.deal.title}» صارت رابحة`, `«${done.deal.title}» is now won`) : L("صفقة جديدة رابحة", "a new won deal"))
        : done.pending ? (done.dealTitle ? L(`«${done.dealTitle}» تصير رابحة بعد الموافقة`, `«${done.dealTitle}» is won after the approval`) : L("صفقة جديدة رابحة بعد الموافقة", "a new won deal after the approval")) : "—"],
    ]
    : [
      [L("العيّنة", "Sample"), done.pending ? L("تنتظر موافقة المدير قبل التحضير", "waits for the manager's approval before preparation") : L("راحت للمستودع يحضّرها ويشحنها", "sent to the warehouse to prepare and ship")],
      [L("الفاتورة", "Invoice"), L("مسودة · عند المحاسب يراجعها ويصدرها", "draft · with the accountant to review and issue")],
      [L("الصفقة", "Deal"), L("مفتوحة للمتابعة", "open for the follow-up")],
    ];
  return (
    <div className="acct-card inv-done" data-testid="invoice-mode-done" data-mode={done.mode}>
      <h2 data-testid="invoice-mode-done-title">{done.mode === "sample" ? L("انرسلت العيّنة", "The sample was sent") : done.pending ? L("انرسل للمشرف يوافق", "Sent to your supervisor to approve") : L("انرسل البيع", "The sale was sent")}</h2>
      <dl className="inv-totals">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        <div className="g"><dt>{L("الإجمالي شامل الضريبة · ⃁", "Total incl. VAT · SAR")}</dt><dd data-testid="invoice-mode-done-gross">{money(done.gross)}</dd></div>
      </dl>
      {done.mode === "direct-sale" && done.uploadError ? <p className="acct-hint is-warn" role="alert">{done.uploadError}</p> : null}
      {/* أبو فهد B5 (D20 parity): a transfer recorded without its receipt sends the rep straight to the deal page to attach it. */}
      {done.mode === "direct-sale" && !done.pending && done.payment === "BANK_TRANSFER" && !done.receiptUploaded && done.opportunityId ? (
        <p className="acct-hint is-warn" data-testid="invoice-mode-no-receipt">{L("تحويل بنكي · بدون إيصال — ارفعه من صفحة الصفقة", "Bank transfer · no receipt — upload it from the deal page")}</p>
      ) : null}
      <div className="acct-actions">
        {done.mode === "direct-sale" && !done.pending && done.payment === "BANK_TRANSFER" && !done.receiptUploaded && done.opportunityId
          ? <Link className="hr-btn is-primary" href={`/dashboard/sales/deals/${done.opportunityId}`} data-testid="invoice-mode-receipt-later">{L("ارفع الإيصال من صفحة الصفقة", "Upload the receipt from the deal page")}</Link> : null}
        {/* A full load: a fresh page (and a fresh request key) for the next one. */}
        <button type="button" className="hr-btn is-primary" onClick={() => window.location.assign(`/dashboard/sales/invoices/new?mode=${done.mode}`)} data-testid="invoice-mode-again">{done.mode === "direct-sale" ? L("بيع ثاني", "Another sale") : L("عيّنة ثانية", "Another sample")}</button>
        {done.opportunityId ? <Link className="hr-btn" href={`/dashboard/sales/deals/${done.opportunityId}`}>{L("افتح الصفقة", "Open the deal")}</Link> : null}
        <Link className="hr-btn" href="/dashboard/my-day">{L("رجوع", "Back")}</Link>
      </div>
    </div>
  );
}

/**
 * أبو فهد B2: a direct sale asks «تربطه بصفقة؟» whenever the customer has an open deal — «لا — صفقة جديدة» (the default: a new
 * WON deal) or one of the open deals by its D21 label; the one chosen is won by the sale. Never chosen for the rep.
 */
export function DirectDealPicker({ deals, customerNames, value, onChange }: { deals: SampleDeal[]; customerNames: string[]; value: string; onChange: (id: string) => void }) {
  const { L, ar } = useLang();
  if (deals.length === 0) return null;
  return (
    <div className="acct-card" data-testid="direct-deal-card">
      <label className="hr-field"><span className="hr-label">{L("تربطه بصفقة؟", "Link it to a deal?")}</span>
        <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="direct-deal">
          <option value="">{L("لا — صفقة جديدة", "No — a new deal")}</option>
          {deals.map((d) => {
            const l = dealLabel(d, { lang: ar ? "ar" : "en", customerNames });
            return <option key={d.id} value={d.id} data-hint={l.hint || undefined}>{l.label}</option>;
          })}
        </Select></label>
      <p className="acct-hint">{value ? L("الصفقة المختارة تصير رابحة بهالبيع.", "The deal chosen is won by this sale.") : L("ينفتح للبيع صفقة جديدة رابحة — صفقاته المفتوحة تبقى مثل ما هي.", "The sale opens a new won deal — the customer's open deals stay as they are.")}</p>
    </div>
  );
}

/**
 * D22 gate (owner 2أ): with several open deals the sample asks «تربطه بصفقة؟» — the D21 labels (type · amount · date, the
 * stage under it; a written title first). The deal passed in (from the deal page) is the default, else the most recent.
 * One open deal: no question. None: the server opens one (quick-deal), as before.
 */
export function SampleDealPicker({ facts, value, onChange }: { facts: Facts | null; value: string; onChange: (id: string) => void }) {
  const { L, ar } = useLang();
  const deals = facts?.deals ?? [];
  if (deals.length < 2) return null;
  return (
    <div className="acct-card" data-testid="sample-deal-card">
      <label className="hr-field"><span className="hr-label">{L("تربطه بصفقة؟", "Link it to a deal?")}</span>
        <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="sample-deal">
          {deals.map((d) => {
            const l = dealLabel(d, { lang: ar ? "ar" : "en", customerNames: facts?.customerNames ?? [] });
            return <option key={d.id} value={d.id} data-hint={l.hint || undefined}>{l.label}</option>;
          })}
        </Select></label>
      <p className="acct-hint">{L("العيّنة تنسجل في هالصفقة، والصفقة تبقى مفتوحة للمتابعة.", "The sample is recorded on this deal; the deal stays open for the follow-up.")}</p>
    </div>
  );
}
