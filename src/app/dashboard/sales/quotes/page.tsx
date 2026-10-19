"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useLang, pick, Spinner, api, formatMoney, num } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { initials } from "@/components/d21/labels";
import { shortDate } from "@/components/d21/format";
import { QuotePane } from "./QuotePane";
import { QuotePicker } from "./QuotePicker";

/**
 * Quotations list, built to `crm-quotes` 1440 (`181:1609`, EN `1528:1930`) and 1024
 * (`182:1811`): the header with its facts and actions («تصدير», «+ عرض سعر»), the status tabs
 * with their counts, the toolbar (search, the owner chip, «تصفية»), the ledger table, the pager
 * with «مستبدلة مخفية», and the row preview pane (docked from 1280, over the list from 1024).
 * On a phone (no list frame exists) the rows stack the way the other CRM lists do.
 *
 * Every number on the screen is the server's (GET /api/sales/quotes: `counts` per status over
 * the same search and owner filter, `summary` over the caller's scope). The discount-approval
 * flag («الخصم يحتاج اعتمادًا») is the server's state for each draft against the threshold in
 * force (Settings › quotations, else the built-in 10%).
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
  discountApproval: "NOT_NEEDED" | "PENDING" | "APPROVED" | "REJECTED";
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string; outcome: string; owner: { id: string; name: string } | null };
  _count: { lines: number; orderLinks: number };
};
type Payload = {
  rows: Quote[]; total: number; scope: "own" | "all";
  counts: Record<string, number>;
  summary: { issued: number; issuedValue: string; pendingApproval: number; expiringSoon: number };
  owners: { id: string; name: string }[];
  discountThresholdPercent: string;
  can: { write: boolean; approveDiscount: boolean; createDeal: boolean };
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
/** The frame's tabs, in its order. Superseded revisions are hidden and counted in the footer. */
const TABS = ["", "DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "EXPIRED"] as const;
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

type Approval = "" | "PENDING" | "APPROVED" | "REJECTED";

export default function QuotesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [approval, setApproval] = useState<Approval>("");
  const [expiring, setExpiring] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [page, setPage] = useState(1);
  const [shownPage, setShownPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const filterBox = useRef<HTMLDivElement | null>(null);

  useD21Phone({ title: ar ? "عروض الأسعار" : "Quotations" });

  /** The current filters as the query string; the CSV export uses the same one. */
  const query = useCallback((withPage: boolean) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search.trim()) params.set("q", search.trim());
    if (ownerId) params.set("ownerId", ownerId);
    if (approval) params.set("approval", approval);
    if (expiring) params.set("expiring", "1");
    if (showSuperseded) params.set("includeSuperseded", "1");
    if (withPage && page > 1) params.set("page", String(page));
    return params;
  }, [status, search, ownerId, approval, expiring, showSuperseded, page]);

  const load = useCallback(async () => {
    const res = await api<Payload>(`/api/sales/quotes?${query(true)}`);
    if (res.ok) {
      setData(res.data);
      setShownPage(page);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
  }, [query, page, ar]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    if (!filterOpen) return;
    const close = (e: MouseEvent) => { if (!filterBox.current?.contains(e.target as Node)) setFilterOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [filterOpen]);

  // A new filter or search starts again from the first page.
  const changeStatus = (s: string) => { setStatus(s); setPage(1); };
  const changeSearch = (s: string) => { setSearch(s); setPage(1); };
  const changeOwner = (s: string) => { setOwnerId(s); setPage(1); };
  const changeApproval = (s: Approval) => { setApproval(s); setPage(1); };
  const clearAll = () => { setSearch(""); setStatus(""); setOwnerId(""); setApproval(""); setExpiring(false); setShowSuperseded(false); setPage(1); };

  if (loading) return <div className="pg"><Spinner /></div>;
  if (!data) return <div className="pg"><p className="notice er" role="alert" data-testid="alert-error">{error}</p></div>;

  const rows = data.rows;
  const total = data.total;
  const scope = data.scope;
  const counts = data.counts ?? {};
  const label = (s: string) => pick(STATUS_LABELS, s, lang);
  const customerName = (q: Quote) => (q.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : "—");
  const revisionText = (q: Quote) => (q.revision > 1 ? (ar ? `المراجعة ${q.revision}` : `revision ${q.revision}`) : null);
  const lapsed = (q: Quote) => q.status === "ISSUED" && !!q.validUntil && new Date(q.validUntil) < new Date();
  const approvalFlag = (q: Quote) =>
    q.status !== "DRAFT" ? null
      : q.discountApproval === "PENDING"
        ? <span className="flag wa" data-testid={`quote-flag-${q.quoteNumber}`}>{ar ? "الخصم يحتاج اعتمادًا" : "Discount needs approval"}</span>
        : q.discountApproval === "REJECTED"
          ? <span className="flag" data-testid={`quote-flag-${q.quoteNumber}`}>{ar ? "رُفض الخصم" : "Discount refused"}</span>
          : q.discountApproval === "APPROVED"
            ? <span className="flag ok" data-testid={`quote-flag-${q.quoteNumber}`}>{ar ? "خصم معتمد" : "Discount approved"}</span>
            : null;
  const statusDot = (q: Quote) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      <span className={`st ${STATUS_DOT[q.status] ?? ""}`} data-testid={`quote-status-${q.quoteNumber}`}>{label(q.status)}</span>
      {approvalFlag(q)}
    </span>
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

  // The header's facts — the server's, over the caller's whole scope — each its own element so
  // the bidi algorithm cannot move a separator between two numerals.
  const sm = data.summary;
  const money = (v: string) => `${formatMoney(v, 0)} ${ar ? "ر.س" : "SAR"}`;
  const facts = [
    <span key="issued" data-testid="quotes-issued"><span className="n">{num(sm.issued, lang)}</span> {ar ? "صادرة بانتظار رد العميل" : "issued, awaiting the customer"}</span>,
    ...(sm.pendingApproval > 0
      ? [<button key="appr" type="button" className="lk-inline" data-testid="quotes-pending-approval" onClick={() => changeApproval("PENDING")}>
          <span className="n">{num(sm.pendingApproval, lang)}</span> {ar ? "يحتاج اعتماد خصم" : sm.pendingApproval === 1 ? "needs discount approval" : "need discount approval"}
        </button>]
      : []),
    <span key="value">{ar ? "قيمة الصادر" : "issued value"} <bdi className="n">{money(sm.issuedValue)}</bdi></span>,
    ...(sm.expiringSoon > 0
      ? [<span key="exp" className="flag wa" data-testid="expiring-soon"><span className="n">{num(sm.expiringSoon, lang)}</span> {ar ? "تنتهي هذا الأسبوع" : "expiring this week"}</span>]
      : []),
    ...(scope === "own" ? [<span key="own">{ar ? "صفقاتك فقط" : "your own deals only"}</span>] : []),
  ];

  const filterCount = (approval ? 1 : 0) + (expiring ? 1 : 0) + (showSuperseded ? 1 : 0);
  const filtered = status !== "" || search.trim() !== "" || ownerId !== "" || filterCount > 0;
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
  const from = total === 0 ? 0 : (shownPage - 1) * PER_PAGE + 1;
  const to = Math.min(total, (shownPage - 1) * PER_PAGE + rows.length);
  const paging = shownPage !== page;
  const exportHref = `/api/sales/quotes?${(() => { const p = query(false); p.set("format", "csv"); return p.toString(); })()}`;

  const notice = (
    <>
      {error && (
        <p className="notice er" role="alert" data-testid="alert-error" style={{ marginBottom: 16 }}>
          {error}<button type="button" onClick={() => setError("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
      {success && (
        <p className="notice ok" role="status" data-testid="alert-success" style={{ marginBottom: 16 }}>
          {success}<button type="button" onClick={() => setSuccess("")} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>
        </p>
      )}
    </>
  );

  const tabs = (
    <div role="group" aria-label={ar ? "الحالة" : "Status"} className={phone ? "segs" : "tabs"} data-testid="quote-status-tabs">
      {TABS.map((s) => {
        const on = status === s;
        const n = counts[s || "ALL"] ?? 0;
        return (
          <button key={s || "ALL"} type="button" aria-pressed={on} className={on ? "on" : undefined}
            data-testid={`quote-tab-${s || "ALL"}`} onClick={() => changeStatus(s)}>
            {s ? label(s) : ar ? "الكل" : "All"}
            <span className={phone ? "n" : "c"} data-testid={`quote-count-${s || "ALL"}`}>{num(n, lang)}</span>
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

  // «المالك: الكل»: the deal owner. Offered to a caller who sees all sales; a rep's list is theirs.
  const ownerName = data.owners.find((o) => o.id === ownerId)?.name;
  const ownerChip = scope === "all" ? (
    <span className="chip" data-testid="owner-chip">
      <label htmlFor="q-owner">{ar ? "المالك:" : "Owner:"}</label>
      <Select id="q-owner" value={ownerId} onChange={(e) => changeOwner(e.target.value)} data-testid="owner-select">
        <option value="">{ar ? "الكل" : "All"}</option>
        {data.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </Select>
      {ownerId && (
        <button type="button" className="x" onClick={() => changeOwner("")} aria-label={ar ? `إزالة المالك ${ownerName ?? ""}` : `Remove owner ${ownerName ?? ""}`}>
          <Ico name="close" small />
        </button>
      )}
    </span>
  ) : null;

  const radio = (v: Approval, text: string) => (
    <label className="q-fopt">
      <input type="radio" name="q-approval" checked={approval === v} onChange={() => changeApproval(v)} />
      {text}
    </label>
  );
  const filterBtn = (
    <div ref={filterBox} style={{ position: "relative" }}>
      <button type="button" className="chip q-fbtn" aria-haspopup="true" aria-expanded={filterOpen}
        onClick={() => setFilterOpen((v) => !v)} data-testid="quote-filter">
        <Ico name="filter" small /> {ar ? "تصفية" : "Filter"}
        {filterCount > 0 && <span className="q-fn">{num(filterCount, lang)}</span>}
      </button>
      {filterOpen && (
        <div className="menu down q-filter" role="group" aria-label={ar ? "تصفية" : "Filter"} data-testid="quote-filter-menu">
          <p className="lbl">{ar ? "اعتماد الخصم (المسودات)" : "Discount approval (drafts)"}</p>
          {radio("", ar ? "الكل" : "Any")}
          {radio("PENDING", ar ? "يحتاج اعتماد خصم" : "Needs approval")}
          {radio("APPROVED", ar ? "خصم معتمد" : "Approved")}
          {radio("REJECTED", ar ? "خصم مرفوض" : "Refused")}
          <hr />
          <label className="q-fopt">
            <input type="checkbox" checked={expiring} onChange={(e) => { setExpiring(e.target.checked); setPage(1); }} data-testid="filter-expiring" />
            {ar ? "صادرة تنتهي خلال 7 أيام" : "Issued, expiring within 7 days"}
          </label>
          <label className="q-fopt">
            <input type="checkbox" checked={showSuperseded} onChange={(e) => { setShowSuperseded(e.target.checked); setPage(1); }} data-testid="filter-superseded" />
            {ar ? "إظهار المستبدلة" : "Show superseded"}
          </label>
          {filterCount > 0 && (
            <button type="button" className="btn sm g" style={{ marginTop: 6 }} onClick={() => { setApproval(""); setExpiring(false); setShowSuperseded(false); setPage(1); }}>
              {ar ? "مسح التصفية" : "Clear filters"}
            </button>
          )}
        </div>
      )}
    </div>
  );

  const exportLink = (
    <a href={exportHref} className="btn g" data-testid="quotes-export" download>
      <Ico name="dl" small /> {ar ? "تصدير" : "Export"}
    </a>
  );
  const newBtn = data.can.write ? (
    <button type="button" className="btn p" onClick={() => setPicker(true)} data-testid="new-quote">
      <Ico name="plus" small /> {ar ? "عرض سعر" : "Quotation"}
    </button>
  ) : null;

  const empty = rows.length === 0 ? (
    filtered ? (
      <div data-testid="quotes-no-results" style={{ padding: "48px 0", textAlign: "center" }}>
        <p>{ar ? "لا عروض تطابق البحث أو التصفية." : "No quotations match this search or filter."}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={clearAll}>
          {ar ? "مسح التصفية" : "Clear filters"}
        </button>
      </div>
    ) : (
      <div data-testid="quotes-empty" style={{ padding: "48px 0", textAlign: "center" }}>
        <p style={{ fontWeight: 500 }}>{ar ? "لا توجد عروض أسعار." : "No quotations."}</p>
        <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "يُنشأ العرض على صفقة: «+ عرض سعر»." : "A quotation is raised on a deal: “+ Quotation”."}</p>
      </div>
    )
  ) : null;

  // «30 عرضًا · 3 مستبدلة مخفية»: the superseded revisions of this search, hidden from «الكل».
  const hidden = counts.SUPERSEDED ?? 0;
  const supersededNote = status === "" && hidden > 0 ? (
    <button type="button" className="lk-inline" data-testid="quotes-superseded" onClick={() => { setShowSuperseded((v) => !v); setPage(1); }}>
      {showSuperseded
        ? (ar ? `تظهر ${num(hidden, lang)} مستبدلة · إخفاء` : `${hidden} superseded shown · hide`)
        : (ar ? `${num(hidden, lang)} مستبدلة مخفية` : `${hidden} superseded hidden`)}
    </button>
  ) : null;

  const pager = (
    <nav aria-label={ar ? "صفحات عروض الأسعار" : "Quotation pages"} className="pager">
      <span className="sm" data-testid="quotes-count">
        <span className="n">{num(total, lang)}</span> {ar ? "عرضًا" : total === 1 ? "quotation" : "quotations"}
        {supersededNote && <> · {supersededNote}</>}
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

  const pickerDialog = picker ? <QuotePicker lang={lang} onClose={() => setPicker(false)} /> : null;

  if (phone) {
    return (
      <div className="pg">
        {notice}
        <div className="lbl" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontWeight: 400 }}>
          {facts}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{searchBox}</div>
        <div className="tool" style={{ marginBottom: 6 }}>
          {ownerChip}
          {filterBtn}
          <span className="sp" />
          {newBtn}
        </div>
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
                  <span className={`st ${STATUS_DOT[q.status] ?? ""}`} data-testid={`quote-status-${q.quoteNumber}`}>{label(q.status)}</span>
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
                    {approvalFlag(q)}
                    {lapsed(q) && <span className="flag wa">{ar ? "انتهى" : "Lapsed"}</span>}
                    <RowAction quote={q} lang={lang} />
                  </div>
                </div>
              );
            })}
            {(lastPage > 1 || supersededNote) && pager}
          </div>
        )}
        <div style={{ marginTop: 12 }}>{exportLink}</div>
        {pickerDialog}
      </div>
    );
  }

  // The preview pane: docked from 1280, over the list from 1024 to 1279 (`crm-quotes`).
  const openPreview = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    e.preventDefault();
    setSelected(id);
  };
  const pane = selected ? (
    <QuotePane key={selected} id={selected} lang={lang} onClose={() => setSelected(null)}
      onChanged={(message) => { setSuccess(message); load(); }} />
  ) : null;

  return (
    <div className={`split${pane ? " has-pane" : ""}`}>
    <div className="pg">
      {notice}
      <div className="ph q-list-ph" style={{ marginBottom: 20 }}>
        <div>
          <h1>{ar ? "عروض الأسعار" : "Quotations"}</h1>
          <div className="meta">
            {facts.map((f, i) => (
              <span key={i} style={{ display: "contents" }}>{i > 0 && <i />}{f}</span>
            ))}
          </div>
        </div>
        <div className="act">
          {exportLink}
          {newBtn}
        </div>
      </div>
      {tabs}
      <div className="tool" style={{ marginBottom: 8 }}>
        {searchBox}
        {ownerChip}
        {filterBtn}
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
                {!pane && <th scope="col"><span className="sr-only">{ar ? "الإجراء التالي" : "Next action"}</span></th>}
              </tr></thead>
              <tbody>
                {rows.map((q) => {
                  const rev = revisionText(q);
                  const owner = q.opportunity.owner;
                  return (
                    <tr key={q.id} data-testid={`quote-row-${q.quoteNumber}`} className={selected === q.id ? "sel" : undefined}>
                      <td>
                        <Link href={`/dashboard/sales/quotes/${q.id}`} className="id" data-testid={`open-quote-${q.quoteNumber}`}
                          onClick={(e) => openPreview(e, q.id)} aria-describedby={undefined}
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
                      {!pane && <td style={{ textAlign: "end" }}><RowAction quote={q} lang={lang} /></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pager}
        </>
      )}
      {pickerDialog}
    </div>
    {pane}
    </div>
  );
}
