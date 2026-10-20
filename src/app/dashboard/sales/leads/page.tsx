"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, X, Download, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

import { LEAD_STATUS_SPECS, LEAD_SOURCE_LABELS, Spinner, FocusDialog } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { initials } from "@/components/d21/labels";
import { dueText, shortDate, dayCount, daysFromToday } from "@/components/d21/format";
import { LeadPane } from "./LeadPane";
import { useUnsavedGuard, isDirtyAgainst } from "../../_components/useUnsavedGuard";
import ImportDialog from "./ImportDialog";

/**
 * Leads — SC-02 in the Sales Screens design.
 *
 * A compact table, not the card list this screen shipped with: eight columns right to left,
 * 13px of vertical padding against 22px line boxes, and one outlined action per row chosen
 * by what is most urgent. Import and export stay in the header, because they are the two
 * things this screen does that no other screen can.
 */

type Lead = {
  id: string;
  companyName: string;
  companyNameAr: string | null;
  contactName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  source: string;
  status: string;
  nextFollowUpAt: string | null;
  createdAt: string;
  owner: { id: string; name: string } | null;
  conversion: { customerId: string; opportunityId: string } | null;
};

type DuplicateCandidate = { leadId: string; companyName: string; contactName: string; strong: boolean };

const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"] as const;

// The shared map, so this screen and the settings screen name a source identically.
const SOURCE_LABELS = LEAD_SOURCE_LABELS;

/** An untouched create form. Also the baseline the unsaved-work guard compares against. */
const EMPTY_LEAD_FORM = {
  companyName: "", companyNameAr: "", contactName: "", phone: "",
  email: "", city: "", source: "REFERRAL", nextFollowUpAt: "", notes: "",
};

// Status labels and colours now come from the shared map in `_components/ui`, so this screen
// and every other one render a stored value identically. The local copy this replaced painted
// UNQUALIFIED red, which reads as an error; disqualifying a lead is ordinary work, not a fault.
const STATUS_LABELS = LEAD_STATUS_SPECS;

/**
 * The single next action for a row.
 *
 * The design gives each lead exactly one, chosen by what is most urgent rather than by what
 * is possible: a converted or disqualified lead has none, an overdue one needs the call
 * logging, one with no commitment needs a date, and anything else is ready to convert. The
 * two follow-up actions navigate to the lead, which is where the forms that perform them
 * live — the list does not grow its own copies of them.
 *
 * Direction 2.1 draws every row action as the same compact outlined control (`ui-row-action`):
 * a column of filled buttons would make each row shout, and the reader is scanning, not acting.
 */
function RowAction({
  lead, lang, canConvert, converting, onConvert, isOverdue, hasNoCommitment,
}: {
  lead: Lead; lang: "ar" | "en"; canConvert: boolean; converting: string | null;
  onConvert: () => void; isOverdue: boolean; hasNoCommitment: boolean;
}) {
  const ar = lang === "ar";
  if (lead.conversion) {
    // Still a link to the customer it became — removing the only route to the converted
    // customer would lose real functionality.
    return <a href="/dashboard/customers" className="btn sm g">{ar ? "محوَّل — لا إجراء" : "Converted — no action"}</a>;
  }
  if (lead.status === "UNQUALIFIED") {
    return <span className="sm" style={{ whiteSpace: "nowrap" }}>{ar ? "غير مؤهَّل — لا تحويل" : "Unqualified — no convert"}</span>;
  }
  if (isOverdue) {
    return <Link href={`/dashboard/sales/leads/${lead.id}`} className="btn sm">{ar ? "تسجيل متابعة" : "Log follow-up"}</Link>;
  }
  if (hasNoCommitment) {
    return <Link href={`/dashboard/sales/leads/${lead.id}`} className="btn sm">{ar ? "جدولة" : "Schedule"}</Link>;
  }
  if (!canConvert) {
    return <Link href={`/dashboard/sales/leads/${lead.id}`} className="btn sm">{ar ? "فتح السجل" : "Open"}</Link>;
  }
  return (
    <button type="button" onClick={onConvert} disabled={converting !== null} aria-busy={converting === lead.id || undefined}
      data-testid={`convert-lead-${lead.id}`} className="btn sm">
      {converting === lead.id ? (ar ? "جارٍ التحويل…" : "Converting…") : ar ? "تحويل" : "Convert"}
    </button>
  );
}

