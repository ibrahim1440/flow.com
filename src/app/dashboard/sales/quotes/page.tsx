"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useLang, pick, Spinner, api, formatMoney, num } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { initials } from "@/components/d21/labels";
import { shortDate } from "@/components/d21/format";

/**
 * Quotations list, built to `crm-quotes` 1440 (`181:1609`, EN `1528:1930`) and 1024
 * (`182:1811`): the header with its facts, the status tabs, the search toolbar, the ledger
 * table (quotation · customer and deal · total · valid until · status · owner) and the pager.
 * On a phone (no list frame exists) the rows stack the way the other CRM lists do.
 *
 * Visual port only. The data, the filters the server understands (status, search, page) and
 * the one next step per row are the ones this screen already had. What the frame shows and the
 * system does not have — the row preview drawer, the owner chip and «تصفية», «تصدير», a
 * «عرض سعر» button with no deal behind it, per-tab counts and the discount-approval flag — is
 * not built (see the batch report).
 *
 * The row's next step: what it SAYS is decided here, because the server decides what a
 * quotation will accept: `create-order` refuses anything that is not ACCEPTED with no order
 * against it yet, and `revise` refuses anything that is not ISSUED, REJECTED or EXPIRED.
 * Offering a control the server would reject is worse than a label that differs from the mock.
 */

type Quote = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: string;
  currency: string;
  validUntil: string | null;
  subtotal: string;
  discountTotal: string;
  grandTotal: string;
  issuedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string; outcome: string; owner: { id: string; name: string } | null };
  _count: { lines: number; orderLinks: number };
};

