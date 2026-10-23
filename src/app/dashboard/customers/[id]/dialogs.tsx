"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, Field } from "@/components/hr/ui";
import { api } from "../../sales/_components/ui";
import { ACTIVITY_LABELS, OUTCOME_LABELS } from "@/components/d21/labels";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import type { Contact, Credit, Customer, Deal } from "./types";
import { CreditNoticeBody, type CreditState } from "@/components/credit/credit-ui";
import { DIRECT_UPLOAD_MAX_BYTES, pickUploadPath } from "@/lib/services/customers/direct-upload-rules";
import { directUpload } from "./direct-upload-client";

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
export function FileDialog({ ar, customerId, maxBytes = 5 * 1024 * 1024, direct = false, onClose, onDone }: { ar: boolean; customerId: string; maxBytes?: number; direct?: boolean; onClose: () => void; onDone: () => void }) {
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
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!file || busy) return;
    const path = pickUploadPath(file.size, { maxBytes, direct });
    if (path === "too-large") { setCanRetry(false); setErr(L(`الحد الأقصى لحجم الملف ${mb} ميغابايت.`, `Files are limited to ${mb} MB.`)); return; }
    setBusy(true); setErr(""); setCanRetry(false);
    if (path === "direct") {
      setProgress(0);
      const r = await directUpload({ customerId, file, category, title: title.trim(), onProgress: (p) => setProgress(Math.max(0, Math.min(100, Math.round(p)))) });
      setBusy(false);
      if (r.ok) { setProgress(100); onDone(); return; }
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
    if (res.ok) { onDone(); return; }
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
      </form>
    </Dialog>
  );
}

function Err({ text }: { text: string }) {
  return text ? <p className="hr-err is-wide" role="alert" data-testid="dialog-error" style={{ gridColumn: "1 / -1" }}>{text}</p> : null;
}

