"use client";

// Figma: ACC-31 (sales invoice editor, optionally from an order: prices from its accepted quote)
// and ACC-35 (credit note against a posted invoice, ?creditFor=<invoiceId>). Live totals are
// computed exactly like the server (half-up per step). ?edit=<id> edits a draft.
// Stage 4b: each invoice line is goods (costed from stock, optionally in another unit of the item)
// or non-stock (services, fees); goods leave from the fulfilment location. A credit note says what
// it credits: returned goods (a posted customer return of the invoice) or a price adjustment. A
// corrected invoice may name the reversed invoice it replaces.
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, X } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Field, INPUT, Notice, Table, Td, Th, useL } from "../../../finance/_components/ui";
import { riyadhToday, useCan } from "../../_components/kit";
import { salesLineMinor } from "../../_components/bill-math";

type Customer = { id: string; name: string; vatNumber: string | null; paymentTermsDays: number; creditLimit: string | null; openReceivables: string };
type Account = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean; controlKind: string; roles: string[] };
type Tax = { id: string; code: string; nameAr: string | null; nameEn: string; rate: string; isActive: boolean; isDefault: boolean };
type Order = { id: string; orderNumber: number; status: string; customerId: string };
type Treatment = "" | "GOODS" | "NON_STOCK";
type Line = { accountId: string; description: string; quantity: string; unitPrice: string; discountPercent: string; taxCategoryId: string; productSkuId: string | null; orderItemId: string | null; stockTreatment: Treatment; invItemId: string; unit: string };
type Item = { id: string; code: string; name: string; nameEn: string; kind: string; baseUnit: string; isActive: boolean; units: { unit: string; factor: string }[]; links: { productSkuId: string | null } };
type Loc = { id: string; code: string; name: string; nameAr: string | null; isActive: boolean; isDelivered: boolean; isSalesDefault: boolean };
type Ret = { id: string; returnNo: number; status: string; reason: string; receivedOn: string | null; documentId: string | null; creditNote: { invoiceNo: number; status: string } | null; lines: { item: string; quantity: string; unit: string }[] };
type Reversed = { id: string; invoiceNo: number; issueDate: string; totalGross: string };
type Original = { id: string; invoiceNo: number; customerId: string; customer: { nameAr: string | null; name: string }; totalGross: string; creditable: string | null; status: string; kind: string; orderId: string | null };

const blank = (tax = ""): Line => ({ accountId: "", description: "", quantity: "1", unitPrice: "", discountPercent: "0", taxCategoryId: tax, productSkuId: null, orderItemId: null, stockTreatment: "", invItemId: "", unit: "" });
const vatOk = (v: string | null | undefined) => !!v && /^3\d{13}3$/.test(v);

