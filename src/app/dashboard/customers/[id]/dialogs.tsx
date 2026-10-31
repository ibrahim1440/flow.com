"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useEffect, useState } from "react";
import { Dialog, Field } from "@/components/hr/ui";
import { api } from "../../sales/_components/ui";
import { OUTCOME_LABELS } from "@/components/d21/labels";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import type { Contact, Customer, Deal } from "./types";
import { DIRECT_UPLOAD_MAX_BYTES, pickUploadPath } from "@/lib/services/customers/direct-upload-rules";
import { directUpload } from "./direct-upload-client";
import { ValidityFields, draftProblem, saveValidity, type DateDraft } from "./_components/contract-validity";
import { hasValidity } from "@/lib/services/customers/contract-rules";

/**
 * The account page's forms, in the HR kit dialog the customers list already uses. Each sends
 * exactly one request to an endpoint that re-checks the permission; the page only decides
 * whether to offer the button.
 */

const errorOf = (d: { error?: string; errorEn?: string }, ar: boolean, fallback: string) =>
  localizeApiError(d, ar ? "ar" : "en") || fallback;

export const SEGMENT_LABELS: Record<string, { ar: string; en: string }> = {
  WHOLESALE: { ar: "جملة", en: "Wholesale" },
  RETAIL: { ar: "تجزئة", en: "Retail" },
  CAFE: { ar: "مقهى", en: "Café" },
  DISTRIBUTOR: { ar: "موزّع", en: "Distributor" },
  OTHER: { ar: "أخرى", en: "Other" },
};

const fmtMoney = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

export const FILE_CATEGORY_LABELS: Record<string, { ar: string; en: string }> = {
  CONTRACT: { ar: "عقد", en: "Contract" },
  REGISTRATION: { ar: "السجل التجاري", en: "Commercial register" },
  TAX: { ar: "شهادة ضريبية", en: "VAT certificate" },
  PRICE_AGREEMENT: { ar: "اتفاقية أسعار", en: "Price agreement" },
  OTHER: { ar: "أخرى", en: "Other" },
};

