"use client";

import { useState, useEffect, useCallback, useMemo, use } from "react";
import Link from "next/link";
import { ArrowLeft, Send, Check, X, Copy, ShoppingCart, Trash2, Printer } from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, Spinner,
  Button, Field, TextInput, TextArea, Money, Pill, Modal, TableWrap, api, formatMoney,
  QuoteStatusBadge,
} from "../../_components/ui";
import { formatDate } from "@/lib/utils";

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

  const load = useCallback(async () => {
    const res = await api<{
      quote: Quote; state: State; can: Can; discountThresholdPercent: string;
    }>(`/api/sales/quotes/${id}`);
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
  }, [id, ar]);

  useEffect(() => {
    load();
  }, [load]);

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
    await load();
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
    load();
  }

  if (loading) return <Spinner />;
  if (!quote || !state || !can) {
    return (
      <div className="space-y-4">
        <Alert kind="error">{error || (ar ? "العرض غير موجود." : "Quotation not found.")}</Alert>
        <Link href="/dashboard/sales/quotes" className="text-orange font-bold text-sm">
          {ar ? "كل عروض الأسعار" : "All quotations"}
        </Link>
      </div>
    );
  }

  const editable = state.editable && can.write;

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <Link
        href={`/dashboard/sales/deals/${quote.opportunity.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-bold text-brown hover:text-orange"
      >
        <ArrowLeft size={15} className="rtl:rotate-180" aria-hidden />
        {quote.opportunity.title}
      </Link>

      <PageHeader
        title={`${quote.quoteNumber}${quote.revision > 1 ? ` · r${quote.revision}` : ""}`}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap mt-1">
            <QuoteStatusBadge status={quote.status} testId="quote-status" />
            {state.expired && quote.status === "ISSUED" && (
              <Pill tone="warn">{ar ? "انتهت الصلاحية" : "lapsed"}</Pill>
            )}
            {quote.discountApprovedAt && (
              <Pill tone="accent">{ar ? "خصم معتمد" : "discount approved"}</Pill>
            )}
            {quote.customer && (
              <span className="font-bold text-charcoal">
                {ar ? (quote.customer.nameAr ?? quote.customer.name) : quote.customer.name}
              </span>
            )}
          </span>
        }
        actions={
          <>
            {quote.issuedSnapshot != null && (
              <Link
                href={`/dashboard/sales/quotes/${quote.id}/print`}
                data-testid="open-print"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold bg-white border-2 border-border text-charcoal hover:border-orange active:scale-[0.98] transition-all"
              >
                <Printer size={15} aria-hidden /> {ar ? "المستند" : "Document"}
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
                <Button disabled={busy} onClick={() => transition("ACCEPTED")} testId="accept-quote">
                  <Check size={15} aria-hidden /> {ar ? "قَبِل العميل" : "Accepted"}
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setDialog("reject")} testId="reject-quote">
                  <X size={15} aria-hidden /> {ar ? "رُفض" : "Rejected"}
                </Button>
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
                <Copy size={15} aria-hidden /> {ar ? "مراجعة جديدة" : "Revise"}
              </Button>
            )}
            {state.orderable && can.createOrder && (
              <Button disabled={busy} onClick={() => setDialog("order")} testId="create-order">
                <ShoppingCart size={15} aria-hidden /> {ar ? "إنشاء طلب" : "Create order"}
              </Button>
            )}
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {quote.supersededBy && (
        <Alert kind="info">
          {ar ? "استُبدل هذا العرض بـ " : "Superseded by "}
          <Link href={`/dashboard/sales/quotes/${quote.supersededBy.id}`} className="underline font-bold">
            {quote.supersededBy.quoteNumber}
          </Link>
          {` (r${quote.supersededBy.revision})`}
        </Alert>
      )}
      {quote.supersedes && (
        <p className="text-xs text-brown/70 font-semibold">
          {ar ? "يراجع " : "Revises "}
          <Link href={`/dashboard/sales/quotes/${quote.supersedes.id}`} className="underline">
            {quote.supersedes.quoteNumber}
          </Link>
        </p>
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
      {editable && needsApproval && (
        <Alert kind="info">
          {ar
            ? `الخصم ${preview.discountPercent.toFixed(2)}% أعلى من ${threshold}% المسموح بها بدون اعتماد، فالإصدار يحتاج مديراً لديه صلاحية اعتماد الخصم.`
            : `This discounts ${preview.discountPercent.toFixed(2)}%, above the ${threshold}% allowed without approval — a manager with discount approval must issue it.`}
        </Alert>
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
                className="text-xs font-bold text-orange hover:underline"
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
          <p className="text-sm text-brown/50 font-semibold py-6 text-center">
            {ar ? "لا توجد بنود. أضف بنداً لتسعير العرض." : "No lines yet. Add one to price the quotation."}
          </p>
        ) : (
          <TableWrap>
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2 w-[26%]">{ar ? "المنتج / الوصف" : "Product / description"}</th>
                  <th className="text-end py-2 w-[10%]">{ar ? "الكمية" : "Qty"}</th>
                  <th className="text-start py-2 w-[9%]">{ar ? "الوحدة" : "Unit"}</th>
                  <th className="text-end py-2 w-[13%]">{ar ? "سعر الوحدة" : "Unit price"}</th>
                  <th className="text-end py-2 w-[9%]">{ar ? "خصم %" : "Disc %"}</th>
                  <th className="text-end py-2 w-[9%]">{ar ? "ضريبة %" : "Tax %"}</th>
                  <th className="text-end py-2 w-[14%]">{ar ? "الإجمالي" : "Total"}</th>
                  <th className="w-[4%]" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
                  const net = gross - (gross * (Number(l.discountPercent) || 0)) / 100;
                  const lineTotal = net + (net * (Number(l.taxRatePercent) || 0)) / 100;
                  return (
                    <tr key={i} className="border-t border-border align-top" data-testid={`line-${i}`}>
                      <td className="py-2 pe-2">
                        <select
                          aria-label={ar ? `المنتج للبند ${i + 1}` : `Product for line ${i + 1}`}
                          value={l.productSkuId}
                          disabled={!editable}
                          onChange={(e) => chooseSku(i, e.target.value)}
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs bg-white disabled:bg-cream/40"
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
                            className="w-full mt-1 px-2 py-2 border-2 border-border rounded-lg text-xs disabled:bg-cream/40"
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
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs text-end tabular-nums disabled:bg-cream/40"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <select
                          aria-label={ar ? `وحدة البند ${i + 1}` : `Unit for line ${i + 1}`}
                          value={l.unit}
                          disabled={!editable}
                          onChange={(e) => setLine(i, { unit: e.target.value })}
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs disabled:bg-cream/40"
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
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs text-end tabular-nums disabled:bg-cream/40"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `خصم البند ${i + 1}` : `Discount for line ${i + 1}`}
                          value={l.discountPercent}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { discountPercent: e.target.value })}
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs text-end tabular-nums disabled:bg-cream/40"
                        />
                      </td>
                      <td className="py-2 pe-2">
                        <input
                          aria-label={ar ? `ضريبة البند ${i + 1}` : `Tax for line ${i + 1}`}
                          value={l.taxRatePercent}
                          inputMode="decimal"
                          disabled={!editable}
                          onChange={(e) => setLine(i, { taxRatePercent: e.target.value })}
                          className="w-full px-2 py-2 border-2 border-border rounded-lg text-xs text-end tabular-nums disabled:bg-cream/40"
                        />
                      </td>
                      <td className="py-2 text-end tabular-nums font-bold" data-testid={`line-total-${i}`}>
                        {formatMoney(lineTotal.toFixed(2))}
                      </td>
                      <td className="py-2 text-center">
                        {editable && (
                          <button
                            aria-label={ar ? `حذف البند ${i + 1}` : `Remove line ${i + 1}`}
                            data-testid={`remove-line-${i}`}
                            onClick={() => {
                              setLines(lines.filter((_, j) => j !== i));
                              setDirty(true);
                            }}
                            className="text-brown/50 hover:text-red-600"
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
            <Field
              id="q-valid"
              label={ar ? "صالح حتى" : "Valid until"}
              hint={ar ? "مطلوب قبل الإصدار." : "Required before the quotation can be issued."}
            >
              <TextInput
                id="q-valid"
                type="date"
                value={validUntil}
                disabled={!editable}
                onChange={(v) => {
                  setValidUntil(v);
                  setDirty(true);
                }}
              />
            </Field>
            {dirty && editable && (
              <p className="text-[11px] text-amber-700 font-bold" role="status">
                {ar ? "تغييرات غير محفوظة." : "Unsaved changes."}
              </p>
            )}
          </div>

          <dl className="bg-cream/50 rounded-xl p-4 space-y-2 text-sm" data-testid="quote-totals">
            <Total label={ar ? "المجموع قبل الخصم" : "Subtotal"} value={(dirty ? preview.subtotal.toFixed(2) : quote.subtotal)} />
            <Total label={ar ? "الخصم" : "Discount"} value={"-" + (dirty ? preview.discountTotal.toFixed(2) : quote.discountTotal)} />
            <Total label={ar ? "الضريبة" : "Tax"} value={dirty ? preview.taxTotal.toFixed(2) : quote.taxTotal} />
            <div className="border-t border-border pt-2 flex items-baseline justify-between gap-3">
              <dt className="font-extrabold text-charcoal">{ar ? "الإجمالي" : "Grand total"}</dt>
              <dd className="text-lg">
                <Money value={dirty ? preview.grandTotal.toFixed(2) : quote.grandTotal} currency={quote.currency} />
              </dd>
            </div>
            {dirty && (
              <p className="text-[10px] text-brown/60 font-semibold">
                {ar
                  ? "معاينة محلية. الأرقام المعتمدة هي التي يحسبها الخادم عند الحفظ."
                  : "Local preview. The figures that count are the server's, computed on save."}
              </p>
            )}
          </dl>
        </div>
      </Card>

      {quote.issuedAt && (
        <p className="text-[11px] text-brown/60 font-medium">
          {ar ? "صدر في " : "Issued "}
          {formatDate(quote.issuedAt)}
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
            load();
          }}
        />
      )}
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  // Negative-signed values ("-125.00" for a discount) keep their sign through the
  // formatter, which is why the sign is part of the string rather than part of the label.
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs font-bold text-brown/70">{label}</dt>
      <dd className="tabular-nums font-bold">{formatMoney(value)}</dd>
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
      <p className="text-sm text-brown font-medium">
        {ar
          ? "يُنشأ الطلب في نظام الطلبات عبر خدمة الطلبات نفسها، ببنود العرض وكمياته. الضغط مرتين لا يُنشئ طلبين."
          : "The order is created in the operational system through the order service itself, with this quotation's lines and quantities. Clicking twice does not make two orders."}
      </p>
      <Field id="ord-notes" label={ar ? "ملاحظات الطلب" : "Order notes"}>
        <TextArea id="ord-notes" value={notes} onChange={setNotes} rows={2} />
      </Field>
      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "البنود ذات الوصف الحر أو الكميات الكسرية للعبوات تُرفض، ويُذكر البند بالاسم."
          : "A free-text line, or a fractional pack count, is refused with the line named — not silently dropped."}
      </p>
    </Modal>
  );
}
