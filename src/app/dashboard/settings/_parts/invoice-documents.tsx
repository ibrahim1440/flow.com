"use client";

// Settings › Invoicing & tax › «الفواتير الضريبية» (sales invoicing A2): the series prefixes, the invoicing point,
// the default payment terms and the seller's structured national address (printed on, and frozen into, every issued
// invoice — ZATCA BR-KSA-09). GET / PUT /api/sales/invoices/settings (PUT: the admin role, step-up, audited).
import { useEffect, useState } from "react";
import { useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Sec } from "../../_components/tools-ui";

type S = {
  invoicePrefix: string; creditNotePrefix: string; debitNotePrefix: string; invoicingPoint: "MANUAL" | "ON_DELIVERY"; defaultTermsDays: number;
  address: Record<string, string | null>; sellerReady: boolean; seller: { name: string | null; vatNumber: string | null }; can: { edit: boolean };
};
const ADDR: [string, string, string][] = [["sellerBuildingNo", "رقم المبنى", "Building no."], ["sellerStreet", "الشارع", "Street"], ["sellerDistrict", "الحي", "District"], ["sellerCity", "المدينة", "City"], ["sellerPostalCode", "الرمز البريدي", "Postal code"], ["sellerAdditionalNo", "الرقم الإضافي", "Additional no."]];

export function InvoiceDocumentsSettings() {
  const L = useL();
  const [s, setS] = useState<S | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/sales/invoices/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: S | null) => {
      if (!j) return;
      setS(j);
      setForm({ invoicePrefix: j.invoicePrefix, creditNotePrefix: j.creditNotePrefix, debitNotePrefix: j.debitNotePrefix, invoicingPoint: j.invoicingPoint, defaultTermsDays: String(j.defaultTermsDays), ...Object.fromEntries(Object.entries(j.address).map(([k, v]) => [k, v ?? ""])) });
    }).catch(() => undefined);
  }, []);
  if (!s) return null;
  const f = (k: string, ar: string, en: string, mono = false) => (
    <label className="hr-field"><span className="hr-label">{L(ar, en)}</span>
      <input className="hr-input" style={mono ? { direction: "ltr", fontFamily: "var(--hr-mono)" } : undefined} value={form[k] ?? ""} disabled={!s.can.edit} onChange={(e) => setForm({ ...form, [k]: e.target.value })} data-testid={`inv-setting-${k}`} /></label>
  );
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/sales/invoices/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "danger", text: localizeApiError(j) ?? `HTTP ${r.status}` }); return; }
      setS(j); setMsg({ tone: "success", text: L("حُفظت إعدادات الفواتير.", "Invoice settings saved.") });
    } finally { setBusy(false); }
  };
  return (
    <Sec title={L("الفواتير الضريبية", "Tax invoices")} caption={L("بادئات الترقيم · نقطة الفوترة · مدة السداد · العنوان الوطني للمنشأة", "Number prefixes · invoicing point · payment terms · the seller's national address")} testId="invoice-documents">
      {!s.sellerReady ? <div className="hr-notice tone-warning" role="note">{L("لا تصدر فاتورة قبل إدخال الاسم القانوني والرقم الضريبي للمنشأة في «المنشأة».", "No invoice issues before the seller's legal name and VAT number are entered on «Organisation».")}</div> : null}
      <div className="acct-row" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {f("invoicePrefix", "بادئة الفواتير", "Invoice prefix", true)}
        {f("creditNotePrefix", "بادئة الإشعارات الدائنة", "Credit note prefix", true)}
        {f("debitNotePrefix", "بادئة الإشعارات المدينة", "Debit note prefix", true)}
        <label className="hr-field"><span className="hr-label">{L("نقطة الفوترة", "Invoicing point")}</span>
          <Select value={form.invoicingPoint ?? "MANUAL"} disabled={!s.can.edit} onChange={(e) => setForm({ ...form, invoicingPoint: e.target.value })} data-testid="inv-setting-point">
            <option value="MANUAL">{L("يدويًا (من الطلب أو فاتورة يدوية)", "Manual (from the order or a manual invoice)")}</option>
            <option value="ON_DELIVERY">{L("عند التسليم (تُفتح مسودة تلقائيًا)", "On delivery (a draft opens automatically)")}</option>
          </Select></label>
        {f("defaultTermsDays", "مدة السداد الافتراضية (يوم)", "Default payment terms (days)", true)}
      </div>
      <p className="tl-sub">{L("الرقم يُعطى عند الإصدار بالتسلسل دون فجوات لكل بادئة (INV-000001). تغيير البادئة يبدأ سلسلة جديدة.", "Numbers are given at issue, gapless per prefix (INV-000001). A new prefix starts a new series.")}</p>
      <h3 style={{ margin: "8px 0 0", fontSize: 14 }}>{L("العنوان الوطني للمنشأة", "Seller national address")}</h3>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{ADDR.map(([k, ar, en]) => <span key={k}>{f(k, ar, en, k !== "sellerStreet" && k !== "sellerDistrict" && k !== "sellerCity")}</span>)}</div>
      {msg ? <div className={`hr-notice tone-${msg.tone}`} role={msg.tone === "danger" ? "alert" : "status"}>{msg.text}</div> : null}
      {s.can.edit ? <div className="tl-acts"><button type="button" className="hr-btn is-primary" disabled={busy} onClick={save} data-testid="inv-settings-save">{L("حفظ", "Save")}</button></div> : null}
    </Sec>
  );
}
