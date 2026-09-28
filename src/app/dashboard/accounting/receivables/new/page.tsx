"use client";

// Figma: ACC-31 (sales invoice editor, optionally from an order: prices from its accepted quote)
// and ACC-35 (credit note against a posted invoice, ?creditFor=<invoiceId>). Live totals are
// computed exactly like the server (half-up per step). ?edit=<id> edits a draft.
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
type Line = { accountId: string; description: string; quantity: string; unitPrice: string; discountPercent: string; taxCategoryId: string; productSkuId: string | null; orderItemId: string | null };
type Original = { id: string; invoiceNo: number; customerId: string; customer: { nameAr: string | null; name: string }; totalGross: string; creditable: string | null; status: string; kind: string; orderId: string | null };

const blank = (tax = ""): Line => ({ accountId: "", description: "", quantity: "1", unitPrice: "", discountPercent: "0", taxCategoryId: tax, productSkuId: null, orderItemId: null });
const vatOk = (v: string | null | undefined) => !!v && /^3\d{13}3$/.test(v);

export default function NewSalesDocPage() {
  const { L, money } = useL();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get("edit");
  const creditFor = sp.get("creditFor");
  const { can } = useCan();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [original, setOriginal] = useState<Original | null>(null);
  const [kind, setKind] = useState<"INVOICE" | "CREDIT_NOTE">(creditFor ? "CREDIT_NOTE" : "INVOICE");
  const [h, setH] = useState(() => ({ customerId: "", orderId: "", issueDate: riyadhToday(), supplyDate: "", dueDate: "", description: "", reason: "" }));
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
      setLines(d.lines.map((l) => ({ accountId: "", description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxCategoryId: l.taxCategoryId ?? "", productSkuId: l.productSkuId, orderItemId: l.orderItemId })));
      setPriceNote(d.quote ? L(`الأسعار من عرض السعر المقبول ${d.quote.number} للطلب ${d.order.orderNumber}.`, `Prices from accepted quote ${d.quote.number} for order ${d.order.orderNumber}.`) : L(`لا عرض سعر مقبول للطلب ${d.order.orderNumber}: الأسعار من بطاقة المنتج — راجعها.`, `No accepted quote for order ${d.order.orderNumber}: prices from the product card — review them.`));
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  };

  useEffect(() => {
    api<Customer[]>("/api/accounting/receivables/customers").then(setCustomers).catch(() => {});
    api<Account[]>("/api/accounting/coa").then(setAccounts).catch(() => {});
    api<Tax[]>("/api/accounting/tax-categories").then((t) => {
      setTaxes(t.filter((x) => x.isActive));
      if (!editId) setLines([blank(t.find((x) => x.isDefault && x.isActive)?.id ?? "")]);
      const fromOrder = sp.get("order");
      if (fromOrder && !editId && !creditFor) loadOrder(fromOrder);   // "invoice this order"
    }).catch(() => {});
    if (creditFor) api<Original>(`/api/accounting/receivables/invoices/${creditFor}`).then((o) => {
      setOriginal(o); setKind("CREDIT_NOTE");
      setH((x) => ({ ...x, customerId: o.customerId }));
    }).catch((e) => setErr((e as Error).message));
    if (editId) api<{ kind: "INVOICE" | "CREDIT_NOTE"; customerId: string; orderId: string | null; originalInvoiceId: string | null; issueDate: string; supplyDate: string | null; dueDate: string; description: string | null; reason: string | null;
      lines: { accountId: string; description: string | null; quantity: string; unitPrice: string; discountPercent: string; taxCategoryId: string | null; productSkuId: string | null; orderItemId: string | null }[] }>(`/api/accounting/receivables/invoices/${editId}`).then((d) => {
      setKind(d.kind);
      setH({ customerId: d.customerId, orderId: d.orderId ?? "", issueDate: d.issueDate.slice(0, 10), supplyDate: d.supplyDate?.slice(0, 10) ?? "", dueDate: d.dueDate.slice(0, 10), description: d.description ?? "", reason: d.reason ?? "" });
      setLines(d.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? "", quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), discountPercent: String(Number(l.discountPercent)), taxCategoryId: l.taxCategoryId ?? "", productSkuId: l.productSkuId, orderItemId: l.orderItemId })));
      if (d.originalInvoiceId) api<Original>(`/api/accounting/receivables/invoices/${d.originalInvoiceId}`).then(setOriginal).catch(() => {});
    }).catch((e) => setErr((e as Error).message));
    // Runs once per document; loadOrder and sp only feed state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, creditFor]);

  useEffect(() => {
    if (kind !== "INVOICE" || !h.customerId) return;
    api<Order[]>(`/api/accounting/receivables/orders?customerId=${h.customerId}`).then(setOrders).catch(() => setOrders([]));
  }, [h.customerId, kind]);
  const customerOrders = orders.filter((o) => o.customerId === h.customerId);


  const customer = customers.find((c) => c.id === h.customerId);
  const revenue = useMemo(() => accounts.filter((a) => a.isActive && a.allowPosting && a.controlKind === "NONE" && a.type === "REVENUE"), [accounts]);
  const acctName = (a?: { code: string; nameAr: string | null; nameEn: string } | null) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : "—");
  const byRole = (role: string) => accounts.find((a) => a.roles?.includes(role));
  const defRevenue = byRole("SALES_REVENUE");
  const rate = (id: string) => taxes.find((t) => t.id === id)?.rate ?? "0";
  const calc = lines.map((l) => salesLineMinor(l.quantity, l.unitPrice, l.discountPercent, rate(l.taxCategoryId)));
  const tot = calc.reduce<{ net: number; vat: number; gross: number }>((s, c) => ({ net: s.net + (c?.net ?? 0), vat: s.vat + (c?.vat ?? 0), gross: s.gross + (c?.gross ?? 0) }), { net: 0, vat: 0, gross: 0 });
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const errors = lines.map((l, i) => !calc[i] ? L("الكمية والسعر أرقام موجبة والخصم بين 0 و100", "Quantity and price must be positive; discount 0–100") : calc[i]!.net <= 0 ? L("المبلغ صفر", "Amount is zero") : null);
  const creditLeft = original?.creditable ? Math.round(Number(original.creditable) * 100) : null;
  const headerErr = !h.customerId ? L("اختر العميل", "Choose the customer")
    : kind === "CREDIT_NOTE" && h.reason.trim().length < 5 ? L("سبب الإشعار (5 أحرف على الأقل)", "Credit note reason (at least 5 characters)")
    : kind === "CREDIT_NOTE" && creditLeft !== null && tot.gross > creditLeft ? L("الإشعار يتجاوز المتبقي للإشعار على الفاتورة", "The credit note exceeds what is left to credit")
    : null;
  const valid = !headerErr && errors.every((e) => !e) && lines.length > 0;
  const dueDefault = customer && h.issueDate ? new Date(Date.parse(h.issueDate) + customer.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : "";
  const overLimit = kind === "INVOICE" && customer?.creditLimit && Number(customer.openReceivables) * 100 + tot.gross > Number(customer.creditLimit) * 100;

  async function save(submit: boolean) {
    setTouched(true); setErr(null);
    if (!valid) return;
    setBusy(submit ? "submit" : "draft");
    try {
      const body = { kind, originalInvoiceId: original?.id ?? null, customerId: h.customerId, orderId: kind === "INVOICE" ? h.orderId || null : null, issueDate: h.issueDate, supplyDate: h.supplyDate || null, dueDate: kind === "INVOICE" ? h.dueDate || null : null, description: h.description || null, reason: kind === "CREDIT_NOTE" ? h.reason : null,
        lines: lines.map((l) => ({ ...l, accountId: kind === "INVOICE" ? l.accountId || null : null, taxCategoryId: l.taxCategoryId || null })) };
      const d = editId ? await api<{ id: string }>(`/api/accounting/receivables/invoices/${editId}`, { method: "PATCH", json: body }) : await api<{ id: string }>("/api/accounting/receivables/invoices", { method: "POST", json: body });
      if (submit) await api(`/api/accounting/receivables/invoices/${d.id}/submit`, { method: "POST", json: {} });
      router.push(`/dashboard/accounting/receivables/${d.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); setBusy(""); }
  }

  if (!can("ar_invoice_create")) return <Notice tone="warn">{L("لا تملك صلاحية إعداد فواتير المبيعات.", "You cannot prepare sales invoices.")}</Notice>;
  const vatAcc = byRole("OUTPUT_VAT"), ar = byRole("AR_CONTROL"), returns = byRole("SALES_RETURNS");
  const credit = kind === "CREDIT_NOTE";
  return (
    <Card>
      <CardTitle title={credit ? L(`إشعار دائن جديد — مقابل INV-${original?.invoiceNo ?? "…"}`, `New credit note — against INV-${original?.invoiceNo ?? "…"}`) : editId ? L("تعديل فاتورة مبيعات (مسودة)", "Edit sales invoice (draft)") : L("فاتورة مبيعات جديدة", "New sales invoice")}
        sub={credit ? L("يُعتمد من شخص غير مُعدّه · لا يتجاوز ما بقي قابلاً للإشعار من الفاتورة", "Approved by someone other than its preparer · never more than is left to credit on the invoice") : L("تُعتمد من شخص غير مُعدّها · المبالغ بالريال السعودي بخانتين عشريتين", "Approved by someone other than its preparer · SAR, two decimals")} />
      <div className="flex gap-3 flex-wrap items-start">
        <Field label={L("العميل", "Customer")} error={touched && !h.customerId ? L("مطلوب", "Required") : null}>
          <select className={`${INPUT} min-w-[240px]`} value={h.customerId} disabled={credit} onChange={(e) => setH({ ...h, customerId: e.target.value, orderId: "" })}>
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
        </>}
      </div>
      <Table>
        <thead><tr><Th>#</Th><Th>{L("البند / الحساب", "Item / account")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("الكمية", "Qty")}</Th><Th num>{L("سعر الوحدة", "Unit price")}</Th><Th num>{L("خصم %", "Disc. %")}</Th><Th num>{L("الصافي", "Net")}</Th><Th>{L("فئة الضريبة", "Tax category")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th></Th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>{i + 1}</Td>
              <Td className="min-w-[210px]">
                {credit ? <span className="text-[13px]">{acctName(returns)} <span className="text-brown text-[11px]">{L("(تلقائي)", "(automatic)")}</span></span> : (
                  <select aria-label={L(`حساب البند ${i + 1}`, `Line ${i + 1} account`)} className={INPUT} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
                    <option value="">{L(`افتراضي: ${acctName(defRevenue)}`, `Default: ${acctName(defRevenue)}`)}</option>{revenue.map((a) => <option key={a.id} value={a.id}>{acctName(a)}</option>)}
                  </select>)}
                {touched && errors[i] && <span role="alert" className="block text-[11px] text-red-700 mt-1">{errors[i]}</span>}
              </Td>
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
          <tr className="bg-cream-dark font-extrabold"><Td></Td><Td>{L("المجموع", "Total")}</Td><Td></Td><Td></Td><Td></Td><Td></Td><Td num>{money(tot.net)}</Td><Td></Td><Td num>{money(tot.vat)}</Td><Td num>{money(tot.gross)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <div><Button kind="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blank(taxes.find((t) => t.isDefault)?.id ?? "")])}>{L("بند", "Line")}</Button></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          {credit
            ? <Notice tone="warn">{L("يسوّي الإشعار فاتورته الأصل أولاً؛ ما يزيد يبقى رصيداً دائناً للعميل يُخصَّص لفاتورة أخرى أو يُرد عبر البنك. إرجاع البضاعة للمخزون وتكلفتها في المرحلة 4 (D-1).", "The credit settles its invoice first; any rest stays as the customer's credit, to allocate to another invoice or refund through the bank. Returning goods to stock and their cost come in stage 4 (D-1).")}</Notice>
            : <Notice tone="warn">{L("تكلفة المبيعات لا تُرحَّل مع الفاتورة حتى يُفعَّل تقييم المخزون (المرحلة 4، D-1). توقيت الإيراد عند التسليم (D-4) بانتظار اعتماد المحاسب.", "Cost of sales does not post with the invoice until inventory valuation is active (stage 4, D-1). Revenue timing at delivery (D-4) awaits the accountant's approval.")}</Notice>}
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
                <tr><Td>{acctName(returns)}</Td><Td num>{money(tot.net)}</Td><Td num></Td></tr>
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