/** «رفع ملف» — one multipart POST to /api/customers/[id]/files, which re-checks everything. */
export function FileDialog({ ar, customerId, maxBytes = 5 * 1024 * 1024, direct = false, canDates = false, onClose, onDone }: { ar: boolean; customerId: string; maxBytes?: number; direct?: boolean; canDates?: boolean; onClose: () => void; onDone: (warning?: string) => void }) {
  const L = (a: string, e: string) => (ar ? a : e);
  // feat/blob-client-upload: ≤ 4 MB through the app's route (with its database fallback); above it,
  // up to 20 MB, straight from the browser to the private Blob store (pickUploadPath).
  const limit = direct ? DIRECT_UPLOAD_MAX_BYTES : maxBytes;
  const mb = Math.round(limit / 1024 / 1024);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState("CONTRACT");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // «صلاحية العقد» (batch 24 WP-C): optional start / end dates for a contract or price agreement, set on the new
  // file right after the upload (PATCH …/files/[fileId]; the account owner or a sales manager only).
  const [dates, setDates] = useState<DateDraft>({ validFrom: "", validUntil: "" });
  const withDates = canDates && hasValidity(category) && !!(dates.validFrom || dates.validUntil);
  const finish = async (fileId: string | undefined) => {
    if (!withDates || !fileId) { onDone(); return; }
    const problem = await saveValidity(ar, customerId, fileId, dates);
    onDone(problem ? L(`رُفع الملف، لكن ما انحفظت التواريخ: ${problem}`, `The file was uploaded, but the dates were not saved: ${problem}`) : undefined);
  };
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!file || busy) return;
    const dp = withDates ? draftProblem(ar, dates) : "";
    if (dp) { setErr(dp); return; }
    const path = pickUploadPath(file.size, { maxBytes, direct });
    if (path === "too-large") { setCanRetry(false); setErr(L(`الحد الأقصى لحجم الملف ${mb} ميغابايت.`, `Files are limited to ${mb} MB.`)); return; }
    setBusy(true); setErr(""); setCanRetry(false);
    if (path === "direct") {
      setProgress(0);
      const r = await directUpload({ customerId, file, category, title: title.trim(), onProgress: (p) => setProgress(Math.max(0, Math.min(100, Math.round(p)))) });
      setBusy(false);
      if (r.ok) { setProgress(100); await finish(r.id); return; }
      setProgress(null);
      setCanRetry(r.retry);
      setErr(errorOf(r.message, ar, L("تعذّر رفع الملف.", "Could not upload the file.")));
      return;
    }
    const fd = new FormData();
    fd.set("file", file); fd.set("category", category); if (title.trim()) fd.set("title", title.trim());
    const res = await fetch(`/api/customers/${customerId}/files`, { method: "POST", body: fd }).catch(() => null);
    setBusy(false);
    if (!res) { setCanRetry(true); setErr(L("تعذّر الاتصال.", "Could not connect.")); return; }
    if (res.ok) { const row = (await res.json().catch(() => null)) as { id?: string } | null; await finish(row?.id); return; }
    const data = await res.json().catch(() => null);
    // A 413 with no JSON is the hosting platform's own request-size limit, before the app saw the file.
    if (!data && res.status === 413) { setErr(L("الملف أكبر مما يقبله الخادم في طلب واحد. جرّب ملفًا أصغر.", "The file is larger than the server accepts in one request. Try a smaller file.")); return; }
    setCanRetry(res.status >= 500);
    setErr(errorOf(data ?? {}, ar, L("تعذّر رفع الملف.", "Could not upload the file.")));
  }
  return (
    <Dialog open title={L("رفع ملف", "Upload a file")} sub={L(`PDF أو JPEG أو PNG · حتى ${mb} ميغابايت`, `PDF, JPEG or PNG · up to ${mb} MB`)} onClose={onClose} testId="file-dialog"
      actions={<>
        <button type="submit" form="acc-file" className="hr-btn is-primary" disabled={!file || busy} data-testid="file-save">{busy ? L("جارٍ الرفع…", "Uploading…") : canRetry ? L("إعادة المحاولة", "Try again") : L("رفع", "Upload")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-file" className="hr-form" onSubmit={save}>
        <Err text={err} />
        <Field label={L("الملف", "File")} wide>
          <input type="file" className="hr-input" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(""); setCanRetry(false); setProgress(null); }} data-testid="file-input" />
        </Field>
        {progress !== null && (
          <div className="acc-upload-progress" style={{ gridColumn: "1 / -1" }} data-testid="file-progress">
            <div className="lbl" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{progress >= 100 ? L("جارٍ التحقق من الملف…", "Checking the file…") : L("جارٍ الرفع إلى مخزن الملفات…", "Uploading to file storage…")}</span>
              <bdi data-testid="file-progress-pct">{progress}%</bdi>
            </div>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={L("تقدّم الرفع", "Upload progress")}
              style={{ height: 8, borderRadius: 999, background: "var(--hr-border-subtle)", overflow: "hidden", marginTop: 6 }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "var(--hr-primary)", transition: "width .2s" }} />
            </div>
          </div>
        )}
        <Field label={L("التصنيف", "Category")}>
          <Select className="hr-select" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="file-category">
            {Object.keys(FILE_CATEGORY_LABELS).map((k) => <option key={k} value={k}>{ar ? FILE_CATEGORY_LABELS[k].ar : FILE_CATEGORY_LABELS[k].en}</option>)}
          </Select>
        </Field>
        <Field label={L("العنوان", "Title")} help={L("اختياري؛ يُستخدم اسم الملف إن تُرك فارغًا.", "Optional; the file name is used when empty.")}>
          <input className="hr-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-testid="file-title" />
        </Field>
        {canDates && hasValidity(category) && <ValidityFields ar={ar} value={dates} onChange={(v) => { setDates(v); setErr(""); }} disabled={busy} />}
      </form>
    </Dialog>
  );
}

function Err({ text }: { text: string }) {
  return text ? <p className="hr-err is-wide" role="alert" data-testid="dialog-error" style={{ gridColumn: "1 / -1" }}>{text}</p> : null;
}

