"use client";

// «الصفقة» on the order card, with «اربط بصفقة» for an order that has none (owner, option A — «طلب مباشر»). The list says
// whether the order has a deal; the dialog asks the server which deals the caller may choose (the customer's OPEN / WON
// deals in their scope) and offers «صفقة جديدة تلقائية» (a deal opened for the order: WON, «تلقائي: طلب مباشر»). Who may
// link is the server's answer (GET /api/orders/[id]/deal `can.link`); the button is not shown otherwise.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";

type Deal = { id: string; title: string; outcome: string; updatedAt: string; owner: { id: string; name: string } | null; stage: { nameAr: string; nameEn: string } | null };
type Options = { linked: { id: string; title: string; outcome: string } | null; can: { link: boolean }; deals: Deal[]; receipts?: string };
const NEW = "__new__";

export function DealLinkControl({ orderId, orderNumber, deal, canLink, lang, onSuccess }: {
  orderId: string; orderNumber: number;
  deal: { id: string; title: string; outcome: string } | null;
  /** The same rule as the server (the order's owner, or the all-sales view: lead_assign / the admin's template). */
  canLink: boolean;
  lang: "ar" | "en"; onSuccess: () => void;
}) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const [opts, setOpts] = useState<Options | null>(null);
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(NEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outcome = (o: string) => (o === "WON" ? L("رابحة", "Won") : o === "LOST" ? L("خاسرة", "Lost") : L("مفتوحة", "Open"));

  async function load(): Promise<Options | null> {
    const r = await fetch(`/api/orders/${encodeURIComponent(orderId)}/deal`, { cache: "no-store" });
    const j = r.ok ? ((await r.json()) as Options) : null;
    setOpts(j); setChecked(true);
    return j;
  }
  async function openDialog() {
    setError(null);
    const j = opts ?? (await load());
    setChoice(j?.deals.find((d) => d.outcome === "OPEN")?.id ?? NEW);
    setOpen(true);
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await fetch(`/api/orders/${encodeURIComponent(orderId)}/deal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opportunityId: choice === NEW ? null : choice }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(ar ? j.error ?? `HTTP ${r.status}` : j.errorEn ?? j.error ?? `HTTP ${r.status}`); return; }
    setOpen(false); setOpts(null); setChecked(false);
    onSuccess();
  }

  if (deal) {
    return (
      <span data-testid={`order-deal-${orderNumber}`}>
        <Link href={`/dashboard/sales/deals/${encodeURIComponent(deal.id)}`}><bdi>{deal.title}</bdi></Link>
        <span className="hr-muted"> · {outcome(deal.outcome)}</span>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} data-testid={`order-deal-${orderNumber}`}>
      <span className="hr-muted">{L("بدون صفقة — لا تحصيل ولا عمولة", "No deal — no collection, no commission")}</span>
      {canLink && (!checked || opts?.can.link) ? (
        <button type="button" className="hr-btn is-sm" onClick={openDialog} data-testid={`order-deal-link-${orderNumber}`}>{L("اربط بصفقة", "Link to a deal")}</button>
      ) : null}
      <Dialog open={open} title={L("ربط الطلب بصفقة", "Link the order to a deal")} onClose={() => { if (!busy) setOpen(false); }} testId="order-deal-dialog"
        actions={<>
          <button type="button" className="hr-btn is-primary" disabled={busy || !opts?.can.link} onClick={save} data-testid="order-deal-save">{L("ربط", "Link")}</button>
          <button type="button" className="hr-btn" disabled={busy} onClick={() => setOpen(false)}>{L("رجوع", "Back")}</button>
        </>}>
        {error ? <div className="hr-notice tone-danger" role="alert">{error}</div> : null}
        {opts && Number(opts.receipts ?? 0) > 0 ? <div className="hr-notice tone-warning" role="status" data-testid="order-deal-receipts">{L(`على فواتير هذا الطلب سندات قبض بمبلغ ${opts.receipts} ر.س؛ تُخصم مما يُحصَّل على الصفقة.`, `This order's invoices already carry receipts of ${opts.receipts} SAR; they are subtracted from what the deal can collect.`)}</div> : null}
                {opts && !opts.can.link ? <div className="hr-notice" role="status">{L("ربط الطلب لصاحب الطلب أو المشرف أو المدير.", "Only the order's owner, a supervisor or the admin links an order.")}</div> : null}
        <p className="hr-caption" style={{ margin: 0 }}>
          {L("اختر صفقة للعميل نفسه، أو «صفقة جديدة تلقائية»: تُفتح رابحة باسم «طلب مباشر» وقيمتها قيمة الطلب شاملة الضريبة (سعر الكتالوج). بعدها يُسجَّل التحصيل وتُحتسب العمولة كأي طلب من عرض سعر.",
            "Choose a deal of the same customer, or «a new deal»: opened as won («direct order»), valued at the order's total incl. VAT (catalogue price). Collections and commission then work as for an order from a quotation.")}
        </p>
        <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="hr-label">{L("الصفقة", "Deal")}</span>
          <Select className="hr-select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!opts} data-testid="order-deal-select">
            <option value={NEW}>{L("صفقة جديدة تلقائية", "A new deal (automatic)")}</option>
            {(opts?.deals ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.title} · {outcome(d.outcome)}{d.owner ? ` · ${d.owner.name}` : ""}</option>
            ))}
          </Select>
        </label>
      </Dialog>
    </span>
  );
}

