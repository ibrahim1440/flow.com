"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, api } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { useQuotesBase } from "./base";
import { NewCustomerDialog, type CreatedCustomer } from "@/components/customers/new-customer-form";


/**
 * Quotes v2 (owner-approved Figma page 11, frame «٢ · عرض سعر جديد», 5 Nov 2026): ONE question — «لمين العرض؟». The
 * employee picks the customer and the quotation is linked to its open deal automatically: one open deal → the editor
 * on it; none → a deal is opened for them (POST /api/customers/[id]/deals, its rules unchanged) and the editor follows;
 * several → they pick one. «عميل جديد» beside the search opens the one shared «إضافة عميل» form and continues with the
 * new customer. The accountant's «بدون صفقة» path is unchanged.
 *
 * Before v2: «+ عرض سعر» on the quotations list (Figma 181:1609). A quotation belongs to a deal, so the
 * picker asks the two questions in order: which customer, then which of its OPEN deals — or a
 * new deal for it, opened through POST /api/customers/[id]/deals (its rules unchanged: lead_convert
 * + the customers module, the Qualification stage, the caller as owner). Then the existing
 * editor (/dashboard/sales/quotes/new?opportunityId=…) raises the draft.
 */

type Deal = {
  id: string; title: string; updatedAt: string;
  owner: { id: string; name: string } | null;
  stage: { nameAr: string; nameEn: string } | null;
  _count: { quotes: number };
};
type Customer = { id: string; name: string; nameAr: string | null; city: string | null; deals: Deal[] };

