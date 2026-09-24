"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Phone, Mail, MapPin, CalendarClock, Lock } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { formatDate } from "@/lib/utils";
import {
  runScheduleFollowUp, scheduleMessage, EMPTY_SCHEDULE_STATE, type ScheduleState,
} from "@/lib/services/sales/follow-up";
import {
  ProvisionalBanner, PageHeader, Card, SectionTitle, Alert, Button, Field, TextInput,
  Select, TextArea, EmptyState, Spinner, LeadStatusBadge, LEAD_STATUS_SPECS,
} from "../../_components/ui";

/**
 * Lead detail.
 *
 * The list could show a lead but never open one, so everything a lead accumulates — the calls
 * made, the visit booked, the reason it stalled — had nowhere to live. This is that place.
 *
 * ── Scheduling is an activity, not a date field ──
 * `nextFollowUpAt` on the lead answers "when next"; it does not answer "who promised what, and
 * when did they promise it". Setting the column alone overwrites the previous commitment with
 * no trace that it ever existed, so a lead rescheduled four times looks identical to one
 * scheduled once. Scheduling here therefore writes BOTH: a TASK activity carrying the promise
 * and its due date, and the column the list sorts and counts on. The activity is written
 * first — if it fails, the column is not moved, and the screen says so rather than silently
 * showing a date with no history behind it.
 *
 * ── Nothing is enforced here ──
 * Ownership, privileges and the converted-lead lock are all decided by the API. This screen
 * hides what the user cannot do so it does not offer dead controls, but hiding a button is a
 * courtesy, not a control: every action below is refused server-side on its own merits.
 */

type Activity = {
  id: string; type: string; subject: string; body: string | null;
  dueAt: string | null; completedAt: string | null; createdAt: string;
  owner: { id: string; name: string } | null;
};

type Lead = {
  id: string; companyName: string; companyNameAr: string | null; contactName: string;
  phone: string | null; email: string | null; city: string | null; address: string | null;
  source: string; sourceNote: string | null; status: string; notes: string | null;
  nextFollowUpAt: string | null; createdAt: string; updatedAt: string;
  owner: { id: string; name: string } | null;
  conversion: {
    customerId: string; opportunityId: string; customerCreated: boolean; convertedAt: string;
    customer: { id: string; name: string } | null;
    opportunity: { id: string; title: string; outcome: string } | null;
  } | null;
  activities: Activity[];
};

const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"];
const SOURCE_LABELS: Record<string, { en: string; ar: string }> = {
  WALK_IN: { en: "Walk-in", ar: "زيارة مباشرة" },
  REFERRAL: { en: "Referral", ar: "إحالة" },
  PHONE: { en: "Phone", ar: "هاتف" },
  SOCIAL: { en: "Social media", ar: "وسائل التواصل" },
  EXHIBITION: { en: "Exhibition", ar: "معرض" },
  WEBSITE: { en: "Website", ar: "الموقع" },
  OTHER: { en: "Other", ar: "أخرى" },
};

