"use client";

import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, UserPlus, Users2, X, ArrowRight, Upload, Download } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { formatDate } from "@/lib/utils";
import ImportDialog from "./ImportDialog";

/**
 * Leads.
 *
 * PROVISIONAL INTERFACE. The Figma design for this feature could not be produced — the
 * design integration is not authorised in this session — so this is built from the existing
 * ERP components and the documented user flow, and says so at the top rather than passing
 * itself off as the designed article. It is functional, not final.
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

const SOURCE_LABELS: Record<string, { en: string; ar: string }> = {
  WALK_IN: { en: "Walk-in", ar: "زيارة مباشرة" },
  REFERRAL: { en: "Referral", ar: "توصية" },
  PHONE: { en: "Phone", ar: "هاتف" },
  SOCIAL: { en: "Social media", ar: "وسائل التواصل" },
  EXHIBITION: { en: "Exhibition", ar: "معرض" },
  WEBSITE: { en: "Website", ar: "الموقع" },
  OTHER: { en: "Other", ar: "أخرى" },
};

const STATUS_LABELS: Record<string, { en: string; ar: string; tone: string }> = {
  NEW: { en: "New", ar: "جديد", tone: "bg-info-bg text-slate" },
  CONTACTED: { en: "Contacted", ar: "تم التواصل", tone: "bg-cream text-brown" },
  QUALIFIED: { en: "Qualified", ar: "مؤهل", tone: "bg-emerald-100 text-emerald-800" },
  UNQUALIFIED: { en: "Unqualified", ar: "غير مؤهل", tone: "bg-red-50 text-red-700" },
  CONVERTED: { en: "Converted", ar: "تم التحويل", tone: "bg-orange/15 text-orange" },
};

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
            {rows.length}
            {overdue > 0 && (
              <span className="text-red-700 font-bold"> · {overdue} {t("leadOverdue")}</span>
            )}
          </p>
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
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm font-bold" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success-bg border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm font-bold">
          {success}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={lang === "ar" ? "ابحث بالمنشأة أو الهاتف أو المدينة…" : "Search company, phone or city…"}
          className="flex-1 min-w-[200px] px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
          aria-label={lang === "ar" ? "بحث" : "Search"}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2.5 border-2 border-border rounded-xl text-sm"
          aria-label={t("leadStatus")}
        >
          <option value="">{lang === "ar" ? "كل الحالات" : "All statuses"}</option>
          {Object.keys(STATUS_LABELS).map((s) => (
            <option key={s} value={s}>{label(STATUS_LABELS, s)}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-border text-brown/40">
          <Users2 size={40} className="mx-auto mb-3 opacity-50" />
          <p className="font-semibold text-lg">{t("leadsEmpty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((lead) => {
            const isOverdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";
            const st = STATUS_LABELS[lead.status];
            return (
              <div
                key={lead.id}
                data-testid={`lead-${lead.id}`}
                className="bg-white rounded-2xl border border-border p-4 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-charcoal">
                        {lang === "ar" && lead.companyNameAr ? lead.companyNameAr : lead.companyName}
                      </p>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${st?.tone ?? "bg-muted"}`}>
                        {label(STATUS_LABELS, lead.status)}
                      </span>
                      {isOverdue && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800">
                          {t("leadOverdue")}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-brown font-medium">
                      {lead.contactName}
                      {lead.phone && <> · <span dir="ltr">{lead.phone}</span></>}
                      {lead.city && <> · {lead.city}</>}
                    </p>
                    <p className="text-xs text-brown/50 mt-0.5">
                      {t("leadSource")}: {label(SOURCE_LABELS, lead.source)}
                      {lead.owner && <> · {t("leadOwner")}: {lead.owner.name}</>}
                      {" · "}
                      {lead.nextFollowUpAt
                        ? <>{t("leadNextFollowUp")}: {formatDate(lead.nextFollowUpAt)}</>
                        : <span className="text-amber-700 font-semibold">{t("leadNoFollowUp")}</span>}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {lead.conversion ? (
                      <a
                        href={`/dashboard/customers`}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border-2 border-border text-brown hover:border-orange/60 hover:text-orange transition-colors"
                      >
                        {lang === "ar" ? "العميل المرتبط" : "Linked customer"} <ArrowRight size={13} />
                      </a>
                    ) : canConvert && lead.status !== "UNQUALIFIED" ? (
                      <button
                        onClick={() => convert(lead)}
                        disabled={converting === lead.id}
                        className="flex items-center gap-1.5 px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {converting === lead.id ? "…" : t("leadConvertBtn")}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
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