// ── «تسجيل نشاط» ─────────────────────────────────────────────────────────────────────────
export function ActivityDialog({ ar, customerId, deals, defaultDealId, onClose, onDone }: {
  ar: boolean; customerId: string; deals: Pick<Deal, "id" | "title">[]; defaultDealId?: string | null;
  onClose: () => void; onDone: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [type, setType] = useState("CALL");
  const [outcome, setOutcome] = useState("NOTE_ONLY");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [completed, setCompleted] = useState(true);
  const [dealId, setDealId] = useState(defaultDealId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isTask = type === "TASK";
  const ready = subject.trim().length >= 2 && (!isTask || !!dueAt);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const res = await api(`/api/customers/${customerId}/activities`, {
      method: "POST",
      body: {
        type, subject, body, opportunityId: dealId || null,
        outcome: isTask ? undefined : outcome,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        completed: isTask ? false : completed,
      },
    });
    setBusy(false);
    if (res.ok) onDone(); else setErr(errorOf(res.data as never, ar, L("تعذّر الحفظ.", "Could not save.")));
  }

  return (
    <Dialog open title={L("تسجيل نشاط", "Log activity")} onClose={onClose} testId="activity-dialog"
      actions={<>
        <button type="submit" form="acc-activity" className="hr-btn is-primary" disabled={!ready || busy} data-testid="save-activity">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-activity" className="hr-form" onSubmit={save}>
        <Err text={err} />
        <Field label={L("النوع", "Type")}>
          <Select className="hr-select" value={type} onChange={(e) => setType(e.target.value)} data-testid="activity-type">
            {Object.keys(ACTIVITY_LABELS).map((k) => <option key={k} value={k}>{ar ? ACTIVITY_LABELS[k].ar : ACTIVITY_LABELS[k].en}</option>)}
          </Select>
        </Field>
        {!isTask ? (
          <Field label={L("ماذا حدث؟", "What happened?")}>
            <Select className="hr-select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {ACTIVITY_OUTCOMES.map((o) => <option key={o} value={o}>{ar ? OUTCOME_LABELS[o].ar : OUTCOME_LABELS[o].en}</option>)}
            </Select>
          </Field>
        ) : <span />}
        <Field label={`${L("الموضوع", "Subject")} *`} wide>
          <input className="hr-input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} data-testid="activity-subject" />
        </Field>
        <Field label={L("التفاصيل", "Details")} wide>
          <textarea className="hr-textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label={L("الصفقة", "Deal")} help={L("اختياري: يُسجَّل على العميل وحده إن لم تُختر صفقة.", "Optional: without a deal it is recorded on the customer itself.")}>
          <Select className="hr-select" value={dealId} onChange={(e) => setDealId(e.target.value)} data-testid="activity-deal">
            <option value="">{L("العميل فقط", "The customer only")}</option>
            {deals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </Field>
        <Field label={`${L("موعد الاستحقاق", "Due")}${isTask ? " *" : ""}`} help={isTask ? L("المهمة بلا موعد لا تظهر في المتأخرات أبدًا.", "A task with no due date never appears as overdue.") : undefined}>
          <input className="hr-input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} dir="ltr" />
        </Field>
        {!isTask && (
          <label className="cu-check is-wide">
            <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
            {L("حدث بالفعل", "This already happened")}
          </label>
        )}
        <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>
          {L("هذا تسجيل لما حدث. لا يُرسل بريدًا ولا رسالة.", "This records that contact happened. It does not send an email or a message.")}
        </p>
      </form>
    </Dialog>
  );
}

// ── «عرض سعر»: a quotation belongs to a deal — pick an open one or open a new one ─────────
export function QuoteDialog({ ar, customer, openDeals, canCreateDeal, credit, creditState, onClose }: {
  ar: boolean; customer: Pick<Customer, "id" | "name" | "nameAr">; openDeals: Pick<Deal, "id" | "title" | "stage" | "amount">[];
  canCreateDeal: boolean; credit?: Credit | null; creditState?: CreditState | null; onClose: () => void;
}) {
  // «إيقاف البيع»: shown before submitting, and the action disabled (the server refuses 409 CUSTOMER_SALES_HOLD regardless).
  const held = !!creditState?.hold;
  const L = (a: string, e: string) => (ar ? a : e);
  const router = useRouter();
  const [choice, setChoice] = useState<string>(openDeals[0]?.id ?? (canCreateDeal ? "new" : ""));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!choice || busy) return;
    setErr("");
    let dealId = choice;
    if (choice === "new") {
      setBusy(true);
      const res = await api<{ opportunityId: string }>(`/api/customers/${customer.id}/deals`, { method: "POST", body: { title: title.trim() || undefined } });
      setBusy(false);
      if (!res.ok) { setErr(errorOf(res.data as never, ar, L("تعذّر فتح الصفقة.", "Could not open the deal."))); return; }
      dealId = res.data.opportunityId;
    }
    // The existing quotation flow: it raises a draft on the deal and opens its editor.
    router.push(`/dashboard/sales/quotes/new?opportunityId=${encodeURIComponent(dealId)}`);
  }

  const nothing = openDeals.length === 0 && !canCreateDeal;
  return (
    <Dialog open title={L("عرض سعر جديد", "New quotation")} sub={ar ? customer.nameAr ?? customer.name : customer.name} onClose={onClose} testId="quote-dialog"
      actions={<>
        <button type="submit" form="acc-quote" className="hr-btn is-primary" disabled={!choice || busy || nothing || held} data-testid="quote-continue">{busy ? L("جارٍ…", "Working…") : L("متابعة", "Continue")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-quote" className="hr-form" onSubmit={go}>
        <Err text={err} />
        <p className="hr-help is-wide" style={{ gridColumn: "1 / -1", margin: 0 }}>
          {L("عرض السعر يُنشأ من صفقة. اختر صفقة مفتوحة لهذا العميل أو افتح صفقة جديدة.", "A quotation is raised from a deal. Choose an open deal of this customer or open a new one.")}
        </p>
        {/* feat/credit-hold: the customer's warning (non-blocking) or its hold (blocking). */}
        {creditState ? <CreditNoticeBody c={creditState} ar={ar} testId="quote-credit" /> : null}
        {/* The credit limit is a warning, never a block (no owner rule refuses a quotation over it). */}
        {!creditState && credit?.over && (
          <p className="hr-err is-wide" role="note" style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="quote-credit-warning">
            {ar
              ? `تنبيه: الرصيد المستحق ${fmtMoney(credit.used)} ر.س يتجاوز حد الائتمان ${fmtMoney(credit.limit)} ر.س. يمكنك المتابعة؛ القرار لك.`
              : `Note: the balance due SAR ${fmtMoney(credit.used)} is above the credit limit SAR ${fmtMoney(credit.limit)}. You may continue; it is your call.`}
          </p>
        )}
        {nothing && (
          <p className="hr-err is-wide" style={{ gridColumn: "1 / -1" }} data-testid="quote-no-deal">
            {L("لا توجد صفقة مفتوحة يمكنك تسعيرها، ولا تملك صلاحية فتح صفقة (تحويل العملاء المحتملين).", "There is no open deal you can quote, and you may not open one (the lead-conversion permission).")}
          </p>
        )}
        <div className="is-wide" style={{ gridColumn: "1 / -1", display: "grid", gap: 8 }} role="radiogroup" aria-label={L("الصفقة", "Deal")}>
          {openDeals.map((d) => (
            <label key={d.id} className="cu-check" style={{ alignItems: "flex-start" }}>
              <input type="radio" name="deal" value={d.id} checked={choice === d.id} onChange={() => setChoice(d.id)} data-testid={`quote-deal-${d.id}`} />
              <span><b style={{ fontWeight: 500 }}>{d.title}</b><br /><span className="hr-help">{ar ? d.stage.nameAr : d.stage.nameEn}</span></span>
            </label>
          ))}
          {canCreateDeal && (
            <label className="cu-check">
              <input type="radio" name="deal" value="new" checked={choice === "new"} onChange={() => setChoice("new")} data-testid="quote-deal-new" />
              {L("صفقة جديدة لهذا العميل", "A new deal for this customer")}
            </label>
          )}
        </div>
        {choice === "new" && (
          <Field label={L("اسم الصفقة", "Deal name")} wide help={L("تبدأ في مرحلة التأهيل وتكون أنت مالكها.", "It starts in the Qualification stage, owned by you.")}>
            <input className="hr-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ar ? customer.nameAr ?? customer.name : customer.name} maxLength={200} data-testid="quote-deal-title" />
          </Field>
        )}
      </form>
    </Dialog>
  );
}

// ── The customer's particulars and account details ────────────────────────────────────────
export function DetailsDialog({ ar, customer, onClose, onDone }: {
  ar: boolean; customer: Customer; onClose: () => void; onDone: () => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [f, setF] = useState({
    name: customer.name, nameAr: customer.nameAr ?? "", phone: customer.phone ?? "", email: customer.email ?? "",
    address: customer.address ?? "", whatsappOptOut: customer.whatsappOptOut,
    commercialRegNo: customer.commercialRegNo ?? "", vatNumber: customer.vatNumber ?? "", segment: customer.segment ?? "",
    city: customer.city ?? "", priceList: customer.priceList ?? "",
    paymentTermsDays: customer.paymentTermsDays != null ? String(customer.paymentTermsDays) : "",
    creditLimit: customer.creditLimit ?? "", accountOwnerId: customer.accountOwner?.id ?? "",
    defaultHoldDays: customer.defaultHoldDays != null ? String(customer.defaultHoldDays) : "",
  });
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
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
    setBusy(true); setErr("");
    const res = await api(`/api/customers/${customer.id}`, { method: "PUT", body: f });
    setBusy(false);
    if (res.ok) onDone(); else setErr(errorOf(res.data as never, ar, L("تعذّر الحفظ.", "Could not save.")));
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
        <Field label={L("البريد", "Email")}><input className="hr-input" dir="ltr" style={{ textAlign: "start" }} type="email" value={f.email} onChange={set("email")} /></Field>
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
          <Select className="hr-select" value={f.accountOwnerId} onChange={set("accountOwnerId")} data-testid="details-owner">
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
          <input className="hr-input" value={f.priceList} onChange={set("priceList")} maxLength={80} />
        </Field>
        <Field label={L("شروط الدفع (أيام)", "Payment terms (days)")}>
          <input className="hr-input" dir="ltr" inputMode="numeric" value={f.paymentTermsDays} onChange={set("paymentTermsDays")} data-testid="details-terms" />
        </Field>
        <Field label={L("حد الائتمان (ر.س)", "Credit limit (SAR)")} help={L("تجاوزه يظهر تحذيرًا أحمر؛ إيقاف البيع قرار يدوي.", "Going over it shows a red warning; holding sales is a manual decision.")}>
          <input className="hr-input" dir="ltr" inputMode="decimal" value={f.creditLimit} onChange={set("creditLimit")} data-testid="details-credit" />
        </Field>
        <Field label={L("مدة الإيقاف الافتراضية (أيام)", "Default hold duration (days)")} help={L("تقترحها نافذة «إيقاف البيع»؛ فارغة = 14 يومًا.", "Proposed by the «Hold sales» dialog; empty = 14 days.")}>
          <input className="hr-input" dir="ltr" inputMode="numeric" value={f.defaultHoldDays} onChange={set("defaultHoldDays")} data-testid="details-hold-days" />
        </Field>
        <label className="cu-check is-wide">
          <input type="checkbox" checked={f.whatsappOptOut} onChange={set("whatsappOptOut")} />
          {L("لا يرغب برسائل واتساب من النظام", "Opted out of system WhatsApp messages")}
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