// ── «سجّل نشاط» ──────────────────────────────────────────────────────────────────────────
/**
 * The kinds a rep picks with one tap (batch 24 WP-A: the dialog's layout is WP-A's). «واتساب» and «بريد» are their
 * own activity types (WHATSAPP / EMAIL, 20261206090000_sales_myday): recorded here, never sent from the system.
 */
export type ActivityKind = "CALL" | "WHATSAPP" | "EMAIL" | "VISIT" | "MEETING" | "NOTE" | "TASK" | "SAMPLE_FOLLOW_UP";
const KINDS: { id: ActivityKind; ar: string; en: string }[] = [
  { id: "CALL", ar: "مكالمة", en: "Call" },
  { id: "WHATSAPP", ar: "واتساب", en: "WhatsApp" },
  { id: "EMAIL", ar: "بريد", en: "Email" },
  { id: "VISIT", ar: "زيارة", en: "Visit" },
  { id: "MEETING", ar: "اجتماع", en: "Meeting" },
  { id: "NOTE", ar: "ملاحظة", en: "Note" },
  { id: "TASK", ar: "مهمة", en: "Task" },
  { id: "SAMPLE_FOLLOW_UP", ar: "متابعة عيّنة", en: "Sample follow-up" },
];
/** The outcomes a rep reaches for first, as one-tap chips; the rest stay in «نتيجة أخرى». */
const QUICK_OUTCOMES = ["INTERESTED", "NO_ANSWER", "LEFT_MESSAGE", "FOLLOW_UP_REQUIRED", "NOT_INTERESTED"] as const;

/**
 * THE activity dialog (council fix round 1, P0-10): the customer page, «يومي» (✓, 📞, swipe right) and «＋ نشاط» all open
 * this one. `customerId` null = a deal with no customer (from «يومي»): it posts to the deal (POST /api/sales/activities).
 * A WhatsApp or an email starts at «تُركت رسالة» — nothing says the customer answered until the rep says so.
 */
