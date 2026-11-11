"use client";

// A new invoice draft: «فاتورة يدوية» (Figma ZT-14) or «إنشاء فاتورة من الطلب» (?orderId=…, the order's lines with
// what is ordered, delivered, already invoiced and left; full, partial or delivered-only). Saving creates a DRAFT
// (no number) and opens it; issuing is a separate, privileged step on the draft.
import { NewCustomerDialog, type CreatedCustomer } from "@/components/customers/new-customer-form";
import { canEdit, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { useUser } from "@/app/dashboard/user-context";
import { canIssueInvoices } from "@/lib/services/invoicing/access";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { InvShell, Msg, money, useApi, useLang, useWrite, todayRiyadh } from "../_ui/inv";
import { BuyerFields, LinesEditor, Totals, emptyLine, useTotals, type Buyer, type EditLine } from "../_ui/editor";
import { IssueConfirm, SplitButton } from "../_ui/request-ui";
import { useTerm } from "@/components/chrome";
import { useAccountantView } from "../../../accounting/_ui/qoyod-pages";
import { PartyCard } from "@/components/forms/QoyodForm";
import { UNASSIGNED_LOCATION, useLocations } from "../../../accounting/_ui/locations";
import { DirectDealPicker, DoneCard, ModeBadge, PaymentSection, SampleDealPicker, samplePaidText, SampleNotes, effectiveDiscounts, isSaleMode, lineForSku, modeLine, sendMode, useModeData, type ModeDone, type SaleMode } from "../_ui/sale-mode";

type Customer = { id: string; name: string; nameAr: string | null; vatNumber: string | null; commercialRegNo: string | null; city: string | null; address: string | null; paymentTermsDays: number | null;
  nationalBuildingNo?: string | null; nationalStreet?: string | null; nationalDistrict?: string | null; nationalCity?: string | null; nationalPostalCode?: string | null };
type OrderFacts = {
  order: { id: string; orderNumber: number; customerId: string; status: string };
  customer: { name: string; nameAr: string | null };
  lines: { orderItemId: string; description: string; skuCode: string | null; unit: "UNIT" | "KG"; ordered: string; delivered: string; drafted: string; issued: string; remaining: string; deliveredNotInvoiced: string; price: { source: "QUOTE" | "SKU" | "NONE"; unitPrice: string } }[];
  invoices: { id: string; number: string | null; status: string; grandTotal: string }[];
};
type Search = { orderId?: string; q?: string; mode?: string; customerId?: string; opportunityId?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});
const newKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export default function NewInvoicePage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  // D22: «بيع مباشر (فاتورة ضريبية بدون عرض سعر)» (?mode=direct-sale) and «إرسال عيّنة» (?mode=sample) — this same page,
  // with the mode's additions (_ui/sale-mode.tsx); without a mode the manual invoice is exactly as before.
  if (sp.orderId) return <FromOrder orderId={sp.orderId} />;
  return isSaleMode(sp.mode) ? <Manual initialQ={sp.q} mode={sp.mode} initialCustomerId={sp.customerId} opportunityId={sp.opportunityId} /> : <Manual initialQ={sp.q} />;
}