/**
 * The order form's «الصفقة» (owner, option A): which deal the new order joins. One open deal → it (said, nothing to pick);
 * several → the creator picks (default the newest, the server's own default); none → a deal is opened for the order.
 */
export function OrderDealPicker({ customerId, lang, value, onChange }: { customerId: string | null; lang: "ar" | "en"; value: string; onChange: (v: string) => void }) {
  const ar = lang === "ar";
  // Keyed by the customer they belong to, so a late answer for a previous customer is never shown for the current one.
  const [got, setGot] = useState<{ for: string; deals: { id: string; title: string; owner: { name: string } | null }[] } | null>(null);
  useEffect(() => {
    if (!customerId) return;
    let off = false;
    fetch(`/api/orders/deal-options?customerId=${encodeURIComponent(customerId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { deals: [] }))
      .then((j: { deals: { id: string; title: string; owner: { name: string } | null }[] }) => { if (!off) setGot({ for: customerId, deals: j.deals ?? [] }); })
      .catch(() => { if (!off) setGot({ for: customerId, deals: [] }); });
    return () => { off = true; };
  }, [customerId]);
  const deals = customerId && got?.for === customerId ? got.deals : null;
  if (!deals) return null;
  if (deals.length === 0) {
    return <p className="hr-caption" style={{ margin: 0 }} data-testid="order-deal-hint">{ar ? "ما عند العميل صفقة مفتوحة: تُفتح صفقة للطلب تلقائيًا (رابحة، «طلب مباشر») حتى يُسجَّل التحصيل وتُحتسب العمولة." : "The customer has no open deal: one is opened for the order (won, «direct order») so collections and commission work."}</p>;
  }
  if (deals.length === 1) {
    return <p className="hr-caption" style={{ margin: 0 }} data-testid="order-deal-hint">{ar ? "يرتبط الطلب بصفقة العميل المفتوحة: " : "The order joins the customer's open deal: "}<bdi>{deals[0].title}</bdi></p>;
  }
  return (
    <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="hr-label">{ar ? "الصفقة" : "Deal"}</span>
      <Select className="hr-select" value={value} onChange={(e) => onChange(e.target.value)} data-testid="order-deal-choice">
        {deals.map((d, i) => <option key={d.id} value={i === 0 ? "" : d.id}>{d.title}{d.owner ? ` · ${d.owner.name}` : ""}{i === 0 ? (ar ? " (الأحدث)" : " (newest)") : ""}</option>)}
      </Select>
    </label>
  );
}
