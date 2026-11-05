"use client";
// «عميل محتمل جديد» — the customer form for a lead (owner-approved Figma page 12, 5 Nov 2026): the same frame, fields and
// spacing as «إضافة عميل» (components/customers/new-customer-form.tsx): «بيانات المنشأة» (only «اسم المنشأة» required;
// the contact person, mobile and e-mail optional), the registration («السجل التجاري / الرقم الموحد», الرقم الضريبي) and
// the national address — the lead keeps them (migration 20261221090000_lead_identity) and the conversion copies them
// onto the customer. On top, an olive «تسجيل نشاط»: it saves the lead and opens the activity form on it
// (LogActivityPicker, step 2) — an activity needs a saved lead to belong to.
import { useEffect, useRef, useState } from "react";
import { Dialog, Field, HrRoot } from "@/components/hr/ui";
import { Ico } from "@/components/shell/icons";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { IdentityFields, blankIdentity, type IdentityForm } from "@/components/customers/identity-fields";
import "./lead-form.css";

export const LEAD_SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"] as const;
export type SavedLead = { id: string; companyName: string; companyNameAr: string | null };
type Dup = { leadId: string; companyName: string; contactName: string | null };

const blank = () => ({ companyName: "", companyNameAr: "", contactName: "", phone: "", email: "", source: "OTHER", notes: "" });

