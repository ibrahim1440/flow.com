"use client";

import { useState, useEffect, useMemo, use } from "react";
import Link from "next/link";
import { ArrowLeft, Send, Check, X, Copy, ShoppingCart, Trash2, Printer, Lock, Wallet } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, Spinner,
  Button, Field, TextInput, TextArea, Money, Pill, Modal, TableWrap, api,
  QuoteStatusBadge, Td, num, formatDay,
} from "../../_components/ui";

/**
 * The quotation editor.
 *
 * ── The totals shown here are the server's ──
 * The row beneath the lines is computed locally so typing feels immediate, and it is
 * replaced by the server's figures the moment the lines are saved. Where the two disagree,
 * the server wins and the screen says so: a browser that decides a price is a browser that
 * can be asked to decide a different one.
 *
 * PROVISIONAL INTERFACE — see the banner.
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
type Can = { write: boolean; approveDiscount: boolean; createOrder: boolean };



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

  const preview = useMemo(() => previewTotals(lines), [lines]);
  const needsApproval = preview.discountPercent > Number(threshold);

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

  if (loading) return <Spinner />;
  if (!quote || !state || !can) {
    return (
      <div className="space-y-4">
        <Alert kind="error">{error || (ar ? "العرض غير موجود." : "Quotation not found.")}</Alert>
        <Link href="/dashboard/sales/quotes" className="text-oo-action-primary font-bold text-sm">
          {ar ? "كل عروض الأسعار" : "All quotations"}
        </Link>
      </div>
    );
  }

  const editable = state.editable && can.write;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <Link
        href={`/dashboard/sales/deals/${quote.opportunity.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-bold text-oo-text-secondary hover:text-oo-action-primary"
      >
        <ArrowLeft size={15} className="rtl:rotate-180" aria-hidden />
        {quote.opportunity.title}
      </Link>

      <PageHeader
        title={`${ar ? "عرض السعر " : "Quotation "}${quote.quoteNumber}`}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            {[
              quote.customer
                ? (ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name)
                : null,
              quote.issuedAt ? `${ar ? "صادر" : "issued"} ${formatDay(quote.issuedAt, lang)}` : null,
              quote.revision > 1
                ? `${ar ? "المراجعة" : "revision"} ${num(quote.revision, lang)}`
                : null,
              quote.validUntil
                ? `${ar ? "صالح حتى" : "valid until"} ${formatDay(quote.validUntil, lang)}`
                : null,
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="text-oo-border-strong">·</span>}
                  <span>{part}</span>
                </span>
              ))}
            {state.expired && quote.status === "ISSUED" && (
              <Pill tone="warn">{ar ? "انتهت الصلاحية" : "lapsed"}</Pill>
            )}
            {quote.discountApprovedAt && (
              <Pill tone="accent">{ar ? "خصم معتمد" : "discount approved"}</Pill>
            )}
          </span>
        }
        actions={
          <>
            {quote.issuedSnapshot != null && (
              <Link
                href={`/dashboard/sales/quotes/${quote.id}/print`}
                data-testid="open-print"
                className="inline-flex items-center gap-2 rounded-[10px] border border-oo-border-strong bg-oo-bg-default px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-oo-text-primary transition-colors hover:border-oo-action-primary"
              >
                <Printer size={15} aria-hidden /> {ar ? "طباعة" : "Print"}
              </Link>
            )}
            {editable && (
              <Button onClick={save} disabled={busy || lines.length === 0} testId="save-quote">
                {ar ? "حفظ" : "Save"}
              </Button>
            )}
            {quote.status === "DRAFT" && can.write && (
              <Button
                variant="secondary"
                disabled={busy || dirty || lines.length === 0}
                title={dirty ? (ar ? "احفظ أولاً" : "Save first") : undefined}
                onClick={() => transition("ISSUED")}
                testId="issue-quote"
              >
                <Send size={15} aria-hidden /> {ar ? "إصدار" : "Issue"}
              </Button>
            )}
            {quote.status === "ISSUED" && can.write && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => transition("ACCEPTED")}
                  testId="accept-quote"
                >
                  <Check size={15} aria-hidden /> {ar ? "قَبِل العميل" : "Customer accepted"}
                </Button>
                {/* Outlined, like the deal screen's "mark lost": recording a refusal is
                    ordinary work, and a solid red button reads as a warning about the act
                    rather than a record of what the customer said. */}
                <button
                  disabled={busy}
                  onClick={() => setDialog("reject")}
                  data-testid="reject-quote"
                  className="inline-flex items-center gap-2 rounded-[10px] border border-oo-status-rejected bg-oo-bg-default px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-oo-status-rejected transition-colors hover:bg-oo-status-rejected-bg disabled:opacity-50"
                >
                  <X size={15} aria-hidden /> {ar ? "رفَضه العميل" : "Customer rejected"}
                </button>
              </>
            )}
            {state.revisable && can.write && (
              <Button
                variant="secondary"
                disabled={busy}
                testId="revise-quote"
                onClick={async () => {
                  setBusy(true);
                  const res = await api<{ quote: { id: string } }>(`/api/sales/quotes/${id}/revise`, {
                    method: "POST",
                  });
                  setBusy(false);
                  if (res.ok) window.location.href = `/dashboard/sales/quotes/${res.data.quote.id}`;
                  else setError(res.data.error ?? "");
                }}
              >
                <Copy size={15} aria-hidden /> {ar ? "إنشاء مراجعة" : "Raise a revision"}
              </Button>
            )}
            {state.orderable && can.createOrder && (
              <Button disabled={busy} onClick={() => setDialog("order")} testId="create-order">
                <ShoppingCart size={15} aria-hidden /> {ar ? "تحويل إلى طلب" : "Convert to an order"}
              </Button>
            )}
            {/* An accepted quotation is the document a collection is recorded against, but
                the collection belongs to the DEAL — one deal can have revisions, and the
                money is owed on the deal, not on a piece of paper. So this is a route back
                rather than a second place to record one. Offered on the quotation because
                that is where somebody is standing when the customer pays. */}
            {quote.status === "ACCEPTED" && (
              <Link
                href={`/dashboard/sales/deals/${quote.opportunity.id}#collections`}
                data-testid="go-to-collection"
                className="inline-flex items-center gap-2 rounded-[10px] border border-oo-border-strong bg-oo-bg-default px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-oo-text-primary transition-colors hover:border-oo-action-primary hover:text-oo-action-primary"
              >
                <Wallet size={15} aria-hidden /> {ar ? "تسجيل تحصيل على الصفقة" : "Record a collection on the deal"}
              </Link>
            )}
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {/* Where the quotation stands, and what it comes to, on one line. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[18px] font-semibold leading-[28px]">
            <Money value={quote.grandTotal} currency={quote.currency} strong />
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[14px] leading-[22px] text-oo-text-secondary">
              {ar ? "الحالة الحالية" : "Current status"}
            </span>
            <QuoteStatusBadge status={quote.status} testId="quote-status" />
          </span>
        </div>
      </Card>

      {/* ── The revision chain ───────────────────────────────────────────────────────
          A revision does not replace its predecessor, it supersedes it: the old quotation
          stays, marked, because it is the document a customer was actually sent. Showing
          the chain is how a reader knows which one that was. */}
      {(quote.supersedes || quote.supersededBy) && (
        <Card>
          <SectionTitle>
            {ar
              ? "سجلّ المراجعات — النسخة السابقة تصبح «مستبدَل» ولا تُحذف"
              : "Revisions — the earlier one becomes superseded, it is not deleted"}
          </SectionTitle>
          <ul className="space-y-2" data-testid="revision-chain">
            {[
              quote.supersededBy
                ? { ...quote.supersededBy, self: false }
                : null,
              { id: quote.id, quoteNumber: quote.quoteNumber, revision: quote.revision, status: quote.status, self: true },
              quote.supersedes
                ? { ...quote.supersedes, status: "SUPERSEDED", self: false }
                : null,
            ]
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-oo-bg-subtle px-3 py-[9px]"
                >
                  <QuoteStatusBadge status={r.status} />
                  <span className="text-end">
                    {r.self ? (
                      <span className="text-[14px] font-medium leading-[22px] text-oo-text-primary">
                        {ar ? `المراجعة ${num(r.revision, lang)} — ` : `Revision ${r.revision} — `}
                        {r.quoteNumber}
                      </span>
                    ) : (
                      <Link
                        href={`/dashboard/sales/quotes/${r.id}`}
                        className="text-[14px] font-medium leading-[22px] text-oo-action-primary hover:underline"
                      >
                        {ar ? `المراجعة ${num(r.revision, lang)} — ` : `Revision ${r.revision} — `}
                        {r.quoteNumber}
                      </Link>
                    )}
                    {r.self && (
                      <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                        {ar ? "المعروضة الآن" : "the one shown here"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      )}
      {quote.rejectionNote && (
        <Alert kind="info">{(ar ? "سبب الرفض: " : "Rejected because: ") + quote.rejectionNote}</Alert>
      )}
      {quote.orderLinks.length > 0 && (
        <Alert kind="success">
          {ar ? "أُنشئ الطلب " : "Order raised: "}
          {quote.orderLinks.map((l) => `#${l.order.orderNumber}`).join(", ")}
        </Alert>
      )}
      {/* The design gives this its own amber card rather than a line of body text, because
          it is the one thing on the screen that changes what the Issue button will do. */}
      {editable && needsApproval && (
        <div
          className="flex items-start gap-2.5 rounded-[10px] border border-oo-status-waiting bg-oo-status-waiting-bg px-4 py-[10px]"
          role="note"
          data-testid="discount-approval-notice"
        >
          <Lock size={16} aria-hidden className="mt-0.5 shrink-0 text-oo-status-hold" />
          <div className="flex-1">
            <p className="text-[14px] font-medium leading-[22px] text-oo-status-hold">
              {can.approveDiscount
                ? (ar ? "الخصم فوق الحدّ — اعتمادك مطلوب" : "The discount is above the threshold — your approval applies")
                : (ar ? "الخصم يتجاوز صلاحيتك — يحتاج اعتماداً" : "The discount is beyond your authority — it needs approval")}
            </p>
            <p className="text-[12px] leading-[18px] text-oo-status-hold">
              {ar
                ? `الخصم الفعّال ${preview.discountPercent.toFixed(2)}% وحدّ الاعتماد ${threshold}%. ` +
                  (can.approveDiscount
                    ? "الإصدار يسجّل اعتمادك على العرض."
                    : "الإصدار يُرفض حتى يصدره مديرٌ لديه صلاحية اعتماد الخصم؛ العرض يبقى مسودة.")
                : `The effective discount is ${preview.discountPercent.toFixed(2)}% against a ${threshold}% threshold. ` +
                  (can.approveDiscount
                    ? "Issuing records your approval on the quotation."
                    : "Issuing is refused until a manager with discount approval does it; the quotation stays a draft.")}
            </p>
          </div>
        </div>
      )}

      {/* ── The facts a quotation is written against ────────────────────────────────
          Read-only on purpose. The customer comes from the deal, the date is when the
          draft was raised, and the currency is fixed: `QUOTE_CURRENCY` is SAR and the
          service refuses a collection in anything else because there is no exchange-rate
          policy to convert it with. Rendering them as editable fields would offer three
          choices the server does not accept. */}
      {editable && (
        <Card>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                ar ? "العميل" : "Customer",
                quote.customer ? (ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name) : "—",
              ],
              [ar ? "الصفقة" : "Deal", quote.opportunity.title],
              [ar ? "تاريخ العرض" : "Quotation date", formatDay(quote.createdAt ?? null, lang)],
              [
                ar ? "العملة" : "Currency",
                ar ? "ريال سعودي (SAR) — لا عملة أخرى" : "Saudi riyals (SAR) — no other currency",
              ],
            ].map(([label_, value]) => (
              <div key={label_} className="rounded-[10px] bg-oo-bg-subtle px-3 py-[9px]">
                <dt className="text-[12px] leading-[18px] text-oo-text-muted">{label_}</dt>
                <dd className="text-[14px] leading-[22px] text-oo-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {/* ── Lines ─────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle
          right={
            editable ? (
              <button
                onClick={() => {
                  setLines([...lines, emptyLine()]);
                  setDirty(true);
                }}
                className="text-xs font-bold text-oo-action-primary hover:underline"
                data-testid="add-line"
              >
                + {ar ? "بند" : "Line"}
              </button>
            ) : null
          }
        >
          {ar ? "البنود" : "Lines"}
        </SectionTitle>

        {lines.length === 0 ? (
          <p className="text-sm text-oo-text-muted font-semibold py-6 text-center">
            {ar ? "لا توجد بنود. أضف بنداً لتسعير العرض." : "No lines yet. Add one to price the quotation."}
          </p>
        ) : !editable ? (
          /* A quotation that can no longer be edited is a record, not a form. It was
             rendering the editor's inputs with `disabled` on them, which looks like a form
             that is merely broken — and the server has refused every one of those fields
             since the moment it was issued. The figures here are the SERVER's, not the
             local recompute the editor previews with. */
          <div className="-mx-5 mt-3 overflow-x-auto border-y border-oo-border-default">
            <table className="w-full min-w-[820px] border-collapse text-start" data-testid="quote-lines-readonly">
              <thead>
                <tr className="bg-oo-bg-subtle">
                  {[
                    [ar ? "المنتج / الوصف" : "Product / description", "min-w-[240px]"],
                    [ar ? "الكمية" : "Qty", "w-[110px]"],
                    [ar ? "سعر الوحدة" : "Unit price", "w-[140px]"],
                    [ar ? "خصم" : "Discount", "w-[100px]"],
                    [ar ? "ضريبة" : "Tax", "w-[100px]"],
                    [ar ? "الإجمالي" : "Total", "w-[150px]"],
                  ].map(([l, w], i) => (
                    <th
                      key={i}
                      scope="col"
                      className={`${w} px-4 py-[11px] text-start text-[12px] font-medium leading-[18px] text-oo-text-muted`}
                    >
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((l) => (
                  <tr key={l.id} className="border-t border-oo-border-default" data-testid={`ro-line-${l.position}`}>
                    <Td>
                      {l.productSku?.name ?? l.description ?? "—"}
                      {l.productSku && (
                        <span className="block font-mono text-[12px] leading-[18px] text-oo-text-muted">
                          {l.productSku.skuCode}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {num(Number(l.quantity), lang)} {l.unit}
                    </Td>
                    <Td><Money value={l.unitPrice} currency={quote.currency} /></Td>
                    <Td>
                      {Number(l.discountPercent) > 0
                        ? ar
                          ? `${num(Number(l.discountPercent), "ar")}%`
                          : `${l.discountPercent}%`
                        : "—"}
                    </Td>
                    <Td>
                      {ar ? `${num(Number(l.taxRatePercent), "ar")}%` : `${l.taxRatePercent}%`}
                    </Td>
                    <Td><Money value={l.lineTotal} currency={quote.currency} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TableWrap>
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="bg-oo-bg-subtle text-[12px] font-medium leading-[18px] text-oo-text-muted">
                  <th className="pe-4 text-start py-2 w-[26%]">{ar ? "المنتج / الوصف" : "Product / description"}</th>
                  <th className="pe-4 text-end py-2 w-[10%]">{ar ? "الكمية" : "Qty"}</th>
                  <th className="pe-4 text-start py-2 w-[9%]">{ar ? "الوحدة" : "Unit"}</th>
                  <th className="pe-4 text-end py-2 w-[13%]">{ar ? "سعر الوحدة" : "Unit price"}</th>
                  <th className="pe-4 text-end py-2 w-[9%]">{ar ? "خصم %" : "Disc %"}</th>
                  <th className="pe-4 text-end py-2 w-[9%]">{ar ? "ضريبة %" : "Tax %"}</th>
                  <th className="pe-4 text-end py-2 w-[14%]">{ar ? "الإجمالي" : "Total"}</th>
                  <th className="pe-4 w-[4%]" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
                  const net = gross - (gross * (Number(l.discountPercent) || 0)) / 100;
                  const lineTotal = net + (net * (Number(l.taxRatePercent) || 0)) / 100;
                  return (
                    <tr key={i} className="border-t border-oo-border-default align-top" data-testid={`line-${i}`}>
                      <td className="py-2 pe-2">
                        <select
                          aria-label={ar ? `المنتج للبند ${i + 1}` : `Product for line ${i + 1}`}
                          value={l.productSkuId}
                          disabled={!editable}
                          onChange={(e) => chooseSku(i, e.target.value)}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs bg-oo-bg-default disabled:bg-oo-bg-subtle"
                        >
                          <option value="">{ar ? "— وصف حر —" : "— free text —"}</option>
                          {skus.map((s) => (
                            <option key={s.id} value={s.id}>
                              {(ar ? s.nameAr : null) ?? s.name ?? s.skuCode}
                            </option>
                          ))}
                        </select>
                        {!l.productSkuId && (
                          <input
                            aria-label={ar ? `وصف البند ${i + 1}` : `Description for line ${i + 1}`}
                            value={l.description}
                            disabled={!editable}
                            placeholder={ar ? "وصف البند" : "What is being quoted"}
                            onChange={(e) => setLine(i, { description: e.target.value })}
                            className="w-full mt-1 px-2 py-2 border border-oo-border-strong rounded-lg text-xs disabled:bg-oo-bg-subtle"
                          />
                        )}
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `كمية البند ${i + 1}` : `Quantity for line ${i + 1}`}
                          value={l.quantity}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { quantity: e.target.value })}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs text-end tabular-nums disabled:bg-oo-bg-subtle"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <select
                          aria-label={ar ? `وحدة البند ${i + 1}` : `Unit for line ${i + 1}`}
                          value={l.unit}
                          disabled={!editable}
                          onChange={(e) => setLine(i, { unit: e.target.value })}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs disabled:bg-oo-bg-subtle"
                        >
                          <option value="KG">KG</option>
                          <option value="UNIT">{ar ? "عبوة" : "UNIT"}</option>
                          <option value="GRAM">GRAM</option>
                        </select>
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `سعر وحدة البند ${i + 1}` : `Unit price for line ${i + 1}`}
                          value={l.unitPrice}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs text-end tabular-nums disabled:bg-oo-bg-subtle"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `خصم البند ${i + 1}` : `Discount for line ${i + 1}`}
                          value={l.discountPercent}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { discountPercent: e.target.value })}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs text-end tabular-nums disabled:bg-oo-bg-subtle"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `ضريبة البند ${i + 1}` : `Tax for line ${i + 1}`}
                          value={l.taxRatePercent}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { taxRatePercent: e.target.value })}
                          className="w-full px-2 py-2 border border-oo-border-strong rounded-lg text-xs text-end tabular-nums disabled:bg-oo-bg-subtle"
                        />
                      </td>
                      <td className="pe-4 py-2 text-end" data-testid={`line-total-${i}`}>
                        <Money value={lineTotal.toFixed(2)} currency={quote.currency} />
                        {/* A line whose own discount is past the threshold, marked where the
                            number is rather than only in the notice above. */}
                        {Number(l.discountPercent) > Number(threshold) && (
                          <span className="block text-[12px] leading-[18px] text-oo-status-rejected">
                            {ar
                              ? `خصم السطر فوق حدّ ${threshold}%`
                              : `line discount is over the ${threshold}% threshold`}
                          </span>
                        )}
                      </td>
                      <td className="pe-4 py-2 text-center">
                        {editable && (
                          <button
                            aria-label={ar ? `حذف البند ${i + 1}` : `Remove line ${i + 1}`}
                            data-testid={`remove-line-${i}`}
                            onClick={() => {
                              setLines(lines.filter((_, j) => j !== i));
                              setDirty(true);
                            }}
                            className="text-oo-text-muted hover:text-oo-status-rejected"
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div className="mt-4 grid sm:grid-cols-2 gap-4 items-start">
          <div className="space-y-3">
            {editable ? (
              <Field
                id="q-valid"
                label={ar ? "صالح حتى" : "Valid until"}
                hint={ar ? "مطلوب قبل الإصدار." : "Required before the quotation can be issued."}
              >
                <TextInput
                  id="q-valid"
                  type="date"
                  value={validUntil}
                  onChange={(v) => {
                    setValidUntil(v);
                    setDirty(true);
                  }}
                />
              </Field>
            ) : (
              <div className="rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[14px] leading-[22px] text-oo-text-primary">
                <span className="text-oo-text-muted">{ar ? "صالح حتى: " : "Valid until: "}</span>
                {quote.validUntil ? formatDay(quote.validUntil, lang) : "—"}
              </div>
            )}
            {dirty && editable && (
              <p className="text-[11px] text-oo-status-hold font-bold" role="status">
                {ar ? "تغييرات غير محفوظة." : "Unsaved changes."}
              </p>
            )}
          </div>

          <dl className="bg-oo-bg-subtle rounded-xl p-4 space-y-2 text-sm" data-testid="quote-totals">
            <Total
              label={ar ? "المجموع قبل الخصم" : "Subtotal"}
              value={dirty ? preview.subtotal.toFixed(2) : quote.subtotal}
              currency={quote.currency}
            />
            <Total
              label={ar ? "الخصم" : "Discount"}
              value={"-" + (dirty ? preview.discountTotal.toFixed(2) : quote.discountTotal)}
              currency={quote.currency}
            />
            {/* The base VAT is charged on. The design names it, because "subtotal minus
                discount" is the figure a customer queries and it was only implied. */}
            <Total
              label={ar ? "الوعاء الخاضع للضريبة" : "Taxable base"}
              value={(
                (dirty ? preview.subtotal : Number(quote.subtotal)) -
                (dirty ? preview.discountTotal : Number(quote.discountTotal))
              ).toFixed(2)}
              currency={quote.currency}
            />
            <Total
              label={ar ? "ضريبة القيمة المضافة" : "VAT"}
              value={dirty ? preview.taxTotal.toFixed(2) : quote.taxTotal}
              currency={quote.currency}
            />
            <div className="border-t border-oo-border-default pt-2 flex items-baseline justify-between gap-3">
              <dt className="text-[14px] font-medium leading-[22px] text-oo-text-primary">
                {ar ? "الإجمالي" : "Grand total"}
              </dt>
              <dd className="text-[18px] leading-[28px]">
                <Money value={dirty ? preview.grandTotal.toFixed(2) : quote.grandTotal} currency={quote.currency} strong />
              </dd>
            </div>
            {dirty && (
              <p className="text-[10px] text-oo-text-muted font-semibold">
                {ar
                  ? "معاينة محلية. الأرقام المعتمدة هي التي يحسبها الخادم عند الحفظ."
                  : "Local preview. The figures that count are the server's, computed on save."}
              </p>
            )}
          </dl>
        </div>
      </Card>

      {quote.issuedAt && (
        <p className="text-[12px] leading-[18px] text-oo-text-muted">
          {ar ? "صدر في " : "Issued "}
          {formatDay(quote.issuedAt, lang)}
          {ar
            ? " — البنود والأسعار المُثبّتة محفوظة كما أُرسلت للعميل."
            : " — the lines and prices sent to the customer are frozen as they were."}
        </p>
      )}

      {dialog === "reject" && (
        <RejectDialog ar={ar} busy={busy} onClose={() => setDialog(null)} onSubmit={(n) => transition("REJECTED", n)} />
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
    </div>
  );
}

function Total({ label, value, currency }: { label: string; value: string; currency: string }) {
  // Negative-signed values ("-125.00" for a discount) keep their sign through the
  // formatter, which is why the sign is part of the string rather than part of the label.
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[14px] leading-[22px] text-oo-text-secondary">{label}</dt>
      <dd className="text-[14px] leading-[22px]">
        <Money value={value} currency={currency} />
      </dd>
    </div>
  );
}

function RejectDialog({
  ar, busy, onClose, onSubmit,
}: {
  ar: boolean; busy: boolean; onClose: () => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title={ar ? "تسجيل رفض العميل" : "Record the rejection"}
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
      <Field
        id="reject-note"
        label={ar ? "السبب" : "Reason"}
        required
        hint={ar ? "مطلوب، للسبب نفسه الذي يجعل سبب خسارة الصفقة مطلوباً." : "Required, for the same reason a lost deal needs one."}
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
      {err && <Alert kind="error">{err}</Alert>}
      <p className="text-sm text-oo-text-secondary font-medium">
        {ar
          ? "يُنشأ الطلب في نظام الطلبات عبر خدمة الطلبات نفسها، ببنود العرض وكمياته. الضغط مرتين لا يُنشئ طلبين."
          : "The order is created in the operational system through the order service itself, with this quotation's lines and quantities. Clicking twice does not make two orders."}
      </p>
      <Field id="ord-notes" label={ar ? "ملاحظات الطلب" : "Order notes"}>
        <TextArea id="ord-notes" value={notes} onChange={setNotes} rows={2} />
      </Field>
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "البنود ذات الوصف الحر أو الكميات الكسرية للعبوات تُرفض، ويُذكر البند بالاسم."
          : "A free-text line, or a fractional pack count, is refused with the line named — not silently dropped."}
      </p>
    </Modal>
  );
}