export function QuotePicker({ lang, onClose }: { lang: "ar" | "en"; onClose: () => void }) {
  // BATCH22 WP-E: from the accounting section the accountant picks an EXISTING open deal and never opens one.
  const { base, accounting } = useQuotesBase();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const router = useRouter();
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [canCreateDeal, setCanCreateDeal] = useState(false);
  const [canCreateCustomer, setCanCreateCustomer] = useState(false);
  // «مسار المحاسب»: from the accounting section a customer is quoted directly — no deal.
  const [canNoDeal, setCanNoDeal] = useState(false);
  const [chosen, setChosen] = useState<Customer | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [newCustomer, setNewCustomer] = useState(false);
  const noDealPath = accounting && canNoDeal;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await api<{ customers: Customer[]; can: { createDeal: boolean; noDeal?: boolean; createCustomer?: boolean } }>(
        `/api/sales/quotes/picker?q=${encodeURIComponent(q.trim())}`,
      );
      if (cancelled) return;
      if (res.ok) {
        setCustomers(res.data.customers); setCanCreateDeal(res.data.can.createDeal); setCanNoDeal(!!res.data.can.noDeal);
        setCanCreateCustomer(!!res.data.can.createCustomer); setError("");
      } else setError(res.data.error ?? L("تعذّر التحميل.", "Could not load."));
      setLoading(false);
    }, q ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, ar]);

  const nameOf = (c: Pick<Customer, "name" | "nameAr">) => (ar ? (c.nameAr ?? c.name) : c.name);
  const goToEditor = (opportunityId: string) => router.push(`${base}/new?opportunityId=${encodeURIComponent(opportunityId)}`);

  async function quoteWithoutDeal(c: Customer) {
    if (busy) return;
    setBusy(c.id);
    setError("");
    const res = await api<{ quote: { id: string } }>("/api/sales/quotes", { method: "POST", body: { customerId: c.id, lines: [] } });
    if (!res.ok) { setBusy(null); setError(res.data.error ?? L("تعذّر إنشاء العرض.", "Could not create the quotation.")); return; }
    router.push(`${base}/${encodeURIComponent(res.data.quote.id)}`);
  }

  async function newDeal(c: Customer, dealTitle?: string) {
    if (busy) return;
    setBusy(c.id);
    setError("");
    const res = await api<{ opportunityId: string }>(`/api/customers/${c.id}/deals`, {
      method: "POST", body: { title: dealTitle?.trim() || undefined },
    });
    if (!res.ok) { setBusy(null); setChosen(c); setError(res.data.error ?? L("تعذّر فتح الصفقة.", "Could not open the deal.")); return; }
    goToEditor(res.data.opportunityId);
  }

  /** «اختر»: the open deal is linked automatically; none → one is opened; several → the employee picks. */
  function choose(c: Customer) {
    setError("");
    if (noDealPath) { setChosen(c); setTitle(""); return; }
    if (c.deals.length === 1) { setBusy(c.id); goToEditor(c.deals[0].id); return; }
    if (c.deals.length === 0 && canCreateDeal && !accounting) { void newDeal(c); return; }
    setChosen(c); setTitle("");
  }

  function created(c: CreatedCustomer) {
    setNewCustomer(false);
    const fresh: Customer = { id: c.id, name: c.name, nameAr: c.nameAr, city: c.city, deals: [] };
    setCustomers((prev) => [fresh, ...prev.filter((x) => x.id !== c.id)]);
    if (noDealPath) { void quoteWithoutDeal(fresh); return; }
    choose(fresh);
  }

  const dealLine = (c: Customer) => {
    if (noDealPath) return c.city ?? "";
    if (c.deals.length === 1) return `${L("صفقة مفتوحة", "Open deal")}: ${c.deals[0].title}`;
    if (c.deals.length > 1) return L(`${c.deals.length} صفقات مفتوحة — تختار وحدة`, `${c.deals.length} open deals — pick one`);
    return canCreateDeal && !accounting ? L("ما عنده صفقة — تنفتح وحدة تلقائيًا", "No open deal — one is opened automatically") : L("لا صفقة مفتوحة", "No open deal");
  };

  return (
    <>
    <Modal title={L("عرض سعر جديد", "New quotation")} onClose={onClose} testId="quote-picker">
      {error && <p className="notice er" role="alert">{error}</p>}
      {!chosen ? (
        <>
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
            {noDealPath
              ? L("اختر العميل. العرض يصدر من قسم المحاسبة بدون صفقة ولا عمولة.", "Choose the customer. The quotation is issued by accounting, with no deal and no commission.")
              : L("لمين العرض؟ اختر العميل، ونربطه بصفقته المفتوحة تلقائيًا.", "Who is it for? Choose the customer — its open deal is linked automatically.")}
          </p>
          <div className="q-pick-bar">
            <label className="search">
              <Ico name="search" small />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} data-testid="picker-search"
                placeholder={L("اكتب اسم العميل أو رقم جواله…", "Customer name or phone…")} aria-label={L("بحث عن عميل", "Search customers")} />
            </label>
            {canCreateCustomer ? (
              <button type="button" className="btn" onClick={() => setNewCustomer(true)} data-testid="picker-new-customer">
                <Ico name="plus" small /> {L("عميل جديد", "New customer")}
              </button>
            ) : null}
          </div>
          <ul className="q-pick q-pick-rows" data-testid="picker-customers" aria-busy={loading || undefined}>
            {customers.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => choose(c)} disabled={!!busy} data-testid={`picker-customer-${c.id}`}>
                  <span className="q-pick-av" aria-hidden>{nameOf(c).trim().slice(0, 2)}</span>
                  <span className="q-pick-txt">
                    <b><bdi>{nameOf(c)}</bdi></b>
                    <span className="sm">{dealLine(c)}</span>
                  </span>
                  <span className="q-pick-go">{busy === c.id ? L("لحظة…", "One moment…") : L("اختر", "Choose")}</span>
                </button>
              </li>
            ))}
            {!loading && customers.length === 0 && (
              <li className="lbl" style={{ fontWeight: 400, padding: "12px 0" }}>
                {q.trim() && canCreateCustomer
                  ? <>{L("ما لقينا عميل بهذا الاسم.", "No customer by that name.")}{" "}
                      <button type="button" className="lk-inline" onClick={() => setNewCustomer(true)} data-testid="picker-new-customer-empty">{L("أضفه كعميل جديد", "Add it as a new customer")}</button></>
                  : L("لا عملاء مطابقون.", "No matching customers.")}
              </li>
            )}
          </ul>
        </>
      ) : (
        <>
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
            <button type="button" className="lk-inline" onClick={() => { setChosen(null); setBusy(null); }} data-testid="picker-back">
              {L("← العملاء", "← Customers")}
            </button>
            {" · "}<b style={{ color: "var(--text-primary)" }}><bdi>{nameOf(chosen)}</bdi></b>
          </p>
          {noDealPath ? (
            <button type="button" className="btn p" disabled={!!busy} onClick={() => quoteWithoutDeal(chosen)} data-testid="picker-no-deal">
              {L("عرض سعر لهذا العميل (بدون صفقة)", "Quote this customer (no deal)")}
            </button>
          ) : null}
          {chosen.deals.length > 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>{noDealPath ? L("أو على صفقة مفتوحة للمبيعات:", "Or on an open Sales deal:") : L("عنده أكثر من صفقة مفتوحة — على أي وحدة العرض؟", "It has several open deals — which one is this for?")}</p>
          ) : null}
          <ul className="q-pick" data-testid="picker-deals">
            {chosen.deals.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => goToEditor(d.id)} data-testid={`picker-deal-${d.id}`}>
                  <b><bdi>{d.title}</bdi></b>
                  <span className="sm">
                    {d.stage && <>{ar ? d.stage.nameAr : d.stage.nameEn} · </>}
                    {d.owner?.name ?? "—"}
                    {d._count.quotes > 0 && <> · {ar ? `${d._count.quotes} عرض سابق` : `${d._count.quotes} earlier quotation(s)`}</>}
                  </span>
                </button>
              </li>
            ))}
            {chosen.deals.length === 0 && !noDealPath && (
              <li className="lbl" style={{ fontWeight: 400, padding: "8px 0" }}>{L("لا توجد صفقة مفتوحة لهذا العميل.", "This customer has no open deal.")}</li>
            )}
          </ul>
          {noDealPath ? null : accounting && chosen.deals.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: 0 }} data-testid="picker-no-open-deal">
              {L("لا توجد صفقة مفتوحة — اطلب من المبيعات فتح صفقة.", "There is no open deal — ask Sales to open one.")}
            </p>
          ) : canCreateDeal && !accounting ? (
            <div className="q-pick-new" data-testid="picker-new-deal">
              <label className="lbl" htmlFor="picker-title" style={{ fontWeight: 400 }}>
                {L("أو افتح صفقة جديدة (مرحلة التأهيل، باسمك):", "Or open a new deal (Qualification stage, owned by you):")}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="picker-title" className="q-input" value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder={nameOf(chosen)} maxLength={200} />
                <button type="button" className="btn p" disabled={!!busy} onClick={() => newDeal(chosen, title)} data-testid="picker-create-deal">
                  {L("صفقة جديدة وعرض", "New deal and quote")}
                </button>
              </div>
            </div>
          ) : chosen.deals.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
              {L("فتح صفقة جديدة يحتاج صلاحية تحويل العملاء المحتملين ووحدة العملاء.", "Opening a deal needs the lead-convert permission and the customers module.")}
            </p>
          ) : null}
        </>
      )}
    </Modal>
    <NewCustomerDialog open={newCustomer} ar={ar} initialName={/\d{3,}/.test(q) ? "" : q.trim()} onClose={() => setNewCustomer(false)} onCreated={created} />
    </>
  );
}
