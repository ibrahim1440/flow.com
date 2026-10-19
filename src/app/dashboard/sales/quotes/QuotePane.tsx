"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { pick, QUOTE_STATUS_SPECS, formatMoney, num, api } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { shortDate } from "@/components/d21/format";

/**
 * The quotation preview of `crm-quotes` (1440 `181:1609`, docked beside the list; over it from
 * 1024 to 1279): the customer, the deal and the owner, the discount-approval band, the lines
 * before discount, the totals, and the frame's footer («اعتماد الخصم وإصدار العرض» ·
 * «تعديل البنود»). It reads the quotation's own record (GET /api/sales/quotes/:id) and acts
 * through the same endpoints the quotation page uses:
 *   · POST /api/sales/quotes/:id/discount-approval — approve or refuse the discount (approvers);
 *   · POST /api/sales/quotes/:id/transition {to: ISSUED} — issue (after an approval).
 * Every rule is the server's; the pane only offers what `can` / `discount.state` allow.
 */

type Line = {
  id: string; description: string | null; quantity: string; unit: string; unitPrice: string;
  discountPercent: string; taxRatePercent: string; lineSubtotal: string; lineTotal: string; position: number;
  productSku: { skuCode: string; name: string | null; nameAr: string | null } | null;
};
type Detail = {
  quote: {
    id: string; quoteNumber: string; revision: number; status: string; validUntil: string | null;
    subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string;
    discountRejectionNote: string | null;
    customer: { name: string; nameAr: string | null } | null;
    opportunity: { id: string; title: string; owner: { name: string } | null };
    lines: Line[];
  };
  state: { editable: boolean };
  can: { write: boolean; approveDiscount: boolean; approveThisDiscount: boolean };
  discount: { state: "NOT_NEEDED" | "PENDING" | "APPROVED" | "REJECTED"; approvedBy: string | null; rejectedBy: string | null };
  discountThresholdPercent: string;
};

