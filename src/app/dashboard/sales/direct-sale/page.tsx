"use client";
// «بيع مباشر» (D10, owner-approved Figma page 1827:2 frames B–E, with the owner's 9 decisions of 6 Nov 2026):
//   1 لمين؟        the rep's own customers (never the pool), «＋ عميل جديد» = the shared NewCustomerDialog
//   2 وش بياخذ؟    products at the list price (no price editing), quantity steppers, an optional discount with the
//                  threshold shown inline as it is typed; the totals are the SERVER's (POST /api/sales/direct-sale/price)
//   3 راجع وأرسل    كاش / شبكة / آجل, what «إرسال» does; one tap = one sale (a requestKey per sale). Every order ships
//                  from the roastery (owner, 6 Nov 2026): no hand-over choice. A discount above the threshold WAITS for a
//                  supervisor (same inbox as a quotation's) — then the deal, the invoice request and the collection follow.
//   ✓ انرسلت       the order, the deal, the invoice at the accountant; «أرسل للعميل» opens WhatsApp on the rep's phone
// The rep never issues the invoice (decision 9): «إرسال» only raises it to the accountant.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, useLang } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { NewCustomerDialog, type CreatedCustomer } from "@/components/customers/new-customer-form";
import "./direct-sale.css";

type Customer = { id: string; name: string; nameAr: string | null; city: string | null; lastOrderAt: string | null };
type Product = { id: string; skuCode: string; name: string; price: string };
type Can = { approveDiscount: boolean; collect: boolean; threshold: number; max: number; createCustomer: boolean };
type Options = { customers: Customer[]; products: Product[]; can: Can };
type Priced = { subtotal: string; discountPercent: string; discount: string; net: string; tax: string; gross: string; needsApproval?: boolean; lines: { productSkuId: string; lineNet: string; lineGross: string; unitPrice: string }[] };
type Payment = "CASH" | "CARD" | "CREDIT";
type Done = { order: { id: string; orderNumber: number }; discountApproval: "NONE" | "PENDING" | "APPROVED"; totals: { gross: string; discountPercent: string }; payment: { method: Payment; collectionId: string | null } };

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ds-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
const money = (v: string | number) => `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;

function daysAgo(iso: string | null, ar: boolean): string {
  if (!iso) return ar ? "ما طلب قبل" : "No order yet";
  const d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (ar) return d === 0 ? "آخر طلب اليوم" : d === 1 ? "آخر طلب أمس" : `آخر طلب قبل ${d} يوم`;
  return d === 0 ? "Last order today" : `Last order ${d} days ago`;
}

export default function DirectSalePage() {
  return <Suspense fallback={null}><DirectSale /></Suspense>;
}

function DirectSale() {
  const lang = useLang();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const router = useRouter();
  const params = useSearchParams();
  useD21Phone({ title: L("بيع مباشر", "Direct sale") });
  useD21Title(L("بيع مباشر", "Direct sale"));

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Options | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [find, setFind] = useState("");
  const [discountOn, setDiscountOn] = useState(false);
  const [discount, setDiscount] = useState("");
  const [priced, setPriced] = useState<Priced | null>(null);
  const [priceError, setPriceError] = useState<{ code?: string; text: string } | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const key = useRef(newKey());

  const nameOf = (c: Pick<Customer, "name" | "nameAr">) => (ar ? c.nameAr || c.name : c.name);

  // Step 1 data (and the products once): the rep's own book only — the server never returns the pool.
  useEffect(() => {
    let off = false;
    const t = setTimeout(async () => {
      const r = await api<Options>(`/api/sales/direct-sale/options?q=${encodeURIComponent(q.trim())}`);
      if (off) return;
      if (r.ok) { setOpts(r.data); setError(""); } else setError(r.data.error ?? L("تعذّر التحميل.", "Could not load."));
      setLoading(false);
    }, q ? 250 : 0);
    return () => { off = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // «طلب جديد» from a customer: start on that customer when it is in the book.
  const asked = params.get("customerId");
  useEffect(() => {
    if (!asked) return;
    let off = false;
    void api<Options>(`/api/sales/direct-sale/options?customerId=${encodeURIComponent(asked)}`).then((r) => {
      if (!off && r.ok && r.data.customers[0]) { setCustomer(r.data.customers[0]); setStep(2); }
    });
    return () => { off = true; };
  }, [asked]);

  const lines = useMemo(() => Object.entries(qty).filter(([, n]) => n > 0).map(([productSkuId, quantityUnits]) => ({ productSkuId, quantityUnits })), [qty]);
  const products = useMemo(() => opts?.products ?? [], [opts]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const can = opts?.can;
  const discountNum = discountOn && discount.trim() ? Number(discount.replace(",", ".")) : 0;
  const overThreshold = !!can && discountNum > can.threshold;

  // The server's price of the cart (the same arithmetic «إرسال» commits).
  const reprice = useCallback(async () => {
    if (!customer || lines.length === 0) { setPriced(null); setPriceError(null); return; }
    const r = await api<Priced & { code?: string }>("/api/sales/direct-sale/price", { method: "POST", body: { customerId: customer.id, lines, discountPercent: discountNum || undefined } });
    if (r.ok) { setPriced(r.data); setPriceError(null); } else { setPriceError({ code: r.data.code, text: r.data.error ?? L("تعذّر حساب السعر.", "Could not price.") }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, lines, discountNum]);
  useEffect(() => { const t = setTimeout(reprice, 250); return () => clearTimeout(t); }, [reprice]);

  function pickCustomer(c: Customer) { setCustomer(c); setStep(2); }
  function created(c: CreatedCustomer) {
    setNewCustomer(false);
    pickCustomer({ id: c.id, name: c.name, nameAr: c.nameAr, city: c.city, lastOrderAt: null });
  }
  const setLine = (id: string, n: number) => setQty((prev) => ({ ...prev, [id]: Math.max(0, Math.min(100000, Math.floor(n))) }));
  const remove = (id: string) => setQty((prev) => { const next = { ...prev }; delete next[id]; return next; });

  async function send() {
    if (!customer || !priced || !payment || busy) return;
    setBusy(true); setError("");
    const r = await api<Done & { code?: string }>("/api/sales/direct-sale", {
      method: "POST",
      body: { customerId: customer.id, lines, requestKey: key.current, discountPercent: discountNum || undefined, payment },
    });
    setBusy(false);
    if (r.ok) { setDone(r.data); setStep(4); return; }
    setError(r.data.error ?? L("ما انرسل — جرّب مرة ثانية.", "Not sent — try again."));
  }

  const close = () => router.push("/dashboard/my-day");
  const back = () => { setError(""); if (step === 2) { setStep(1); setCustomer(null); } else if (step === 3) setStep(2); };
  const stepName = step === 1 ? L("العميل", "Customer") : step === 2 ? L("الأصناف", "Items") : L("راجع وأرسل", "Review and send");
  const units = lines.reduce((t, l) => t + l.quantityUnits, 0);

  const askedOrder = params.get("order");
  if (askedOrder) return <Resubmit orderId={askedOrder} ar={ar} />;

  if (step === 4 && done && customer) {
    const waiting = done.discountApproval === "PENDING";
    const msg = [
      L(`طلب #${done.order.orderNumber} · ${nameOf(customer)}`, `Order #${done.order.orderNumber} · ${nameOf(customer)}`),
      ...lines.map((l) => `• ${byId.get(l.productSkuId)?.name ?? ""} × ${l.quantityUnits}`),
      L(`الإجمالي شامل الضريبة: ${money(done.totals.gross)}`, `Total incl. VAT: ${money(done.totals.gross)}`),
      L("الفاتورة الضريبية الرسمية توصلك بعد ما يصدرها المحاسب.", "The official tax invoice follows once the accountant issues it."),
    ].join("\n");
    return (
      <div className="ds" dir={ar ? "rtl" : "ltr"} data-testid="ds-done">
        <div className="ds-done">
          <span className={waiting ? "ds-ok wait" : "ds-ok"} aria-hidden><Ico name={waiting ? "clock" : "tick"} /></span>
          <h1>{waiting ? L("انرسل للمشرف", "Sent to your supervisor") : L("انرسلت", "Sent")}</h1>
          <p className="ds-mut"><bdi>#{done.order.orderNumber}</bdi> · <bdi>{nameOf(customer)}</bdi> · {money(done.totals.gross)}</p>
          <dl className="ds-card ds-kv">
            <div><dt>{L("الطلب", "Order")}</dt><dd className={waiting ? "ds-warn" : undefined} data-testid="ds-done-order">{waiting ? L(`بانتظار موافقة الخصم (${Number(done.totals.discountPercent)}٪)`, `Waiting for the discount approval (${Number(done.totals.discountPercent)}%)`) : L("انسوّى · يتجهز ويوصل من المحمصة", "Created · prepared and shipped from the roastery")}</dd></div>
            <div><dt>{L("الصفقة", "Deal")}</dt><dd className={waiting ? undefined : "ds-good"}>{waiting ? L("تنقفل رابحة بعد الموافقة", "Won once approved") : L("رابحة", "Won")}</dd></div>
            <div><dt>{L("الدفع", "Payment")}</dt><dd>{done.payment.method === "CREDIT" ? L("آجل على حساب العميل", "On account") : waiting ? L(done.payment.method === "CASH" ? "كاش · ينسجل بعد الموافقة" : "شبكة · ينسجل بعد الموافقة", "Recorded once approved") : done.payment.method === "CASH" ? L("كاش · ينتظر اعتماد المحاسب", "Cash · awaiting the accountant") : L("شبكة · ينتظر اعتماد المحاسب", "Card · awaiting the accountant")}</dd></div>
            <div><dt>{L("الفاتورة", "Invoice")}</dt><dd className="ds-warn">{waiting ? L("تروح للمحاسب بعد الموافقة", "Goes to the accountant once approved") : L("عند المحاسب يصدرها", "With the accountant to issue")}</dd></div>
          </dl>
          <p className="ds-note">{waiting
            ? L("لا تسلّم البضاعة ولا تستلم فلوس للحين. يوصلك إشعار لما يوافق المشرف أو يرفض.", "Don't hand over goods or take money yet. You'll be notified when your supervisor decides.")
            : L("الفاتورة الضريبية الرسمية يصدرها المحاسب ويرسلها للعميل.", "The accountant issues the official tax invoice and sends it to the customer.")}</p>
          {!waiting ? (
            <a className="ds-btn p" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer" data-testid="ds-whatsapp">
              <Ico name="chat" small /> {L("أرسل للعميل (واتساب)", "Send to the customer (WhatsApp)")}
            </a>
          ) : null}
          <Link className="ds-btn" href={`/dashboard/orders?order=${done.order.orderNumber}`} data-testid="ds-open-order">{L("افتح الطلب", "Open the order")}</Link>
          <Link className="ds-btn g" href="/dashboard/my-day">{L("رجوع ليومي", "Back to my day")}</Link>
        </div>
      </div>
    );
  }

  const shown = find.trim() ? products.filter((p) => `${p.name} ${p.skuCode}`.toLowerCase().includes(find.trim().toLowerCase())) : products;

  return (
    <div className="ds" dir={ar ? "rtl" : "ltr"} data-testid="direct-sale">
      <header className="ds-head">
        {step > 1 ? <button type="button" className="ds-ib" onClick={back} aria-label={L("رجوع", "Back")} data-testid="ds-back"><Ico name="back" /></button> : <span className="ds-ib-ph" />}
        <div className="ds-title"><h1>{customer && step > 1 ? <>{L("بيع مباشر", "Direct sale")} · <bdi>{nameOf(customer)}</bdi></> : L("بيع مباشر", "Direct sale")}</h1><span>{L(`${step} من 3`, `${step} of 3`)} · {stepName}</span></div>
        <button type="button" className="ds-ib" onClick={close} aria-label={L("إغلاق", "Close")} data-testid="ds-close"><Ico name="close" /></button>
      </header>
      <div className="ds-steps" aria-hidden>{[1, 2, 3].map((i) => <i key={i} className={i <= step ? "on" : ""} />)}</div>
      {error ? <p className="notice er" role="alert" data-testid="ds-error">{error}</p> : null}

      {step === 1 ? (
        <section className="ds-body" aria-label={L("العميل", "Customer")}>
          <label className="ds-search">
            <Ico name="search" small />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("ابحث باسم العميل أو رقم الجوال", "Search by name or mobile")} aria-label={L("بحث عن عميل", "Search customers")} data-testid="ds-search" />
          </label>
          {can?.createCustomer ? (
            <button type="button" className="ds-btn" onClick={() => setNewCustomer(true)} data-testid="ds-new-customer"><Ico name="plus" small /> {L("عميل جديد", "New customer")}</button>
          ) : null}
          <p className="ds-lbl">{L("عملائي", "My customers")}</p>
          <ul className="ds-list" aria-busy={loading || undefined} data-testid="ds-customers">
            {(opts?.customers ?? []).map((c) => (
              <li key={c.id}>
                <button type="button" className="ds-row" onClick={() => pickCustomer(c)} data-testid={`ds-customer-${c.id}`}>
                  <span className="ds-row-txt"><b><bdi>{nameOf(c)}</bdi></b><small>{[c.city, daysAgo(c.lastOrderAt, ar)].filter(Boolean).join(" · ")}</small></span>
                  <span className="ds-chev" aria-hidden><Ico name="chev" small /></span>
                </button>
              </li>
            ))}
            {!loading && (opts?.customers.length ?? 0) === 0 ? <li className="ds-empty">{q.trim() ? L("ما لقينا عميل بهذا الاسم في عملائك.", "No customer of yours by that name.") : L("ما عندك عملاء للحين.", "You have no customers yet.")}</li> : null}
          </ul>
        </section>
      ) : null}

      {step === 2 && customer ? (
        <section className="ds-body ds-two" aria-label={L("الأصناف", "Items")}>
          <div className="ds-main">
            <div className="ds-chip"><span>{L("العميل:", "Customer:")}</span><b><bdi>{nameOf(customer)}</bdi></b><button type="button" className="ds-link" onClick={back}>{L("غيّر", "Change")}</button></div>
            {lines.map((l) => {
              const p = byId.get(l.productSkuId);
              const pl = priced?.lines.find((x) => x.productSkuId === l.productSkuId);
              return (
                <div key={l.productSkuId} className="ds-card ds-item" data-testid={`ds-line-${l.productSkuId}`}>
                  <div className="ds-item-top">
                    <span className="ds-row-txt"><b>{p?.name ?? l.productSkuId}</b><small>{L(`السعر من قائمة الأسعار: ${money(p?.price ?? 0)}`, `List price: ${money(p?.price ?? 0)}`)}</small></span>
                    <button type="button" className="ds-ib sm" onClick={() => remove(l.productSkuId)} aria-label={L(`شيل ${p?.name ?? ""}`, `Remove ${p?.name ?? ""}`)}><Ico name="close" small /></button>
                  </div>
                  <div className="ds-item-bot">
                    <div className="ds-qty" role="group" aria-label={L("الكمية", "Quantity")}>
                      <button type="button" onClick={() => setLine(l.productSkuId, l.quantityUnits - 1)} aria-label={L("نقّص", "Less")} data-testid={`ds-minus-${l.productSkuId}`}>−</button>
                      <input inputMode="numeric" value={l.quantityUnits} onChange={(e) => setLine(l.productSkuId, Number(e.target.value.replace(/\D/g, "")) || 0)} aria-label={L("الكمية", "Quantity")} data-testid={`ds-qty-${l.productSkuId}`} />
                      <button type="button" onClick={() => setLine(l.productSkuId, l.quantityUnits + 1)} aria-label={L("زِد", "More")} data-testid={`ds-plus-${l.productSkuId}`}>＋</button>
                    </div>
                    <b className="ds-amt">{pl ? money(pl.lineGross) : "—"}</b>
                  </div>
                </div>
              );
            })}
            {adding || lines.length === 0 ? (
              <div className="ds-card ds-add" data-testid="ds-products">
                <label className="ds-search"><Ico name="search" small /><input autoFocus={lines.length > 0} value={find} onChange={(e) => setFind(e.target.value)} placeholder={L("ابحث عن صنف", "Find a product")} aria-label={L("ابحث عن صنف", "Find a product")} data-testid="ds-find" /></label>
                <ul className="ds-list">
                  {shown.slice(0, 30).map((p) => (
                    <li key={p.id}>
                      <button type="button" className="ds-row" onClick={() => { setLine(p.id, (qty[p.id] ?? 0) + 1); setAdding(false); setFind(""); }} data-testid={`ds-product-${p.id}`}>
                        <span className="ds-row-txt"><b>{p.name}</b><small><bdi>{p.skuCode}</bdi> · {money(p.price)}</small></span>
                        <span className="ds-chev" aria-hidden><Ico name="plus" small /></span>
                      </button>
                    </li>
                  ))}
                  {shown.length === 0 ? <li className="ds-empty">{L("ما فيه صنف بهذا الاسم.", "No product by that name.")}</li> : null}
                </ul>
              </div>
            ) : (
              <button type="button" className="ds-btn" onClick={() => setAdding(true)} data-testid="ds-add-item"><Ico name="plus" small /> {L("أضف صنف", "Add an item")}</button>
            )}
            {lines.length > 0 ? (
              discountOn ? (
                <div className="ds-disc">
                  <label htmlFor="ds-discount">{L("خصم ٪", "Discount %")}</label>
                  <input id="ds-discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.,]/g, "").slice(0, 5))} data-testid="ds-discount" aria-describedby="ds-disc-hint" />
                  <button type="button" className="ds-link" onClick={() => { setDiscountOn(false); setDiscount(""); }}>{L("بدون خصم", "No discount")}</button>
                  <p id="ds-disc-hint" className={overThreshold ? "ds-hint warn" : "ds-hint"} data-testid="ds-disc-hint">
                    {overThreshold
                      ? (can?.approveDiscount
                        ? L(`فوق ${can.threshold}٪ — عندك صلاحية الموافقة (الحد ${can.max}٪).`, `Above ${can.threshold}% — you may approve it (max ${can.max}%).`)
                        : L(`فوق ${can?.threshold}٪ — ينرسل لمشرفك يوافق، وبعدها يكمل الطلب والفاتورة لحالهم.`, `Above ${can?.threshold}% — it goes to your supervisor first; the order and invoice follow once approved.`))
                      : L(`لين ${can?.threshold ?? 10}٪ بدون موافقة. فوقها يروح لمشرفك يوافق.`, `Up to ${can?.threshold ?? 10}% without approval; above it goes to your supervisor.`)}
                  </p>
                </div>
              ) : (
                <button type="button" className="ds-link ds-disc-on" onClick={() => setDiscountOn(true)} data-testid="ds-discount-on"><Ico name="plus" small /> {L("خصم", "Discount")}</button>
              )
            ) : null}
          </div>
          <aside className="ds-side">
            <Totals priced={priced} ar={ar} />
            {priceError ? <p className="notice er" role="alert" data-testid="ds-price-error">{priceError.text}</p> : null}
            <button type="button" className="ds-btn p big" disabled={!priced || !!priceError || lines.length === 0} onClick={() => setStep(3)} data-testid="ds-next">{L("التالي: راجع وأرسل", "Next: review and send")}</button>
          </aside>
        </section>
      ) : null}

      {step === 3 && customer && priced ? (
        <section className="ds-body" aria-label={L("راجع وأرسل", "Review and send")}>
          <div className="ds-card">
            <div className="ds-kvrow"><span>{L("العميل", "Customer")}</span><b><bdi>{nameOf(customer)}</bdi></b></div>
            <div className="ds-kvrow"><span>{L("الأصناف", "Items")}</span><b>{L(`${lines.length} صنف · ${units} حبة`, `${lines.length} items · ${units} units`)}</b></div>
            <Totals priced={priced} ar={ar} flat />
          </div>
          <fieldset className="ds-choice" data-testid="ds-payment">
            <legend>{L("الدفع", "Payment")}</legend>
            {(can?.collect ? (["CASH", "CARD", "CREDIT"] as const) : (["CREDIT"] as const)).map((m) => (
              <label key={m} className={payment === m ? "on" : ""}><input type="radio" name="ds-payment" checked={payment === m} onChange={() => setPayment(m)} data-testid={`ds-payment-${m}`} />{m === "CASH" ? L("كاش", "Cash") : m === "CARD" ? L("شبكة", "Card") : L("آجل", "On account")}</label>
            ))}
          </fieldset>
          <p className="ds-lbl strong">{L("لما تضغط «إرسال»:", "When you tap «Send»:")}</p>
          {priced.needsApproval ? (
            <div className="ds-card ds-pending" role="note" data-testid="ds-pending-note">
              <b>{L(`الخصم ${Number(priced.discountPercent)}٪ فوق الحد — ينرسل لمشرفك يوافق`, `The ${Number(priced.discountPercent)}% discount is above the limit — it goes to your supervisor`)}</b>
              <span>{L("بعد الموافقة: تنقفل الصفقة رابحة، وينسجل الدفع، وتروح الفاتورة للمحاسب. لا تسلّم البضاعة ولا تستلم فلوس قبلها.", "Once approved: the deal is won, the payment recorded and the invoice sent to the accountant. Don't hand over goods or take money before.")}</span>
            </div>
          ) : (
            <ul className="ds-card ds-what">
              <li><Ico name="tick" small />{L("ينسوّى الطلب ويتجهز ويوصل من المحمصة", "The order is created, prepared and shipped from the roastery")}</li>
              <li><Ico name="tick" small />{L("تنقفل الصفقة «رابحة» بنفس المبلغ", "The deal is closed «won» for this amount")}</li>
              {payment === "CASH" || payment === "CARD" ? <li><Ico name="tick" small />{L("ينسجل التحصيل وينتظر اعتماد المحاسب", "The payment is recorded for the accountant to approve")}</li> : null}
              <li><Ico name="tick" small />{L("تروح الفاتورة للمحاسب يصدرها ويرسلها للعميل", "The invoice goes to the accountant, who issues and sends it")}</li>
            </ul>
          )}
          <div className="ds-foot">
            <button type="button" className="ds-btn p big" disabled={busy || !payment} onClick={send} data-testid="ds-send">{busy ? L("لحظة…", "One moment…") : priced.needsApproval ? L("أرسل لمشرفي يوافق", "Send to my supervisor") : L("إرسال", "Send")}</button>
            {!payment ? <p className="ds-hint">{L("اختر طريقة الدفع.", "Choose how the customer pays.")}</p> : null}
          </div>
        </section>
      ) : null}

      <NewCustomerDialog open={newCustomer} ar={ar} initialName={/\d{3,}/.test(q) ? "" : q.trim()} onClose={() => setNewCustomer(false)} onCreated={created} />
    </div>
  );
}