function FromOrder({ orderId }: { orderId: string }) {
  const { L } = useLang();
  const router = useRouter();
  const facts = useApi<OrderFacts>(`/api/sales/invoices/order/${encodeURIComponent(orderId)}`);
  const w = useWrite();
  const [basis, setBasis] = useState<"REMAINING" | "DELIVERED">("REMAINING");
  const [family, setFamily] = useState<"STANDARD" | "SIMPLIFIED">("STANDARD");
  const [key] = useState(newKey);
  const d = facts.data;
  const qty = (l: OrderFacts["lines"][number]) => (basis === "DELIVERED" ? l.deliveredNotInvoiced : l.remaining);
  const any = d?.lines.some((l) => Number(qty(l)) > 0);
  const create = async () => {
    const r = await w.run<{ id: string }>("create", "/api/sales/invoices/from-order", "POST", { orderId, basis, family, requestKey: key });
    if (r) router.push(`/dashboard/sales/invoices/${r.id}`);
  };
  return (
    <InvShell title={L("فاتورة من الطلب", "Invoice from an order")} testId="invoice-from-order">
      <Msg error={w.error ?? facts.error} />
      {!d ? <OpsLoading /> : (
        <>
          <div className="acct-card">
            <h2>{L("الطلب", "Order")} <bdi className="hr-num">#{d.order.orderNumber}</bdi> · <bdi>{d.customer.nameAr || d.customer.name}</bdi></h2>
            <p className="acct-hint">{L("الأسعار من عرض السعر المقبول للطلب، وإلا من سعر الصنف. تُراجَع في المسودة قبل الإصدار. لا تُفوتر كمية أكثر من المطلوبة.", "Prices come from the order's accepted quotation, else the SKU price; review them on the draft before issue. Nothing beyond the ordered quantity is invoiced.")}</p>
            <div className="acct-row">
              <div className="inv-seg" role="group" aria-label={L("ما يُفوتر", "What to invoice")}>
                <button type="button" aria-pressed={basis === "REMAINING"} onClick={() => setBasis("REMAINING")} data-testid="basis-remaining">{L("كل المتبقي", "Everything left")}</button>
                <button type="button" aria-pressed={basis === "DELIVERED"} onClick={() => setBasis("DELIVERED")} data-testid="basis-delivered">{L("المُسلَّم فقط", "Delivered only")}</button>
              </div>
              <label className="hr-field"><span className="hr-label">{L("نوع الفاتورة", "Invoice type")}</span>
                <Select value={family} onChange={(e) => setFamily(e.target.value === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD")}>
                  <option value="STANDARD">{L("فاتورة ضريبية (منشأة)", "Tax invoice (business)")}</option>
                  <option value="SIMPLIFIED">{L("فاتورة ضريبية مبسطة (مستهلك)", "Simplified (consumer)")}</option>
                </Select></label>
            </div>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="order-invoicing">
              <thead><tr><th>{L("البند", "Line")}</th><th className="num">{L("المطلوب", "Ordered")}</th><th className="num">{L("المُسلَّم", "Delivered")}</th><th className="num">{L("مُفوتر", "Invoiced")}</th><th className="num">{L("في مسودات", "In drafts")}</th><th className="num">{L("يُفوتر الآن", "To invoice")}</th><th className="num">{L("سعر الوحدة", "Unit price")}</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.orderItemId}>
                    <td><bdi>{l.description}</bdi>{l.skuCode ? <span className="inv-sub acct-code">{l.skuCode}</span> : null}</td>
                    <td className="num hr-num">{l.ordered}</td><td className="num hr-num">{l.delivered}</td><td className="num hr-num">{l.issued}</td><td className="num hr-num">{l.drafted}</td>
                    <td className="num hr-num"><b>{qty(l)}</b></td>
                    <td className="num hr-num">{l.price.source === "NONE" ? <span className="inv-chip is-warn">{L("يُدخل في المسودة", "Enter on the draft")}</span> : <>{money(l.price.unitPrice)}<span className="inv-sub">{l.price.source === "QUOTE" ? L("من عرض السعر", "from the quotation") : L("سعر الصنف", "SKU price")}</span></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.invoices.length ? <p className="acct-hint">{L("فواتير هذا الطلب: ", "This order's invoices: ")}{d.invoices.map((i, k) => <span key={i.id}>{k ? " · " : ""}<Link href={`/dashboard/sales/invoices/${i.id}`}><bdi className="acct-code">{i.number ?? L("مسودة", "draft")}</bdi></Link></span>)}</p> : null}
          <div className="acct-foot">
            <span className="acct-hint">{any ? "" : L("لا يوجد ما يُفوتر بهذا الخيار.", "Nothing to invoice with this choice.")}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href="/dashboard/orders">{L("رجوع", "Back")}</Link>
              <button type="button" className="hr-btn is-primary" disabled={!any || !!w.busy} onClick={create} data-testid="create-from-order">{L("إنشاء مسودة الفاتورة", "Create the invoice draft")}</button>
            </span>
          </div>
        </>
      )}
    </InvShell>
  );
}

const blankBuyer = (): Buyer => ({ name: "", vatNumber: "", crNumber: "", city: "", district: "", street: "", buildingNo: "", postalCode: "" });

function Manual({ initialQ, mode = null, initialCustomerId, opportunityId }: { initialQ?: string; mode?: SaleMode | null; initialCustomerId?: string; opportunityId?: string }) {
  const { L, ar: isAr } = useLang();
  const router = useRouter();
  const w = useWrite();
  // «العملاء» of the accountant: «فاتورة» opens here with the customer's name already searched (?q=).
  const [q, setQ] = useState(initialQ ?? "");
  const custs = useApi<{ items: Customer[] }>(`/api/sales/invoices/customers?q=${encodeURIComponent(q)}`);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [family, setFamily] = useState<"STANDARD" | "SIMPLIFIED">("STANDARD");
  const [buyer, setBuyer] = useState<Buyer>(blankBuyer());
  const [supplyDate, setSupplyDate] = useState(todayRiyadh());
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditLine[]>(() => [mode ? modeLine(mode)() : emptyLine()]);
  // «الموقع» (WP-B, council Q-F1 / Q-F4): "" = the default (the order's, else the requester's branch), "none" = «غير محدد».
  const [branchId, setBranchId] = useState("");
  const branches = useLocations();
  const [key] = useState(newKey);
  const pickCustomer = (c: Customer) => {
    setCustomer(c);
    // The customer's national address (soon batch round 2) prefills the buyer address; still editable on the draft.
    setBuyer({ name: c.nameAr || c.name, vatNumber: c.vatNumber ?? "", crNumber: c.commercialRegNo ?? "", city: c.nationalCity || c.city || "", district: c.nationalDistrict ?? "", street: c.nationalStreet ?? "", buildingNo: c.nationalBuildingNo ?? "", postalCode: c.nationalPostalCode ?? "", address: c.address });
    setTerms(c.paymentTermsDays != null ? String(c.paymentTermsDays) : "");
    // The type follows the customer (Qoyod derives it): a VAT number → tax invoice, none → simplified; still editable.
    setFamily(c.vatNumber ? "STANDARD" : "SIMPLIFIED");
  };
  const options = useMemo(() => custs.data?.items ?? [], [custs.data]);
  // D22.1: «+ عميل جديد» — the same rule as everywhere a rep registers a customer (POST /api/customers re-checks it).
  const [newCust, setNewCust] = useState(false);
  const me = useUser();
  const mayCreateCustomer = !!me && (canEdit(me.permissions as Permissions, "customers") || hasSubPrivilege(me.permissions as Permissions, "sales", "lead_write") || hasSubPrivilege(me.permissions as Permissions, "sales", "lead_convert"));
  const madeCustomer = async (c: CreatedCustomer) => {
    setNewCust(false);
    // The invoice's own view of the customer (VAT number, address, terms) — the new one, picked, and the sale goes on.
    const r = await fetch(`/api/sales/invoices/customers?id=${encodeURIComponent(c.id)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { items?: Customer[] } | null;
    pickCustomer(r?.items?.[0] ?? { id: c.id, name: c.name, nameAr: c.nameAr, vatNumber: null, commercialRegNo: null, city: c.city, address: null, paymentTermsDays: null });
  };
  // ── D22 modes only (every hook below is idle without a mode) ──
  const md = useModeData(mode, customer?.id ?? null);
  const asked = useApi<{ items: Customer[] }>(mode && initialCustomerId ? `/api/sales/invoices/customers?id=${encodeURIComponent(initialCustomerId)}` : null);
  const prefilled = useRef(false);
  const askedFirst = asked.data?.items[0] ?? null;
  useEffect(() => {
    // «＋» from a customer: the page opens on that customer (once; «تغيير» still works).
    if (!askedFirst || prefilled.current) return;
    prefilled.current = true;
    pickCustomer(askedFirst);
  }, [askedFirst]);
  const [payment, setPayment] = useState<"CASH" | "CARD" | "BANK_TRANSFER" | "CREDIT" | null>(null);
  const [reference, setReference] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [done, setDone] = useState<ModeDone | null>(null);
  const [sending, setSending] = useState(false);
  // «إرسال عيّنة» with several open deals: the deal chosen (default: the one passed in, else the most recent — owner 2أ).
  const [pickedDeal, setPickedDeal] = useState<string | null>(null);
  const sampleDeals = md.facts?.deals ?? [];
  const sampleDeal = pickedDeal && sampleDeals.some((d) => d.id === pickedDeal) ? pickedDeal
    : opportunityId && customer?.id === initialCustomerId && sampleDeals.some((d) => d.id === opportunityId) ? opportunityId
    : sampleDeals[0]?.id ?? null;
  // «بيع مباشر» (أبو فهد B2): «لا — صفقة جديدة» unless the rep picks one of the customer's open deals (per customer).
  const [directPick, setDirectPick] = useState<{ customerId: string; dealId: string } | null>(null);
  const directDeal = directPick && directPick.customerId === customer?.id && md.directDeals.some((d) => d.id === directPick.dealId) ? directPick.dealId : "";
  const qoyod = useAccountantView();
  // أبو فهد (clutter): in the D22 modes a rep (no invoices_issue) sees the sale, not the accountant's fields — the invoice
  // type, dates and the buyer's particulars are prefilled from the customer and folded away; the checks wait for the first
  // «أرسل». The accountant (invoices_issue) sees everything, as on the manual invoice.
  const viewer = useUser();
  const simple = !!mode && !(viewer && canIssueInvoices(viewer.permissions));
  const [tried, setTried] = useState(false);
  const t = useTerm();
  // The customer card's «الرصيد الحالي» (the accountant workspace): the AR aging's balance for the customer.
  const ar = useApi<{ rows: { customerId: string; balance: string; overdue: string }[] }>(qoyod && customer ? `/api/accounting/ar/aging?asOf=${todayRiyadh()}` : null);
  const arRow = ar.data?.rows.find((r) => r.customerId === customer?.id);
  const due = (() => { const n = Number(terms || 0); if (!supplyDate || !Number.isFinite(n)) return ""; const d = new Date(`${supplyDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); })();
  const familyField = (
    <label className="hr-field"><span className="hr-label">{L("نوع الفاتورة", "Invoice type")}</span>
      <Select value={family} onChange={(e) => setFamily(e.target.value === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD")}>
        <option value="STANDARD">{L("فاتورة ضريبية (منشأة)", "Tax invoice (business)")}</option>
        <option value="SIMPLIFIED">{L("فاتورة ضريبية مبسطة (مستهلك)", "Simplified (consumer)")}</option>
      </Select></label>
  );
  const buyerBlock = (
    <>
      <h3>{L("بيانات المشتري", "Buyer particulars")}</h3>
      <BuyerFields buyer={buyer} family={family} onChange={setBuyer} />
    </>
  );
  // Q-F2: who may do what decides the split button (Sales requests; an issuer saves and issues). The API re-checks.
  // أبو فهد B6: the manual invoice's own questions (who may issue, the series) — not asked in the D22 modes, whose rep may
  // hold invoices_create without invoices_view (two 403s in the console for nothing).
  const abilities = useApi<{ can: { create: boolean; issue: boolean; sellAssets?: boolean } }>(mode ? null : "/api/sales/invoices?take=1");
  const series = useApi<{ invoicePrefix: string }>(mode ? null : "/api/sales/invoices/settings");
  const can = abilities.data?.can ?? { create: false, issue: false };
  const totals = useTotals(lines);
  const eff = mode ? effectiveDiscounts(lines, lines.map((_, i) => totals.priced?.lines[i]?.lineNet.toFixed(2) ?? null), md.skus) : [];
  const topEff = eff.length ? Math.max(...eff) : 0;
  const needsApproval = mode === "direct-sale" && !!md.can && topEff > md.can.threshold && !md.can.approveDiscount;
  const lockTax = !(mode === "sample" ? md.facts?.taxOverride : md.can?.taxOverride);
  const modeGross = totals.priced ? Number(totals.priced.grandTotal.toFixed(2)) : 0;
  // A second sample of a product this year (the same rule SampleNotes shows): its «أرسل» says where it goes.
  const repeatSample = mode === "sample" && !!md.facts && lines.some((l) => { const s = md.skus.find((x) => x.id === l.productSkuId); return !!s?.productId && md.facts!.sampledProducts.some((p) => p.productId === s.productId); });
  const modeReady = !!mode && !!customer && totals.ok && lines.length > 0 && lines.every((l) => !!l.productSkuId) && (mode === "sample" || !!payment);
  const sendSale = async () => {
    setTried(true);
    if (!mode || !customer || !modeReady || sending) return;
    w.setError(null);
    const body = {
      customerId: customer.id, requestKey: key, note: notes || undefined,
      lines: lines.map((l) => ({ productSkuId: l.productSkuId, quantityUnits: Number(l.quantity), unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent, exemptionReasonCode: l.exemptionReasonCode ?? null })),
      invoice: { family, buyer, supplyDate, paymentTermsDays: terms || undefined, notes, ...(branchId ? { branchId: branchId === UNASSIGNED_LOCATION ? null : branchId } : {}) },
      // A sample goes on the deal chosen (or passed in from the deal page); with no open deal the server opens one.
      ...(mode === "sample" && sampleDeal ? { opportunityId: sampleDeal } : {}),
      ...(mode === "direct-sale" ? { payment, reference: payment === "BANK_TRANSFER" ? reference.trim() || undefined : undefined, opportunityId: directDeal || null, dealTitle: md.directDeals.find((d) => d.id === directDeal)?.title } : {}),
    };
    setSending(true);
    const r = await sendMode(mode, body, payment === "BANK_TRANSFER" ? receipt : null, L);
    setSending(false);
    if (r.ok) setDone(r.done); else w.setError(r.error);
  };
  const [confirm, setConfirm] = useState<null | "issue" | "print" | "pdf">(null);
  const payload = () => ({ customerId: customer!.id, family, buyer, supplyDate, paymentTermsDays: terms || undefined, notes, lines, requestKey: key,
    ...(branchId ? { branchId: branchId === UNASSIGNED_LOCATION ? null : branchId } : {}) });
  const save = async () => {
    if (!customer) return;
    const r = await w.run<{ id: string }>("save", "/api/sales/invoices", "POST", payload());
    if (r) router.push(`/dashboard/sales/invoices/${r.id}`);
  };
  /** «إرسال الطلب للمحاسب»: the draft is saved (under the key: a retry never makes a second one), then requested. */
  const sendRequest = async () => {
    if (!customer) return;
    const r = await w.run<{ id: string }>("save", "/api/sales/invoices", "POST", payload());
    if (!r) return;
    const q = await w.run("request", `/api/sales/invoices/${r.id}/request`, "POST", {});
    router.push(`/dashboard/sales/invoices/${r.id}${q ? "?requested=1" : ""}`);
  };
  /** «حفظ وإصدار» (issuers only, behind step-up and the confirm dialog): one request; NOT_READY keeps the draft and opens it. */
  const saveAndIssue = async (then: "issue" | "print" | "pdf") => {
    if (!customer) return;
    w.setError(null);
    const res = await fetch("/api/sales/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload(), issue: true }) });
    const b = await res.json().catch(() => ({}));
    setConfirm(null);
    if (res.status === 409 && b.kept && b.id) { router.push(`/dashboard/sales/invoices/${b.id}?notReady=1`); return; }
    if (!res.ok) { w.setError(b.error ?? b.errorEn ?? `HTTP ${res.status}`); return; }
    router.push(then === "issue" ? `/dashboard/sales/invoices/${b.id}` : `/dashboard/sales/invoices/${b.id}/print${then === "pdf" ? "?pdf=1" : ""}`);
  };
  if (mode && done) {
    return (
      <InvShell title={L("فاتورة مبيعات جديدة", "New sales invoice")} testId="invoice-new" bare={simple}>
        <ModeBadge mode={mode} />
        <DoneCard done={done} />
      </InvShell>
    );
  }
  return (
    <InvShell title={L("فاتورة مبيعات جديدة", "New sales invoice")} testId="invoice-new" bare={simple}>
      {mode ? <ModeBadge mode={mode} lockTax={lockTax} gross={modeGross} /> : null}
      <Msg error={w.error ?? (mode ? md.error : null)} />
      <div className="acct-card">
        <h2>{L("العميل", "Customer")}</h2>
        {customer ? (
          <div className="acct-row"><b data-testid="picked-customer"><bdi>{customer.nameAr || customer.name}</bdi></b><button type="button" className="hr-btn is-sm" onClick={() => setCustomer(null)}>{L("تغيير", "Change")}</button></div>
        ) : (
          <>
            <label className="hr-field"><span className="hr-label">{L("ابحث عن العميل", "Find the customer")}</span>
              <input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} data-testid="customer-search" /></label>
            {/* D22.1 (owner on the phone): the whole row picks the customer (a full-width button, 48px tall), the VAT
                number stays inside it; in the direct sale / sample, «+ عميل جديد» registers one and continues with it. */}
            {mode && mayCreateCustomer ? <button type="button" className="hr-btn is-sm inv-cust-new" onClick={() => setNewCust(true)} data-testid="invoice-new-customer">{L("+ عميل جديد", "+ New customer")}</button> : null}
            <ul className="inv-cust-list" data-testid="customer-options">
              {options.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <button type="button" className="inv-cust-row" onClick={() => pickCustomer(c)} data-testid={`customer-option-${c.id}`}>
                    <span className="inv-cust-name"><bdi>{c.nameAr || c.name}</bdi></span>
                    {c.vatNumber ? <bdi className="inv-cust-vat acct-code" dir="ltr">{c.vatNumber}</bdi> : null}
                  </button>
                </li>
              ))}
            </ul>
            <NewCustomerDialog open={newCust} ar={isAr} initialName={/\d{3,}/.test(q) ? "" : q.trim()} onClose={() => setNewCust(false)} onCreated={madeCustomer} />
          </>
        )}
      </div>
      {customer ? (
        <>
          {/* Qoyod parity (accountant workspace): the header reads party → date → terms → type, the lines and totals
              follow, and the buyer's particulars come after the lines. Same fields and payload for everyone. */}
          {mode === "sample" ? <SampleDealPicker facts={md.facts} value={sampleDeal ?? ""} onChange={setPickedDeal} /> : null}
          {mode === "direct-sale" && customer ? <DirectDealPicker deals={md.directDeals} customerNames={md.directNames} value={directDeal} onChange={(id) => setDirectPick({ customerId: customer.id, dealId: id })} /> : null}
          {qoyod ? (
            <PartyCard title={L("تفاصيل بيانات العميل", "Customer details")} empty="—" testId="invoice-party"
              action={<Link className="hr-btn is-sm" href={`/dashboard/customers/${customer.id}`} data-testid="invoice-party-edit">✎ {L("تعديل بيانات العميل", "Edit the customer")}</Link>}
              rows={[
                { k: L("الاسم", "Name"), v: <bdi>{customer.nameAr || customer.name}</bdi> },
                { k: L("الرقم الضريبي", "VAT number"), v: customer.vatNumber ? <bdi className="acct-code">{customer.vatNumber}</bdi> : L("غير مسجل — فاتورة مبسطة", "None — a simplified invoice") },
                ...(arRow ? [{ k: L("الرصيد الحالي", "Current balance"), v: <bdi className="hr-num">{money(arRow.balance)} {L("⃁", "SAR")}</bdi>, tone: Number(arRow.overdue) > 0 ? ("bad" as const) : ("good" as const), testId: "invoice-party-balance" }] : []),
              ]} />
          ) : null}
          {simple ? null : <div className="acct-card" data-testid="invoice-header">
            {qoyod ? (
              <div className="acct-row">
                <label className="hr-field"><span className="hr-label">{L("المرجع", "Reference")}</span><span className="hr-input" aria-readonly="true" data-testid="invoice-ref-placeholder" style={{ display: "flex", alignItems: "center", color: "var(--text-muted)" }}>{L("يُعطى الرقم عند الإصدار", "The number is given at issue")}</span></label>
              </div>
            ) : null}
            <div className="acct-row">
              {qoyod ? null : familyField}
              <label className="hr-field"><span className="hr-label">{L("تاريخ التوريد", "Supply date")}</span><input type="date" className="hr-input" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} data-testid="supply-date" /></label>
              <label className="hr-field"><span className="hr-label">{qoyod ? L("شروط الدفع (يوم)", "Payment terms (days)") : L("مدة السداد (يوم)", "Payment terms (days)")}</span><input className="hr-input acct-amount" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="30" /></label>
              {/* «الموقع» (SalesInvoice.branchId; default the order's / the requester's branch — council Q-F4). A sale of a
                  fixed asset takes the asset's branch on the server (WP-F refinement 5). */}
              <label className="hr-field"><span className="hr-label">{L("الموقع", "Location")}</span>
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} data-testid="invoice-location">
                  <option value="">{L("الافتراضي (موقعك)", "Default (yours)")}</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr, b.nameEn)}</option>)}
                  <option value={UNASSIGNED_LOCATION}>{L("غير محدد", "Unassigned")}</option>
                </Select></label>
              {qoyod ? <label className="hr-field"><span className="hr-label">{L("تاريخ الاستحقاق", "Due date")}</span><span className="hr-input hr-num" aria-readonly="true" data-testid="invoice-due" style={{ display: "flex", alignItems: "center" }}>{due || "—"}</span></label> : null}
              {qoyod ? familyField : null}
            </div>
            {qoyod ? null : buyerBlock}
          </div>}
          {simple ? (
            <details className="acct-card inv-acct-fields" data-testid="invoice-accountant-fields">
              <summary>{L("بيانات الفاتورة والمشتري — من ملف العميل، والمحاسب يراجعها", "Invoice and buyer particulars — from the customer's file; the accountant reviews them")}</summary>
              <div className="acct-row">
                {familyField}
                <label className="hr-field"><span className="hr-label">{L("تاريخ التوريد", "Supply date")}</span><input type="date" className="hr-input" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} data-testid="supply-date" /></label>
                <label className="hr-field"><span className="hr-label">{L("مدة السداد (يوم)", "Payment terms (days)")}</span><input className="hr-input acct-amount" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="30" /></label>
              </div>
              {buyerBlock}
            </details>
          ) : null}
          <div className="acct-card">
            <h2>{L("البنود", "Lines")}</h2>
            {mode ? (
              <LinesEditor lines={lines} onChange={setLines} sellAssets={false} qoyod={qoyod} newLine={modeLine(mode)}
                sku={{ skus: md.skus, ar: isAr, oneUnit: mode === "sample", lockTax, quietProblems: simple && !tried, onPick: (i, sk) => setLines(lines.map((l, j) => (j === i ? lineForSku(mode, l, md.skus.find((x) => x.id === sk?.id) ?? null, isAr) : l))) }} />
            ) : (
            <LinesEditor lines={lines} onChange={setLines} sellAssets={!!abilities.data?.can.sellAssets} qoyod={qoyod} />
            )}
            {mode === "direct-sale" && md.can ? (
              <p className={`acct-hint${needsApproval ? " is-warn" : ""}`} data-testid="mode-discount-note" data-pending={needsApproval ? "1" : "0"}>
                {needsApproval
                  ? L(`خصم ${topEff}٪ من سعر القائمة فوق الحد (${md.can.threshold}٪). لما ترسل يروح لمشرفك يوافق — الطلب ينتظر، والفاتورة ما تروح للمحاسب قبل الموافقة.`, `${topEff}% off the list price is above the limit (${md.can.threshold}%). When you send, it goes to your supervisor — the order waits, and the invoice reaches the accountant only after the approval.`)
                  : lockTax
                    ? L(`لين ${md.can.threshold}٪ بدون موافقة. فوقها يروح لمشرفك يوافق. السعر والخصم تقدر تعدّلها — الضريبة 15٪ ثابتة، والمحاسب يراجع قبل ما يصدر`, `Up to ${md.can.threshold}% needs no approval; above it your supervisor approves. You can change the price and the discount — VAT is a fixed 15%, and the accountant reviews before issue`)
                    : L(`لين ${md.can.threshold}٪ بدون موافقة. فوقها يروح لمشرفك يوافق. السعر والخصم والضريبة تقدر تعدّلها — المحاسب يراجع قبل ما يصدر`, `Up to ${md.can.threshold}% needs no approval; above it your supervisor approves. You can change the price, discount and VAT — the accountant reviews before issue`)}
              </p>
            ) : null}
            {mode === "sample" ? <p className="acct-hint" data-testid="sample-qty-hint">{L("عبوة وحدة لكل صنف", "One unit of each product")}</p> : null}
            {mode === "sample" ? <SampleNotes lines={lines} skus={md.skus} facts={md.facts} /> : null}
            <div className="inv-grid2">
              <label className="hr-field"><span className="hr-label">{L("ملاحظات للعميل", "Notes to the customer")}</span><textarea className="hr-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              <Totals lines={lines} qoyod={qoyod} />
            </div>
          </div>
          {qoyod ? <div className="acct-card" data-testid="buyer-card">{buyerBlock}</div> : null}
          {mode === "direct-sale" ? <PaymentSection can={md.can} payment={payment} setPayment={setPayment} reference={reference} setReference={setReference} receipt={receipt} setReceipt={setReceipt} pending={needsApproval} /> : null}
          {mode ? (
            <div className="acct-foot inv-mode-foot" data-testid="invoice-mode-foot">
              {/* أبو فهد (B4 / wording): what «أرسل» does, as the state really is — never a line that contradicts it. */}
              <span className="acct-hint" data-testid="invoice-mode-foot-text">{mode === "sample"
                ? (modeGross > 0
                  ? <>{L("لما تضغط «أرسل»: تنسوّى شحنة العيّنة وتروح للتحضير · ", "On «Send»: the sample goes to preparation · ")}{samplePaidText(modeGross, L)}</>
                  : L("لما تضغط «أرسل»: تنسوّى شحنة العيّنة وتروح للتحضير · الفاتورة بصفر تروح للمحاسب يصدرها · ما فيه دفع", "On «Send»: the sample goes to preparation · the zero invoice goes to the accountant to issue · no payment"))
                : needsApproval
                  ? L("لما تضغط «أرسل»: يروح لمشرفك يوافق — بعدها الطلب للتحضير والفاتورة للمحاسب", "On «Send»: it goes to your supervisor — then the order to preparation and the invoice to the accountant")
                  : payment === "CREDIT"
                    ? L("لما تضغط «أرسل»: ينسوّى الطلب ويروح للتحضير · تروح الفاتورة للمحاسب يصدرها · ما ينسجل تحصيل — الفاتورة تنتظر الدفع", "On «Send»: the order goes to preparation · the invoice goes to the accountant to issue · no collection is recorded — the invoice waits for payment")
                    : L("لما تضغط «أرسل»: ينسوّى الطلب ويروح للتحضير · تروح الفاتورة للمحاسب يصدرها · ينسجل التحصيل", "On «Send»: the order goes to preparation · the invoice goes to the accountant to issue · the collection is recorded")}</span>
              <span className="acct-actions">
                <button type="button" className="hr-btn is-primary" disabled={sending || ((!simple || tried) && !modeReady)} onClick={sendSale} data-testid="invoice-mode-send">{sending ? L("نرسل…", "Sending…") : needsApproval ? L("أرسل للموافقة", "Send for approval") : repeatSample ? L("أرسل للمدير يوافق", "Send to the manager to approve") : L("أرسل", "Send")}</button>
                <Link className="hr-btn" href="/dashboard/my-day">{L("إلغاء", "Cancel")}</Link>
              </span>
            </div>
          ) : (
          <div className="acct-foot">
            <span className="acct-hint">{L("تُحفظ مسودة بلا رقم؛ الرقم يُعطى عند الإصدار.", "Saved as a draft without a number; the number is given at issue.")}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href="/dashboard/sales/invoices">{L("إلغاء", "Cancel")}</Link>
              {can.issue ? (
                <SplitButton testId="save-split" disabled={!!w.busy || !totals.ok} label={L("حفظ وإصدار", "Save and issue")} onPrimary={() => setConfirm("issue")}
                  items={[
                    { id: "print", label: L("حفظ وإصدار وطباعة", "Save, issue and print"), onSelect: () => setConfirm("print") },
                    { id: "pdf", label: L("حفظ وإصدار وتنزيل PDF", "Save, issue and download PDF"), onSelect: () => setConfirm("pdf") },
                    { id: "draft", label: qoyod ? t("saveDraft") : L("حفظ كمسودة", "Save as draft"), onSelect: save, testId: "save-draft" },
                  ]} />
              ) : can.create ? (
                <SplitButton testId="save-split" disabled={!!w.busy} label={L("إرسال الطلب للمحاسب", "Send the request to the accountant")} onPrimary={sendRequest}
                  hint={L("يصدر المحاسب الفاتورة الضريبية؛ تظهر لك بعد الإصدار للطباعة والتنزيل.", "The accountant issues the tax invoice; it shows to you after issue to print and download.")}
                  items={[{ id: "draft", label: qoyod ? t("saveDraft") : L("حفظ كمسودة", "Save as draft"), onSelect: save, testId: "save-draft" }]} />
              ) : null}
            </span>
          </div>
          )}
          {confirm && totals.priced ? (
            <IssueConfirm busy={!!w.busy} onClose={() => setConfirm(null)} onConfirm={() => saveAndIssue(confirm)}
              facts={{ customer: buyer.name || customer.nameAr || customer.name, vatNumber: buyer.vatNumber || null, family,
                taxable: totals.priced.taxableTotal.toFixed(2), tax: totals.priced.taxTotal.toFixed(2), grand: totals.priced.grandTotal.toFixed(2),
                breakdown: totals.priced.breakdown, series: series.data?.invoicePrefix ?? null }} />
          ) : null}
        </>
      ) : null}
    </InvShell>
  );
}
