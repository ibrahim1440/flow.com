"use client";
// Settings › Invoicing & tax («الفوترة والضرائب» in the settings navigation of GX F-P01 1205:2).
// Settings only: nothing here issues, signs or submits an invoice — e-invoicing (ZATCA) is a later
// batch. No Figma frame draws this page; it holds the VAT figure the system already used as a
// constant (the 15% a new quotation line starts with) and shows the registration numbers the
// documents print, which are edited once, on «المنشأة», in the label-column sections of F-P01.
// GET / PUT /api/settings/invoicing (admin role, step-up, audited).
import Link from "next/link";
import { useEffect, useState } from "react";
import { OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { Sec, SettingsFrame } from "../../_components/tools-ui";
import { SingleSetting } from "../_parts/single-setting";
import { InvoiceDocumentsSettings } from "../_parts/invoice-documents";
import "../_parts/sections.css";

type Inv = {
  defaultVatPercent: string | null; effectiveDefaultVatPercent: string; isDefault: boolean; range: { default: number };
  sampleVatAlertSar: string | null; effectiveSampleVatAlertSar: string;
  registration: { vatNumber: string | null; crNumber: string | null }; can: { edit: boolean };
};

export default function InvoicingSettingsPage() {
  const L = useL();
  const [s, setS] = useState<Inv | null>(null);
  const [failed, setFailed] = useState(false);
  useD21Phone({ title: L("الفوترة والضرائب", "Invoicing & tax"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" });
  useEffect(() => {
    fetch("/api/settings/invoicing", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setS).catch(() => setFailed(true));
  }, []);
  const notSet = <span className="ss-muted">{L("غير مُدخل", "Not entered")}</span>;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("الفوترة والضرائب", "Invoicing & tax")} />
        <p className="tl-sub">{L("إعدادات النظام", "System settings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>
        {failed ? <div className="hr-notice tone-danger" role="alert">{L("تعذّر التحميل.", "Could not load.")}</div> : !s ? <OpsLoading rows={4} /> : (
          <div data-testid="invoicing-settings">
            <Sec title={L("ضريبة القيمة المضافة", "VAT")} caption={L("النسبة التي يبدأ بها كل بند جديد في عرض السعر · البنود القائمة والمستندات الصادرة تحتفظ بنسبتها", "The rate each new quotation line starts with · existing lines and issued documents keep theirs")} testId="vat-default">
              <SingleSetting
                url="/api/settings/invoicing" field="defaultVatPercent" testId="vat-default"
                stored={s.defaultVatPercent} effective={s.effectiveDefaultVatPercent} isDefault={s.isDefault} canEdit={s.can.edit}
                label={L("النسبة الافتراضية للبند الجديد", "Default rate of a new line")}
                help={L(`فارغ = الافتراضي ${s.range.default}%`, `Empty = the default ${s.range.default}%`)}
                unit="%"
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. البنود الجديدة في عروض الأسعار تبدأ بنسبة ${String(j.effectiveDefaultVatPercent)}%.`, `Saved. New quotation lines start at ${String(j.effectiveDefaultVatPercent)}%.`)}
              />
            </Sec>
            {/* D22 (owner-approved, 11 Nov 2026): «حد تنبيه ضريبة العيّنات» — an alert for holders of sales › samples_vat_alert. */}
            <Sec title={L("حد العيّنات المجانية", "Free samples alert")} caption={L("لما تتعدى عيّنات عميل هالحد في السنة الميلادية (بسعر القائمة قبل الضريبة)، يطلع التنبيه لمن عنده «تنبيه ضريبة العيّنات» · تأكد من الحد والقاعدة في zatca.gov.sa — تنبيه للمتابعة، مو حساب ضريبة", "When a customer's samples in the calendar year pass this (list price before VAT), holders of «samples VAT alert» are alerted · check the rule on zatca.gov.sa — an alert, not a tax computation")} testId="sample-vat-alert">
              <SingleSetting
                url="/api/settings/invoicing" field="sampleVatAlertSar" testId="sample-vat-alert"
                stored={s.sampleVatAlertSar} effective={s.effectiveSampleVatAlertSar} isDefault={s.sampleVatAlertSar === null} canEdit={s.can.edit}
                label={L("الحد لكل عميل في السنة", "Per customer per year")}
                help={L("فارغ = الافتراضي 200", "Empty = the default 200")}
                unit="⃁"
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. التنبيه فوق ${String(j.effectiveSampleVatAlertSar)} ⃁ لكل عميل في السنة.`, `Saved. The alert is above SAR ${String(j.effectiveSampleVatAlertSar)} per customer per year.`)}
              />
            </Sec>
            <Sec title={L("التسجيل الضريبي", "Tax registration")} caption={L("يُعدَّل في «المنشأة» ويُطبع في المستندات", "Edited on «Organisation» and printed on the documents")} testId="tax-registration">
              <dl className="ss-kv is-wide">
                <dt>{L("الرقم الضريبي", "VAT number")}</dt><dd>{s.registration.vatNumber ? <bdi className="hr-num">{s.registration.vatNumber}</bdi> : notSet}</dd>
                <dt>{L("الرقم الوطني الموحد (السجل التجاري)", "Unified national number (CR)")}</dt><dd>{s.registration.crNumber ? <bdi className="hr-num">{s.registration.crNumber}</bdi> : notSet}</dd>
              </dl>
              <div className="tl-acts"><Link href="/dashboard/settings" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("تعديل في «المنشأة»", "Edit on «Organisation»")}</Link></div>
            </Sec>
            <InvoiceDocumentsSettings />
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