function Totals({ priced, ar, flat }: { priced: Priced | null; ar: boolean; flat?: boolean }) {
  const L = (a: string, e: string) => (ar ? a : e);
  if (!priced) return <div className={flat ? "ds-tot flat" : "ds-tot"} data-testid="ds-totals"><p className="ds-mut">{L("أضف صنف عشان يطلع الإجمالي.", "Add an item to see the total.")}</p></div>;
  const hasDisc = Number(priced.discount) > 0;
  return (
    <div className={flat ? "ds-tot flat" : "ds-tot"} data-testid="ds-totals">
      {hasDisc ? <div className="ds-kvrow"><span>{L("قبل الخصم", "Before discount")}</span><b>{money(priced.subtotal)}</b></div> : null}
      {hasDisc ? <div className="ds-kvrow warn"><span>{L(`خصم ${Number(priced.discountPercent)}٪`, `Discount ${Number(priced.discountPercent)}%`)}</span><b>− {money(priced.discount)}</b></div> : null}
      <div className="ds-kvrow"><span>{L("قبل الضريبة", "Before VAT")}</span><b>{money(priced.net)}</b></div>
      <div className="ds-kvrow"><span>{L("ضريبة 15٪", "VAT 15%")}</span><b>{money(priced.tax)}</b></div>
      <div className="ds-kvrow total"><span>{L("الإجمالي", "Total")}</span><b data-testid="ds-gross">{money(priced.gross)}</b></div>
    </div>
  );
}