export function ActivityDialog({ ar, customerId, customerName, deals, defaultDealId, initialKind = "CALL", onClose, onDone }: {
  ar: boolean; customerId: string | null; customerName?: string; deals: Pick<Deal, "id" | "title">[]; defaultDealId?: string | null;
  initialKind?: ActivityKind; onClose: () => void; onDone: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [kind, setKind] = useState<ActivityKind>(initialKind);
  const firstOutcome = (k: ActivityKind) => (k === "NOTE" ? "NOTE_ONLY" : k === "WHATSAPP" || k === "EMAIL" ? "LEFT_MESSAGE" : "INTERESTED");
  const [outcome, setOutcome] = useState(firstOutcome(initialKind));
  const [more, setMore] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [later, setLater] = useState(false);
  const [dealId, setDealId] = useState(defaultDealId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isTask = kind === "TASK";
  const isNote = kind === "NOTE";
  const kindWord = (k: ActivityKind) => { const x = KINDS.find((i) => i.id === k)!; return ar ? x.ar : x.en; };
  // The subject is optional for the rep: an empty one becomes «مكالمة — مقهى السدرة».
  const autoSubject = `${kindWord(kind)}${customerName ? ` — ${customerName}` : ""}`;
  const ready = (!isTask || !!dueAt) && (subject.trim().length >= 2 || autoSubject.length >= 2) && (!isNote || subject.trim().length >= 2);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const typed = subject.trim() || autoSubject;
    const res = await api(customerId ? `/api/customers/${customerId}/activities` : `/api/sales/activities`, {
      method: "POST",
      body: {
        type: kind,
        subject: typed,
        body, opportunityId: dealId || null,
        outcome: isTask ? undefined : isNote ? "NOTE_ONLY" : outcome,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        completed: isTask ? false : !later,
      },
    });
    setBusy(false);
    if (res.ok) onDone(); else setErr(errorOf(res.data as never, ar, L("تعذّر الحفظ.", "Could not save.")));
  }

  return (
    <Dialog open title={L("سجّل نشاط", "Log activity")} sub={customerName} onClose={onClose} testId="activity-dialog"
      actions={<>
        <button type="submit" form="acc-activity" className="hr-btn is-primary" disabled={!ready || busy} data-testid="save-activity">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-activity" className="hr-form" onSubmit={save}>
        <Err text={err} />
        <div className="is-wide" style={{ gridColumn: "1 / -1" }}>
          <div className="hr-label" id="act-kind-l">{L("وش سويت؟", "What did you do?")}</div>
          <div className="acc-chips" role="radiogroup" aria-labelledby="act-kind-l" data-testid="activity-type">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`acc-chip${kind === k.id ? " on" : ""}`}
                data-testid={`activity-kind-${k.id}`} data-value={k.id}
                onClick={() => { setKind(k.id); setOutcome(firstOutcome(k.id)); }}>
                {ar ? k.ar : k.en}
              </button>
            ))}
          </div>
        </div>
        {!isTask && !isNote ? (
          <div className="is-wide" style={{ gridColumn: "1 / -1" }}>
            <div className="hr-label" id="act-out-l">{L("وش صار؟", "What happened?")}</div>
            <div className="acc-chips" role="radiogroup" aria-labelledby="act-out-l" data-testid="activity-outcome">
              {QUICK_OUTCOMES.map((o) => (
                <button key={o} type="button" role="radio" aria-checked={outcome === o} className={`acc-chip${outcome === o ? " on" : ""}`}
                  data-testid={`activity-outcome-${o}`} onClick={() => setOutcome(o)}>{ar ? OUTCOME_LABELS[o].ar : OUTCOME_LABELS[o].en}</button>
              ))}
              <Select className="hr-select acc-chip-select" value={(QUICK_OUTCOMES as readonly string[]).includes(outcome) ? "" : outcome}
                onChange={(e) => { if (e.target.value) setOutcome(e.target.value); }} aria-label={L("نتيجة أخرى", "Another outcome")}>
                <option value="">{L("نتيجة أخرى…", "Another outcome…")}</option>
                {ACTIVITY_OUTCOMES.filter((o) => !(QUICK_OUTCOMES as readonly string[]).includes(o) && o !== "NOTE_ONLY").map((o) => <option key={o} value={o}>{ar ? OUTCOME_LABELS[o].ar : OUTCOME_LABELS[o].en}</option>)}
              </Select>
            </div>
          </div>
        ) : null}
        <Field label={isNote ? `${L("الملاحظة", "Note")} *` : L("ملاحظة قصيرة (اختياري)", "Short note (optional)")} wide>
          <input className="hr-input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} data-testid="activity-subject"
            placeholder={isNote ? "" : L("مثلًا: يبغون كولومبي للشتاء", "e.g. they want a Colombian for winter")} autoFocus />
        </Field>
        {deals.length > 0 ? (
          <Field label={L("الصفقة", "Deal")} help={L("اختياري", "Optional")}>
            <Select className="hr-select" value={dealId} onChange={(e) => setDealId(e.target.value)} data-testid="activity-deal">
              <option value="">{L("العميل فقط", "The customer only")}</option>
              {deals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
            </Select>
          </Field>
        ) : null}
        {!isTask ? (
          <label className="cu-check is-wide" style={{ gridColumn: "1 / -1" }}>
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} data-testid="activity-later" />
            {L("ما صار بعد — أبغى أذكّر نفسي", "Not done yet — remind me")}
          </label>
        ) : null}
        {isTask || later ? (
          <Field label={`${L("متى؟", "When?")}${isTask ? " *" : ""}`} help={isTask ? L("المهمة بلا موعد ما تظهر في المتأخرات.", "A task with no date never shows as overdue.") : undefined}>
            <input className="hr-input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} dir="ltr" data-testid="activity-due" />
          </Field>
        ) : null}
        {!isNote && !more && !body ? (
          <button type="button" className="hr-btn is-wide" style={{ gridColumn: "1 / -1", justifySelf: "start" }} onClick={() => setMore(true)} data-testid="activity-more">{L("+ أضف تفاصيل", "+ Add details")}</button>
        ) : null}
        {!isNote && (more || body) ? (
          <Field label={L("تفاصيل أكثر", "More details")} wide>
            <textarea className="hr-textarea" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        ) : null}
        <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>
          {L("هذا تسجيل لما صار. ما يرسل رسالة ولا بريد.", "This records what happened. It does not send a message or an email.")}
        </p>
      </form>
    </Dialog>
  );
}

