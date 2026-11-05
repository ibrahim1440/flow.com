"use client";
// «إضافة عميل» — ONE form for every place a customer is created (owner decision, 5 Nov 2026): the customers list and
// the quotation's customer picker (and whatever opens it next). Name is the only required field; the registration
// numbers (VAT, «السجل التجاري / الرقم الموحد» as one field) and the national address — the customer's one address —
// are optional and checked by the server (POST /api/customers, unchanged rules: 400 with an Arabic message, 409
// DUPLICATE_CUSTOMER that never names the other customer). A rep registering gets the same form; the server makes them
// the account owner.
import { useState } from "react";
import { Dialog, Field, HrRoot } from "@/components/hr/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { IdentityFields, blankIdentity, type IdentityForm } from "./identity-fields";

export type CreatedCustomer = { id: string; name: string; nameAr: string | null; phone: string | null; city: string | null };

const blankContact = () => ({ name: "", nameAr: "", phone: "", email: "", whatsappOptOut: false });

export function NewCustomerDialog({ open, ar, onClose, onCreated, initialName }: {
  open: boolean; ar: boolean; onClose: () => void; onCreated: (c: CreatedCustomer) => void; initialName?: string;
}) {
  if (!open) return null;
  return <NewCustomerForm ar={ar} onClose={onClose} onCreated={onCreated} initialName={initialName} />;
}

function NewCustomerForm({ ar, onClose, onCreated, initialName }: { ar: boolean; onClose: () => void; onCreated: (c: CreatedCustomer) => void; initialName?: string }) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [f, setF] = useState({ ...blankContact(), name: initialName ?? "" });
  const [idf, setIdf] = useState<IdentityForm>(blankIdentity());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  const set = (k: "name" | "nameAr" | "phone" | "email") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !f.name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, ...idf }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr({ text: localizeApiError(d, ar ? "ar" : "en") || (ar ? d.error : d.errorEn) || L("تعذّر الحفظ.", "Could not save."), field: d.field }); return; }
      onCreated({ id: d.id, name: d.name, nameAr: d.nameAr ?? null, phone: d.phone ?? null, city: d.city ?? null });
    } catch {
      setErr({ text: L("تعذّر الاتصال — حاول مرة ثانية.", "Could not connect — try again.") });
    } finally {
      setBusy(false);
    }
  }

  // Wrapped in HrRoot: the hr form styles apply wherever the form opens (the quotation pages are not an HR page).
  return (
    <HrRoot>
    <Dialog open title={L("إضافة عميل", "Add customer")} onClose={onClose} testId="customer-form"
      actions={<>
        <button type="submit" form="new-customer-el" className="hr-btn is-primary" disabled={busy || !f.name.trim()} data-testid="cf-save">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="new-customer-el" onSubmit={save} className="hr-form" noValidate>
        {err ? <p className="hr-err is-wide" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="cf-error">{err.text}</p> : null}
        <Field label={`${L("اسم العميل", "Customer name")} *`} wide>
          <input required autoFocus value={f.name} onChange={set("name")} className="hr-input" maxLength={200} data-testid="cf-name" />
        </Field>
        <Field label={L("الاسم بالعربية (اختياري)", "Arabic name (optional)")} wide>
          <input value={f.nameAr} onChange={set("nameAr")} className="hr-input" dir="rtl" maxLength={200} data-testid="cf-nameAr" />
        </Field>
        <Field label={L("الهاتف", "Phone")}>
          <input value={f.phone} onChange={set("phone")} className="hr-input" dir="ltr" inputMode="tel" style={{ textAlign: "start" }} placeholder="05xxxxxxxx" data-testid="cf-phone" />
        </Field>
        <Field label={L("البريد الإلكتروني", "Email")}>
          <input type="email" value={f.email} onChange={set("email")} className="hr-input" dir="ltr" style={{ textAlign: "start" }} placeholder="name@cafe.com" data-testid="cf-email" />
        </Field>
        <IdentityFields value={idf} onChange={setIdf} ar={ar} testPrefix="cf" />
        <label style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer" }}>
          <input type="checkbox" style={{ width: 16, height: 16, flex: "none" }} checked={f.whatsappOptOut} onChange={(e) => setF({ ...f, whatsappOptOut: e.target.checked })} data-testid="customer-whatsapp-optout" />
          {L("لا يرغب برسائل واتساب من النظام", "Does not want WhatsApp messages from the system")}
        </label>
      </form>
    </Dialog>
    </HrRoot>
  );
}
