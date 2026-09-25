"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, UserPlus, Users2, X, Upload, Download, Trash2, CircleDashed } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

import {
  LeadStatusBadge, LEAD_STATUS_SPECS, LEAD_SOURCE_LABELS, DataTable, Toolbar,
  SearchField, FilterSelect, formatWhen, num,
} from "../_components/ui";
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
 */
function RowAction({
  lead, lang, canConvert, converting, onConvert, isOverdue, hasNoCommitment, full,
}: {
  lead: Lead; lang: "ar" | "en"; canConvert: boolean; converting: string | null;
  onConvert: () => void; isOverdue: boolean; hasNoCommitment: boolean; full?: boolean;
}) {
  const ar = lang === "ar";
  const base = `${full ? "w-full justify-center " : ""}inline-flex items-center whitespace-nowrap rounded-lg px-3 py-[7px] text-[12px] leading-[18px] transition-colors`;
  const outline = `${base} border border-oo-border-strong bg-oo-bg-default`;

  if (lead.conversion) {
    // Still a link to the customer it became — the design shows this slot as non-actionable,
    // but removing the only route to the converted customer would lose real functionality.
    return (
      <a href="/dashboard/customers" className={`${outline} text-oo-text-muted hover:text-oo-action-primary`}>
        {ar ? "محوَّل — لا إجراء" : "Converted — no action"}
      </a>
    );
  }
  if (lead.status === "UNQUALIFIED") {
    return (
      <span className={`${outline} text-oo-text-muted`}>
        {ar ? "غير مؤهَّل — لا تحويل" : "Unqualified — no convert"}
      </span>
    );
  }
  if (isOverdue) {
    return (
      <Link href={`/dashboard/sales/leads/${lead.id}`} className={`${outline} text-oo-action-primary hover:border-oo-action-primary`}>
        {ar ? "تسجيل متابعة" : "Log a follow-up"}
      </Link>
    );
  }
  if (hasNoCommitment) {
    return (
      <Link href={`/dashboard/sales/leads/${lead.id}`} className={`${outline} text-oo-action-primary hover:border-oo-action-primary`}>
        {ar ? "تحديد موعد متابعة" : "Schedule a follow-up"}
      </Link>
    );
  }
  if (!canConvert) {
    return (
      <Link href={`/dashboard/sales/leads/${lead.id}`} className={`${outline} text-oo-action-primary hover:border-oo-action-primary`}>
        {ar ? "فتح السجل" : "Open the lead"}
      </Link>
    );
  }
  return (
    <button
      onClick={onConvert}
      disabled={converting === lead.id}
      data-testid={`convert-lead-${lead.id}`}
      className={`${base} bg-oo-action-primary text-white hover:bg-oo-action-primary-hover disabled:opacity-50`}
    >
      {converting === lead.id ? "…" : ar ? "تحويل إلى عميل" : "Convert to customer"}
    </button>
  );
}

