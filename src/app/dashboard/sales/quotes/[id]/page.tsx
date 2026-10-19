"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useMemo, use } from "react";
import Link from "next/link";
import { Printer, FileText } from "lucide-react";
import { usePrintCertified } from "@/components/print/Certification";
import {
  useLang, pick, Spinner, Button, Field, TextArea, Modal, api,
  QUOTE_STATUS_SPECS, num, formatDay, formatMoney,
} from "../../_components/ui";
import { useUnsavedGuard } from "../../../_components/useUnsavedGuard";
import { Ico } from "@/components/shell/icons";
import { useD21Title, usePhone, useD21Phone } from "@/components/shell/page-context";
import { splitTitle } from "@/components/d21/labels";
import { shortDate } from "@/components/d21/format";
import { DISCOUNT_MAX } from "@/lib/services/sales/discount-limits";

/**
 * The quotation — editor while it is a draft (GX A-10, Figma 1230:121651 / EN 1230:147423,
 * 390 1233:24114) and the issued record once it is not (GX A-11, 1230:132625 / 1233:70190,
 * 390 1233:24180): header with its facts and actions, the discount band, the lines at the start
 * and the totals, facts and revision chain at the end.
 *
 * Visual port only: the requests, payloads, the local preview arithmetic and every condition
 * that decides which action is offered are the ones this screen already had. What the frames
 * draw and the system does not have (notes to the customer) is not built.
 *
 * ── The totals shown here are the server's ──
 * The figures beside the lines are computed locally so typing feels immediate, and they are
 * replaced by the server's the moment the lines are saved. Where the two disagree, the server
 * wins: a browser that decides a price is a browser that can be asked to decide a different one.
 */

type Sku = {
  id: string;
  skuCode: string;
  name: string | null;
  nameAr: string | null;
  unitOfMeasure: string;
  price: number;
};

type Line = {
  id?: string;
  productSkuId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
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
  // Present only once the quotation has been issued. Its presence is what decides whether
  // there is a document to print at all — a draft has no frozen copy to show a customer.
  issuedSnapshot: unknown | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  discountApprovedAt: string | null;
  createdAt: string;
  supersedes: { id: string; quoteNumber: string; revision: number } | null;
  supersededBy: { id: string; quoteNumber: string; revision: number; status: string } | null;
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string; outcome: string; owner: { id: string; name: string } | null };
  lines: {
    id: string;
    productSkuId: string | null;
    description: string | null;
    quantity: string;
    unit: string;
    unitPrice: string;
    discountPercent: string;
    taxRatePercent: string;
    lineSubtotal: string;
    lineTax: string;
    lineTotal: string;
    position: number;
    productSku: { id: string; skuCode: string; name: string | null; unitOfMeasure: string; price: number } | null;
  }[];
  orderLinks: { id: string; isFirstOrder: boolean; order: { id: string; orderNumber: number; status: string } }[];
};

type State = { editable: boolean; revisable: boolean; expired: boolean; orderable: boolean };
type Can = { write: boolean; approveDiscount: boolean; createOrder: boolean; close: boolean };

/** Quote status → the reference status dot (`.st` + tone), as on the list. */
const STATUS_DOT: Record<string, string> = {
  ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x",
};
/** The stored unit, as the frames write it («800 عبوة»). The value sent is unchanged. */
const UNIT_LABELS: Record<string, { en: string; ar: string }> = {
  KG: { en: "kg", ar: "كغ" },
  UNIT: { en: "pack", ar: "عبوة" },
  GRAM: { en: "g", ar: "غ" },
};

const emptyLine = (): Line => ({
  productSkuId: "",
  description: "",
  quantity: "1",
  unit: "KG",
  unitPrice: "0",
  discountPercent: "0",
  taxRatePercent: "15",
});

/**
 * The same arithmetic the server does, for the preview only.
 *
 * Kept deliberately simple and deliberately labelled: it rounds the way `priceLine` rounds
 * — each step to two places — so the preview and the saved figures agree for ordinary
 * inputs. It is never what gets stored.
 */
function previewTotals(lines: Line[]) {
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const l of lines) {
    const gross = r2((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0));
    const disc = r2((gross * (Number(l.discountPercent) || 0)) / 100);
    const net = r2(gross - disc);
    const tax = r2((net * (Number(l.taxRatePercent) || 0)) / 100);
    subtotal = r2(subtotal + gross);
    discountTotal = r2(discountTotal + disc);
    taxTotal = r2(taxTotal + tax);
  }
  const grandTotal = r2(subtotal - discountTotal + taxTotal);
  const discountPercent = subtotal === 0 ? 0 : (discountTotal * 100) / subtotal;
  return { subtotal, discountTotal, taxTotal, grandTotal, discountPercent };
}