/** Several open deals of yours with this customer: which one? One tap, the most recent first. */
export function DealPickDialog({ ar, purpose, deals, onClose, onPick }: {
  ar: boolean; purpose: "quote" | "sample";
  deals: { id: string; title: string; stageAr: string; stageEn: string; amount: string | null }[];
  onClose: () => void; onPick: (id: string) => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  return (
    <Dialog open title={purpose === "quote" ? L("عرض السعر على أي صفقة؟", "Which deal is the quotation for?") : L("العيّنة على أي صفقة؟", "Which deal is the sample for?")}
      sub={L("عندك أكثر من صفقة مفتوحة مع هذا العميل", "You have more than one open deal with this customer")} onClose={onClose} testId="deal-pick-dialog"
      actions={<button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>}>
      <ul className="acc-pick" role="list">
        {deals.map((d, i) => (
          <li key={d.id}>
            <button type="button" className={`acc-pick-row${i === 0 ? " first" : ""}`} onClick={() => onPick(d.id)} data-testid={`deal-pick-${d.id}`} autoFocus={i === 0}>
              <b><bdi>{d.title}</bdi></b>
              <small>{ar ? d.stageAr : d.stageEn}{d.amount && Number(d.amount) > 0 ? <> · <bdi className="n">{fmtMoney(d.amount)}</bdi> {L("ريال", "SAR")}</> : null}</small>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

// ── The customer's particulars and account details ────────────────────────────────────────
export function DetailsDialog({ ar, customer, canOwner, canCredit, onClose, onDone }: {
  // The account owner and the credit terms have their own duties (services/customers/account-guard.ts);
  // without them the fields are shown read-only and the server refuses a change anyway.
  ar: boolean; customer: Customer; canOwner: boolean; canCredit: boolean; onClose: () => void; onDone: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [f, setF] = useState({
    name: customer.name, nameAr: customer.nameAr ?? "", phone: customer.phone ?? "", email: customer.email ?? "",
    address: customer.address ?? "", whatsappOptOut: customer.whatsappOptOut, emailOptOut: customer.emailOptOut ?? false,
    commercialRegNo: customer.commercialRegNo ?? "", vatNumber: customer.vatNumber ?? "", segment: customer.segment ?? "",
    city: customer.city ?? "", priceList: customer.priceList ?? "",
    paymentTermsDays: customer.paymentTermsDays != null ? String(customer.paymentTermsDays) : "",
    creditLimit: customer.creditLimit ?? "", accountOwnerId: customer.accountOwner?.id ?? "",
    defaultHoldDays: customer.defaultHoldDays != null ? String(customer.defaultHoldDays) : "",
  });
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [emailErr, setEmailErr] = useState("");
  useEffect(() => {
    // The roster: id, name, role and active for anyone signed in (GET /api/employees).
    api<{ id: string; name: string; active: boolean }[]>("/api/employees").then((r) => {
      if (r.ok && Array.isArray(r.data)) setEmployees(r.data.filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name })));
    });
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || busy) return;
    setBusy(true); setErr(""); setEmailErr("");
    // Fix round 1 (council b25): the opt-outs are sent ONLY when changed here — saving another field never rewrites a
    // choice the customer (or a colleague) made since this dialog was opened.
    const { whatsappOptOut, emailOptOut, ...rest } = f;
    const body: Record<string, unknown> = { ...rest };
    if (whatsappOptOut !== customer.whatsappOptOut) body.whatsappOptOut = whatsappOptOut;
    if (emailOptOut !== (customer.emailOptOut ?? false)) body.emailOptOut = emailOptOut;
    const res = await api<{ field?: string }>(`/api/customers/${customer.id}`, { method: "PUT", body });
    setBusy(false);
    if (res.ok) return onDone();
    const msg = errorOf(res.data as never, ar, L("تعذّر الحفظ.", "Could not save."));
    if (res.data.field === "email") setEmailErr(msg); else setErr(msg);
  }

  return (
    <Dialog open title={L("بيانات العميل", "Customer details")} onClose={onClose} testId="details-dialog"
      actions={<>
        <button type="submit" form="acc-details" className="hr-btn is-primary" disabled={busy || !f.name.trim()} data-testid="save-details">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-details" className="hr-form" onSubmit={save}>
        <Err text={err} />
        <Field label={`${L("الاسم", "Name")} *`}><input className="hr-input" required value={f.name} onChange={set("name")} /></Field>
        <Field label={L("الاسم بالعربية", "Arabic name")}><input className="hr-input" dir="rtl" value={f.nameAr} onChange={set("nameAr")} /></Field>
        <Field label={L("الهاتف", "Phone")}><input className="hr-input" dir="ltr" style={{ textAlign: "start" }} value={f.phone} onChange={set("phone")} /></Field>
        <Field label={L("الإيميل", "Email")} error={emailErr || undefined} help={L("تروح له الإيميلات التلقائية (عروض الأسعار).", "Automated e-mails (quotations) go here.")}><input className="hr-input" dir="ltr" style={{ textAlign: "start" }} type="text" inputMode="email" value={f.email} onChange={set("email")} data-testid="details-email" /></Field>
        <Field label={L("التوصيل (العنوان)", "Delivery (address)")} wide><textarea className="hr-textarea" rows={2} value={f.address} onChange={set("address")} /></Field>
        <p className="cu-formsec is-wide">{L("الحساب", "Account")}</p>
        <Field label={L("الفئة", "Category")}>
          <Select className="hr-select" value={f.segment} onChange={set("segment")} data-testid="details-segment">
            <option value="">{L("غير محددة", "Not set")}</option>
            {Object.entries(SEGMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{ar ? v.ar : v.en}</option>)}
          </Select>
        </Field>
        <Field label={L("المدينة", "City")}><input className="hr-input" value={f.city} onChange={set("city")} maxLength={80} /></Field>
        <Field label={L("المسؤول", "Account owner")}>
          <Select className="hr-select" value={f.accountOwnerId} onChange={set("accountOwnerId")} disabled={!canOwner} data-testid="details-owner">
            <option value="">{L("بلا مسؤول", "None")}</option>
            {customer.accountOwner && !employees.some((x) => x.id === customer.accountOwner!.id) && <option value={customer.accountOwner.id}>{customer.accountOwner.name}</option>}
            {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <Field label={L("السجل التجاري", "Commercial registration")} help={L("10 أرقام", "10 digits")}>
          <input className="hr-input" dir="ltr" style={{ textAlign: "start" }} inputMode="numeric" value={f.commercialRegNo} onChange={set("commercialRegNo")} data-testid="details-cr" />
        </Field>
        <Field label={L("الرقم الضريبي", "VAT number")} help={L("15 رقمًا، يبدأ بـ 3 وينتهي بـ 3", "15 digits, starting and ending with 3")}>
          <input className="hr-input" dir="ltr" style={{ textAlign: "start" }} inputMode="numeric" value={f.vatNumber} onChange={set("vatNumber")} data-testid="details-vat" />
        </Field>
        <Field label={L("قائمة الأسعار", "Price list")} help={L("نص يصف الاتفاق، لا يغيّر أي سعر.", "Text recording the agreement; it changes no price.")}>
          <input className="hr-input" value={f.priceList} onChange={set("priceList")} maxLength={80} disabled={!canCredit} />
        </Field>
        <Field label={L("شروط الدفع (أيام)", "Payment terms (days)")}>
          <input className="hr-input" dir="ltr" inputMode="numeric" value={f.paymentTermsDays} onChange={set("paymentTermsDays")} disabled={!canCredit} data-testid="details-terms" />
        </Field>
        <Field label={L("حد الائتمان (ريال)", "Credit limit (SAR)")} help={L("تجاوزه يظهر تحذيرًا أحمر؛ إيقاف البيع قرار يدوي.", "Going over it shows a red warning; holding sales is a manual decision.")}>
          <input className="hr-input" dir="ltr" inputMode="decimal" value={f.creditLimit} onChange={set("creditLimit")} disabled={!canCredit} data-testid="details-credit" />
        </Field>
        <Field label={L("مدة الإيقاف الافتراضية (أيام)", "Default hold duration (days)")} help={L("تقترحها نافذة «إيقاف البيع»؛ فارغة = 14 يومًا.", "Proposed by the «Hold sales» dialog; empty = 14 days.")}>
          <input className="hr-input" dir="ltr" inputMode="numeric" value={f.defaultHoldDays} onChange={set("defaultHoldDays")} disabled={!canCredit} data-testid="details-hold-days" />
        </Field>
        <label className="cu-check is-wide">
          <input type="checkbox" checked={f.whatsappOptOut} onChange={set("whatsappOptOut")} />
          {L("لا يرغب برسائل واتساب من النظام", "Opted out of system WhatsApp messages")}
        </label>
        <label className="cu-check is-wide">
          <input type="checkbox" checked={f.emailOptOut} onChange={set("emailOptOut")} data-testid="details-email-optout" />
          {L("لا يرغب بإيميلات من النظام", "Opted out of system e-mails")}
        </label>
      </form>
    </Dialog>
  );
}

// ── A contact ─────────────────────────────────────────────────────────────────────────────
export function ContactDialog({ ar, customerId, contact, onClose, onDone }: {
  ar: boolean; customerId: string; contact: Contact | null; onClose: () => void; onDone: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [f, setF] = useState({ name: contact?.name ?? "", role: contact?.role ?? "", phone: contact?.phone ?? "", email: contact?.email ?? "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || busy) return;
    setBusy(true); setErr("");
    const res = contact
      ? await api(`/api/customers/${customerId}/contacts/${contact.id}`, { method: "PUT", body: f })
      : await api(`/api/customers/${customerId}/contacts`, { method: "POST", body: f });
    setBusy(false);
    if (res.ok) onDone(); else setErr(errorOf(res.data as never, ar, L("تعذّر الحفظ.", "Could not save.")));
  }
  async function remove() {
    if (!contact || busy) return;
    if (!confirm(L(`حذف ${contact.name} من جهات الاتصال؟`, `Remove ${contact.name} from the contacts?`))) return;
    setBusy(true);
    const res = await api(`/api/customers/${customerId}/contacts/${contact.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) onDone(); else setErr(errorOf(res.data as never, ar, L("تعذّر الحذف.", "Could not remove.")));
  }

  return (
    <Dialog open title={contact ? L("تعديل جهة اتصال", "Edit contact") : L("جهة اتصال جديدة", "New contact")} onClose={onClose} testId="contact-dialog"
      actions={<>
        <button type="submit" form="acc-contact" className="hr-btn is-primary" disabled={busy || !f.name.trim()} data-testid="save-contact">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
        {contact && <button type="button" className="hr-btn is-danger" onClick={remove} disabled={busy} data-testid="delete-contact">{L("حذف", "Remove")}</button>}
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-contact" className="hr-form" onSubmit={save}>
        <Err text={err} />
        <Field label={`${L("الاسم", "Name")} *`}><input className="hr-input" required value={f.name} onChange={set("name")} maxLength={120} data-testid="contact-name" /></Field>
        <Field label={L("الدور", "Role")}><input className="hr-input" value={f.role} onChange={set("role")} maxLength={80} placeholder={L("مدير المشتريات", "Purchasing manager")} data-testid="contact-role" /></Field>
        <Field label={L("الهاتف", "Phone")}><input className="hr-input" dir="ltr" style={{ textAlign: "start" }} value={f.phone} onChange={set("phone")} maxLength={40} data-testid="contact-phone" /></Field>
        <Field label={L("البريد", "Email")}><input className="hr-input" dir="ltr" style={{ textAlign: "start" }} type="email" value={f.email} onChange={set("email")} maxLength={160} /></Field>
      </form>
    </Dialog>
  );
}
