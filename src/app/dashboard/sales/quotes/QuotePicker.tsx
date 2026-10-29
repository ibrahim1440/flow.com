"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, api } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { useQuotesBase } from "./base";


/**
 * «+ عرض سعر» on the quotations list (Figma 181:1609). A quotation belongs to a deal, so the
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
  const router = useRouter();
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [canCreateDeal, setCanCreateDeal] = useState(false);
  const [chosen, setChosen] = useState<Customer | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await api<{ customers: Customer[]; can: { createDeal: boolean } }>(
        `/api/sales/quotes/picker?q=${encodeURIComponent(q.trim())}`,
      );
      if (cancelled) return;
      if (res.ok) { setCustomers(res.data.customers); setCanCreateDeal(res.data.can.createDeal); setError(""); }
      else setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      setLoading(false);
    }, q ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, ar]);

  const nameOf = (c: Customer) => (ar ? (c.nameAr ?? c.name) : c.name);
  const goToEditor = (opportunityId: string) => router.push(`${base}/new?opportunityId=${encodeURIComponent(opportunityId)}`);

  async function newDeal() {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ opportunityId: string }>(`/api/customers/${chosen.id}/deals`, {
      method: "POST", body: { title: title.trim() || undefined },
    });
    setBusy(false);
    if (!res.ok) { setError(res.data.error ?? (ar ? "تعذّر فتح الصفقة." : "Could not open the deal.")); return; }
    goToEditor(res.data.opportunityId);
  }

  return (
    <Modal title={ar ? "عرض سعر جديد" : "New quotation"} onClose={onClose} testId="quote-picker">
      {error && <p className="notice er" role="alert">{error}</p>}
      {!chosen ? (
        <>
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
            {ar ? "١ · اختر العميل. العرض يُنشأ على صفقة مفتوحة له." : "1 · Choose the customer. The quotation is raised on one of its open deals."}
          </p>
          <label className="search" style={{ width: "100%" }}>
            <Ico name="search" small />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} data-testid="picker-search"
              placeholder={ar ? "اسم العميل" : "Customer name"} aria-label={ar ? "بحث عن عميل" : "Search customers"} />
          </label>
          <ul className="q-pick" data-testid="picker-customers" aria-busy={loading || undefined}>
            {customers.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => { setChosen(c); setTitle(""); }} data-testid={`picker-customer-${c.id}`}>
                  <b><bdi>{nameOf(c)}</bdi></b>
                  <span className="sm">
                    {c.city && <>{c.city} · </>}
                    {c.deals.length === 0
                      ? (ar ? "لا صفقة مفتوحة" : "no open deal")
                      : ar ? `${c.deals.length} صفقة مفتوحة` : `${c.deals.length} open deal${c.deals.length === 1 ? "" : "s"}`}
                  </span>
                </button>
              </li>
            ))}
            {!loading && customers.length === 0 && (
              <li className="lbl" style={{ fontWeight: 400, padding: "12px 0" }}>{ar ? "لا عملاء مطابقون." : "No matching customers."}</li>
            )}
          </ul>
        </>
      ) : (
        <>
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
            <button type="button" className="lk-inline" onClick={() => setChosen(null)} data-testid="picker-back">
              {ar ? "← العملاء" : "← Customers"}
            </button>
            {" · "}<b style={{ color: "var(--text-primary)" }}><bdi>{nameOf(chosen)}</bdi></b>
          </p>
          <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>{ar ? "٢ · اختر الصفقة المفتوحة:" : "2 · Choose the open deal:"}</p>
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
            {chosen.deals.length === 0 && (
              <li className="lbl" style={{ fontWeight: 400, padding: "8px 0" }}>{ar ? "لا توجد صفقة مفتوحة لهذا العميل." : "This customer has no open deal."}</li>
            )}
          </ul>
          {accounting && chosen.deals.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: 0 }} data-testid="picker-no-open-deal">
              {ar ? "لا توجد صفقة مفتوحة — اطلب من المبيعات فتح صفقة." : "There is no open deal — ask Sales to open one."}
            </p>
          ) : canCreateDeal && !accounting ? (
            <div className="q-pick-new" data-testid="picker-new-deal">
              <label className="lbl" htmlFor="picker-title" style={{ fontWeight: 400 }}>
                {ar ? "أو افتح صفقة جديدة (مرحلة التأهيل، باسمك):" : "Or open a new deal (Qualification stage, owned by you):"}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="picker-title" className="q-input" value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder={nameOf(chosen)} maxLength={200} />
                <button type="button" className="btn p" disabled={busy} onClick={newDeal} data-testid="picker-create-deal">
                  {ar ? "صفقة جديدة وعرض" : "New deal and quote"}
                </button>
              </div>
            </div>
          ) : chosen.deals.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400, margin: 0 }}>
              {ar ? "فتح صفقة جديدة يحتاج صلاحية تحويل العملاء المحتملين ووحدة العملاء." : "Opening a deal needs the lead-convert permission and the customers module."}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