export default function QuoteEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [can, setCan] = useState<Can | null>(null);
  const [threshold, setThreshold] = useState("10");
  const [skus, setSkus] = useState<Sku[]>([]);

  const [lines, setLines] = useState<Line[]>([]);
  const [validUntil, setValidUntil] = useState("");
  const [dirty, setDirty] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<"reject" | "order" | null>(null);
  /** Phone: the «⋯» menu of the sticky bar, and the lines opened for editing from it. */
  const [more, setMore] = useState(false);
  const [phoneEdit, setPhoneEdit] = useState(false);

  /**
   * Reload counter. The fetch lives in the effect rather than a `useCallback` it calls, so the
   * first `await` precedes any state write. Saving, issuing and revising bump this to refresh;
   * none of them consumed the loader's completion, so nothing is lost by not awaiting it.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
    const res = await api<{
      quote: Quote; state: State; can: Can; discountThresholdPercent: string;
    }>(`/api/sales/quotes/${id}`);
    if (cancelled) return;
    if (res.ok) {
      setQuote(res.data.quote);
      setState(res.data.state);
      setCan(res.data.can);
      setThreshold(res.data.discountThresholdPercent);
      setValidUntil(res.data.quote.validUntil?.slice(0, 10) ?? "");
      setLines(
        res.data.quote.lines.map((l) => ({
          id: l.id,
          productSkuId: l.productSkuId ?? "",
          description: l.description ?? "",
          quantity: String(l.quantity),
          unit: l.unit,
          unitPrice: String(l.unitPrice),
          discountPercent: String(l.discountPercent),
          taxRatePercent: String(l.taxRatePercent),
        })),
      );
      setDirty(false);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر تحميل العرض." : "Could not load the quotation."));
    }
    setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, ar, reloadToken]);

  useEffect(() => {
    api<Sku[]>("/api/products").then((r) => {
      if (r.ok && Array.isArray(r.data)) setSkus(r.data);
    });
  }, []);

  // Edited lines that have not been saved are the only unsaved state in the module.
  // Navigating away from them silently would lose a priced quotation somebody was building.
  useUnsavedGuard(dirty && Boolean(state?.editable));

  const preview = useMemo(() => previewTotals(lines), [lines]);
  const needsApproval = preview.discountPercent > Number(threshold);

  const editable = Boolean(state?.editable && can?.write);
  const customerName = quote?.customer ? (ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name) : null;

  // The last crumb of the top bar is the quotation number («المبيعات / عروض الأسعار / Q-…»).
  useD21Title(quote?.quoteNumber);

  // The phone bar carries the actions the 390 frames put at the bottom; with none, the tab bar stays.
  const phoneBar = !!(quote && state && can) && (
    (quote.status === "DRAFT" && can.write) ||
    (quote.status === "ISSUED" && can.write) ||
    (state.orderable && can.createOrder) ||
    (state.revisable && can.write) ||
    quote.status === "ACCEPTED" ||
    quote.issuedSnapshot != null
  );
  useD21Phone({
    title: ar ? "عرض السعر" : "Quotation",
    sub: quote
      ? `${quote.quoteNumber} · ${editable ? `${ar ? "المراجعة" : "revision"} ${quote.revision}` : (customerName ?? quote.opportunity.title)}`
      : undefined,
    back: "/dashboard/sales/quotes",
    ownBar: phoneBar,
  });
  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-q-more]")) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [more]);

  function setLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  }

  /** Picking a product fills the price and the unit from the catalogue, as a starting point. */
  function chooseSku(i: number, skuId: string) {
    const sku = skus.find((s) => s.id === skuId);
    setLine(i, {
      productSkuId: skuId,
      ...(sku
        ? {
            unitPrice: String(sku.price ?? 0),
            unit: sku.unitOfMeasure === "KG" ? "KG" : "UNIT",
            description: "",
          }
        : {}),
    });
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ totals: Record<string, string>; needsDiscountApproval: boolean; notice: string | null }>(
      `/api/sales/quotes/${id}`,
      { method: "PUT", body: { lines, validUntil: validUntil || null } },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save."));
      return false;
    }
    setSuccess(ar ? "حُفظ العرض." : "Saved.");
    reload();
    return true;
  }

  async function transition(to: string, note?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ status: string; discountApproved?: boolean }>(
      `/api/sales/quotes/${id}/transition`,
      { method: "POST", body: { to, note } },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? (ar ? "تعذّر التنفيذ." : "Could not do that."));
      return;
    }
    setDialog(null);
    setSuccess(
      to === "ISSUED"
        ? ar ? "صدر العرض وتُثبّتت أسعاره." : "Issued, and its prices are now frozen."
        : to === "ACCEPTED"
          ? ar ? "سُجّل قبول العميل." : "Acceptance recorded."
          : ar ? "تم التحديث." : "Updated.",
    );
    reload();
  }

  async function revise() {
    setBusy(true);
    const res = await api<{ quote: { id: string } }>(`/api/sales/quotes/${id}/revise`, {
      method: "POST",
    });
    setBusy(false);
    if (res.ok) window.location.href = `/dashboard/sales/quotes/${res.data.quote.id}`;
    else setError(res.data.error ?? "");
  }

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!quote || !state || !can) {
    return (
      <div className="pg">
        <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 12 }}>
          {error || (ar ? "العرض غير موجود." : "Quotation not found.")}
        </p>
        <Link href="/dashboard/sales/quotes" className="btn sm">
          {ar ? "كل عروض الأسعار" : "All quotations"}
        </Link>
      </div>
    );
  }

  const statusLabel = (s: string) => pick(QUOTE_STATUS_SPECS, s, lang);
  const unitLabel = (u: string) => (UNIT_LABELS[u] ? (ar ? UNIT_LABELS[u].ar : UNIT_LABELS[u].en) : u);
  const pct = (v: string | number) => <bdi>{`${num(Number(v), lang)}%`}</bdi>;
  const dealSub = splitTitle(quote.opportunity.title, customerName).sub || (customerName ? "" : quote.opportunity.title);
  const revisionText = (n: number) => `${ar ? "المراجعة" : "Revision"} ${n}`;

  // ── The figures: the local preview while lines are unsaved, otherwise the server's. ──
  const fig = {
    subtotal: dirty ? preview.subtotal.toFixed(2) : quote.subtotal,
    discount: dirty ? preview.discountTotal.toFixed(2) : quote.discountTotal,
    tax: dirty ? preview.taxTotal.toFixed(2) : quote.taxTotal,
    grand: dirty ? preview.grandTotal.toFixed(2) : quote.grandTotal,
  };
  // The base VAT is charged on. The design names it, because "subtotal minus discount" is the
  // figure a customer queries and it was only implied.
  const taxableBase = (
    (dirty ? preview.subtotal : Number(quote.subtotal)) -
    (dirty ? preview.discountTotal : Number(quote.discountTotal))
  ).toFixed(2);
  const hasDiscount = Number(fig.discount) > 0;
  const rates = Array.from(new Set((editable ? lines.map((l) => l.taxRatePercent) : quote.lines.map((l) => l.taxRatePercent)).map((r) => Number(r))));
  const vatLabel = <>{ar ? "ضريبة القيمة المضافة" : "VAT"}{rates.length === 1 && <> {pct(rates[0])}</>}</>;
  const unit = quote.currency === "SAR" ? (ar ? "ر.س" : "SAR") : quote.currency;
  const minus = (v: string) => (Number(v) > 0 ? `−${formatMoney(v)}` : formatMoney(v));

  // ── Notices ──
  const notices = (
    <>
      {error && (
        <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 16 }}>
          {error}<button type="button" onClick={() => setError("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
      {success && (
        <p className="notice ok" role="status" data-testid="alert-success" style={{ marginBottom: 16 }}>
          {success}<button type="button" onClick={() => setSuccess("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
    </>
  );

  // ── The facts under the title, each its own element so the bidi algorithm cannot move a
  //    separator between two numerals. ──
  const dealHref = `/dashboard/sales/deals/${quote.opportunity.id}`;
  const meta: React.ReactNode[] = [
    <span key="st" className={`st ${STATUS_DOT[quote.status] ?? ""}`} data-testid="quote-status">{statusLabel(quote.status)}</span>,
    <span key="who">
      {customerName && <bdi>{customerName}</bdi>}
      {customerName && dealSub && " · "}
      {dealSub && <Link href={dealHref} style={{ color: "inherit" }}><bdi>{dealSub}</bdi></Link>}
      {customerName && !dealSub && <> · <Link href={dealHref} style={{ color: "inherit" }}>{ar ? "الصفقة" : "deal"}</Link></>}
    </span>,
    ...(editable || quote.revision > 1 ? [<span key="rev">{revisionText(quote.revision)}</span>] : []),
    ...(quote.issuedAt ? [<span key="iss">{ar ? "صادر " : "Issued "}<bdi className="n">{formatDay(quote.issuedAt, lang)}</bdi></span>] : []),
    ...(quote.validUntil ? [<span key="valid">{ar ? "صالح حتى " : "Valid until "}{shortDate(quote.validUntil, lang)}</span>] : []),
    ...(state.expired && quote.status === "ISSUED" ? [<span key="lapsed" className="flag wa">{ar ? "انتهت الصلاحية" : "Lapsed"}</span>] : []),
    ...(quote.discountApprovedAt ? [<span key="disc" className="flag ok">{ar ? "خصم معتمد" : "Discount approved"}</span>] : []),
    ...(dirty && editable ? [<span key="dirty" className="flag wa" role="status">{ar ? "تغييرات غير محفوظة" : "Unsaved changes"}</span>] : []),
  ];

  // ── Actions, in the frame's order: the secondary ones first, the page's primary last. ──
  const issueLabel = needsApproval && can.approveDiscount
    ? (ar ? "اعتماد الخصم وإصدار العرض" : "Approve discount and issue")
    : (ar ? "إصدار العرض" : "Issue");
  const saveBtn = editable ? (
    <button type="button" className="btn" onClick={save} disabled={busy || lines.length === 0} data-testid="save-quote">
      {ar ? "حفظ" : "Save"}
    </button>
  ) : null;
  const issueBtn = quote.status === "DRAFT" && can.write ? (
    <button
      type="button"
      className="btn p"
      disabled={busy || dirty || lines.length === 0}
      title={dirty ? (ar ? "احفظ أولاً" : "Save first") : undefined}
      onClick={() => transition("ISSUED")}
      data-testid="issue-quote"
    >
      {issueLabel}
    </button>
  ) : null;
  // Accepting closes the deal Won, so it follows the deal-close privilege.
  const acceptBtn = quote.status === "ISSUED" && can.write && can.close ? (
    <button type="button" className="btn p" disabled={busy} onClick={() => transition("ACCEPTED")} data-testid="accept-quote">
      {ar ? "قَبِل العميل" : "Customer accepted"}
    </button>
  ) : null;
  const rejectBtn = quote.status === "ISSUED" && can.write ? (
    <button type="button" className="btn" disabled={busy} onClick={() => setDialog("reject")} data-testid="reject-quote">
      {ar ? "رفَضه العميل" : "Customer rejected"}
    </button>
  ) : null;
  const reviseBtn = state.revisable && can.write ? (
    <button type="button" className="btn" disabled={busy} data-testid="revise-quote" onClick={revise}>
      {ar ? "إنشاء مراجعة" : "Raise a revision"}
    </button>
  ) : null;
  const orderBtn = state.orderable && can.createOrder ? (
    <button type="button" className="btn p" disabled={busy} onClick={() => setDialog("order")} data-testid="create-order">
      {ar ? "تحويل إلى طلب" : "Convert to an order"}
    </button>
  ) : null;
  // An accepted quotation is the document a collection is recorded against, but the collection
  // belongs to the DEAL — one deal can have revisions, and the money is owed on the deal, not on
  // a piece of paper. So this is a route back rather than a second place to record one.
  const collectionLink = quote.status === "ACCEPTED" ? (
    <Link href={`${dealHref}#collections`} data-testid="go-to-collection" className="btn">
      {ar ? "تسجيل تحصيل على الصفقة" : "Record a collection on the deal"}
    </Link>
  ) : null;
  const docLink = quote.issuedSnapshot != null ? <QuoteDocumentLink id={quote.id} ar={ar} /> : null;

  // ── Blocks ──
  const discountBand = editable && needsApproval ? (
    <div className="callout wa" role="note" data-testid="discount-approval-notice">
      <span>
        <b>
          {can.approveDiscount
            ? (ar ? "الخصم فوق الحدّ — اعتمادك مطلوب." : "Discount above the limit — your approval is required.")
            : (ar ? "الخصم يتجاوز صلاحيتك — يحتاج اعتماداً." : "The discount is beyond your authority — it needs approval.")}
        </b>{" "}
        {ar
          ? `الخصم الفعّال ${preview.discountPercent.toFixed(2)}% وحدّ الاعتماد ${threshold}%، ` +
            (can.approveDiscount
              ? "والإصدار يسجّل اعتمادك على العرض."
              : "والإصدار يُرفض حتى يصدره مديرٌ لديه صلاحية اعتماد الخصم؛ العرض يبقى مسودة.")
          : `The effective discount is ${preview.discountPercent.toFixed(2)}% against a ${threshold}% limit; ` +
            (can.approveDiscount
              ? "issuing records your approval."
              : "issuing is refused until a manager with discount approval does it, and the quotation stays a draft.")}
      </span>
    </div>
  ) : null;

  const recordNotes = (
    <>
      {quote.rejectionNote && (
        <p className="notice" style={{ marginBottom: 18 }}>{(ar ? "سبب الرفض: " : "Rejected because: ") + quote.rejectionNote}</p>
      )}
      {quote.orderLinks.length > 0 && (
        <p className="notice ok" style={{ marginBottom: 18 }}>
          {ar ? "أُنشئ الطلب " : "Order raised: "}
          <bdi className="n">{quote.orderLinks.map((l) => `#${l.order.orderNumber}`).join(", ")}</bdi>
        </p>
      )}
    </>
  );

  const addLine = editable && (!phone || phoneEdit) ? (
    <button
      type="button"
      className="lk-inline"
      onClick={() => { setLines([...lines, emptyLine()]); setDirty(true); }}
      data-testid="add-line"
    >
      {ar ? "إضافة بند" : "Add line"}
    </button>
  ) : null;

  const linesHeader = (
    <div className="q-bh">
      <h2 className="bt">{ar ? "البنود" : "Lines"}</h2>
      {editable ? (
        <span className="sub">
          {ar ? `الضريبة تُحسب لكل بند بعد الخصم · خصم البند حتى ${DISCOUNT_MAX}%` : `Tax per line after discount · line discount up to ${DISCOUNT_MAX}%`}
        </span>
      ) : quote.issuedAt ? (
        <span className="sub">{ar ? "مثبّتة كما أُرسلت للعميل" : "Frozen as sent to the customer"}</span>
      ) : null}
      {addLine}
    </div>
  );

  const emptyLines = (
    <p className="lbl" style={{ padding: "24px 0", textAlign: "center", fontWeight: 400 }}>
      {ar ? "لا توجد بنود. أضف بنداً لتسعير العرض." : "No lines yet. Add one to price the quotation."}
    </p>
  );

  const editTable = (
    <div className="q-scroll">
      <table className="t q-lines ed" style={{ minWidth: 700 }}>
        <thead>
          <tr>
            <th scope="col">{ar ? "المنتج" : "Product"}</th>
            <th scope="col" style={{ width: 72 }}>{ar ? "الكمية" : "Qty"}</th>
            <th scope="col" style={{ width: 76 }}>{ar ? "الوحدة" : "Unit"}</th>
            <th scope="col" style={{ width: 96 }}>{ar ? "سعر الوحدة" : "Unit price"}</th>
            <th scope="col" style={{ width: 64 }}>{ar ? "خصم" : "Disc."}</th>
            <th scope="col" style={{ width: 64 }}>{ar ? "ضريبة" : "Tax"}</th>
            <th scope="col" style={{ width: 140 }}>{ar ? "الإجمالي شامل الضريبة" : "Total incl. VAT"}</th>
            <th scope="col" className="x"><span className="sr-only">{ar ? "حذف" : "Remove"}</span></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
            const net = gross - (gross * (Number(l.discountPercent) || 0)) / 100;
            const lineTotal = net + (net * (Number(l.taxRatePercent) || 0)) / 100;
            const over = Number(l.discountPercent) > Number(threshold);
            const sku = skus.find((s) => s.id === l.productSkuId);
            return (
              <tr key={i} data-testid={`line-${i}`}>
                <td className="prod">
                  <Select
                    aria-label={ar ? `المنتج للبند ${i + 1}` : `Product for line ${i + 1}`}
                    value={l.productSkuId}
                    onChange={(e) => chooseSku(i, e.target.value)}
                    className="qi prodsel"
                  >
                    <option value="">{ar ? "— وصف حر —" : "— free text —"}</option>
                    {skus.map((s) => (
                      <option key={s.id} value={s.id}>
                        {(ar ? s.nameAr : null) ?? s.name ?? s.skuCode}
                      </option>
                    ))}
                  </Select>
                  {sku && <span className="id">{sku.skuCode}</span>}
                  {!l.productSkuId && (
                    <input
                      aria-label={ar ? `وصف البند ${i + 1}` : `Description for line ${i + 1}`}
                      value={l.description}
                      placeholder={ar ? "وصف البند" : "What is being quoted"}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                      className="qi desc"
                    />
                  )}
                </td>
                <td>
                  <input
                    aria-label={ar ? `كمية البند ${i + 1}` : `Quantity for line ${i + 1}`}
                    value={l.quantity}
                    inputMode="decimal"
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                    className="qi num"
                  />
                </td>
                <td>
                  <Select
                    aria-label={ar ? `وحدة البند ${i + 1}` : `Unit for line ${i + 1}`}
                    value={l.unit}
                    onChange={(e) => setLine(i, { unit: e.target.value })}
                    className="qi"
                  >
                    <option value="KG">{unitLabel("KG")}</option>
                    <option value="UNIT">{unitLabel("UNIT")}</option>
                    <option value="GRAM">{unitLabel("GRAM")}</option>
                  </Select>
                </td>
                <td>
                  <input
                    aria-label={ar ? `سعر وحدة البند ${i + 1}` : `Unit price for line ${i + 1}`}
                    value={l.unitPrice}
                    inputMode="decimal"
                    onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                    className="qi num"
                  />
                </td>
                {/* A line whose own discount is past the threshold is marked where the number is. */}
                <td className={over ? "wa" : undefined} title={over ? (ar ? `خصم السطر فوق حدّ ${threshold}%` : `Line discount is over the ${threshold}% threshold`) : undefined}>
                  <span className="pctw" dir="ltr"><input
                    aria-label={ar ? `خصم البند ${i + 1}` : `Discount for line ${i + 1}`}
                    aria-describedby={over ? `over-${i}` : undefined}
                    value={l.discountPercent}
                    inputMode="decimal"
                    onChange={(e) => setLine(i, { discountPercent: e.target.value })}
                    className="qi num pct"
                  /><span className="sfx" aria-hidden>%</span></span>
                  {over && (
                    <span id={`over-${i}`} className="sr-only">
                      {ar ? `خصم السطر فوق حدّ ${threshold}%` : `line discount is over the ${threshold}% threshold`}
                    </span>
                  )}
                </td>
                <td>
                  <span className="pctw" dir="ltr"><input
                    aria-label={ar ? `ضريبة البند ${i + 1}` : `Tax for line ${i + 1}`}
                    value={l.taxRatePercent}
                    inputMode="decimal"
                    onChange={(e) => setLine(i, { taxRatePercent: e.target.value })}
                    className="qi num pct"
                  /><span className="sfx" aria-hidden>%</span></span>
                </td>
                <td data-testid={`line-total-${i}`}><bdi className="n">{formatMoney(lineTotal.toFixed(2))}</bdi></td>
                <td className="x">
                  <button
                    type="button"
                    className="ib"
                    aria-label={ar ? `حذف البند ${i + 1}` : `Remove line ${i + 1}`}
                    data-testid={`remove-line-${i}`}
                    onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}
                  >
                    <Ico name="close" small />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  /* A quotation that can no longer be edited is a record, not a form, and its figures are the
     SERVER's, not the local recompute the editor previews with. */
  const readTable = (
    <div className="q-scroll">
      <table className="t q-lines" style={{ minWidth: 640 }} data-testid="quote-lines-readonly">
        <thead>
          <tr>
            <th scope="col">{ar ? "المنتج" : "Product"}</th>
            <th scope="col">{ar ? "الكمية" : "Qty"}</th>
            <th scope="col">{ar ? "سعر الوحدة" : "Unit price"}</th>
            <th scope="col">{ar ? "خصم" : "Disc."}</th>
            <th scope="col">{ar ? "ضريبة" : "Tax"}</th>
            <th scope="col">{ar ? "الإجمالي" : "Total"}</th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((l) => (
            <tr key={l.id} data-testid={`ro-line-${l.position}`}>
              <td className="prod">
                <b>{l.productSku?.name ?? l.description ?? "—"}</b>
                {l.productSku && <span className="id">{l.productSku.skuCode}</span>}
              </td>
              <td><bdi className="n">{num(Number(l.quantity), lang)}</bdi> {unitLabel(l.unit)}</td>
              <td><bdi className="n">{formatMoney(l.unitPrice)}</bdi></td>
              <td><bdi className="n">{Number(l.discountPercent) > 0 ? pct(l.discountPercent) : "—"}</bdi></td>
              <td><bdi className="n">{pct(l.taxRatePercent)}</bdi></td>
              <td><bdi className="n">{formatMoney(l.lineTotal)}</bdi></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const issuedNote = quote.issuedAt ? (
    <p className="lbl" style={{ fontWeight: 400, marginTop: 10 }}>
      {ar ? "صدر في " : "Issued "}
      <bdi className="n">{formatDay(quote.issuedAt, lang)}</bdi>
      {ar
        ? " — البنود والأسعار المثبّتة محفوظة كما أُرسلت للعميل."
        : " — the lines and prices sent to the customer are frozen as they were."}
      {quote.status === "ISSUED" && (ar ? " القبول يجعل الصفقة رابحة." : " Acceptance marks the deal won.")}
    </p>
  ) : null;

  const previewNote = dirty ? (
    <p className="q-note">
      {ar
        ? "معاينة محلية. الأرقام المعتمدة هي التي يحسبها الخادم عند الحفظ."
        : "Local preview. The figures that count are the server's, computed on save."}
    </p>
  ) : null;

  const totals = (
    <div>
      <div className="q-bh"><h2 className="bt">{ar ? "الإجمالي" : "Totals"}</h2></div>
      <dl className="q-props" data-testid="quote-totals">
        {(editable || hasDiscount) && (
          <>
            <dt>{ar ? "المجموع قبل الخصم" : "Subtotal"}</dt><dd><bdi className="n">{formatMoney(fig.subtotal)}</bdi></dd>
            <dt>{ar ? "الخصم" : "Discount"}</dt><dd><bdi className="n">{minus(fig.discount)}</bdi></dd>
          </>
        )}
        <dt>{editable || hasDiscount ? (ar ? "الوعاء الخاضع للضريبة" : "Taxable base") : (ar ? "قبل الضريبة" : "Before VAT")}</dt>
        <dd><bdi className="n">{formatMoney(taxableBase)}</bdi></dd>
        <dt>{vatLabel}</dt><dd><bdi className="n">{formatMoney(fig.tax)}</bdi></dd>
        <dt>{ar ? "الإجمالي" : "Total"}</dt>
        <dd className="grand"><bdi>{formatMoney(fig.grand)}</bdi><span className="unit">{unit}</span></dd>
      </dl>
      {previewNote}
    </div>
  );

  /* The facts a quotation is written against. Read-only on purpose: the customer comes from the
     deal, the date is when the draft was raised, and the currency is fixed (SAR) — the service
     refuses anything else. Only the validity date is the editor's. */
  const facts = editable ? (
    <div>
      <div className="q-bh"><h2 className="bt">{ar ? "البيانات" : "Facts"}</h2></div>
      <dl className="q-props facts">
        <dt>{ar ? "العميل" : "Customer"}</dt><dd><bdi>{customerName ?? "—"}</bdi></dd>
        <dt>{ar ? "الصفقة" : "Deal"}</dt>
        <dd>
          <Link href={dealHref} style={{ color: "inherit" }}><bdi>{quote.opportunity.title}</bdi></Link>
          {quote.opportunity.owner && <> · {quote.opportunity.owner.name}</>}
        </dd>
        <dt>{ar ? "تاريخ العرض" : "Quote date"}</dt><dd><bdi className="n">{formatDay(quote.createdAt ?? null, lang)}</bdi></dd>
        <dt>{ar ? "العملة" : "Currency"}</dt><dd>{ar ? "ريال سعودي (SAR) فقط" : "Saudi riyal (SAR) only"}</dd>
        <dt><label htmlFor="q-valid">{ar ? "صالح حتى" : "Valid until"}</label></dt>
        <dd>
          <input
            id="q-valid"
            type="date"
            className="q-date"
            aria-describedby="q-valid-hint"
            value={validUntil}
            onChange={(e) => { setValidUntil(e.target.value); setDirty(true); }}
          />
          <span id="q-valid-hint" className="q-note" style={{ display: "block", marginTop: 4 }}>
            {ar ? "مطلوب قبل الإصدار." : "Required before the quotation can be issued."}
          </span>
        </dd>
      </dl>
    </div>
  ) : null;

  /* ── The revision chain ──
     A revision does not replace its predecessor, it supersedes it: the old quotation stays,
     marked, because it is the document a customer was actually sent. */
  const showChain = !editable || quote.supersedes != null || quote.supersededBy != null;
  const chainLink = (r: { id: string; quoteNumber: string; revision: number }) => (
    <Link href={`/dashboard/sales/quotes/${r.id}`}>
      <span className="id">{r.quoteNumber}</span> · {revisionText(r.revision)}
    </Link>
  );
  const chainRows: [string, React.ReactNode][] = [
    [ar ? "الأحدث" : "Latest", quote.supersededBy
      ? <>{chainLink(quote.supersededBy)} · <span className={`st ${STATUS_DOT[quote.supersededBy.status] ?? ""}`}>{statusLabel(quote.supersededBy.status)}</span></>
      : "—"],
    [ar ? "المعروضة الآن" : "Shown here",
      <><span className="id">{quote.quoteNumber}</span> · {revisionText(quote.revision)} · {statusLabel(quote.status)}</>],
    [ar ? "السابقة" : "Earlier", quote.supersedes
      ? <>{chainLink(quote.supersedes)} · <span className="st x">{statusLabel("SUPERSEDED")}</span></>
      : "—"],
  ];
  const chain = showChain ? (
    <div>
      <div className="q-bh">
        <h2 className="bt">{ar ? "سجلّ المراجعات" : "Revisions"}</h2>
        <span className="sub">{ar ? "السابقة تصبح «مستبدَل» ولا تُحذف" : "The earlier one becomes «superseded», not deleted"}</span>
      </div>
      {phone ? (
        <dl className="phrows" data-testid="revision-chain" style={{ marginTop: 0 }}>
          {chainRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      ) : (
        <dl className="q-props facts" data-testid="revision-chain">
          {chainRows.map(([k, v]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></span>)}
        </dl>
      )}
    </div>
  ) : null;

  const dialogs = (
    <>
      {dialog === "reject" && (
        <RejectDialog ar={ar} busy={busy} quoteNumber={quote.quoteNumber} customer={customerName}
          onClose={() => setDialog(null)} onSubmit={(n) => transition("REJECTED", n)} />
      )}
      {dialog === "order" && (
        <OrderDialog
          ar={ar}
          quoteId={id}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setSuccess(msg);
            reload();
          }}
        />
      )}
    </>
  );

  // ── Phone (390): the facts line, lines as rows, figures as label/value rows, the band, and
  //    the frame's sticky bar. Functions the 390 frames leave to the desktop stay under «⋯». ──
  if (phone) {
    const editingHere = editable && phoneEdit;
    const primary = issueBtn ?? orderBtn ?? acceptBtn ?? (!rejectBtn ? reviseBtn : null);
    const secondary = editingHere ? saveBtn : (rejectBtn ?? collectionLink);
    const moreItems: React.ReactNode[] = [];
    if (editable && !phoneEdit) moreItems.push(
      <button key="edit" type="button" role="menuitem" data-testid="phone-edit-lines" onClick={() => { setMore(false); setPhoneEdit(true); }}>
        {ar ? "تعديل البنود هنا" : "Edit the lines here"}
      </button>,
    );
    if (reviseBtn && primary !== reviseBtn) moreItems.push(
      <button key="rev" type="button" role="menuitem" disabled={busy} data-testid="revise-quote" onClick={() => { setMore(false); revise(); }}>
        {ar ? "إنشاء مراجعة" : "Raise a revision"}
      </button>,
    );
    if (collectionLink && secondary !== collectionLink) moreItems.push(
      <Link key="col" role="menuitem" href={`${dealHref}#collections`} data-testid="go-to-collection">
        {ar ? "تسجيل تحصيل على الصفقة" : "Record a collection on the deal"}
      </Link>,
    );
    if (quote.issuedSnapshot != null) moreItems.push(
      <Link key="doc" role="menuitem" href={`/dashboard/sales/quotes/${quote.id}/print`} data-testid="open-print">
        {ar ? "مستند العرض" : "Quotation document"}
      </Link>,
    );
    const phoneRows = editable
      ? lines.map((l, i) => {
          const sku = skus.find((s) => s.id === l.productSkuId);
          const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
          const net = gross - (gross * (Number(l.discountPercent) || 0)) / 100;
          return {
            key: String(i),
            name: (sku ? ((ar ? sku.nameAr : null) ?? sku.name ?? sku.skuCode) : l.description) || "—",
            qty: l.quantity, unit: l.unit, price: l.unitPrice, disc: l.discountPercent, tax: l.taxRatePercent,
            total: formatMoney((net + (net * (Number(l.taxRatePercent) || 0)) / 100).toFixed(2)),
          };
        })
      : quote.lines.map((l) => ({
          key: l.id, name: l.productSku?.name ?? l.description ?? "—",
          qty: l.quantity, unit: l.unit, price: l.unitPrice, disc: l.discountPercent, tax: l.taxRatePercent,
          total: formatMoney(l.lineTotal),
        }));

    return (
      <div className="pg">
        {notices}
        <div className="q-mmeta">
          {meta.map((m, i) => <span key={i} style={{ display: "contents" }}>{i > 0 && <span aria-hidden>·</span>}{m}</span>)}
        </div>
        {discountBand}
        {recordNotes}
        {linesHeader}
        {phoneRows.length === 0 ? emptyLines : editingHere ? (
          <>
            {editTable}
            <div style={{ marginTop: 16 }}>{facts}</div>
          </>
        ) : (
          <div data-testid="quote-lines-phone">
            {phoneRows.map((r) => (
              <div key={r.key} className="q-mline">
                <b>{r.name}</b>
                <span className="n">{r.total}</span>
                <div className="r2">
                  <span><bdi className="n">{num(Number(r.qty), lang)}</bdi> {unitLabel(r.unit)} × <bdi className="n">{formatMoney(String(r.price))}</bdi></span>
                  {Number(r.disc) > 0
                    ? <span className={Number(r.disc) > Number(threshold) ? "wa" : undefined}>{ar ? "خصم " : "Disc. "}{pct(r.disc)}</span>
                    : <span>{ar ? "ضريبة " : "Tax "}{pct(r.tax)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {editingHere && phoneRows.length === 0 && <div style={{ marginTop: 16 }}>{facts}</div>}
        <dl className="phrows" data-testid="quote-totals">
          {(editable || hasDiscount) ? (
            <>
              <div><dt>{ar ? "المجموع قبل الخصم" : "Subtotal"}</dt><dd><bdi className="n">{formatMoney(fig.subtotal)}</bdi></dd></div>
              <div><dt>{ar ? "الخصم" : "Discount"}</dt><dd><bdi className="n">{minus(fig.discount)}</bdi></dd></div>
            </>
          ) : (
            <div><dt>{ar ? "قبل الضريبة" : "Before VAT"}</dt><dd><bdi className="n">{formatMoney(taxableBase)}</bdi></dd></div>
          )}
          <div><dt>{vatLabel}</dt><dd><bdi className="n">{formatMoney(fig.tax)}</bdi></dd></div>
          <div className="grand"><dt>{ar ? "الإجمالي · ر.س" : "Total · SAR"}</dt><dd>{formatMoney(fig.grand)}</dd></div>
        </dl>
        {previewNote}
        {issuedNote}
        {chain && <div style={{ marginTop: 20 }}>{chain}</div>}
        <p className="q-band">
          {editable
            ? (ar ? "تعديل البنود والأسعار والخصم أسهل من سطح المكتب، وهو متاح هنا من «⋯»." : "Lines, prices and discounts are easier to edit on a desktop; here they are under «⋯».")
            : (ar ? "مستند العرض وإنشاء مراجعة من «⋯» أو من سطح المكتب." : "The document and revisions are under «⋯» or on the desktop.")}
        </p>
        {phoneBar && (
          <div className="sticky-act" data-q-more>
            {moreItems.length > 0 && (
              <div style={{ position: "relative" }}>
                <button type="button" className="btn" style={{ width: 44, padding: 0, justifyContent: "center" }}
                  aria-haspopup="menu" aria-expanded={more} aria-label={ar ? "المزيد" : "More"}
                  data-testid="quote-more" onClick={() => setMore((v) => !v)}>
                  <Ico name="more" small />
                </button>
                {more && <div className="menu" role="menu" style={{ insetInlineEnd: "auto", insetInlineStart: 0 }}>{moreItems}</div>}
              </div>
            )}
            {secondary}
            {primary && <div className="grow">{primary}</div>}
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="pg">
      {notices}
      <div className="ph q-ph">
        <div style={{ minWidth: 0 }}>
          <h1>{ar ? "عرض السعر" : "Quotation"}{" "}<span className="id">{quote.quoteNumber}</span></h1>
          <div className="meta">
            {meta.map((m, i) => <span key={i} style={{ display: "contents" }}>{i > 0 && <i />}{m}</span>)}
          </div>
        </div>
        <div className="act">
          {docLink}
          {reviseBtn}
          {collectionLink}
          {rejectBtn}
          {saveBtn}
          {issueBtn}
          {acceptBtn}
          {orderBtn}
        </div>
      </div>

      {discountBand}
      {recordNotes}

      <div className="q-cols">
        <section aria-label={ar ? "البنود" : "Lines"} style={{ minWidth: 0 }}>
          {linesHeader}
          {(editable ? lines.length === 0 : quote.lines.length === 0) ? emptyLines : editable ? editTable : readTable}
          {issuedNote}
        </section>
        <aside className="q-side">
          {totals}
          {facts}
          {chain}
        </aside>
      </div>
      {dialogs}
    </div>
  );
}

function RejectDialog({
  ar, busy, quoteNumber, customer, onClose, onSubmit,
}: {
  ar: boolean; busy: boolean; quoteNumber: string; customer: string | null;
  onClose: () => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title={ar ? "تسجيل رفض العميل" : "Record the customer's rejection"}
      onClose={onClose}
      testId="reject-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button variant="danger" disabled={busy || note.trim().length < 2} onClick={() => onSubmit(note)} testId="confirm-reject">
            {ar ? "تأكيد" : "Confirm"}
          </Button>
        </>
      }
    >
      <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
        <bdi className="id">{quoteNumber}</bdi>{customer && <> · <bdi>{customer}</bdi></>}
      </p>
      <p className="notice">
        {ar
          ? "تُسجَّل النتيجة على العرض ولا تُغلق الصفقة. يمكن إنشاء مراجعة جديدة لاحقًا."
          : "The outcome is recorded on the quotation and the deal stays open. A new revision can be raised later."}
      </p>
      <Field
        id="reject-note"
        label={ar ? "السبب" : "Reason"}
        required
        hint={ar ? "مطلوب، كما يُطلب سبب خسارة الصفقة." : "Required, for the same reason a lost deal needs one."}
      >
        <TextArea id="reject-note" value={note} onChange={setNote} rows={3} />
      </Field>
    </Modal>
  );
}

function OrderDialog({
  ar, quoteId, onClose, onDone,
}: {
  ar: boolean; quoteId: string; onClose: () => void; onDone: (message: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  return (
    <Modal
      title={ar ? "إنشاء طلب من العرض" : "Create the order"}
      onClose={onClose}
      testId="order-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy}
            testId="confirm-order"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api<{ message: string; orderNumber: number; replayed: boolean }>(
                `/api/sales/quotes/${quoteId}/create-order`,
                { method: "POST", body: { notes } },
              );
              setBusy(false);
              if (res.ok) onDone(res.data.message ?? (ar ? "أُنشئ الطلب." : "Order created."));
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "إنشاء الطلب" : "Create order"}
          </Button>
        </>
      }
    >
      {err && <p className="notice er" role="alert">{err}</p>}
      <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
        {ar
          ? "يُنشأ الطلب في نظام الطلبات عبر خدمة الطلبات نفسها، ببنود العرض وكمياته. الضغط مرتين لا يُنشئ طلبين."
          : "The order is created in the operational system through the order service itself, with this quotation's lines and quantities. Clicking twice does not make two orders."}
      </p>
      <Field id="ord-notes" label={ar ? "ملاحظات الطلب" : "Order notes"}>
        <TextArea id="ord-notes" value={notes} onChange={setNotes} rows={2} />
      </Field>
      <p className="lbl" style={{ fontWeight: 400, margin: 0, fontSize: 12 }}>
        {ar
          ? "البنود ذات الوصف الحر أو الكميات الكسرية للعبوات تُرفض، ويُذكر البند بالاسم."
          : "A free-text line, or a fractional pack count, is refused with the line named — not silently dropped."}
      </p>
    </Modal>
  );
}

/**
 * The link to the quotation document. Owner decision D1: printing is out of Phase 1, so while
 * the PRINT_CERTIFIED gate is off (or unknown) it is not offered as «Print»: it opens the
 * document, which stays viewable (and, per decision point D1-Q, savable as the customer's PDF).
 */
function QuoteDocumentLink({ id, ar }: { id: string; ar: boolean }) {
  const printing = usePrintCertified();
  return (
    <Link href={`/dashboard/sales/quotes/${id}/print`} data-testid="open-print" className="btn">
      {printing === true
        ? <><Printer size={16} aria-hidden /> {ar ? "طباعة" : "Print"}</>
        : <><FileText size={16} aria-hidden /> {ar ? "مستند العرض" : "Quotation document"}</>}
    </Link>
  );
}