/** The page size the API is asked for. The API caps it at 100 and defaults to 25. */
const PER_PAGE = 25;

/** The tabs of `crm-leads`: the open ones (new, contacted, qualified) and the closed ones
    (unqualified, converted) as groups, the three open statuses on their own. Counts are the
    server's, over everything the search and owner filter match. */
const STATUS_TABS = ["OPEN", "NEW", "CONTACTED", "QUALIFIED", "CLOSED"] as const;
const TAB_LABELS: Record<string, { ar: string; en: string }> = {
  OPEN: { ar: "المفتوحة", en: "Open" }, CLOSED: { ar: "المغلقة", en: "Closed" },
};
/** Status → the reference status dot. */
const LEAD_ST: Record<string, string> = { NEW: "in", QUALIFIED: "ok", CONVERTED: "ok", UNQUALIFIED: "x" };

export default function LeadsPage() {
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";
  const canWrite = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_write");
  const canConvert = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_convert");
  const canImport = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_import");
  const canExport = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_export");
  const [showImport, setShowImport] = useState(false);

  const [rows, setRows] = useState<Lead[]>([]);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("OPEN");
  const [owner, setOwner] = useState("all");
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [overdueAll, setOverdueAll] = useState(0);
  const [noCommitmentAll, setNoCommitmentAll] = useState(0);
  // The lead in the preview pane (`crm-leads`: docked at 1440, over the list at 1024).
  const [selected, setSelected] = useState<string | null>(null);
  const phone = usePhone();
  // The API pages at 25. The list used to fetch page 1 and stop, so a rep with a 26th lead
  // could not reach it from this screen at all (IMD-02).
  const [page, setPage] = useState(1);
  // The page the rows on screen actually belong to. The range, and whether the list is
  // "busy", are read from this rather than from `page`, which moves the moment a button is
  // pressed — otherwise page 1's rows sat under a "51–78" range until the fetch landed (IMD-14).
  const [shownPage, setShownPage] = useState(1);
  const [total, setTotal] = useState(0);
  // A failed fetch is not an empty list. Showing "no leads yet" over a network error tells
  // the rep their pipeline is empty when it is merely unreachable.
  const [loadFailed, setLoadFailed] = useState(false);
  // Responses can arrive out of order while somebody types; only the latest request may
  // write the list.
  const requestSeq = useRef(0);

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [form, setForm] = useState(EMPTY_LEAD_FORM);

  // `?new=1` opens the form on arrival — the shell's «+ جديد» menu links here. Derived, not
  // set in an effect; closing the form marks the request handled and drops the parameter.
  const router = useRouter();
  const requestedNew = useSearchParams().get("new") === "1";
  const [newHandled, setNewHandled] = useState(false);
  const formOpen = showForm || (requestedNew && canWrite && !newHandled);
  function closeForm() {
    setShowForm(false);
    if (requestedNew && !newHandled) {
      setNewHandled(true);
      router.replace("/dashboard/sales/leads");
    }
  }

  // Nine fields somebody may have spent a minute filling in. Navigating away used to
  // discard them without a word.
  useUnsavedGuard(isDirtyAgainst(formOpen, form, EMPTY_LEAD_FORM));

  const [converting, setConverting] = useState<string | null>(null);
  /**
   * The lead being considered for deletion.
   *
   * A two-step confirmation rather than a window.confirm(): the reason a delete is refused
   * — "this lead has nine logged conversations" — is the useful part, and a native dialog
   * has nowhere to put it.
   */
  const [deleting, setDeleting] = useState<Lead | null>(null);

  async function remove(lead: Lead) {
    setError("");
    const res = await fetch(`/api/sales/leads/${lead.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setDeleting(null);
    if (!res.ok) {
      setError(localizeApiError(data) ?? (lang === "ar" ? "تعذّر الحذف." : "Could not delete."));
      return;
    }
    setSuccess(lang === "ar" ? "حُذف العميل المحتمل." : "Lead deleted.");
    // Deleting the only lead on the last page would leave an empty page; step back instead.
    if (rows.length === 1 && page > 1) goToPage(page - 1);
    else load();
  }

  async function load(p: number = page) {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter) params.set("status", statusFilter);
    if (owner !== "all") params.set("owner", owner);
    params.set("page", String(p));
    params.set("perPage", String(PER_PAGE));
    try {
      const res = await fetch(`/api/sales/leads?${params}`);
      if (seq !== requestSeq.current) return;
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows ?? []);
        setShownPage(p);
        setScope(data.scope ?? "own");
        setTotal(typeof data.total === "number" ? data.total : (data.rows ?? []).length);
        setCounts(data.counts ?? {});
        setOwners(data.owners ?? []);
        setOverdueAll(data.overdue ?? 0);
        setNoCommitmentAll(data.noCommitment ?? 0);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch {
      if (seq === requestSeq.current) setLoadFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  // Debounced so typing does not fire a request per keystroke. A new search or filter starts
  // again from the first page — page 3 of a narrower result may not exist.
  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); load(1); }, 350);
    return () => clearTimeout(timer);
  }, [search, statusFilter, owner]);

  function goToPage(p: number) {
    setPage(p);
    load(p);
  }

  function openForm() {
    setForm({
      companyName: "", companyNameAr: "", contactName: "", phone: "",
      email: "", city: "", source: "REFERRAL", nextFollowUpAt: "", notes: "",
    });
    setDuplicates([]);
    setFormError("");
    setShowForm(true);
  }

  const formValid = form.companyName.trim().length >= 2 && form.contactName.trim().length >= 2;

  async function submit(acknowledgeDuplicate: boolean) {
    if (!formValid || saving) return;
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/sales/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          companyNameAr: form.companyNameAr || null,
          nextFollowUpAt: form.nextFollowUpAt || null,
          acknowledgeDuplicate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(data.duplicates)) {
        // Surfaced, not silently blocked and not merged: the operator decides.
        setDuplicates(data.duplicates);
        setFormError("");
        return;
      }
      if (!res.ok) {
        setFormError(localizeApiError(data) ?? (lang === "ar" ? "تعذّر الحفظ." : "Could not save."));
        return;
      }
      closeForm();
      setSuccess(lang === "ar" ? "تم إنشاء العميل المحتمل." : "Lead created.");
      load();
    } finally {
      setSaving(false);
    }
  }

  async function convert(lead: Lead) {
    if (converting) return;
    setConverting(lead.id);
    setError("");
    try {
      const res = await fetch(`/api/sales/leads/${lead.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(localizeApiError(data) ?? (lang === "ar" ? "تعذّر التحويل." : "Could not convert."));
        return;
      }
      setSuccess(
        data.replayed
          ? lang === "ar" ? "هذا العميل المحتمل محوَّل مسبقاً." : "This lead was already converted."
          : lang === "ar" ? "تم التحويل إلى عميل وصفقة." : "Converted to a customer and a deal.",
      );
      load();
    } finally {
      setConverting(null);
    }
  }

  // The phone header (`173:586`): the title and «+» for a new lead in place of search.
  useD21Phone({
    title: lang === "ar" ? "العملاء المحتملون" : "Leads",
    action: canWrite ? { href: "/dashboard/sales/leads?new=1", label: lang === "ar" ? "عميل محتمل جديد" : "New lead", icon: "plus" } : undefined,
  });
  // «+» links to `?new=1` again after the form was closed once: a new request reopens it.
  const [prevRequested, setPrevRequested] = useState(requestedNew);
  if (requestedNew !== prevRequested) {
    setPrevRequested(requestedNew);
    if (!requestedNew) setNewHandled(false);
  }

  const label = (m: Record<string, { en: string; ar: string }>, k: string) =>
    lang === "ar" ? (m[k]?.ar ?? k) : (m[k]?.en ?? k);
  const ar = lang === "ar";
  const tabLabel = (s: string) => (TAB_LABELS[s] ? (ar ? TAB_LABELS[s].ar : TAB_LABELS[s].en) : label(STATUS_LABELS, s));
  const filtered = search.trim() !== "" || owner !== "all" || statusFilter !== "OPEN";
  const from = total === 0 ? 0 : (shownPage - 1) * PER_PAGE + 1;
  const to = Math.min(total, (shownPage - 1) * PER_PAGE + rows.length);
  const paging = shownPage !== page;
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
  const clearAll = () => { setSearch(""); setOwner("all"); setStatusFilter("OPEN"); };

  if (loading) return <div className="pg"><Spinner /></div>;

  // Counted nouns for the header line («19 مفتوحًا · 3 متابعات متأخرة · 2 بلا التزام قادم»).
  const openText = (n: number) => ar
    ? (n === 1 ? "واحد مفتوح" : n === 2 ? "اثنان مفتوحان" : n <= 10 ? `${n} مفتوحة` : `${n} مفتوحًا`)
    : `${n} open`;
  const lateText = (n: number) => ar
    ? (n === 1 ? "متابعة متأخرة واحدة" : n === 2 ? "متابعتان متأخرتان" : n <= 10 ? `${n} متابعات متأخرة` : `${n} متابعة متأخرة`)
    : `${n} overdue`;

  // The next commitment: relative near today («اليوم 13:00», «أمس 15:00»), else the date.
  const commitment = (lead: Lead) => {
    if (!lead.nextFollowUpAt) return null;
    const n = daysFromToday(lead.nextFollowUpAt);
    const text = Math.abs(n) <= 1 ? dueText(lead.nextFollowUpAt, lang) : shortDate(lead.nextFollowUpAt, lang);
    const late = new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";
    const flag = !late ? null : n <= -2
      ? (ar ? `متأخر ${dayCount(-n, lang)}` : `${dayCount(-n, lang)} overdue`)
      : (ar ? "متأخر" : "Overdue");
    return { text, flag };
  };
  const statusDot = (s: string, id?: string) => (
    <span className={`st ${LEAD_ST[s] ?? ""}`} data-testid={id ? `lead-status-${id}` : undefined}>{label(STATUS_LABELS, s)}</span>
  );

  const notices = (
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
    <div role="group" aria-label={ar ? "الحالة" : "Status"} className={phone ? "segs" : "tabs"} data-testid="lead-status-tabs">
      {STATUS_TABS.map((s) => {
        const on = statusFilter === s;
        return (
          <button key={s} type="button" aria-pressed={on} className={on ? "on" : undefined} data-testid={`lead-tab-${s}`}
            onClick={() => setStatusFilter(s)}>
            {tabLabel(s)}
            {typeof counts[s] === "number" && <span className={phone ? "n" : "c"}>{counts[s]}</span>}
          </button>
        );
      })}
    </div>
  );

  const searchBox = (
    <label className="search" style={phone ? { width: "100%", height: 40 } : { width: 280 }}>
      <Ico name="search" small />
      <input value={search} onChange={(e) => setSearch(e.target.value)} data-testid="lead-search"
        placeholder={phone ? (ar ? "الشركة أو الهاتف" : "Company or phone") : (ar ? "الشركة أو جهة الاتصال أو الهاتف" : "Company, contact or phone")}
        aria-label={ar ? "بحث في العملاء المحتملين" : "Search leads"} />
    </label>
  );

  const states = loadFailed ? (
    <div className="notice er" role="alert" data-testid="leads-load-error">
      <span>{ar ? "تعذّر تحميل العملاء المحتملين. لم تتغير أي بيانات." : "Could not load leads. Nothing was changed."}</span>
      <button type="button" className="btn sm" onClick={() => load()}>{ar ? "إعادة المحاولة" : "Try again"}</button>
    </div>
  ) : rows.length === 0 ? (
    filtered ? (
      <div data-testid="leads-no-results" style={{ padding: "48px 0", textAlign: "center" }}>
        <p>{ar ? "لا نتائج تطابق البحث أو التصفية." : "No leads match this search or filter."}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} data-testid="lead-clear-filters" onClick={clearAll}>
          {ar ? "مسح التصفية" : "Clear filters"}
        </button>
      </div>
    ) : (
      <div data-testid="leads-empty" style={{ padding: "48px 0", textAlign: "center" }}>
        <p style={{ fontWeight: 500 }}>{t("leadsEmpty")}</p>
        {canWrite && <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "أضف أول عميل محتمل من زر «عميل محتمل»." : "Add the first one with “Lead”."}</p>}
      </div>
    )
  ) : null;

  const pager = (
    <nav aria-label={ar ? "صفحات العملاء المحتملين" : "Lead pages"} className="pager">
      <span className="sm" data-testid="leads-count">
        <span className="n">{total}</span> {ar ? (statusFilter === "OPEN" ? "عميلًا محتملًا مفتوحًا" : "عميلًا محتملًا") : statusFilter === "OPEN" ? (total === 1 ? "open lead" : "open leads") : total === 1 ? "lead" : "leads"}
      </span>
      <span className="sp" />
      <span className="sm" data-testid="leads-range" aria-live="polite">
        <bdi dir="ltr" className="n">{from}–{to}</bdi> {ar ? "من" : "of"} <bdi className="n">{total}</bdi>
      </span>
      <button type="button" className="btn sm" data-testid="leads-prev" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
        {ar ? "السابق" : "Previous"}
      </button>
      <button type="button" className="btn sm" data-testid="leads-next" disabled={page >= lastPage} onClick={() => goToPage(page + 1)}>
        {ar ? "التالي" : "Next"}
      </button>
    </nav>
  );

  // The preview pane: docked from 1280, over the list from 1024 to 1279 (`crm-leads` 1440 / 1024).
  const openPreview = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    e.preventDefault();
    setSelected(id);
  };
  const pane = selected && !phone ? (
    <LeadPane id={selected} lang={lang} canConvert={canConvert} canWrite={canWrite}
      onClose={() => setSelected(null)}
      onChanged={(message: string) => { setSuccess(message); load(); }} />
  ) : null;

  return (
    <div className={`split${pane ? " has-pane" : ""}`}>
    <div className="pg">
      {phone ? (
        <>
          {notices}
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{searchBox}</div>
          {tabs}
          {states ?? (
            <div aria-busy={paging || undefined} style={paging ? { opacity: .6 } : undefined} data-testid="leads-table">
              {rows.map((lead) => {
                const c = commitment(lead);
                const name = ar && lead.companyNameAr ? lead.companyNameAr : lead.companyName;
                return (
                  <div key={lead.id} className="mrow rowlink" data-testid={`lead-${lead.id}`}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/dashboard/sales/leads/${lead.id}`} className="who open" data-testid={`open-lead-${lead.id}`}>{name}</Link>
                    </div>
                    {statusDot(lead.status, lead.id)}
                    <div className="r2">
                      <span style={{ flex: 1, minWidth: 0 }}>{[lead.contactName, lead.city].filter(Boolean).join(" · ")}</span>
                      {c ? <span>{c.text}</span> : <span data-testid={`lead-no-commitment-${lead.id}`}>{t("leadNoCommitment")}</span>}
                      {c?.flag && <span className="flag">{c.flag}</span>}
                    </div>
                  </div>
                );
              })}
              {lastPage > 1 && pager}
            </div>
          )}
        </>
      ) : (
        <>
          {notices}
          <div className="ph" style={{ marginBottom: 20 }}>
            <div>
              <h1>{t("leadsTitle")}</h1>
              <div className="meta">
                <span data-testid="leads-total">{openText(counts.OPEN ?? 0)}</span>
                <i /><span data-testid="leads-overdue">{lateText(overdueAll)}</span>
                <i /><span data-testid="count-no-commitment"><span className="n">{noCommitmentAll}</span> {t("leadNoCommitment")}</span>
              </div>
            </div>
            <div className="act">
              {/* Export is not in the frame; it is the only route to it (record: conflict L-1). */}
              {canExport && (
                <a href={`/api/sales/leads/export${statusFilter ? `?status=${statusFilter}` : ""}`} download data-testid="export-leads" className="btn g">
                  <Download size={16} aria-hidden /> {ar ? "تصدير" : "Export"}
                </a>
              )}
              {canImport && (
                <button type="button" onClick={() => setShowImport(true)} data-testid="import-leads" className="btn g">
                  <Ico name="dl" small /> {ar ? "استيراد" : "Import"}
                </button>
              )}
              {canWrite && (
                <button type="button" onClick={openForm} className="btn p" data-testid="new-lead">
                  <Ico name="plus" small /> {ar ? "عميل محتمل" : "Lead"}
                </button>
              )}
            </div>
          </div>
          {tabs}
          <div className="tool" style={{ marginBottom: 8 }}>
            {searchBox}
            {scope === "all" && (
              <span className="chip">
                <label htmlFor="ld-owner">{ar ? "المالك:" : "Owner:"}</label>
                <Select id="ld-owner" value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="lead-owner">
                  <option value="all">{ar ? "الكل" : "All"}</option>
                  {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
                <button type="button" className="x" onClick={() => setOwner("all")} aria-label={ar ? "إزالة فلتر المالك" : "Clear owner"} data-testid="lead-owner-clear">
                  <Ico name="close" small />
                </button>
              </span>
            )}
            <span className="sp" />
            {/* The one order the server applies, stated rather than offered as a choice. */}
            <span className="sort-note">{ar ? "الالتزام القادم ↑" : "Next commitment ↑"}</span>
          </div>
          {states ?? (
            <>
              <div aria-busy={paging || undefined} style={paging ? { opacity: .6 } : undefined}>
                <table className="t leads" data-testid="leads-table">
                  <thead><tr>
                    <th scope="col">{t("leadCompany")}</th>
                    <th scope="col" className="xl">{t("leadSource")}</th>
                    <th scope="col">{t("leadStatus")}</th>
                    <th scope="col" aria-sort="ascending">{ar ? t("leadNextFollowUp") : "Next commitment"}</th>
                    <th scope="col" className="xl">{t("leadOwner")}</th>
                    <th scope="col"><span className="sr-only">{ar ? "الإجراء التالي" : "Next action"}</span></th>
                  </tr></thead>
                  <tbody>
                    {rows.map((lead) => {
                      const isOverdue = !!lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";
                      const hasNoCommitment = !lead.nextFollowUpAt && lead.status !== "CONVERTED" && lead.status !== "UNQUALIFIED";
                      const name = ar && lead.companyNameAr ? lead.companyNameAr : lead.companyName;
                      const c = commitment(lead);
                      return (
                        <tr key={lead.id} data-testid={`lead-${lead.id}`} className={selected === lead.id ? "sel" : undefined}>
                          <td>
                            <Link href={`/dashboard/sales/leads/${lead.id}`} data-testid={`open-lead-${lead.id}`} className="who"
                              style={{ textDecoration: "none", display: "block" }} onClick={(e) => openPreview(e, lead.id)}>
                              {name}
                            </Link>
                            <span className="sm" style={{ display: "block", lineHeight: "18px" }}>{[lead.contactName, lead.city].filter(Boolean).join(" · ")}</span>
                          </td>
                          <td className="xl" style={{ color: "var(--text-secondary)" }}>{label(SOURCE_LABELS, lead.source)}</td>
                          <td>{statusDot(lead.status, lead.id)}</td>
                          <td>
                            {hasNoCommitment || !c ? (
                              <span data-testid={`lead-no-commitment-${lead.id}`} className="sm">{t("leadNoCommitment")}</span>
                            ) : (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 13.5 }}>{c.text}</span>
                                {c.flag && <span className="flag">{c.flag}</span>}
                              </span>
                            )}
                          </td>
                          <td className="xl">
                            {lead.owner
                              ? <span className="av s" title={lead.owner.name} aria-label={lead.owner.name}>{initials(lead.owner.name)}</span>
                              : <span className="sm">{ar ? "غير مُسنَد" : "Unassigned"}</span>}
                          </td>
                          <td style={{ textAlign: "end" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <RowAction lead={lead} lang={lang} canConvert={canConvert} converting={converting}
                                onConvert={() => convert(lead)} isOverdue={isOverdue} hasNoCommitment={hasNoCommitment} />
                              {/* Not in the frame; the only delete there is (record: conflict L-2). */}
                              {canWrite && !lead.conversion && (
                                <button type="button" className="ib" onClick={() => setDeleting(lead)} data-testid={`delete-lead-${lead.id}`}
                                  aria-label={ar ? `حذف ${lead.companyName}` : `Delete ${lead.companyName}`} title={ar ? "حذف" : "Delete"}>
                                  <Trash2 size={14} aria-hidden />
                                </button>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pager}
            </>
          )}
        </>
      )}

      {showImport && (
        <ImportDialog
          lang={lang}
          onClose={() => setShowImport(false)}
          onDone={(message) => {
            setShowImport(false);
            setSuccess(message);
            load();
          }}
        />
      )}

      {deleting && (
        <div
          data-ui="dialog-scrim"
          className="fixed inset-0 z-[60] bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
          onClick={() => setDeleting(null)}
          role="presentation"
        >
          <FocusDialog
            onClose={() => setDeleting(null)}
            labelledBy="delete-lead-title"
            testId="delete-lead-dialog"
            className="bg-oo-bg-default w-full max-w-[440px] my-8"
          >
            <div className="border-b">
              <h2 id="delete-lead-title" className="text-oo-text-primary">
                {ar ? "حذف عميل محتمل" : "Delete this lead"}
              </h2>
            </div>
            <div className="py-4 space-y-2">
              <p className="font-medium text-oo-text-primary">{deleting.companyName}</p>
              <p className="text-[13.5px] text-oo-text-secondary leading-relaxed">
                {ar
                  ? "الحذف مخصّص لسجل أُنشئ بالخطأ. أما العميل المحتمل الذي جرت معه محادثات مسجّلة فلا يُحذف — علّمه «غير مؤهل» بدلاً من محو سجل تلك المحادثات."
                  : "Deleting is for a record raised in error. A lead with logged conversations is not deleted — mark it unqualified rather than erasing the record of those conversations."}
              </p>
            </div>
            <div className="flex justify-end gap-2 py-4 border-t">
              <button type="button" autoFocus onClick={() => setDeleting(null)} data-ui="btn" className="inline-flex items-center">
                {ar ? "إلغاء" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => remove(deleting)}
                data-testid="confirm-delete-lead"
                data-ui="btn"
                data-variant="danger"
                className="inline-flex items-center"
              >
                {ar ? "حذف" : "Delete"}
              </button>
            </div>
          </FocusDialog>
        </div>
      )}

      {formOpen && (
        <div
          data-ui="dialog-scrim"
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
          role="presentation"
        >
          <FocusDialog
            onClose={() => { if (!saving) closeForm(); }}
            labelledBy="lead-form-title"
            testId="lead-form"
            className="bg-oo-bg-default w-full max-w-lg my-8"
          >
            <div className="flex items-center justify-between border-b">
              <h2 id="lead-form-title" className="text-oo-text-primary">{t("newLeadBtn")}</h2>
              <button type="button" onClick={() => closeForm()} aria-label={ar ? "إغلاق" : "Close"} disabled={saving}
                className="grid size-8 place-items-center rounded-lg text-oo-text-muted hover:bg-[var(--d-surface-hover)]">
                <X size={18} aria-hidden />
              </button>
            </div>

            <form
              className="py-4 space-y-3"
              onSubmit={(e) => { e.preventDefault(); submit(false); }}
              noValidate
            >
              {/* Required first, optional after: a short form gets filled, a long one gets
                  abandoned halfway and leaves a half-built record. */}
              <label className="block space-y-1.5" data-ui="field">
                <span className="block text-[13px] font-medium text-oo-text-primary">{t("leadCompany")} <span aria-hidden className="text-oo-status-rejected">*</span></span>
                <input
                  aria-label={t("leadCompany")}
                  aria-required="true"
                  autoFocus
                  data-ui="input"
                  value={form.companyName}
                  onChange={(e) => { setForm({ ...form, companyName: e.target.value }); setDuplicates([]); }}
                  className="w-full"
                />
              </label>
              <label className="block space-y-1.5" data-ui="field">
                <span className="block text-[13px] font-medium text-oo-text-primary">{t("leadContact")} <span aria-hidden className="text-oo-status-rejected">*</span></span>
                <input
                  aria-label={t("leadContact")}
                  aria-required="true"
                  data-ui="input"
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  className="w-full"
                />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1.5" data-ui="field">
                  <span className="block text-[13px] font-medium text-oo-text-primary">{ar ? "الهاتف" : "Phone"}</span>
                  <input
                    dir="ltr"
                    inputMode="tel"
                    aria-label={ar ? "الهاتف" : "Phone"}
                    data-ui="input"
                    value={form.phone}
                    onChange={(e) => { setForm({ ...form, phone: e.target.value }); setDuplicates([]); }}
                    className="w-full text-start"
                  />
                </label>
                <label className="block space-y-1.5" data-ui="field">
                  <span className="block text-[13px] font-medium text-oo-text-primary">{t("leadCity")}</span>
                  <input
                    aria-label={t("leadCity")}
                    data-ui="input"
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full"
                  />
                </label>
                <label className="block space-y-1.5" data-ui="field">
                  <span className="block text-[13px] font-medium text-oo-text-primary">{t("leadSource")}</span>
                  <Select
                    // Named explicitly. Without this the wrapping label hands the control an
                    // accessible name assembled from every option in the list, which is
                    // unusable to a screen reader and ambiguous to anything else looking the
                    // control up by name.
                    aria-label={t("leadSource")}
                    data-ui="input"
                    value={form.source}
                    onChange={(e) => setForm({ ...form, source: e.target.value })}
                    className="w-full"
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>{label(SOURCE_LABELS, s)}</option>
                    ))}
                  </Select>
                </label>
                <label className="block space-y-1.5" data-ui="field">
                  <span className="block text-[13px] font-medium text-oo-text-primary">{t("leadNextFollowUp")}</span>
                  <input
                    type="date"
                    aria-label={t("leadNextFollowUp")}
                    data-ui="input"
                    value={form.nextFollowUpAt}
                    onChange={(e) => setForm({ ...form, nextFollowUpAt: e.target.value })}
                    className="w-full"
                  />
                </label>
              </div>
              <p className="text-[12px] text-oo-text-muted">
                {ar ? "الحقول المعلّمة بـ * مطلوبة: حرفان على الأقل." : "Fields marked * are required: at least two characters."}
              </p>

              {duplicates.length > 0 && (
                <div className="rounded-[9px] border border-oo-status-waiting bg-oo-status-waiting-bg p-3" role="alert">
                  <p className="text-[13px] font-medium text-oo-status-hold mb-1 flex items-center gap-1.5">
                    <AlertTriangle size={14} aria-hidden /> {t("leadDuplicateTitle")}
                  </p>
                  <p className="text-[12.5px] text-oo-status-hold leading-relaxed mb-2">{t("leadDuplicateBody")}</p>
                  <ul className="space-y-1 mb-2">
                    {duplicates.map((d) => (
                      <li key={d.leadId} className="text-[12.5px] text-oo-status-hold font-medium">
                        {d.companyName} — {d.contactName}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={saving}
                    data-ui="btn"
                    className="inline-flex items-center"
                  >
                    {t("leadCreateAnyway")}
                  </button>
                </div>
              )}

              {formError && (
                <p className="text-[12.5px] font-medium text-oo-status-rejected flex items-start gap-1.5" role="alert">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden /> {formError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-[var(--d-border-subtle)] -mx-6 px-6">
                <button
                  type="button"
                  onClick={() => closeForm()}
                  disabled={saving}
                  data-ui="btn"
                  className="inline-flex items-center"
                >
                  {ar ? "إلغاء" : "Cancel"}
                </button>
                <button
                  type="submit"
                  disabled={!formValid || saving}
                  aria-busy={saving || undefined}
                  data-ui="btn"
                  data-variant="primary"
                  className="inline-flex items-center"
                >
                  {saving ? (ar ? "جارٍ الحفظ…" : "Saving…") : ar ? "حفظ" : "Save"}
                </button>
              </div>
            </form>
          </FocusDialog>
        </div>
      )}
    </div>
    {pane}
    </div>
  );
}