export function NewLeadDialog({ ar, sourceLabel, onClose, onSaved }: {
  ar: boolean;
  sourceLabel: (s: string) => string;
  onClose: () => void;
  /** After a save; `logActivity` — the save came from «تسجيل نشاط» (the caller opens the activity form). */
  onSaved: (lead: SavedLead, opts: { logActivity: boolean; weak: string[] }) => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [f, setF] = useState(blank());
  const [idf, setIdf] = useState<IdentityForm>(blankIdentity());
  const [busy, setBusy] = useState<null | "save" | "activity">(null);
  const [err, setErr] = useState<string | null>(null);
  const [dups, setDups] = useState<Dup[]>([]);
  // Which button the duplicate warning interrupted: «احفظه على أي حال» repeats THAT save.
  const [lastLog, setLastLog] = useState(false);
  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setF({ ...f, [k]: e.target.value });
    if (k === "companyName" || k === "phone") setDups([]);
  };
  const valid = f.companyName.trim().length >= 2;
  // The dialog focuses its first control (the close button); the business name is where typing starts.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = window.setTimeout(() => nameRef.current?.focus(), 0); return () => window.clearTimeout(t); }, []);

  async function save(logActivity: boolean, acknowledgeDuplicate = false) {
    if (!valid || busy) return;
    setBusy(logActivity ? "activity" : "save"); setErr(null); setLastLog(logActivity);
    try {
      const { nationalShortAddress, ...ident } = idf;
      const res = await fetch("/api/sales/leads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, companyNameAr: f.companyNameAr || null, ...ident, nationalShortAddress, acknowledgeDuplicate }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(d.duplicates)) { setDups(d.duplicates); return; }
      if (!res.ok) { setErr(localizeApiError(d, ar ? "ar" : "en") ?? (ar ? d.error : d.errorEn ?? d.error) ?? L("تعذّر الحفظ.", "Could not save.")); return; }
      const weak = Array.isArray(d.weakDuplicates) ? (d.weakDuplicates as { companyName: string }[]).map((w) => w.companyName) : [];
      onSaved({ id: d.lead.id, companyName: d.lead.companyName, companyNameAr: f.companyNameAr.trim() || null }, { logActivity, weak });
    } catch {
      setErr(L("تعذّر الاتصال — حاول مرة ثانية.", "Could not connect — try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <HrRoot>
      <Dialog open title={L("عميل محتمل جديد", "New lead")} onClose={() => { if (!busy) onClose(); }} testId="lead-form"
        actions={<>
          <button type="submit" form="new-lead-el" className="hr-btn is-primary" disabled={!valid || !!busy} data-testid="lead-save">{busy === "save" ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
          <button type="button" className="hr-btn" onClick={onClose} disabled={!!busy}>{L("إلغاء", "Cancel")}</button>
          <span className="lf-foot-hint">{L("المطلوب اسم المنشأة بس. لما يتحول لعميل تنتقل كل البيانات معه.", "Only the business name is required. Everything moves to the customer on conversion.")}</span>
        </>}>
        <form id="new-lead-el" className="hr-form lf" noValidate onSubmit={(e) => { e.preventDefault(); void save(false); }}>
          {err ? <p className="hr-err is-wide" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="lead-form-error">{err}</p> : null}
          {/* First in the DOM so the dialog focuses it; drawn under the activity bar (order). */}
          <p className="lf-h">{L("بيانات المنشأة", "Business")}</p>
          <Field label={`${L("اسم المنشأة", "Business name")} *`} wide>
            <input ref={nameRef} required value={f.companyName} onChange={set("companyName")} className="hr-input" maxLength={200} aria-required="true" data-testid="lead-company" />
          </Field>
          <div className="lf-act">
            <button type="button" className="lf-act-btn" disabled={!valid || !!busy} onClick={() => void save(true)} data-testid="lead-log-activity">
              <Ico name="plus" small />{busy === "activity" ? L("جارٍ الحفظ…", "Saving…") : L("تسجيل نشاط", "Log activity")}
            </button>
            <span>{valid ? L("يحفظ العميل المحتمل ويفتح تسجيل النشاط عليه (اتصال، زيارة، واتساب…)", "Saves the lead and opens the activity form on it (call, visit, WhatsApp…)")
              : L("اكتب اسم المنشأة أول، بعدها سجّل النشاط.", "Type the business name first, then log the activity.")}</span>
          </div>
          <Field label={L("الشخص المسؤول", "Contact person")}>
            <input value={f.contactName} onChange={set("contactName")} className="hr-input" maxLength={200} data-testid="lead-contact" />
          </Field>
          <Field label={L("الجوال", "Mobile")}>
            <input value={f.phone} onChange={set("phone")} className="hr-input" dir="ltr" inputMode="tel" style={{ textAlign: "start" }} placeholder="05xxxxxxxx" data-testid="lead-phone" />
          </Field>
          <Field label={L("البريد", "E-mail")}>
            <input type="email" value={f.email} onChange={set("email")} className="hr-input" dir="ltr" style={{ textAlign: "start" }} placeholder="name@cafe.com" data-testid="lead-email" />
          </Field>
          <Field label={L("المصدر", "Source")}>
            <select value={f.source} onChange={set("source")} className="hr-input" data-testid="lead-source">
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
            </select>
          </Field>
          <Field label={L("الاسم بالعربية", "Arabic name")} wide>
            <input value={f.companyNameAr} onChange={set("companyNameAr")} className="hr-input" dir="rtl" maxLength={200} data-testid="lead-companyAr" />
          </Field>
          <IdentityFields value={idf} onChange={setIdf} ar={ar} testPrefix="lead" />
          <Field label={L("ملاحظات", "Notes")} wide>
            <textarea value={f.notes} onChange={set("notes")} className="hr-input" rows={3} maxLength={2000} data-testid="lead-notes" />
          </Field>
          {dups.length ? (
            <div className="lf-dup" role="alert" data-testid="lead-duplicates">
              <b>{L("فيه عميل محتمل موجود بنفس رقم الجوال", "A lead with this mobile number already exists")}</b>
              <ul>{dups.map((d) => <li key={d.leadId}><bdi>{d.companyName}</bdi>{d.contactName ? <> — <bdi>{d.contactName}</bdi></> : null}</li>)}</ul>
              <button type="button" className="hr-btn" onClick={() => void save(lastLog, true)} data-testid="lead-save-anyway">{L("احفظه على أي حال", "Create anyway")}</button>
            </div>
          ) : null}
        </form>
      </Dialog>
    </HrRoot>
  );
}