const STATUS_LABELS: Record<string, { en: string; ar: string }> = {
  DRAFT: { en: "Draft", ar: "مسودة" },
  ISSUED: { en: "Issued", ar: "صادر" },
  ACCEPTED: { en: "Accepted", ar: "مقبول" },
  REJECTED: { en: "Rejected", ar: "مرفوض" },
  EXPIRED: { en: "Expired", ar: "منتهي الصلاحية" },
  SUPERSEDED: { en: "Superseded", ar: "مستبدل" },
};
/** Status → the reference status dot (`.st`). */
const STATUS_DOT: Record<string, string> = {
  ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x",
};
/** The frame's tabs, in its order, plus «مستبدل»: the old status filter offered it, so it stays. */
const TABS = ["", "DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "EXPIRED", "SUPERSEDED"] as const;
/** The API's default page size (it is not sent, so the request is the one the list always made). */
const PER_PAGE = 25;

/**
 * The one next step for a quotation. Every branch mirrors a server predicate — `isEditable`,
 * `isRevisable`, and the `orderable` flag the detail endpoint reports — so the list never shows
 * a control that would come back refused. The actions themselves live on the quotation.
 */
function RowAction({ quote, lang }: { quote: Quote; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const href = `/dashboard/sales/quotes/${quote.id}`;
  let text: string;
  let quiet = false;
  if (quote.status === "DRAFT") text = ar ? "متابعة التحرير" : "Continue editing";
  else if (quote.status === "ACCEPTED") {
    // Already converted: the convert action is gone, and saying so is more use than an action
    // the server would refuse.
    if (quote._count.orderLinks > 0) { text = ar ? "حُوِّل إلى طلب" : "Converted to order"; quiet = true; }
    else text = ar ? "تحويل إلى طلب" : "Convert to order";
  } else if (quote.status === "ISSUED") text = ar ? "تسجيل القرار" : "Record the decision";
  else if (quote.status === "REJECTED" || quote.status === "EXPIRED") text = ar ? "إنشاء مراجعة" : "Raise a revision";
  else { text = ar ? "عرض" : "View"; quiet = true; }
  return <Link href={href} className={quiet ? "btn sm g" : "btn sm"}>{text}</Link>;
}

export default function QuotesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [rows, setRows] = useState<Quote[]>([]);
  // Counted when the data arrives, not during render: reading the clock while rendering is
  // impure and shows up as a hydration mismatch.
  const [expiringSoon, setExpiringSoon] = useState(0);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [shownPage, setShownPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useD21Phone({ title: ar ? "عروض الأسعار" : "Quotations" });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search.trim()) params.set("q", search.trim());
    if (page > 1) params.set("page", String(page));
    const res = await api<{ rows: Quote[]; total: number; scope: "own" | "all" }>(
      `/api/sales/quotes?${params}`,
    );
    if (res.ok) {
      setRows(res.data.rows);
      setTotal(res.data.total);
      setScope(res.data.scope);
      setShownPage(page);
      const now = Date.now();
      setExpiringSoon(
        res.data.rows.filter((q) => {
          if (q.status !== "ISSUED" || !q.validUntil) return false;
          const due = new Date(q.validUntil).getTime();
          return due > now && due - now < 7 * 86400_000;
        }).length,
      );
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
  }, [status, search, page, ar]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // A new filter or search starts again from the first page.
  const changeStatus = (s: string) => { setStatus(s); setPage(1); };
  const changeSearch = (s: string) => { setSearch(s); setPage(1); };

  if (loading) return <div className="pg"><Spinner /></div>;

  const label = (s: string) => pick(STATUS_LABELS, s, lang);
  const customerName = (q: Quote) => (q.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : "—");
  const revisionText = (q: Quote) => (q.revision > 1 ? (ar ? `المراجعة ${q.revision}` : `revision ${q.revision}`) : null);
  const lapsed = (q: Quote) => q.status === "ISSUED" && !!q.validUntil && new Date(q.validUntil) < new Date();
  const statusDot = (q: Quote) => (
    <span className={`st ${STATUS_DOT[q.status] ?? ""}`} data-testid={`quote-status-${q.quoteNumber}`}>{label(q.status)}</span>
  );
  const validCell = (q: Quote) => {
    if (!q.validUntil) return <span className="sm">—</span>;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{shortDate(q.validUntil, lang)}</span>
        {lapsed(q) && <span className="flag wa">{ar ? "انتهى" : "Lapsed"}</span>}
      </span>
    );
  };

  // The header's facts, from the rows on screen (as before), each its own element so the bidi
  // algorithm cannot move a separator between two numerals.
  const issued = rows.filter((q) => q.status === "ISSUED").length;
  const issuedValue = rows.filter((q) => q.status === "ISSUED").reduce((sum, q) => sum + Number(q.grandTotal), 0);
  const money = (n: number) => `${formatMoney(n.toFixed(2), 0)} ${ar ? "ر.س" : "SAR"}`;
  const facts = [
    <span key="issued" data-testid="quotes-issued"><span className="n">{num(issued, lang)}</span> {ar ? "صادرة بانتظار رد العميل" : "issued, awaiting the customer"}</span>,
    <span key="value">{ar ? "قيمة الصادر" : "issued value"} <bdi className="n">{money(issuedValue)}</bdi></span>,
    ...(expiringSoon > 0
      ? [<span key="exp" className="flag wa" data-testid="expiring-soon"><span className="n">{num(expiringSoon, lang)}</span> {ar ? "تنتهي هذا الأسبوع" : "expiring this week"}</span>]
      : []),
    ...(scope === "own" ? [<span key="own">{ar ? "صفقاتك فقط" : "your own deals only"}</span>] : []),
  ];

  const filtered = status !== "" || search.trim() !== "";
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
  const from = total === 0 ? 0 : (shownPage - 1) * PER_PAGE + 1;
  const to = Math.min(total, (shownPage - 1) * PER_PAGE + rows.length);
  const paging = shownPage !== page;

  const notice = error ? (
    <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 16 }}>
      {error}<button type="button" onClick={() => setError("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
    </p>
  ) : null;

  const tabs = (
    <div role="group" aria-label={ar ? "الحالة" : "Status"} className={phone ? "segs" : "tabs"} data-testid="quote-status-tabs">
      {TABS.map((s) => {
        const on = status === s;
        return (
          <button key={s || "ALL"} type="button" aria-pressed={on} className={on ? "on" : undefined}
            data-testid={`quote-tab-${s || "ALL"}`} onClick={() => changeStatus(s)}>
            {s ? label(s) : ar ? "الكل" : "All"}
            {/* The server counts the active tab only; the others' counts are not available. */}
            {on && <span className={phone ? "n" : "c"}>{total}</span>}
          </button>
        );
      })}
    </div>
  );

  const searchBox = (
    <label className="search" style={phone ? { width: "100%", height: 40 } : { width: 220 }}>
      <Ico name="search" small />
      <input value={search} onChange={(e) => changeSearch(e.target.value)} data-testid="quote-search"
        placeholder={ar ? "رقم العرض أو العميل" : "Quote no. or customer"}
        aria-label={ar ? "بحث في عروض الأسعار" : "Search quotations"} />
      {search && (
        <button type="button" className="ib" style={{ width: 22, height: 22 }} onClick={() => changeSearch("")}
          aria-label={ar ? "مسح البحث" : "Clear search"}>
          <Ico name="close" small />
        </button>
      )}
    </label>
  );

  const empty = rows.length === 0 ? (
    filtered ? (
      <div data-testid="quotes-no-results" style={{ padding: "48px 0", textAlign: "center" }}>
        <p>{ar ? "لا عروض تطابق البحث أو التصفية." : "No quotations match this search or filter."}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => { changeSearch(""); changeStatus(""); }}>
          {ar ? "مسح التصفية" : "Clear filters"}
        </button>
      </div>
    ) : (
      <div data-testid="quotes-empty" style={{ padding: "48px 0", textAlign: "center" }}>
        <p style={{ fontWeight: 500 }}>{ar ? "لا توجد عروض أسعار." : "No quotations."}</p>
        <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "يُنشأ العرض من صفحة الصفقة." : "A quotation is raised from a deal."}</p>
      </div>
    )
  ) : null;

  const pager = (
    <nav aria-label={ar ? "صفحات عروض الأسعار" : "Quotation pages"} className="pager">
      <span className="sm" data-testid="quotes-count">
        <span className="n">{num(total, lang)}</span> {ar ? "عرضًا" : total === 1 ? "quotation" : "quotations"}
      </span>
      <span className="sp" />
      <span className="sm" data-testid="quotes-range" aria-live="polite">
        <bdi dir="ltr" className="n">{from}–{to}</bdi> {ar ? "من" : "of"} <bdi className="n">{total}</bdi>
      </span>
      <button type="button" className="btn sm" data-testid="quotes-prev" disabled={page <= 1} onClick={() => setPage(page - 1)}>
        {ar ? "السابق" : "Previous"}
      </button>
      <button type="button" className="btn sm" data-testid="quotes-next" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
        {ar ? "التالي" : "Next"}
      </button>
    </nav>
  );

  if (phone) {
    return (
      <div className="pg">
        {notice}
        <div className="lbl" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontWeight: 400 }}>
          {facts}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{searchBox}</div>
        {tabs}
        {empty ?? (
          <div aria-busy={paging || undefined} style={paging ? { opacity: .6 } : undefined} data-testid="quotes-table">
            {rows.map((q) => {
              const rev = revisionText(q);
              return (
                <div key={q.id} className="mrow rowlink" data-testid={`m-quote-${q.quoteNumber}`}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/dashboard/sales/quotes/${q.id}`} className="who open" style={{ textDecoration: "none" }}>
                      <bdi>{customerName(q)}</bdi>
                    </Link>
                  </div>
                  {statusDot(q)}
                  <div className="r2">
                    <span className="id" style={{ fontSize: 12 }}>{q.quoteNumber}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <bdi>{q.opportunity.title}</bdi>{rev && <> · {rev}</>}
                    </span>
                    <span className="n" style={{ color: "var(--text-primary)", fontSize: 13.5 }}>{formatMoney(q.grandTotal)}</span>
                  </div>
                  <div className="r2">
                    <span style={{ flex: 1 }}>
                      {q.validUntil ? `${ar ? "صالح حتى" : "Valid until"} ${shortDate(q.validUntil, lang)}` : "—"}
                    </span>
                    {lapsed(q) && <span className="flag wa">{ar ? "انتهى" : "Lapsed"}</span>}
                    <RowAction quote={q} lang={lang} />
                  </div>
                </div>
              );
            })}
            {lastPage > 1 && pager}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pg">
      {notice}
      <div className="ph" style={{ marginBottom: 20 }}>
        <div>
          <h1>{ar ? "عروض الأسعار" : "Quotations"}</h1>
          <div className="meta">
            {facts.map((f, i) => (
              <span key={i} style={{ display: "contents" }}>{i > 0 && <i />}{f}</span>
            ))}
          </div>
        </div>
      </div>
      {tabs}
      <div className="tool" style={{ marginBottom: 8 }}>
        {searchBox}
        <span className="sp" />
        {/* The one order the server applies, stated rather than offered as a choice. */}
        <span className="sort-note">{ar ? "الأحدث ↓" : "Newest ↓"}</span>
      </div>
      {empty ?? (
        <>
          <div aria-busy={paging || undefined} style={{ overflowX: "auto", ...(paging ? { opacity: .6 } : {}) }}>
            <table className="t quotes" data-testid="quotes-table">
              <thead><tr>
                <th scope="col">{ar ? "العرض" : "Quotation"}</th>
                <th scope="col">{ar ? "العميل والصفقة" : "Customer and deal"}</th>
                <th scope="col" className="num">{ar ? "الإجمالي · ر.س" : "Total · SAR"}</th>
                <th scope="col">{ar ? "صالح حتى" : "Valid until"}</th>
                <th scope="col">{ar ? "الحالة" : "Status"}</th>
                <th scope="col">{ar ? "المالك" : "Owner"}</th>
                <th scope="col"><span className="sr-only">{ar ? "الإجراء التالي" : "Next action"}</span></th>
              </tr></thead>
              <tbody>
                {rows.map((q) => {
                  const rev = revisionText(q);
                  const owner = q.opportunity.owner;
                  return (
                    <tr key={q.id} data-testid={`quote-row-${q.quoteNumber}`}>
                      <td>
                        <Link href={`/dashboard/sales/quotes/${q.id}`} className="id" data-testid={`open-quote-${q.quoteNumber}`}
                          style={{ color: "var(--text-secondary)" }}>
                          {q.quoteNumber}
                        </Link>
                      </td>
                      <td style={{ whiteSpace: "normal", paddingBlock: 3 }}>
                        <span className="who" style={{ display: "block", lineHeight: "22px" }}><bdi>{customerName(q)}</bdi></span>
                        <span className="sm" style={{ display: "block", lineHeight: "18px" }}>
                          <Link href={`/dashboard/sales/deals/${q.opportunity.id}`}><bdi>{q.opportunity.title}</bdi></Link>
                          {rev && <> · {rev}</>}
                        </span>
                      </td>
                      <td className="num">{formatMoney(q.grandTotal)}{q.currency !== "SAR" && <span className="unit">{q.currency}</span>}</td>
                      <td>{validCell(q)}</td>
                      <td>{statusDot(q)}</td>
                      <td>
                        {owner
                          ? <span className="av s" title={owner.name} aria-label={owner.name}>{initials(owner.name)}</span>
                          : <span className="sm">{ar ? "غير مُسنَد" : "Unassigned"}</span>}
                      </td>
                      <td style={{ textAlign: "end" }}><RowAction quote={q} lang={lang} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pager}
        </>
      )}
    </div>
  );
}