/** A key/value line for the narrow layout, mirroring one table column. */
function KV({ k, v, ltr }: { k: string; v: string; ltr?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] leading-[18px] text-oo-text-muted">{k}</span>
      <span
        className="text-[14px] leading-[22px] text-oo-text-primary"
        dir={ltr ? "ltr" : undefined}
        style={ltr ? { textAlign: "start" } : undefined}
      >
        {v}
      </span>
    </div>
  );
}

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
  const [statusFilter, setStatusFilter] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [form, setForm] = useState({
    companyName: "", companyNameAr: "", contactName: "", phone: "",
    email: "", city: "", source: "REFERRAL", nextFollowUpAt: "", notes: "",
  });

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
      setError(data.error ?? (lang === "ar" ? "تعذّر الحذف." : "Could not delete."));
      return;
    }
    setSuccess(lang === "ar" ? "حُذف العميل المحتمل." : "Lead deleted.");
    load();
  }

  useEffect(() => { load(); }, []);

  async function load() {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/sales/leads?${params}`);
    if (res.ok) {
      const data = await res.json();
      setRows(data.rows ?? []);
      setScope(data.scope ?? "own");
    } else {
      setError(lang === "ar" ? "تعذّر تحميل العملاء المحتملين." : "Could not load leads.");
    }
    setLoading(false);
  }

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 350);
    return () => clearTimeout(timer);
  }, [search, statusFilter]);

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
        setFormError(data.error ?? (lang === "ar" ? "تعذّر الحفظ." : "Could not save."));
        return;
      }
      setShowForm(false);
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
        setError(data.error ?? (lang === "ar" ? "تعذّر التحويل." : "Could not convert."));
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

  const overdue = useMemo(
    () => rows.filter((r) => r.nextFollowUpAt && new Date(r.nextFollowUpAt) < new Date() && r.status !== "CONVERTED").length,
    [rows],
  );

  // A lead nobody owns a next step for is the commonest way a pipeline goes quiet, and it is
  // NOT counted as overdue: overdue means a commitment was made and missed, and these have no
  // commitment to miss. Counted separately rather than folded in, so neither number lies.
  //
  // The exclusions differ from `overdue` on purpose. Converted and unqualified leads are
  // terminal — no next step is expected of them — whereas `overdue` deliberately still counts
  // an unqualified lead with a date that has passed, because that commitment was real. Leaving
  // `overdue` alone keeps this change presentational.
  const noCommitment = useMemo(
    () => rows.filter((r) => !r.nextFollowUpAt && r.status !== "CONVERTED" && r.status !== "UNQUALIFIED").length,
    [rows],
  );

  const label = (m: Record<string, { en: string; ar: string }>, k: string) =>
    lang === "ar" ? (m[k]?.ar ?? k) : (m[k]?.en ?? k);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Says what it is. A provisional screen that looks finished is worse than one that
          admits it, because nobody reviews what appears already signed off. */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-start gap-2">
        <AlertTriangle size={15} className="text-amber-700 flex-shrink-0 mt-0.5" />
        <p className="text-xs font-bold text-amber-900">{t("provisionalUiBanner")}</p>
      </div>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("leadsTitle")}</h1>
          <p className="text-brown text-sm font-medium">
            {/* The design draws the urgent count as an outlined chip rather than coloured
                text in a sentence, so it survives being scanned rather than read. */}
            <span className="flex flex-wrap items-center gap-2">
              {overdue > 0 && (
                <span
                  data-testid="count-overdue"
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-oo-status-blocked bg-oo-status-blocked-bg px-2.5 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked"
                >
                  <AlertTriangle size={13} aria-hidden />
                  {num(overdue, lang)} {t("leadOverdue")}
                </span>
              )}
              {noCommitment > 0 && (
                <span
                  data-testid="count-no-commitment"
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-oo-status-hold bg-oo-status-hold-bg px-2.5 py-[3px] text-[12px] leading-[18px] text-oo-status-hold"
                >
                  <CircleDashed size={13} aria-hidden />
                  {num(noCommitment, lang)} {t("leadNoCommitment")}
                </span>
              )}
              <span className="text-[12px] leading-[18px] text-oo-text-muted">
                {num(rows.length, lang)} {t("leadShown")}
              </span>
            </span>
          </p>
          {/* The counts are computed over the loaded rows, which the filter narrows. Saying so
              stops the number being read as a total across every lead in the system. */}
          <p className="text-brown/60 text-xs mt-0.5">{t("leadCountScope")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canExport && (
            <a
              // A real link, not a scripted download: the browser handles the file, the
              // Content-Disposition header names it, and it still works with JavaScript
              // having failed to load.
              href={`/api/sales/leads/export${statusFilter ? `?status=${statusFilter}` : ""}`}
              download
              data-testid="export-leads"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-white border-2 border-border text-charcoal rounded-xl text-sm font-bold hover:border-orange active:scale-[0.98] transition-all"
            >
              <Download size={16} aria-hidden /> {lang === "ar" ? "تصدير CSV" : "Export CSV"}
            </a>
          )}
          {canImport && (
            <button
              onClick={() => setShowImport(true)}
              data-testid="import-leads"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-white border-2 border-border text-charcoal rounded-xl text-sm font-bold hover:border-orange active:scale-[0.98] transition-all"
            >
              <Upload size={16} aria-hidden /> {lang === "ar" ? "استيراد CSV" : "Import CSV"}
            </button>
          )}
          {canWrite && (
            <button
              onClick={openForm}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all"
            >
              <UserPlus size={16} /> {t("newLeadBtn")}
            </button>
          )}
        </div>
      </div>

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

      {scope === "own" && (
        <p className="text-xs text-brown/60 font-semibold">{t("leadScopeOwn")}</p>
      )}

      {error && (
        <div
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm font-bold"
          role="alert"
          data-testid="alert-error"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="bg-success-bg border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm font-bold"
          role="status"
          data-testid="alert-success"
        >
          {success}
        </div>
      )}

      {/* Toolbar: the status filter at a fixed 200, the search taking the rest, both with a
          1px border and 10px radius. The old controls used a 2px border and a larger radius,
          which read as two chunky form fields rather than a quiet filter bar above a table. */}
      {/* In an RTL document the first child sits on the right. The design puts the search
          there and the status filter on the left, with the magnifier against the search
          box's right edge and the chevron against the filter's left edge — so both icons
          use logical `start`/`end` rather than a hard side. */}
      <Toolbar>
        <SearchField
          value={search}
          onChange={setSearch}
          label={lang === "ar" ? "بحث" : "Search"}
          placeholder={lang === "ar" ? "ابحث بالشركة أو جهة الاتصال أو الجوال…" : "Search company, contact or phone…"}
        />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} label={t("leadStatus")}>
          <option value="">{lang === "ar" ? "كل الحالات" : "All statuses"}</option>
          {Object.keys(STATUS_LABELS).map((s) => (
            <option key={s} value={s}>{label(STATUS_LABELS, s)}</option>
          ))}
        </FilterSelect>
      </Toolbar>

      {rows.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-border text-brown/40">
          <Users2 size={40} className="mx-auto mb-3 opacity-50" />
          <p className="font-semibold text-lg">{t("leadsEmpty")}</p>
        </div>
      ) : (
        <>
          {/* ── Desktop: the compact table the design specifies ──────────────────────
              Column order right-to-left is company, contact, phone, source, status, next
              commitment, owner, next action. In an RTL document the first cell renders on
              the right, so DOM order and reading order are the same thing here.

              Row height is 13px of vertical padding against 22px line boxes, which is what
              makes five leads readable in roughly the height the old cards gave to two. */}
          <div className="hidden lg:block">
            <DataTable
              testId="leads-table"
              minWidth={1180}
              cols={[
                { label: t("leadCompany"), w: "min-w-[240px]" },
                { label: t("leadContact"), w: "w-[160px]" },
                { label: lang === "ar" ? "الجوال" : "Phone", w: "w-[145px]" },
                { label: t("leadSource"), w: "w-[95px]" },
                { label: t("leadStatus"), w: "w-[150px]" },
                { label: t("leadNextFollowUp"), w: "w-[210px]" },
                { label: t("leadOwner"), w: "w-[130px]" },
                { label: lang === "ar" ? "الإجراء التالي" : "Next action", w: "w-[190px]" },
              ]}
            >
              {rows.map((lead) => {
                    const isOverdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";
                    const hasNoCommitment = !lead.nextFollowUpAt && lead.status !== "CONVERTED" && lead.status !== "UNQUALIFIED";
                    return (
                      <tr key={lead.id} data-testid={`lead-${lead.id}`} className="border-t border-oo-border-default">
                        <td className="px-4 py-[13px] align-middle">
                          <Link
                            href={`/dashboard/sales/leads/${lead.id}`}
                            className="block text-[14px] font-medium leading-[22px] text-oo-action-primary hover:underline"
                            data-testid={`open-lead-${lead.id}`}
                          >
                            {lang === "ar" && lead.companyNameAr ? lead.companyNameAr : lead.companyName}
                          </Link>
                          <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                            {[lead.city, label(SOURCE_LABELS, lead.source)].filter(Boolean).join(" · ")}
                          </span>
                        </td>
                        <td className="px-4 py-[13px] align-middle text-[14px] leading-[22px] text-oo-text-primary">
                          {lead.contactName}
                        </td>
                        {/* A Latin run inside an RTL cell reverses unless it is marked. */}
                        <td className="px-4 py-[13px] align-middle text-[14px] leading-[20px] text-oo-text-primary" dir="ltr" style={{ textAlign: "start" }}>
                          {lead.phone ?? "—"}
                        </td>
                        <td className="px-4 py-[13px] align-middle text-[14px] leading-[22px] text-oo-text-primary">
                          {label(SOURCE_LABELS, lead.source)}
                        </td>
                        <td className="px-4 py-[13px] align-middle">
                          <LeadStatusBadge status={lead.status} testId={`lead-status-${lead.id}`} />
                        </td>
                        <td className="px-4 py-[13px] align-middle">
                          {isOverdue ? (
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-oo-status-blocked bg-oo-status-blocked-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked">
                              <AlertTriangle size={13} aria-hidden /> {t("leadOverdue")}
                            </span>
                          ) : hasNoCommitment ? (
                            <span
                              data-testid={`lead-no-commitment-${lead.id}`}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-oo-status-hold bg-oo-status-hold-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-hold"
                            >
                              <CircleDashed size={13} aria-hidden /> {t("leadNoCommitment")}
                            </span>
                          ) : (
                            <span className="text-[14px] leading-[22px] text-oo-text-primary">
                              {formatWhen(lead.nextFollowUpAt, lang)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-[13px] align-middle text-[14px] leading-[22px] text-oo-text-primary">
                          {lead.owner?.name ?? (lang === "ar" ? "غير مُسنَد" : "Unassigned")}
                        </td>
                        <td className="px-4 py-[13px] align-middle">
                          <div className="flex items-center gap-1.5">
                            <RowAction
                              lead={lead}
                              lang={lang}
                              canConvert={canConvert}
                              converting={converting}
                              onConvert={() => convert(lead)}
                              isOverdue={!!isOverdue}
                              hasNoCommitment={hasNoCommitment}
                            />
                            {canWrite && !lead.conversion && (
                              <button
                                onClick={() => setDeleting(lead)}
                                data-testid={`delete-lead-${lead.id}`}
                                aria-label={lang === "ar" ? `حذف ${lead.companyName}` : `Delete ${lead.companyName}`}
                                className="rounded-lg p-1.5 text-brown/40 transition-colors hover:bg-red-50 hover:text-red-600"
                              >
                                <Trash2 size={14} aria-hidden />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
            </DataTable>
          </div>

          {/* ── Narrow: the same columns as a stacked record, not a squeezed table ──── */}
          <div className="space-y-2 lg:hidden">
            {rows.map((lead) => {
              const isOverdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";
              const hasNoCommitment = !lead.nextFollowUpAt && lead.status !== "CONVERTED" && lead.status !== "UNQUALIFIED";
              return (
                <div key={lead.id} data-testid={`m-lead-${lead.id}`} className="rounded-2xl border border-oo-border-default bg-oo-bg-default p-4">
                  <div className="flex items-start justify-between gap-2">
                    <LeadStatusBadge status={lead.status} />
                    <div className="min-w-0 text-end">
                      <Link
                        href={`/dashboard/sales/leads/${lead.id}`}
                        className="block break-words text-[14px] font-medium leading-[22px] text-oo-action-primary hover:underline"
                      >
                        {lang === "ar" && lead.companyNameAr ? lead.companyNameAr : lead.companyName}
                      </Link>
                      <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                        {[lead.city, label(SOURCE_LABELS, lead.source)].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1.5">
                    <KV k={t("leadContact")} v={lead.contactName} />
                    <KV k={lang === "ar" ? "الجوال" : "Phone"} v={lead.phone ?? "—"} ltr />
                    <KV k={t("leadOwner")} v={lead.owner?.name ?? (lang === "ar" ? "غير مُسنَد" : "Unassigned")} />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] leading-[18px] text-brown-light">{t("leadNextFollowUp")}</span>
                      {isOverdue ? (
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-oo-status-blocked bg-oo-status-blocked-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked">
                          <AlertTriangle size={13} aria-hidden /> {t("leadOverdue")}
                        </span>
                      ) : hasNoCommitment ? (
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-oo-status-hold bg-oo-status-hold-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-hold">
                          <CircleDashed size={13} aria-hidden /> {t("leadNoCommitment")}
                        </span>
                      ) : (
                        <span className="text-[14px] leading-[22px] text-oo-text-primary">
                          {formatWhen(lead.nextFollowUpAt, lang)}
                        </span>
                      )}
                    </div>
                  </dl>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex-1">
                      <RowAction
                        lead={lead}
                        lang={lang}
                        canConvert={canConvert}
                        converting={converting}
                        onConvert={() => convert(lead)}
                        isOverdue={!!isOverdue}
                        hasNoCommitment={hasNoCommitment}
                        full
                      />
                    </div>
                    {canWrite && !lead.conversion && (
                      <button
                        onClick={() => setDeleting(lead)}
                        aria-label={lang === "ar" ? `حذف ${lead.companyName}` : `Delete ${lead.companyName}`}
                        className="rounded-lg p-2 text-brown/40 transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {deleting && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setDeleting(null)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={lang === "ar" ? "حذف عميل محتمل" : "Delete a lead"}
            data-testid="delete-lead-dialog"
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl w-full max-w-md my-8 shadow-xl"
          >
            <div className="p-4 border-b border-border">
              <h2 className="font-extrabold text-charcoal">
                {lang === "ar" ? "حذف عميل محتمل" : "Delete this lead"}
              </h2>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm font-bold text-charcoal">{deleting.companyName}</p>
              <p className="text-xs text-brown leading-relaxed">
                {lang === "ar"
                  ? "الحذف مخصّص لسجل أُنشئ بالخطأ. أما العميل المحتمل الذي جرت معه محادثات مسجّلة فلا يُحذف — علّمه «غير مؤهل» بدلاً من محو سجل تلك المحادثات."
                  : "Deleting is for a record raised in error. A lead with logged conversations is not deleted — mark it unqualified rather than erasing the record of those conversations."}
              </p>
            </div>
            <div className="flex gap-3 p-4 border-t border-border">
              <button
                type="button"
                onClick={() => remove(deleting)}
                data-testid="confirm-delete-lead"
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white font-bold text-sm hover:bg-red-700"
              >
                {lang === "ar" ? "حذف" : "Delete"}
              </button>
              <button
                type="button"
                onClick={() => setDeleting(null)}
                className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-sm text-brown hover:bg-cream transition-colors"
              >
                {lang === "ar" ? "إلغاء" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-lg my-8 shadow-xl" data-testid="lead-form">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="font-extrabold text-charcoal">{t("newLeadBtn")}</h2>
              <button type="button" onClick={() => setShowForm(false)} aria-label="Close" disabled={saving}>
                <X size={20} className="text-brown/60" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Required first, optional after: a short form gets filled, a long one gets
                  abandoned halfway and leaves a half-built record. */}
              <label className="block">
                <span className="text-[11px] font-bold text-brown">{t("leadCompany")} *</span>
                <input
                  aria-label={t("leadCompany")}
                  value={form.companyName}
                  onChange={(e) => { setForm({ ...form, companyName: e.target.value }); setDuplicates([]); }}
                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-bold text-brown">{t("leadContact")} *</span>
                <input
                  aria-label={t("leadContact")}
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] font-bold text-brown">{lang === "ar" ? "الهاتف" : "Phone"}</span>
                  <input
                    dir="ltr"
                    aria-label={lang === "ar" ? "الهاتف" : "Phone"}
                    value={form.phone}
                    onChange={(e) => { setForm({ ...form, phone: e.target.value }); setDuplicates([]); }}
                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-bold text-brown">{t("leadCity")}</span>
                  <input
                    aria-label={t("leadCity")}
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-bold text-brown">{t("leadSource")}</span>
                  <select
                    // Named explicitly. Without this the wrapping label hands the control an
                    // accessible name assembled from every option in the list, which is
                    // unusable to a screen reader and ambiguous to anything else looking the
                    // control up by name.
                    aria-label={t("leadSource")}
                    value={form.source}
                    onChange={(e) => setForm({ ...form, source: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>{label(SOURCE_LABELS, s)}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] font-bold text-brown">{t("leadNextFollowUp")}</span>
                  <input
                    type="date"
                    aria-label={t("leadNextFollowUp")}
                    value={form.nextFollowUpAt}
                    onChange={(e) => setForm({ ...form, nextFollowUpAt: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                  />
                </label>
              </div>

              {duplicates.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3" role="alert">
                  <p className="text-[11px] font-bold text-amber-900 uppercase mb-1 flex items-center gap-1.5">
                    <AlertTriangle size={13} /> {t("leadDuplicateTitle")}
                  </p>
                  <p className="text-xs text-amber-900 leading-relaxed mb-2">{t("leadDuplicateBody")}</p>
                  <ul className="space-y-1 mb-2">
                    {duplicates.map((d) => (
                      <li key={d.leadId} className="text-xs text-amber-900 font-semibold">
                        {d.companyName} — {d.contactName}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={saving}
                    className="px-3 py-2 rounded-xl text-xs font-bold bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50"
                  >
                    {t("leadCreateAnyway")}
                  </button>
                </div>
              )}

              {formError && (
                <p className="text-xs font-semibold text-red-700 flex items-start gap-1.5" role="alert">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {formError}
                </p>
              )}
            </div>

            <div className="flex gap-3 p-4 border-t border-border">
              <button
                type="button"
                onClick={() => submit(false)}
                disabled={!formValid || saving}
                className="flex-1 py-2.5 rounded-xl bg-orange text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "…" : lang === "ar" ? "حفظ" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={saving}
                className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-sm text-brown hover:bg-cream transition-colors"
              >
                {lang === "ar" ? "إلغاء" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