export default function NewSalesDocPage() {
  const { L, money } = useL();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get("edit");
  const creditFor = sp.get("creditFor");
  // Stage 6: a debit note raises a posted invoice (an invoice naming it, with a reason; no goods).
  const debitFor = sp.get("debitFor");
  const { can } = useCan();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [original, setOriginal] = useState<Original | null>(null);
  const [debitOf, setDebitOf] = useState<Original | null>(null);
  const [kind, setKind] = useState<"INVOICE" | "CREDIT_NOTE">(creditFor ? "CREDIT_NOTE" : "INVOICE");
  const [h, setH] = useState(() => ({ customerId: "", orderId: "", issueDate: riyadhToday(), supplyDate: "", dueDate: "", description: "", reason: "",
    fulfilmentLocationId: "", replacesInvoiceId: "", creditType: "" as "" | "RETURN_OF_GOODS" | "PRICE_ADJUSTMENT", customerReturnId: "" }));
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [returns, setReturns] = useState<Ret[]>([]);
  const [reversedInvoices, setReversedInvoices] = useState<Reversed[]>([]);
  const [ownNo, setOwnNo] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "draft" | "submit">("");
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Invoice from order (?order=… or the order picker): lines and prices proposed by the server.
  const loadOrder = async (orderId: string) => {
    setH((x) => ({ ...x, orderId }));
    if (!orderId) { setPriceNote(null); return; }
    try {
      const d = await api<{ order: { customerId: string; orderNumber: number }; quote: { number: string } | null; existingInvoice: { invoiceNo: number } | null; lines: { orderItemId: string; productSkuId: string | null; description: string; quantity: string; unitPrice: string; discountPercent: string; taxCategoryId: string | null }[] }>(`/api/accounting/receivables/from-order/${orderId}`);
      if (d.existingInvoice) { setErr(L(`للطلب فاتورة قائمة INV-${d.existingInvoice.invoiceNo}.`, `The order already has invoice INV-${d.existingInvoice.invoiceNo}.`)); return; }
      setH((x) => ({ ...x, customerId: d.order.customerId, orderId }));
      setLines(d.lines.map((l) => ({ accountId: "", description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxCategoryId: l.taxCategoryId ?? "", productSkuId: l.productSkuId, orderItemId: l.orderItemId,
        stockTreatment: l.productSkuId ? "GOODS" : "", invItemId: "", unit: "" })));
      setPriceNote(d.quote ? L(`الأسعار من عرض السعر المقبول ${d.quote.number} للطلب ${d.order.orderNumber}.`, `Prices from accepted quote ${d.quote.number} for order ${d.order.orderNumber}.`) : L(`لا عرض سعر مقبول للطلب ${d.order.orderNumber}: الأسعار من بطاقة المنتج — راجعها.`, `No accepted quote for order ${d.order.orderNumber}: prices from the product card — review them.`));
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  };

  useEffect(() => {
    api<Customer[]>("/api/accounting/receivables/customers").then(setCustomers).catch(() => {});
    api<Account[]>("/api/accounting/coa").then(setAccounts).catch(() => {});
    api<{ items: Item[]; locations: Loc[] }>("/api/accounting/inventory/items").then((m) => { setItems(m.items); setLocations(m.locations); }).catch(() => {});
    api<Tax[]>("/api/accounting/tax-categories").then((t) => {
      setTaxes(t.filter((x) => x.isActive));
      if (!editId) setLines([blank(t.find((x) => x.isDefault && x.isActive)?.id ?? "")]);
      const fromOrder = sp.get("order");
      if (fromOrder && !editId && !creditFor) loadOrder(fromOrder);   // "invoice this order"
    }).catch(() => {});
    if (debitFor) api<Original>(`/api/accounting/receivables/invoices/${debitFor}`).then((o) => {
      setDebitOf(o); setH((x) => ({ ...x, customerId: o.customerId }));
    }).catch((e) => setErr((e as Error).message));
    if (creditFor) api<Original>(`/api/accounting/receivables/invoices/${creditFor}`).then((o) => {
      setOriginal(o); setKind("CREDIT_NOTE");
      setH((x) => ({ ...x, customerId: o.customerId }));
    }).catch((e) => setErr((e as Error).message));
    if (editId) api<{ kind: "INVOICE" | "CREDIT_NOTE"; invoiceNo: number; customerId: string; orderId: string | null; originalInvoiceId: string | null; issueDate: string; supplyDate: string | null; dueDate: string; description: string | null; reason: string | null;
      fulfilmentLocationId: string | null; replacesInvoiceId: string | null; creditType: "RETURN_OF_GOODS" | "PRICE_ADJUSTMENT" | null; customerReturnId: string | null;
      lines: { accountId: string; description: string | null; quantity: string; unitPrice: string; discountPercent: string; taxCategoryId: string | null; productSkuId: string | null; orderItemId: string | null; stockTreatment: "GOODS" | "NON_STOCK" | null; invItemId: string | null; unit: string | null }[] }>(`/api/accounting/receivables/invoices/${editId}`).then((d) => {
      setKind(d.kind); setOwnNo(d.invoiceNo);
      setH({ customerId: d.customerId, orderId: d.orderId ?? "", issueDate: d.issueDate.slice(0, 10), supplyDate: d.supplyDate?.slice(0, 10) ?? "", dueDate: d.dueDate.slice(0, 10), description: d.description ?? "", reason: d.reason ?? "",
        fulfilmentLocationId: d.fulfilmentLocationId ?? "", replacesInvoiceId: d.replacesInvoiceId ?? "", creditType: d.creditType ?? "", customerReturnId: d.customerReturnId ?? "" });
      setLines(d.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? "", quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), discountPercent: String(Number(l.discountPercent)), taxCategoryId: l.taxCategoryId ?? "", productSkuId: l.productSkuId, orderItemId: l.orderItemId,
        stockTreatment: l.stockTreatment ?? (l.productSkuId || l.invItemId ? "GOODS" : ""), invItemId: l.invItemId ?? "", unit: l.unit ?? "" })));
      if (d.originalInvoiceId) api<Original>(`/api/accounting/receivables/invoices/${d.originalInvoiceId}`).then(setOriginal).catch(() => {});
    }).catch((e) => setErr((e as Error).message));
    // Runs once per document; loadOrder and sp only feed state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, creditFor, debitFor]);

  useEffect(() => {
    if (kind !== "INVOICE" || !h.customerId) return;
    api<Order[]>(`/api/accounting/receivables/orders?customerId=${h.customerId}`).then(setOrders).catch(() => setOrders([]));
  }, [h.customerId, kind]);
  const customerOrders = orders.filter((o) => o.customerId === h.customerId);

  // A corrected invoice may replace a reversed invoice of the same customer.
  useEffect(() => {
    if (kind !== "INVOICE" || !h.customerId) return;
    api<{ rows: Reversed[] }>(`/api/accounting/receivables/invoices?status=REVERSED&kind=INVOICE&customerId=${h.customerId}&pageSize=100`).then((r) => setReversedInvoices(r.rows)).catch(() => setReversedInvoices([]));
  }, [h.customerId, kind]);
  // A credit note for returned goods credits a posted customer return of the same invoice.
  const originalId = original?.id ?? null;
  useEffect(() => {
    if (kind !== "CREDIT_NOTE" || !originalId) return;
    api<Ret[]>(`/api/accounting/inventory/returns?invoiceId=${originalId}&status=POSTED`).then(setReturns).catch(() => setReturns([]));
  }, [originalId, kind]);
  const openReturns = returns.filter((r) => !r.creditNote || (ownNo !== null && r.creditNote.invoiceNo === ownNo) || r.id === h.customerReturnId);
  const chosenReturn = returns.find((r) => r.id === h.customerReturnId);
  const shipFrom = locations.filter((l) => l.isActive && !l.isDelivered);
  const salesDefault = locations.find((l) => l.isSalesDefault && l.isActive && !l.isDelivered);
  const locName = (l?: Loc) => (l ? `${l.code} · ${L(l.nameAr ?? l.name, l.name)}` : "—");
  const itemFor = (l: Line) => (l.invItemId ? items.find((x) => x.id === l.invItemId) : l.productSkuId ? items.find((x) => x.links?.productSkuId === l.productSkuId) : undefined);


  const customer = customers.find((c) => c.id === h.customerId);
  const revenue = useMemo(() => accounts.filter((a) => a.isActive && a.allowPosting && a.controlKind === "NONE" && a.type === "REVENUE"), [accounts]);
  const acctName = (a?: { code: string; nameAr: string | null; nameEn: string } | null) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : "—");
  const byRole = (role: string) => accounts.find((a) => a.roles?.includes(role));
  const defRevenue = byRole("SALES_REVENUE");
  const rate = (id: string) => taxes.find((t) => t.id === id)?.rate ?? "0";
  const calc = lines.map((l) => salesLineMinor(l.quantity, l.unitPrice, l.discountPercent, rate(l.taxCategoryId)));
  const tot = calc.reduce<{ net: number; vat: number; gross: number }>((s, c) => ({ net: s.net + (c?.net ?? 0), vat: s.vat + (c?.vat ?? 0), gross: s.gross + (c?.gross ?? 0) }), { net: 0, vat: 0, gross: 0 });
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const errors = lines.map((l, i) => !calc[i] ? L("الكمية والسعر أرقام موجبة والخصم بين 0 و100", "Quantity and price must be positive; discount 0–100") : calc[i]!.net <= 0 ? L("المبلغ صفر", "Amount is zero")
    : kind === "INVOICE" && !l.stockTreatment ? L("حدّد: بضاعة من المخزون أم بند غير مخزني (خدمة، رسوم)", "Say whether the line is goods from stock or non-stock (service, fee)")
    : kind === "INVOICE" && l.stockTreatment === "GOODS" && !l.productSkuId && !l.invItemId ? L("اختر صنف المخزون لبند البضاعة", "Choose the stock item of the goods line")
    : null);
  const creditLeft = original?.creditable ? Math.round(Number(original.creditable) * 100) : null;
  const headerErr = !h.customerId ? L("اختر العميل", "Choose the customer")
    : (kind === "CREDIT_NOTE" || debitOf) && h.reason.trim().length < 5 ? L("سبب الإشعار (5 أحرف على الأقل)", "Note reason (at least 5 characters)")
    : debitOf && lines.some((l) => l.stockTreatment !== "NON_STOCK") ? L("بنود الإشعار المدين غير مخزنية (سعر أو رسوم)", "Debit-note lines are non-stock (price or charge)")
    : kind === "CREDIT_NOTE" && creditLeft !== null && tot.gross > creditLeft ? L("الإشعار يتجاوز المتبقي للإشعار على الفاتورة", "The credit note exceeds what is left to credit")
    : kind === "CREDIT_NOTE" && !h.creditType ? L("حدّد ما يُشعَر عنه: بضاعة مرتجعة أم تعديل سعر", "Say what the credit note is for: returned goods or a price adjustment")
    : kind === "CREDIT_NOTE" && h.creditType === "RETURN_OF_GOODS" && !h.customerReturnId ? L("اختر مرتجع العميل المرحّل لهذه الفاتورة", "Choose the posted customer return of this invoice")
    : null;
  const valid = !headerErr && errors.every((e) => !e) && lines.length > 0;
  const dueDefault = customer && h.issueDate ? new Date(Date.parse(h.issueDate) + customer.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : "";
  const overLimit = kind === "INVOICE" && customer?.creditLimit && Number(customer.openReceivables) * 100 + tot.gross > Number(customer.creditLimit) * 100;

  async function save(submit: boolean) {
    setTouched(true); setErr(null);
    if (!valid) return;
    setBusy(submit ? "submit" : "draft");
    try {
      const inv = kind === "INVOICE";
      const body = { kind, originalInvoiceId: original?.id ?? null, customerId: h.customerId, orderId: inv ? h.orderId || null : null, issueDate: h.issueDate, supplyDate: h.supplyDate || null, dueDate: inv ? h.dueDate || null : null, description: h.description || null, reason: kind === "CREDIT_NOTE" || debitOf ? h.reason : null, debitNoteOfId: debitOf?.id ?? null,
        fulfilmentLocationId: inv ? h.fulfilmentLocationId || null : null, replacesInvoiceId: inv ? h.replacesInvoiceId || null : null,
        creditType: inv ? null : h.creditType || null, customerReturnId: !inv && h.creditType === "RETURN_OF_GOODS" ? h.customerReturnId || null : null,
        lines: lines.map((l) => ({ ...l, accountId: inv ? l.accountId || null : null, taxCategoryId: l.taxCategoryId || null,
          stockTreatment: inv ? l.stockTreatment || null : null, invItemId: inv && l.stockTreatment === "GOODS" ? l.invItemId || null : null, unit: inv && l.stockTreatment === "GOODS" ? l.unit || null : null })) };
      const d = editId ? await api<{ id: string }>(`/api/accounting/receivables/invoices/${editId}`, { method: "PATCH", json: body }) : await api<{ id: string }>("/api/accounting/receivables/invoices", { method: "POST", json: body });
      if (submit) await api(`/api/accounting/receivables/invoices/${d.id}/submit`, { method: "POST", json: {} });
      router.push(`/dashboard/accounting/receivables/${d.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); setBusy(""); }
  }

  if (!can("ar_invoice_create")) return <Notice tone="warn">{L("لا تملك صلاحية إعداد فواتير المبيعات.", "You cannot prepare sales invoices.")}</Notice>;
  const vatAcc = byRole("OUTPUT_VAT"), ar = byRole("AR_CONTROL"), returnsAcc = byRole("SALES_RETURNS");
  const credit = kind === "CREDIT_NOTE";
  return (
    <Card>
      <CardTitle title={credit ? L(`إشعار دائن جديد — مقابل INV-${original?.invoiceNo ?? "…"}`, `New credit note — against INV-${original?.invoiceNo ?? "…"}`) : debitOf ? L(`إشعار مدين جديد — يرفع INV-${debitOf.invoiceNo}`, `New debit note — raising INV-${debitOf.invoiceNo}`) : editId ? L("تعديل فاتورة مبيعات (مسودة)", "Edit sales invoice (draft)") : L("فاتورة مبيعات جديدة", "New sales invoice")}
        sub={credit ? L("يُعتمد من شخص غير مُعدّه · لا يتجاوز ما بقي قابلاً للإشعار من الفاتورة", "Approved by someone other than its preparer · never more than is left to credit on the invoice") : L("تُعتمد من شخص غير مُعدّها · المبالغ بالريال السعودي بخانتين عشريتين", "Approved by someone other than its preparer · SAR, two decimals")} />
      <div className="flex gap-3 flex-wrap items-start">
        <Field label={L("العميل", "Customer")} error={touched && !h.customerId ? L("مطلوب", "Required") : null}>
          <select className={`${INPUT} min-w-[240px]`} value={h.customerId} disabled={credit || !!debitOf} onChange={(e) => setH({ ...h, customerId: e.target.value, orderId: "" })}>
            <option value="">{L("اختر…", "Choose…")}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {customer && (vatOk(customer.vatNumber) ? <Badge tone="ok">✓ {L("رقم ضريبي", "VAT no.")} {customer.vatNumber}</Badge> : <Badge tone="info">{L("بلا رقم ضريبي — فاتورة مبسطة", "No VAT number — simplified invoice")}</Badge>)}
        </Field>
        {credit ? <>
          <Field label={L("المتبقي للإشعار", "Left to credit")} hint={L("الفاتورة ناقص إشعارات سابقة", "Invoice less earlier credit notes")}><input className={INPUT} readOnly dir="ltr" value={original?.creditable ?? ""} /></Field>
          <Field label={L("تاريخ الإشعار", "Credit note date")}><input type="date" className={INPUT} value={h.issueDate} onChange={(e) => setH({ ...h, issueDate: e.target.value })} /></Field>
          <Field label={L("السبب", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")} error={touched && h.reason.trim().length < 5 ? L("مطلوب", "Required") : null}><input className={`${INPUT} min-w-[240px]`} value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} /></Field>
          <Field label={L("الفاتورة الأصل", "Original invoice")}><input className={INPUT} readOnly dir="ltr" value={original ? `INV-${original.invoiceNo}` : ""} /></Field>
        </> : <>
          {debitOf && <>
            <Field label={L("الفاتورة الأصل", "Original invoice")}><input className={INPUT} readOnly dir="ltr" value={`INV-${debitOf.invoiceNo}`} /></Field>
            <Field label={L("سبب الإشعار المدين", "Debit-note reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")} error={touched && h.reason.trim().length < 5 ? L("مطلوب", "Required") : null}><input aria-label={L("سبب الإشعار المدين", "Debit-note reason")} className={`${INPUT} min-w-[240px]`} value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} /></Field>
          </>}
          <Field label={L("تاريخ التوريد", "Supply date")} hint={L("التسليم — توقيت الإيراد (D-4)", "Delivery — revenue timing (D-4)")}><input type="date" className={INPUT} value={h.supplyDate} onChange={(e) => setH({ ...h, supplyDate: e.target.value })} /></Field>
          <Field label={L("تاريخ الإصدار", "Issue date")}><input type="date" className={INPUT} value={h.issueDate} onChange={(e) => setH({ ...h, issueDate: e.target.value })} /></Field>
          <Field label={L("الاستحقاق", "Due date")} hint={customer ? L(`${customer.paymentTermsDays} يوماً من شروط العميل`, `${customer.paymentTermsDays} days (customer terms)`) : undefined}>
            <input type="date" className={INPUT} value={h.dueDate || dueDefault} onChange={(e) => setH({ ...h, dueDate: e.target.value })} />
          </Field>
          <Field label={L("الطلب", "Order")} hint={L("طلبات العميل غير المفوترة", "The customer's uninvoiced orders")}>
            <select className={INPUT} value={h.orderId} onChange={(e) => loadOrder(e.target.value)}>
              <option value="">{L("بدون طلب", "No order")}</option>{customerOrders.map((o) => <option key={o.id} value={o.id}>{L(`طلب ${o.orderNumber}`, `Order ${o.orderNumber}`)} · {o.status}</option>)}
            </select>
          </Field>
          <Field label={L("موقع الصرف", "Fulfilment location")} hint={L("تُصرف منه بنود البضاعة التي لا تتبع طلباً مُسلَّماً", "Goods lines not dispatched through an order leave stock from here")}>
            <select className={`${INPUT} min-w-[200px]`} value={h.fulfilmentLocationId} onChange={(e) => setH({ ...h, fulfilmentLocationId: e.target.value })}>
              <option value="">{salesDefault ? L(`افتراضي: ${locName(salesDefault)}`, `Default: ${locName(salesDefault)}`) : L("موقع البيع الافتراضي", "Default sales location")}</option>
              {shipFrom.map((l) => <option key={l.id} value={l.id}>{locName(l)}</option>)}
            </select>
          </Field>
          <Field label={L("تحلّ محل فاتورة معكوسة (اختياري)", "Replaces reversed invoice (optional)")} hint={L("فاتورة مصحّحة للعميل نفسه — لا تُحرّك المخزون", "A corrected invoice for the same customer — moves no stock")}>
            <select className={`${INPUT} min-w-[200px]`} value={h.replacesInvoiceId} disabled={!h.customerId} onChange={(e) => setH({ ...h, replacesInvoiceId: e.target.value })}>
              <option value="">{L("لا تحلّ محل فاتورة", "Does not replace an invoice")}</option>
              {reversedInvoices.map((r) => <option key={r.id} value={r.id}>INV-{r.invoiceNo} · {r.issueDate.slice(0, 10)} · {money(Math.round(Number(r.totalGross) * 100))}</option>)}
            </select>
          </Field>
        </>}
      </div>
      {credit && (
        <fieldset className="rounded-xl border border-border p-3 flex flex-col gap-2">
          <legend className="px-1 text-xs font-bold text-brown">{L("ما الذي يُشعَر عنه؟", "What does the credit note credit?")}</legend>
          <div className="flex gap-4 flex-wrap text-[13px]">
            {([["RETURN_OF_GOODS", L("بضاعة مرتجعة (مرتجع عميل مستلَم ومرحّل)", "Returned goods (a received, posted customer return)")], ["PRICE_ADJUSTMENT", L("تعديل سعر أو خصم — بلا إرجاع بضاعة", "Price adjustment or discount — no goods returned")]] as const).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 cursor-pointer min-h-11">
                <input type="radio" name="creditType" value={v} checked={h.creditType === v} onChange={() => setH({ ...h, creditType: v, customerReturnId: v === "RETURN_OF_GOODS" ? h.customerReturnId : "" })} />
                <span className="font-bold">{label}</span>
              </label>
            ))}
          </div>
          {touched && !h.creditType && <span role="alert" className="text-[11px] text-red-700">{L("مطلوب", "Required")}</span>}
          <p className="text-[11px] text-brown">{L("الإشعار الدائن يصحّح مبلغ الفاتورة فقط؛ البضاعة لا تعود للمخزون إلا عبر مرتجع عميل يستلمه المستودع ويُرحَّل (المخزون ← مرتجعات العملاء).", "A credit note corrects the invoice amount only; goods come back to stock only through a customer return the warehouse receives and posts (Inventory → customer returns).")}</p>
          {h.creditType === "RETURN_OF_GOODS" && (
            <Field label={L("مرتجع العميل", "Customer return")} error={touched && !h.customerReturnId ? L("مطلوب", "Required") : null}
              hint={openReturns.length ? L("المرتجعات المرحّلة لهذه الفاتورة وغير المُشعَر عنها", "Posted returns of this invoice not yet credited") : L("لا مرتجع مرحّل لهذه الفاتورة بعد — استلم البضاعة أولاً", "No posted return for this invoice yet — receive the goods first")}>
              <select className={`${INPUT} min-w-[260px]`} value={h.customerReturnId} onChange={(e) => setH({ ...h, customerReturnId: e.target.value })}>
                <option value="">{L("اختر…", "Choose…")}</option>
                {openReturns.map((r) => <option key={r.id} value={r.id}>R-{r.returnNo}{r.receivedOn ? ` · ${r.receivedOn.slice(0, 10)}` : ""} · {r.reason}</option>)}
              </select>
            </Field>
          )}
          {chosenReturn && <p className="text-[12px] text-charcoal">{L("البنود المرتجعة:", "Returned lines:")} <span dir="auto">{chosenReturn.lines.map((l) => `${l.item} × ${Number(l.quantity)} ${l.unit}`).join(" · ")}</span></p>}
        </fieldset>
      )}
      <Table>
        <thead><tr><Th>#</Th><Th>{L("البند / الحساب", "Item / account")}</Th>{!credit && <Th>{L("المخزون", "Stock")}</Th>}<Th>{L("الوصف", "Description")}</Th><Th num>{L("الكمية", "Qty")}</Th><Th num>{L("سعر الوحدة", "Unit price")}</Th><Th num>{L("خصم %", "Disc. %")}</Th><Th num>{L("الصافي", "Net")}</Th><Th>{L("فئة الضريبة", "Tax category")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th></Th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>{i + 1}</Td>
              <Td className="min-w-[210px]">
                {credit ? <span className="text-[13px]">{acctName(returnsAcc)} <span className="text-brown text-[11px]">{L("(تلقائي)", "(automatic)")}</span></span> : (
                  <select aria-label={L(`حساب البند ${i + 1}`, `Line ${i + 1} account`)} className={INPUT} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
                    <option value="">{L(`افتراضي: ${acctName(defRevenue)}`, `Default: ${acctName(defRevenue)}`)}</option>{revenue.map((a) => <option key={a.id} value={a.id}>{acctName(a)}</option>)}
                  </select>)}
                {touched && errors[i] && <span role="alert" className="block text-[11px] text-red-700 mt-1">{errors[i]}</span>}
              </Td>
              {!credit && <Td className="min-w-[200px]"><StockCell l={l} i={i} item={itemFor(l)} items={items} onChange={(patch) => set(i, patch)} /></Td>}
              <Td className="min-w-[170px]"><input aria-label={L(`وصف البند ${i + 1}`, `Line ${i + 1} description`)} className={INPUT} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></Td>
              <Td num className="w-[80px]"><input aria-label={L(`كمية البند ${i + 1}`, `Line ${i + 1} quantity`)} inputMode="decimal" dir="ltr" className={`${INPUT} text-end`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Td>
              <Td num className="w-[110px]"><input aria-label={L(`سعر البند ${i + 1}`, `Line ${i + 1} unit price`)} inputMode="decimal" dir="ltr" className={`${INPUT} text-end`} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} /></Td>
              <Td num className="w-[80px]"><input aria-label={L(`خصم البند ${i + 1}`, `Line ${i + 1} discount`)} inputMode="decimal" dir="ltr" className={`${INPUT} text-end`} value={l.discountPercent} onChange={(e) => set(i, { discountPercent: e.target.value })} /></Td>
              <Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td>
              <Td className="min-w-[130px]">
                <select aria-label={L(`ضريبة البند ${i + 1}`, `Line ${i + 1} tax`)} className={INPUT} value={l.taxCategoryId} onChange={(e) => set(i, { taxCategoryId: e.target.value })}>
                  <option value="">{L("خارج النطاق (0%)", "Out of scope (0%)")}</option>{taxes.map((t) => <option key={t.id} value={t.id}>{L(t.nameAr ?? t.nameEn, t.nameEn)}</option>)}
                </select>
              </Td>
              <Td num>{calc[i] ? money(calc[i]!.vat) : "—"}</Td>
              <Td num className="font-bold">{calc[i] ? money(calc[i]!.gross) : "—"}</Td>
              <Td><button type="button" aria-label={L(`حذف البند ${i + 1}`, `Remove line ${i + 1}`)} disabled={lines.length <= 1} className="text-brown hover:text-red-700 disabled:opacity-40 p-1" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X size={16} /></button></Td>
            </tr>
          ))}
          <tr className="bg-cream-dark font-extrabold"><Td></Td><Td>{L("المجموع", "Total")}</Td>{!credit && <Td></Td>}<Td></Td><Td></Td><Td></Td><Td></Td><Td num>{money(tot.net)}</Td><Td></Td><Td num>{money(tot.vat)}</Td><Td num>{money(tot.gross)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <div><Button kind="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blank(taxes.find((t) => t.isDefault)?.id ?? "")])}>{L("بند", "Line")}</Button></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          {credit
            ? <Notice tone="warn">{L("يسوّي الإشعار فاتورته الأصل أولاً؛ ما يزيد يبقى رصيداً دائناً للعميل يُخصَّص لفاتورة أخرى أو يُرد عبر البنك. الإشعار لا يُعيد بضاعة للمخزون: ذلك يتم فقط بمرتجع عميل مستلَم ومرحّل.", "The credit settles its invoice first; any rest stays as the customer's credit, to allocate to another invoice or refund through the bank. A credit note brings no goods back to stock: only a received, posted customer return does.")}</Notice>
            : <Notice tone="info">{L("تكلفة المبيعات قيد مستقل عن الفاتورة: بعد الترحيل تُصرف بنود البضاعة بالتكلفة من المخزون، وتظهر حالتها على الفاتورة. البنود غير المخزنية (خدمات، رسوم) لا تُكلَّف. توقيت الإيراد عند التسليم (D-4) بانتظار اعتماد المحاسب.", "Cost of sales is a separate entry: after posting, goods lines are issued from stock at cost and the status shows on the invoice. Non-stock lines (services, fees) are not costed. Revenue timing at delivery (D-4) awaits the accountant's approval.")}</Notice>}
          {!credit && h.replacesInvoiceId && <Notice tone="info">{L("فاتورة مصحّحة: تأخذ البضاعة التي سُلّمت على الفاتورة المعكوسة؛ لا يُصرف مخزون مرة أخرى.", "Corrected invoice: it takes over the goods delivered on the reversed invoice; no stock is issued again.")}</Notice>}
          {priceNote && <Notice tone="info">{priceNote}</Notice>}
          {overLimit && <Notice tone="bad">{L("تتجاوز هذه الفاتورة حد ائتمان العميل مع المستحق القائم — يقرر المعتمد.", "This invoice takes the customer over the credit limit with what is already owed — the approver decides.")}</Notice>}
          {customer && !credit && <Notice tone={vatOk(customer.vatNumber) ? "ok" : "info"}>{vatOk(customer.vatNumber) ? L("العميل مسجّل ضريبياً: فاتورة ضريبية. الربط مع ZATCA في المرحلة 6 (غير مفعّل بعد).", "The customer is VAT-registered: a tax invoice. ZATCA integration is stage 6 (not active yet).") : L("عميل غير مسجّل: فاتورة ضريبية مبسطة. الربط مع ZATCA في المرحلة 6.", "Unregistered customer: a simplified tax invoice. ZATCA integration is stage 6.")}</Notice>}
        </div>
        <div className="bg-cream rounded-xl border border-border p-3 flex flex-col gap-2">
          <p className="text-[13px] font-extrabold text-charcoal">{L("معاينة القيد عند الترحيل", "Journal preview on posting")}</p>
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {credit ? <>
                <tr><Td>{acctName(returnsAcc)}</Td><Td num>{money(tot.net)}</Td><Td num></Td></tr>
                {tot.vat > 0 && <tr><Td>{acctName(vatAcc)}</Td><Td num>{money(tot.vat)}</Td><Td num></Td></tr>}
                <tr><Td>{acctName(ar)}{customer ? ` — ${customer.name}` : ""}</Td><Td num></Td><Td num>{money(tot.gross)}</Td></tr>
              </> : <>
                <tr><Td>{acctName(ar)}{customer ? ` — ${customer.name}` : ""}</Td><Td num>{money(tot.gross)}</Td><Td num></Td></tr>
                {lines.map((l, i) => <tr key={i}><Td>{acctName(accounts.find((a) => a.id === l.accountId) ?? defRevenue)}</Td><Td num></Td><Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td></tr>)}
                {tot.vat > 0 && <tr><Td>{acctName(vatAcc)}</Td><Td num></Td><Td num>{money(tot.vat)}</Td></tr>}
              </>}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("متوازن ✓", "Balanced ✓")}</Td><Td num>{money(tot.gross)}</Td><Td num>{money(tot.gross)}</Td></tr>
            </tbody>
          </Table>
        </div>
      </div>
      {touched && headerErr && <Notice tone="bad">{headerErr}</Notice>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2 justify-start">
        <Button kind="primary" busy={busy === "submit"} disabled={!!busy} onClick={() => save(true)}>{L("حفظ وتقديم للاعتماد", "Save and submit")}</Button>
        <Button busy={busy === "draft"} disabled={!!busy} onClick={() => save(false)}>{L("حفظ كمسودة", "Save as draft")}</Button>
        <Button kind="ghost" onClick={() => router.push("/dashboard/accounting/receivables")}>{L("إلغاء", "Cancel")}</Button>
      </div>
    </Card>
  );
}

/** Per-line stock treatment (invoices): goods from stock (item, optional unit) or non-stock. */
function StockCell({ l, i, item, items, onChange }: { l: Line; i: number; item: Item | undefined; items: Item[]; onChange: (patch: Partial<Line>) => void }) {
  const { L } = useL();
  const named = !!l.productSkuId;
  return (
    <div className="flex flex-col gap-1.5">
      <select aria-label={L(`نوع البند ${i + 1}`, `Line ${i + 1} stock treatment`)} className={INPUT} value={l.stockTreatment}
        onChange={(e) => { const v = e.target.value as Treatment; onChange(v === "GOODS" ? { stockTreatment: v } : { stockTreatment: v, invItemId: "", unit: "" }); }}>
        <option value="">{L("اختر…", "Choose…")}</option>
        <option value="GOODS">{L("بضاعة من المخزون", "Goods (from stock)")}</option>
        <option value="NON_STOCK" disabled={named}>{L("غير مخزني (خدمة، رسوم)", "Non-stock (service, fee)")}</option>
      </select>
      {l.stockTreatment === "GOODS" && (named && !l.invItemId
        ? <span className="text-[11px] text-brown">{item ? `${item.code} · ${L(item.name, item.nameEn)}` : L("المنتج غير مربوط بصنف مخزون — ستتوقف التكلفة مع السبب", "The product is not linked to a stock item — costing will stop with the reason")}</span>
        : <select aria-label={L(`صنف البند ${i + 1}`, `Line ${i + 1} stock item`)} className={INPUT} value={l.invItemId} onChange={(e) => onChange({ invItemId: e.target.value, unit: "" })}>
          <option value="">{L("صنف المخزون…", "Stock item…")}</option>
          {items.filter((x) => x.isActive || x.id === l.invItemId).map((x) => <option key={x.id} value={x.id}>{x.code} · {L(x.name, x.nameEn)}</option>)}
        </select>)}
      {l.stockTreatment === "GOODS" && item && (
        <select aria-label={L(`وحدة البند ${i + 1}`, `Line ${i + 1} unit`)} className={INPUT} value={l.unit} onChange={(e) => onChange({ unit: e.target.value })}>
          <option value="">{L(`الوحدة الأساسية (${item.baseUnit})`, `Base unit (${item.baseUnit})`)}</option>
          {item.units.filter((u) => u.unit !== item.baseUnit).map((u) => <option key={u.unit} value={u.unit}>{u.unit} = {Number(u.factor)} {item.baseUnit}</option>)}
        </select>
      )}
    </div>
  );
}
