"use client";

// A new invoice draft: «فاتورة يدوية» (Figma ZT-14) or «إنشاء فاتورة من الطلب» (?orderId=…, the order's lines with
// what is ordered, delivered, already invoiced and left; full, partial or delivered-only). Saving creates a DRAFT
// (no number) and opens it; issuing is a separate, privileged step on the draft.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { InvShell, Msg, money, useApi, useLang, useWrite, todayRiyadh } from "../_ui/inv";
import { BuyerFields, LinesEditor, Totals, emptyLine, type Buyer, type EditLine } from "../_ui/editor";
import { useTerm } from "@/components/chrome";
import { useAccountantView } from "../../../accounting/_ui/qoyod-pages";

type Customer = { id: string; name: string; nameAr: string | null; vatNumber: string | null; commercialRegNo: string | null; city: string | null; address: string | null; paymentTermsDays: number | null };
type OrderFacts = {
  order: { id: string; orderNumber: number; customerId: string; status: string };
  customer: { name: string; nameAr: string | null };
  lines: { orderItemId: string; description: string; skuCode: string | null; unit: "UNIT" | "KG"; ordered: string; delivered: string; drafted: string; issued: string; remaining: string; deliveredNotInvoiced: string; price: { source: "QUOTE" | "SKU" | "NONE"; unitPrice: string } }[];
  invoices: { id: string; number: string | null; status: string; grandTotal: string }[];
};
type Search = { orderId?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});
const newKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export default function NewInvoicePage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  return sp.orderId ? <FromOrder orderId={sp.orderId} /> : <Manual />;
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

function Manual() {
  const { L } = useLang();
  const router = useRouter();
  const w = useWrite();
  const [q, setQ] = useState("");
  const custs = useApi<{ items: Customer[] }>(`/api/sales/invoices/customers?q=${encodeURIComponent(q)}`);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [family, setFamily] = useState<"STANDARD" | "SIMPLIFIED">("STANDARD");
  const [buyer, setBuyer] = useState<Buyer>(blankBuyer());
  const [supplyDate, setSupplyDate] = useState(todayRiyadh());
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditLine[]>([emptyLine()]);
  const [key] = useState(newKey);
  const pickCustomer = (c: Customer) => {
    setCustomer(c);
    setBuyer({ name: c.nameAr || c.name, vatNumber: c.vatNumber ?? "", crNumber: c.commercialRegNo ?? "", city: c.city ?? "", district: "", street: "", buildingNo: "", postalCode: "", address: c.address });
    setTerms(c.paymentTermsDays != null ? String(c.paymentTermsDays) : "");
    if (!c.vatNumber) setFamily("SIMPLIFIED");
  };
  const options = useMemo(() => custs.data?.items ?? [], [custs.data]);
  const qoyod = useAccountantView();
  const t = useTerm();
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
  const save = async () => {
    if (!customer) return;
    const r = await w.run<{ id: string }>("save", "/api/sales/invoices", "POST", { customerId: customer.id, family, buyer, supplyDate, paymentTermsDays: terms || undefined, notes, lines, requestKey: key });
    if (r) router.push(`/dashboard/sales/invoices/${r.id}`);
  };
  return (
    <InvShell title={L("فاتورة مبيعات جديدة", "New sales invoice")} testId="invoice-new">
      <Msg error={w.error} />
      <div className="acct-card">
        <h2>{L("العميل", "Customer")}</h2>
        {customer ? (
          <div className="acct-row"><b data-testid="picked-customer"><bdi>{customer.nameAr || customer.name}</bdi></b><button type="button" className="hr-btn is-sm" onClick={() => setCustomer(null)}>{L("تغيير", "Change")}</button></div>
        ) : (
          <>
            <label className="hr-field"><span className="hr-label">{L("ابحث عن العميل", "Find the customer")}</span>
              <input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} data-testid="customer-search" /></label>
            <ul className="ops-list" data-testid="customer-options">
              {options.slice(0, 8).map((c) => <li key={c.id}><button type="button" className="hr-btn is-ghost" onClick={() => pickCustomer(c)}><bdi>{c.nameAr || c.name}</bdi>{c.vatNumber ? <span className="inv-sub acct-code">{c.vatNumber}</span> : null}</button></li>)}
            </ul>
          </>
        )}
      </div>
      {customer ? (
        <>
          {/* Qoyod parity (accountant workspace): the header reads party → date → terms → type, the lines and totals
              follow, and the buyer's particulars come after the lines. Same fields and payload for everyone. */}
          <div className="acct-card" data-testid="invoice-header">
            <div className="acct-row">
              {qoyod ? null : familyField}
              <label className="hr-field"><span className="hr-label">{L("تاريخ التوريد", "Supply date")}</span><input type="date" className="hr-input" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} data-testid="supply-date" /></label>
              <label className="hr-field"><span className="hr-label">{L("مدة السداد (يوم)", "Payment terms (days)")}</span><input className="hr-input acct-amount" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="30" /></label>
              {qoyod ? familyField : null}
            </div>
            {qoyod ? null : buyerBlock}
          </div>
          <div className="acct-card">
            <h2>{L("البنود", "Lines")}</h2>
            <LinesEditor lines={lines} onChange={setLines} />
            <div className="inv-grid2">
              <label className="hr-field"><span className="hr-label">{L("ملاحظات للعميل", "Notes to the customer")}</span><textarea className="hr-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              <Totals lines={lines} />
            </div>
          </div>
          {qoyod ? <div className="acct-card" data-testid="buyer-card">{buyerBlock}</div> : null}
          <div className="acct-foot">
            <span className="acct-hint">{L("تُحفظ مسودة بلا رقم؛ الرقم يُعطى عند الإصدار.", "Saved as a draft without a number; the number is given at issue.")}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href="/dashboard/sales/invoices">{L("إلغاء", "Cancel")}</Link>
              <button type="button" className="hr-btn is-primary" disabled={!!w.busy} onClick={save} data-testid="save-draft">{qoyod ? t("saveDraft") : L("حفظ المسودة", "Save draft")}</button>
            </span>
          </div>
        </>
      ) : null}
    </InvShell>
  );
}