const UNIT: Record<string, { ar: string; en: string }> = { KG: { ar: "كغ", en: "kg" }, UNIT: { ar: "عبوة", en: "pack" }, GRAM: { ar: "غ", en: "g" } };
const DOT: Record<string, string> = { ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x" };

export function QuotePane({
  id, lang, onClose, onChanged,
}: {
  id: string; lang: "ar" | "en"; onClose: () => void; onChanged: (message: string) => void;
}) {
  const ar = lang === "ar";
  const [data, setData] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [token, setToken] = useState(0);
  const head = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Detail>(`/api/sales/quotes/${id}`);
      if (cancelled) return;
      if (res.ok) { setData(res.data); setFailed(false); } else setFailed(true);
    })();
    return () => { cancelled = true; };
  }, [id, token]);
  useEffect(() => { if (data) head.current?.focus(); }, [data?.quote.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function decide(decision: "APPROVE" | "REJECT", thenIssue = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await api<{ state: string }>(`/api/sales/quotes/${id}/discount-approval`, {
      method: "POST", body: { decision, note: decision === "REJECT" ? reason : undefined },
    });
    if (!r.ok) { setBusy(false); setError(r.data.error ?? ""); return; }
    if (thenIssue) {
      const t = await api(`/api/sales/quotes/${id}/transition`, { method: "POST", body: { to: "ISSUED" } });
      setBusy(false);
      setToken((n) => n + 1);
      if (!t.ok) {
        // The approval stands (it is recorded and audited); only the issue was refused.
        setError((ar ? "اعتُمد الخصم، لكن تعذّر الإصدار: " : "The discount is approved, but issuing was refused: ") + (t.data.error ?? ""));
        onChanged(ar ? "اعتُمد الخصم." : "Discount approved.");
        return;
      }
      onChanged(ar ? "اعتُمد الخصم وصدر العرض." : "Discount approved and the quotation issued.");
      return;
    }
    setBusy(false);
    setRejecting(false);
    setReason("");
    setToken((n) => n + 1);
    onChanged(decision === "APPROVE" ? (ar ? "اعتُمد الخصم." : "Discount approved.") : (ar ? "رُفض الخصم." : "Discount refused."));
  }

  const q = data?.quote;
  const customer = q?.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : null;
  const pct = (v: string | number) => <bdi>{`${num(Number(v), lang)}%`}</bdi>;
  const effective = q && Number(q.subtotal) > 0 ? (Number(q.discountTotal) * 100) / Number(q.subtotal) : 0;
  const effText = `${(Math.round(effective * 100) / 100).toString()}%`;
  const rates = q ? Array.from(new Set(q.lines.map((l) => Number(l.taxRatePercent)))) : [];
  const st = data?.discount.state;
  const canDecide = !!data && st !== undefined && (st === "PENDING" || st === "REJECTED") && data.can.approveThisDiscount && q?.status === "DRAFT";
  const unit = (u: string) => (UNIT[u] ? (ar ? UNIT[u].ar : UNIT[u].en) : u);

  return (
    <aside className="pane q-pane" aria-label={ar ? "معاينة عرض السعر" : "Quotation preview"} data-testid="quote-pane">
      <div className="pane-h">
        {q ? (
          <span className="lbl" style={{ fontWeight: 400 }}>
            <bdi className="id">{q.quoteNumber}</bdi> {ar ? "المراجعة" : "revision"} <bdi className="n">{q.revision}</bdi>
          </span>
        ) : <span className="lbl">{ar ? "عرض سعر" : "Quotation"}</span>}
        <span className="sp" />
        <Link href={`/dashboard/sales/quotes/${id}`} className="lk" data-testid="open-quote-page">
          {ar ? "فتح الصفحة" : "Open page"} <Ico name="back" small className="fwd" />
        </Link>
        <button type="button" className="ib" onClick={onClose} aria-label={ar ? "إغلاق المعاينة" : "Close preview"} data-testid="close-quote-pane">
          <Ico name="close" small />
        </button>
      </div>
      <div className="pane-b">
        {failed ? (
          <p className="notice er" role="alert">{ar ? "تعذّر تحميل العرض." : "Could not load the quotation."}</p>
        ) : !data || !q ? (
          <p className="lbl" role="status" style={{ fontWeight: 400 }}>{ar ? "جارٍ التحميل…" : "Loading…"}</p>
        ) : (
          <>
            <h2 ref={head} tabIndex={-1} className="pane-t"><bdi>{customer ?? q.opportunity.title}</bdi></h2>
            <div className="meta" style={{ marginTop: 0, marginBottom: 20 }}>
              <span className={`st ${DOT[q.status] ?? ""}`}>{pick(QUOTE_STATUS_SPECS, q.status, lang)}</span>
              <span>
                {ar ? "صفقة " : "Deal "}<bdi>{q.opportunity.title}</bdi>
                {q.opportunity.owner && <> · {q.opportunity.owner.name}</>}
              </span>
            </div>
            {error && <p className="notice er" role="alert" style={{ marginBottom: 12 }}>{error}</p>}

            {st === "PENDING" || st === "REJECTED" ? (
              <div className="callout wa q-approval" data-testid="pane-discount-band" style={{ marginBottom: 24 }}>
                <span>
                  {st === "REJECTED" ? (
                    <>
                      <b>{ar ? "رُفض الخصم" : "Discount refused"}</b>
                      {data.discount.rejectedBy && <> · {data.discount.rejectedBy}</>}
                      {q.discountRejectionNote && <>: <bdi>{q.discountRejectionNote}</bdi></>}
                      {ar ? ". يعدّل المندوب الخصم ثم يُعاد طلبه." : ". The rep changes the discount, which asks again."}
                    </>
                  ) : canDecide ? (
                    <>
                      <b>{ar ? "الخصم فوق الحدّ — اعتمادك مطلوب." : "Discount above the limit — your approval is required."}</b>{" "}
                      {ar
                        ? <>حدّ الاعتماد <bdi>{data.discountThresholdPercent}%</bdi>، والإصدار يسجّل اعتمادك.</>
                        : <>The approval limit is {data.discountThresholdPercent}%; issuing records your approval.</>}
                    </>
                  ) : (
                    <>
                      <b>{ar ? "بانتظار اعتماد الخصم." : "Waiting for discount approval."}</b>{" "}
                      {ar
                        ? <>حدّ الاعتماد <bdi>{data.discountThresholdPercent}%</bdi>؛ يعتمده مدير لديه صلاحية اعتماد الخصم.</>
                        : <>The limit is {data.discountThresholdPercent}%; a manager with discount approval decides it.</>}
                    </>
                  )}
                </span>
                <span className="flag wa q-dflag">{ar ? "خصم " : "Discount "}<bdi className="n">{effText}</bdi></span>
                {canDecide && !rejecting && (
                  <span className="q-approval-acts">
                    <button type="button" className="btn sm" disabled={busy} onClick={() => decide("APPROVE")} data-testid="pane-approve-only">
                      {ar ? "اعتماد فقط" : "Approve only"}
                    </button>
                    {st === "PENDING" && (
                      <button type="button" className="btn sm g" disabled={busy} onClick={() => setRejecting(true)} data-testid="pane-reject">
                        {ar ? "رفض الخصم" : "Refuse"}
                      </button>
                    )}
                  </span>
                )}
                {rejecting && (
                  <span className="q-approval-acts" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <label className="lbl" htmlFor="pane-reason" style={{ fontWeight: 400 }}>{ar ? "سبب الرفض (يراه المندوب)" : "Reason (the rep sees it)"}</label>
                    <textarea id="pane-reason" className="q-notes" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <span style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="btn sm" disabled={busy || reason.trim().length < 2} onClick={() => decide("REJECT")} data-testid="pane-confirm-reject">
                        {ar ? "تأكيد الرفض" : "Confirm"}
                      </button>
                      <button type="button" className="btn sm g" onClick={() => setRejecting(false)}>{ar ? "إلغاء" : "Cancel"}</button>
                    </span>
                  </span>
                )}
              </div>
            ) : st === "APPROVED" && q.status === "DRAFT" ? (
              <p className="notice ok" style={{ marginBottom: 24 }} data-testid="pane-discount-approved">
                {ar ? "اعتُمد الخصم" : "Discount approved"} <bdi className="n">{effText}</bdi>
                {data.discount.approvedBy && <> · {data.discount.approvedBy}</>}
              </p>
            ) : null}

            <table className="q-pane-lines">
              <thead><tr><th scope="col">{ar ? "البند" : "Item"}</th><th scope="col" className="num">{ar ? "قبل الخصم · ر.س" : "Before discount · SAR"}</th></tr></thead>
              <tbody>
                {q.lines.map((l) => {
                  const name = l.productSku ? ((ar ? l.productSku.nameAr : null) ?? l.productSku.name ?? l.productSku.skuCode) : (l.description ?? "—");
                  const gross = (Number(l.quantity) * Number(l.unitPrice)).toFixed(2);
                  const over = Number(l.discountPercent) > Number(data.discountThresholdPercent);
                  return (
                    <tr key={l.id}>
                      <td>
                        <b><bdi>{name}</bdi></b>
                        <span className="sm">
                          <bdi className="n">{num(Number(l.quantity), lang)}</bdi> {unit(l.unit)} × <bdi className="n">{formatMoney(l.unitPrice)}</bdi>
                          {Number(l.discountPercent) > 0 && <> · <span className={over ? "wa" : undefined}>{ar ? "خصم " : "disc. "}{pct(l.discountPercent)}</span></>}
                          {" · "}{ar ? "ضريبة " : "VAT "}{pct(l.taxRatePercent)}
                        </span>
                      </td>
                      <td className="num">{formatMoney(gross)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <dl className="q-props q-pane-tot" data-testid="pane-totals">
              <dt>{ar ? "المجموع قبل الخصم" : "Subtotal"}</dt><dd><bdi className="n">{formatMoney(q.subtotal)}</bdi></dd>
              {Number(q.discountTotal) > 0 && (<><dt>{ar ? "الخصم " : "Discount "}<bdi>{effText}</bdi></dt><dd><bdi className="n">−{formatMoney(q.discountTotal)}</bdi></dd></>)}
              <dt>{ar ? "الوعاء الخاضع للضريبة" : "Taxable base"}</dt>
              <dd><bdi className="n">{formatMoney((Number(q.subtotal) - Number(q.discountTotal)).toFixed(2))}</bdi></dd>
              <dt>{ar ? "ضريبة القيمة المضافة" : "VAT"}{rates.length === 1 && <> {pct(rates[0])}</>}</dt><dd><bdi className="n">{formatMoney(q.taxTotal)}</bdi></dd>
              <dt className="g">{ar ? "الإجمالي · ر.س" : "Total · SAR"}</dt><dd className="g"><bdi className="n">{formatMoney(q.grandTotal)}</bdi></dd>
            </dl>
            <p className="sm" style={{ marginTop: 14, color: "var(--text-muted)", fontSize: 12.5 }}>
              {q.validUntil && <>{ar ? "صالح حتى " : "Valid until "}{shortDate(q.validUntil, lang)} · </>}
              {q.status === "DRAFT" ? (ar ? "تُثبَّت الأسعار عند الإصدار" : "prices are frozen at issue") : (ar ? "الأسعار مثبّتة كما صدرت" : "prices frozen as issued")}
            </p>
          </>
        )}
      </div>
      {data && q && (
        <div className="pane-f">
          {canDecide && st === "PENDING" ? (
            <button type="button" className="btn p" disabled={busy} aria-busy={busy || undefined} onClick={() => decide("APPROVE", true)} data-testid="pane-approve-issue">
              {ar ? "اعتماد الخصم وإصدار العرض" : "Approve discount and issue"}
            </button>
          ) : q.status === "DRAFT" && data.can.write && st !== "PENDING" && st !== "REJECTED" ? (
            <Link href={`/dashboard/sales/quotes/${id}`} className="btn p">{ar ? "متابعة وإصدار" : "Continue and issue"}</Link>
          ) : null}
          {q.status === "DRAFT" && data.can.write ? (
            <Link href={`/dashboard/sales/quotes/${id}`} className="btn" data-testid="pane-edit-lines">{ar ? "تعديل البنود" : "Edit lines"}</Link>
          ) : (
            <Link href={`/dashboard/sales/quotes/${id}`} className="btn">{ar ? "فتح العرض" : "Open quotation"}</Link>
          )}
        </div>
      )}
    </aside>
  );
}