/** The activity types a follow-up on a lead can be. TASK is reserved for scheduling. */
const LOG_TYPES = ["CALL", "VISIT", "MEETING", "NOTE"];
const TYPE_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" },
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Scheduled follow-up", ar: "متابعة مجدولة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عيّنة" },
};

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";
  const ar = lang === "ar";

  const canWrite = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_write");
  const canConvert = hasSubPrivilege(user?.permissions ?? {}, "sales", "lead_convert");

  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    companyName: "", companyNameAr: "", contactName: "", phone: "", email: "",
    city: "", address: "", source: "REFERRAL", sourceNote: "", notes: "", status: "NEW",
  });

  const [logType, setLogType] = useState("CALL");
  const [logSubject, setLogSubject] = useState("");
  const [logBody, setLogBody] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleSubject, setScheduleSubject] = useState("");
  /** Survives a failed attempt so a retry does not write the activity twice. */
  const [scheduleState, setScheduleState] = useState<ScheduleState>(EMPTY_SCHEDULE_STATE);

  const label = (m: Record<string, { en: string; ar: string }>, k: string) =>
    ar ? (m[k]?.ar ?? k) : (m[k]?.en ?? k);

  useEffect(() => { load(); }, [params.id]);

  /**
   * Loads the lead.
   *
   * No setState before the first `await`: doing so inside an effect body triggers a cascading
   * render, and the lint rule is right to refuse it. `loading` starts true so the spinner shows
   * on first paint without anyone setting it, and refetches after a save are covered by the
   * per-action busy state instead. It also does not clear `error` on success, because callers
   * set a message and then refetch — the partial-failure path in `scheduleFollowUp` depends on
   * that message surviving the reload.
   */
  async function load() {
    const res = await fetch(`/api/sales/leads/${params.id}`);
    if (res.ok) {
      const data = await res.json();
      setLead(data.lead);
      setForm({
        companyName: data.lead.companyName ?? "", companyNameAr: data.lead.companyNameAr ?? "",
        contactName: data.lead.contactName ?? "", phone: data.lead.phone ?? "",
        email: data.lead.email ?? "", city: data.lead.city ?? "", address: data.lead.address ?? "",
        source: data.lead.source ?? "REFERRAL", sourceNote: data.lead.sourceNote ?? "",
        notes: data.lead.notes ?? "", status: data.lead.status ?? "NEW",
      });
    } else {
      setLead(null);
      // 404 covers "does not exist" and "not yours" with one message on purpose: telling a
      // stranger that a record exists but is someone else's is itself a disclosure.
      setError(ar ? "هذا العميل المحتمل غير موجود أو ليس ضمن نطاقك." : "That lead does not exist, or is not in your scope.");
    }
    setLoading(false);
  }

  const converted = !!lead?.conversion;
  const readOnly = !canWrite || converted;

  async function saveEdits() {
    if (busy) return;
    setBusy("save"); setError(""); setSuccess("");
    try {
      const res = await fetch(`/api/sales/leads/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
      setSuccess(ar ? "حُفظت التعديلات." : "Changes saved.");
      setEditing(false);
      await load();
    } finally { setBusy(""); }
  }

  /** Logs a completed follow-up. Written as an activity so the history survives. */
  async function logActivity() {
    if (busy) return;
    if (logSubject.trim().length < 2) {
      setError(ar ? "الموضوع مطلوب." : "A subject is required.");
      return;
    }
    setBusy("log"); setError(""); setSuccess("");
    try {
      const res = await fetch("/api/sales/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: logType, subject: logSubject.trim(),
          body: logBody.trim() || null, leadId: params.id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? (ar ? "تعذّر تسجيل النشاط." : "Could not record the activity.")); return; }
      setLogSubject(""); setLogBody("");
      setSuccess(ar ? "سُجِّل النشاط." : "Activity recorded.");
      await load();
    } finally { setBusy(""); }
  }

  /**
   * Schedules the next follow-up.
   *
   * The sequencing, the half-written case and the no-duplicate-on-retry rule all live in
   * `runScheduleFollowUp`, so they can be exercised without a browser. This function is the
   * wiring: it supplies the two writes, holds the partial-success marker across attempts, and
   * turns the outcome into a message. Only a fully written schedule reads as success.
   */
  async function scheduleFollowUp() {
    if (!scheduleAt) { setError(ar ? "اختر تاريخ المتابعة." : "Pick a follow-up date."); return; }
    const dueAtIso = new Date(scheduleAt).toISOString();
    const subject = scheduleSubject.trim() || (ar ? "متابعة مجدولة" : "Scheduled follow-up");

    // The in-flight check happens before the busy flag is raised, so a second tap that arrives
    // before React has re-rendered the disabled button is still refused by the orchestration.
    if (busy === "schedule") return;
    setBusy("schedule"); setError(""); setSuccess("");
    try {
      const result = await runScheduleFollowUp(
      {
        createActivity: async ({ subject: s, dueAtIso: iso }) => {
          const r = await fetch("/api/sales/activities", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "TASK", subject: s, leadId: params.id, dueAt: iso }),
          });
          if (r.ok) return { ok: true };
          const d = await r.json().catch(() => ({}));
          return { ok: false, error: d.error };
        },
        setFollowUpDate: async (iso) => {
          const r = await fetch(`/api/sales/leads/${params.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nextFollowUpAt: iso }),
          });
          if (r.ok) return { ok: true };
          const d = await r.json().catch(() => ({}));
          return { ok: false, error: d.error };
        },
      },
      scheduleState,
      { subject, dueAtIso, inFlight: false },
      );

      if (result.outcome === "already-running") return;

      setScheduleState(result.state);
      const msg = scheduleMessage(result.outcome, ar, result.error);
      setError(msg.kind === "success" || msg.kind === "none" ? "" : msg.text);
      setSuccess(msg.kind === "success" ? msg.text : "");

      if (result.outcome === "scheduled") { setScheduleAt(""); setScheduleSubject(""); }
      // Refreshed on both a full and a half write: after a partial the activity really is in
      // the history, and hiding that would make the retry look like the first attempt had
      // done nothing at all.
      if (result.outcome !== "activity-failed") await load();
    } finally { setBusy(""); }
  }

  async function convert() {
    if (busy) return;
    setBusy("convert"); setError(""); setSuccess("");
    try {
      const res = await fetch(`/api/sales/leads/${params.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? (ar ? "تعذّر التحويل." : "Could not convert.")); return; }
      setSuccess(data.replayed
        ? (ar ? "هذا العميل المحتمل محوَّل مسبقاً." : "This lead was already converted.")
        : (ar ? "تم التحويل إلى عميل وصفقة." : "Converted to a customer and a deal."));
      await load();
    } finally { setBusy(""); }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner /></div>;

  if (!lead) {
    return (
      <div className="space-y-6">
        <ProvisionalBanner />
        <Alert kind="error">{error}</Alert>
        <Button variant="secondary" onClick={() => router.push("/dashboard/sales/leads")}>
          {ar ? "رجوع إلى القائمة" : "Back to the list"}
        </Button>
      </div>
    );
  }

  const overdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date() && lead.status !== "CONVERTED";

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <Link
        href="/dashboard/sales/leads"
        className="inline-flex items-center gap-1.5 text-sm font-bold text-brown hover:text-orange"
      >
        <ArrowRight size={15} className="rtl:rotate-0 rotate-180" aria-hidden />
        {ar ? "العملاء المحتملون" : "Leads"}
      </Link>

      <PageHeader
        title={ar && lead.companyNameAr ? lead.companyNameAr : lead.companyName}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <LeadStatusBadge status={lead.status} testId="lead-detail-status" />
            <span>{lead.contactName}</span>
            {lead.owner && <span>· {lead.owner.name}</span>}
          </span>
        }
        actions={
          <>
            {canWrite && !converted && (
              <Button variant="secondary" onClick={() => setEditing((v) => !v)} testId="toggle-edit">
                {editing ? (ar ? "إلغاء التعديل" : "Cancel edit") : (ar ? "تعديل" : "Edit")}
              </Button>
            )}
            {canConvert && !converted && lead.status !== "UNQUALIFIED" && (
              <Button onClick={convert} disabled={busy === "convert"} testId="convert-lead">
                {busy === "convert" ? "…" : (ar ? "تحويل إلى عميل" : "Convert to customer")}
              </Button>
            )}
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      {converted && (
        <Alert kind="info">
          <span className="flex items-center gap-2 flex-wrap">
            <Lock size={14} aria-hidden />
            {ar
              ? "هذا العميل المحتمل محوَّل، وتفاصيله صارت عميلاً وصفقة — فهو للقراءة فقط."
              : "This lead has been converted; its details became a customer and a deal, so it is read-only."}
            {lead.conversion?.opportunity && (
              <Link
                href={`/dashboard/sales/deals/${lead.conversion.opportunityId}`}
                className="underline font-bold"
              >
                {ar ? "افتح الصفقة" : "Open the deal"}
              </Link>
            )}
          </span>
        </Alert>
      )}

      {!canWrite && !converted && (
        <Alert kind="info">
          <span className="flex items-center gap-2">
            <Lock size={14} aria-hidden />
            {ar
              ? "دورك يسمح بالاطلاع فقط. التعديل وتسجيل الأنشطة يحتاجان صلاحية «الكتابة على العملاء المحتملين»."
              : "Your role is read-only here. Editing and recording activity need the lead-write privilege."}
          </span>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <SectionTitle>{ar ? "البيانات" : "Details"}</SectionTitle>
            {editing && !readOnly ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field id="companyName" label={ar ? "اسم الشركة" : "Company"} required>
                  <TextInput id="companyName" value={form.companyName} onChange={(v) => setForm({ ...form, companyName: v })} />
                </Field>
                <Field id="companyNameAr" label={ar ? "الاسم بالعربية" : "Arabic name"}>
                  <TextInput id="companyNameAr" value={form.companyNameAr} onChange={(v) => setForm({ ...form, companyNameAr: v })} />
                </Field>
                <Field id="contactName" label={ar ? "جهة الاتصال" : "Contact"} required>
                  <TextInput id="contactName" value={form.contactName} onChange={(v) => setForm({ ...form, contactName: v })} />
                </Field>
                <Field id="phone" label={ar ? "الجوال" : "Phone"}>
                  <TextInput id="phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} inputMode="tel" />
                </Field>
                <Field id="email" label={ar ? "البريد" : "Email"}>
                  <TextInput id="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} inputMode="email" />
                </Field>
                <Field id="city" label={ar ? "المدينة" : "City"}>
                  <TextInput id="city" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
                </Field>
                <Field id="source" label={ar ? "المصدر" : "Source"}>
                  <Select id="source" value={form.source} onChange={(v) => setForm({ ...form, source: v })}>
                    {SOURCES.map((s) => <option key={s} value={s}>{label(SOURCE_LABELS, s)}</option>)}
                  </Select>
                </Field>
                <Field id="status" label={ar ? "الحالة" : "Status"} hint={ar ? "«محوَّل» نتيجة تحويل، ولا تُضبط يدوياً." : "Converted is a consequence of converting, not a value you set."}>
                  <Select id="status" value={form.status} onChange={(v) => setForm({ ...form, status: v })}>
                    {Object.keys(LEAD_STATUS_SPECS)
                      .filter((s) => s !== "CONVERTED")
                      .map((s) => <option key={s} value={s}>{label(LEAD_STATUS_SPECS, s)}</option>)}
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field id="address" label={ar ? "العنوان" : "Address"}>
                    <TextInput id="address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field id="notes" label={ar ? "ملاحظات" : "Notes"}>
                    <TextArea id="notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={3} />
                  </Field>
                </div>
                <div className="sm:col-span-2 flex gap-2">
                  <Button onClick={saveEdits} disabled={busy === "save"} testId="save-lead">
                    {busy === "save" ? "…" : (ar ? "حفظ" : "Save")}
                  </Button>
                  <Button variant="secondary" onClick={() => { setEditing(false); load(); }}>
                    {ar ? "إلغاء" : "Cancel"}
                  </Button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mt-3 text-sm">
                <Row label={ar ? "جهة الاتصال" : "Contact"} value={lead.contactName} />
                <Row label={ar ? "الجوال" : "Phone"} value={lead.phone} ltr icon={<Phone size={13} />} />
                <Row label={ar ? "البريد" : "Email"} value={lead.email} ltr icon={<Mail size={13} />} />
                <Row label={ar ? "المدينة" : "City"} value={lead.city} icon={<MapPin size={13} />} />
                <Row label={ar ? "المصدر" : "Source"} value={label(SOURCE_LABELS, lead.source)} />
                <Row label={ar ? "العنوان" : "Address"} value={lead.address} />
                <Row label={ar ? "أُنشئ" : "Created"} value={formatDate(lead.createdAt)} />
                <Row label={ar ? "آخر تعديل" : "Updated"} value={formatDate(lead.updatedAt)} />
                {lead.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-[11px] text-brown/60 font-bold">{ar ? "ملاحظات" : "Notes"}</dt>
                    <dd className="whitespace-pre-wrap">{lead.notes}</dd>
                  </div>
                )}
              </dl>
            )}
          </Card>

          <Card>
            <SectionTitle>
              {ar ? "سجل النشاط" : "Activity history"}
            </SectionTitle>
            {lead.activities.length === 0 ? (
              <EmptyState>
                {ar
                  ? "لا نشاط بعد. كل مكالمة أو زيارة تُسجَّل هنا وتبقى."
                  : "No activity yet. Every call or visit recorded here stays here."}
              </EmptyState>
            ) : (
              <ul className="mt-3 space-y-2" data-testid="activity-list">
                {lead.activities.map((a) => (
                  <li key={a.id} className="border border-border rounded-xl px-3 py-2.5" data-testid={`activity-${a.id}`}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <span className="font-bold text-sm">{a.subject}</span>
                      <span className="text-[11px] text-brown/60">
                        {label(TYPE_LABELS, a.type)} · {formatDate(a.createdAt)}
                        {a.owner ? ` · ${a.owner.name}` : ""}
                      </span>
                    </div>
                    {a.body && <p className="text-xs text-brown mt-1 whitespace-pre-wrap">{a.body}</p>}
                    {a.dueAt && (
                      <p className="text-[11px] text-brown/60 mt-1 flex items-center gap-1">
                        <CalendarClock size={12} aria-hidden />
                        {ar ? "مستحق" : "Due"} {formatDate(a.dueAt)}
                        {a.completedAt ? ` · ${ar ? "اكتمل" : "completed"}` : ""}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle>{ar ? "الالتزام القادم" : "Next commitment"}</SectionTitle>
            <p className={`mt-2 text-sm font-bold ${overdue ? "text-red-700" : lead.nextFollowUpAt ? "text-charcoal" : "text-amber-700"}`} data-testid="next-followup">
              {lead.nextFollowUpAt
                ? `${formatDate(lead.nextFollowUpAt)}${overdue ? ` · ${t("leadOverdue")}` : ""}`
                : (ar ? "لا التزام قادم" : "No next step")}
            </p>
            {!readOnly && (
              <div className="mt-3 space-y-2">
                <Field id="scheduleAt" label={ar ? "موعد المتابعة" : "Follow-up date"}>
                  <TextInput id="scheduleAt" type="datetime-local" value={scheduleAt} onChange={setScheduleAt} />
                </Field>
                <Field id="scheduleSubject" label={ar ? "ماذا ستفعل؟" : "What will you do?"}>
                  <TextInput id="scheduleSubject" value={scheduleSubject} onChange={setScheduleSubject}
                    placeholder={ar ? "متابعة مجدولة" : "Scheduled follow-up"} />
                </Field>
                <Button onClick={scheduleFollowUp} disabled={busy === "schedule" || !scheduleAt} testId="schedule-followup">
                  {busy === "schedule" ? "…" : (ar ? "جدولة المتابعة" : "Schedule follow-up")}
                </Button>
                <p className="text-[11px] text-brown/60">
                  {ar
                    ? "تُنشئ مهمة في السجل وتحدّث الموعد معاً — لا يُغيَّر التاريخ وحده."
                    : "Creates a task in the history and updates the date together — the date is never moved on its own."}
                </p>
              </div>
            )}
          </Card>

          {!readOnly && (
            <Card>
              <SectionTitle>{ar ? "تسجيل متابعة" : "Record a follow-up"}</SectionTitle>
              <div className="mt-3 space-y-2">
                <Field id="logType" label={ar ? "النوع" : "Type"}>
                  <Select id="logType" value={logType} onChange={setLogType}>
                    {LOG_TYPES.map((x) => <option key={x} value={x}>{label(TYPE_LABELS, x)}</option>)}
                  </Select>
                </Field>
                <Field id="logSubject" label={ar ? "الموضوع" : "Subject"} required>
                  <TextInput id="logSubject" value={logSubject} onChange={setLogSubject} />
                </Field>
                <Field id="logBody" label={ar ? "التفاصيل" : "Details"}>
                  <TextArea id="logBody" value={logBody} onChange={setLogBody} rows={3} />
                </Field>
                <Button onClick={logActivity} disabled={busy === "log"} testId="log-activity">
                  {busy === "log" ? "…" : (ar ? "تسجيل" : "Record")}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, ltr, icon }: { label: string; value: string | null; ltr?: boolean; icon?: React.ReactNode }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] text-brown/60 font-bold flex items-center gap-1">{icon}{label}</dt>
      {/* Latin digits inside Arabic text render reversed unless the run is marked LTR. */}
      <dd className="font-semibold" dir={ltr ? "ltr" : undefined} style={ltr ? { textAlign: "start" } : undefined}>
        {value}
      </dd>
    </div>
  );
}