/** After «الخصم انرفض» (the notification links here with ?order=): the refusal, and a resubmission at or under the
 *  threshold (it completes now) — or the order page, to cancel it. */
function Resubmit({ orderId, ar }: { orderId: string; ar: boolean }) {
  const L = (a: string, e: string) => (ar ? a : e);
  type View = { orderNumber: number; status: string; discountApproval: string; requestedDiscountPercent: string | null; rejectionNote: string | null; customer: { name: string; nameAr: string | null }; threshold: string };
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<"NONE" | "PENDING" | null>(null);
  useEffect(() => {
    void api<View>(`/api/sales/direct-sale/${encodeURIComponent(orderId)}`).then((r) => { if (r.ok) { setV(r.data); setPct(r.data.threshold); } else setError(r.data.error ?? L("تعذّر التحميل.", "Could not load.")); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
  async function go() {
    setBusy(true); setError("");
    const r = await api<{ discountApproval: "NONE" | "PENDING" }>(`/api/sales/direct-sale/${encodeURIComponent(orderId)}/resubmit`, { method: "POST", body: { discountPercent: pct || 0 } });
    setBusy(false);
    if (r.ok) setSent(r.data.discountApproval); else setError(r.data.error ?? L("ما انرسل.", "Not sent."));
  }
  if (!v) return <div className="ds" dir={ar ? "rtl" : "ltr"}>{error ? <p className="notice er" role="alert">{error}</p> : null}</div>;
  const name = ar ? v.customer.nameAr || v.customer.name : v.customer.name;
  return (
    <div className="ds" dir={ar ? "rtl" : "ltr"} data-testid="ds-resubmit">
      <div className="ds-done">
        <h1>{L(`الطلب #${v.orderNumber}`, `Order #${v.orderNumber}`)} · <bdi>{name}</bdi></h1>
        {sent ? (
          <p className="ds-mut" data-testid="ds-resubmitted">{sent === "PENDING" ? L("انرسل لمشرفك من جديد.", "Sent to your supervisor again.") : L("انرسل — الطلب والفاتورة راحوا للمحاسب.", "Sent — the order and invoice went to the accountant.")}</p>
        ) : v.discountApproval === "REJECTED" ? (
          <>
            <div className="ds-card ds-pending" role="note"><b>{L("الخصم انرفض", "The discount was refused")}</b>{v.rejectionNote ? <span>{v.rejectionNote}</span> : null}</div>
            <div className="ds-disc">
              <label htmlFor="ds-re-pct">{L("خصم ٪", "Discount %")}</label>
              <input id="ds-re-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.,]/g, "").slice(0, 5))} data-testid="ds-re-pct" />
              <span />
              <p className="ds-hint">{L(`أرسله بخصم ${Number(v.threshold)}٪ أو أقل ويكمل على طول — أو ألغِ الطلب من صفحته.`, `Resubmit at ${Number(v.threshold)}% or less and it completes now — or cancel the order from its page.`)}</p>
            </div>
            <button type="button" className="ds-btn p big" disabled={busy} onClick={go} data-testid="ds-re-send">{busy ? L("لحظة…", "One moment…") : L("أرسل من جديد", "Send again")}</button>
          </>
        ) : (
          <p className="ds-mut">{v.discountApproval === "PENDING" ? L("الخصم ينتظر موافقة مشرفك.", "The discount is waiting for your supervisor.") : L("الطلب ما ينتظر شي منك.", "Nothing is waiting on you.")}</p>
        )}
        {error ? <p className="notice er" role="alert">{error}</p> : null}
        <Link className="ds-btn" href={`/dashboard/orders?order=${v.orderNumber}`}>{L("افتح الطلب", "Open the order")}</Link>
      </div>
    </div>
  );
}
