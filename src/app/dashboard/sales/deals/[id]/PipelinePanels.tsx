"use client";

import { useState } from "react";
import { Modal, Button, Field, TextArea, Select, api } from "../../_components/ui";
import { QualificationFields, draftFromLead, type QualificationDraft } from "../../_components/QualificationFields";
import { BUSINESS_TYPE_LABELS, QUALIFICATION_FIELD_LABELS, qualificationMissing, LOST_REASON_CODES, LOST_REASON_LABELS, type BusinessType } from "@/lib/services/sales/needs";
import type { StageAction } from "@/lib/services/sales/stage-actions";

/**
 * The deal page's pipeline pieces (migration 20261204100000_pipeline_qualification;
 * docs/sales/PIPELINE_STAGES.md): the needs analysis of the Qualified Opportunity stage, the
 * documented skip of Sample Evaluation, a sample's evaluation, and the words of the stage's one
 * primary action. Kept out of page.tsx so the page only gains the wiring.
 */

export type Needs = {
  businessType: string | null;
  needSummary: string | null;
  expectedMonthlyKg: string | null;
  agreedNextStep: string | null;
};

/** The label of the stage's primary action (`stagePrimaryAction`), in the page's language. */
export function actionLabel(a: StageAction, ar: boolean, nextStageName?: string): string {
  switch (a.key) {
    case "RECORD_NEEDS": return ar ? "تسجيل تحليل الاحتياج" : "Record the needs";
    case "RECORD_SAMPLE": return ar ? "تسجيل عيّنة" : "Record a sample";
    case "SEND_SAMPLE": return ar ? "تعليم العيّنة مُرسلة" : "Mark the sample sent";
    case "RECORD_SAMPLE_EVALUATION": return ar ? "تسجيل تقييم العيّنة" : "Record the sample evaluation";
    case "SKIP_SAMPLES": return ar ? "تخطّي العيّنات" : "Skip samples";
    case "CREATE_QUOTE": return ar ? "إنشاء عرض سعر" : "Create a quotation";
    case "FOLLOW_QUOTE": return ar ? "متابعة عرض السعر" : "Follow the quotation";
    case "REQUEST_APPROVAL": return ar ? "طلب اعتماد الخصم" : "Get the discount approved";
    case "RECORD_NEGOTIATION": return ar ? "تسجيل نتيجة التفاوض" : "Record the negotiation result";
    case "WIN": return ar ? "توثيق الربح" : "Mark won";
    case "DOCUMENT_LOSS": return ar ? "توثيق سبب الخسارة" : "Record the loss reason";
    case "ADVANCE": return nextStageName ? (ar ? `التالي: ${nextStageName}` : `Next: ${nextStageName}`) : (ar ? "المرحلة التالية" : "Next stage");
  }
}

/**
 * «تحليل الاحتياج» — compact: what is known, what the minimum still lacks, and «تعديل».
 * A detail of the Qualified Opportunity stage, shown on the deal whatever stage it is in.
 */
export function NeedsBlock({ ar, needs, canEdit, onEdit }: { ar: boolean; needs: Needs; canEdit: boolean; onEdit: () => void }) {
  const missing = qualificationMissing(needs);
  const bt = needs.businessType && needs.businessType in BUSINESS_TYPE_LABELS ? BUSINESS_TYPE_LABELS[needs.businessType as BusinessType] : null;
  const notSet = <span style={{ color: "var(--text-muted)" }}>{ar ? "غير محدد" : "Not set"}</span>;
  return (
    <div data-testid="deal-needs" style={{ maxWidth: 628, marginBottom: 22 }}>
      <div className="bh">
        <h2 className="bt">{ar ? "تحليل الاحتياج" : "Needs analysis"}</h2>
        {missing.length > 0 && (
          <span className="sub" style={{ color: "var(--status-warning)" }}>
            {ar ? `ينقص ${missing.length} من الحد الأدنى` : `${missing.length} of the minimum missing`}
          </span>
        )}
        {canEdit && (
          <button type="button" className="lk-inline" data-testid="edit-needs" onClick={onEdit}>{ar ? "تعديل" : "Edit"}</button>
        )}
      </div>
      <dl className="props" style={{ gridTemplateColumns: "160px minmax(0,1fr)" }}>
        <dt>{ar ? QUALIFICATION_FIELD_LABELS.businessType.ar : QUALIFICATION_FIELD_LABELS.businessType.en}</dt>
        <dd>{bt ? (ar ? bt.ar : bt.en) : notSet}</dd>
        <dt>{ar ? QUALIFICATION_FIELD_LABELS.needSummary.ar : QUALIFICATION_FIELD_LABELS.needSummary.en}</dt>
        <dd>{needs.needSummary ? <bdi>{needs.needSummary}</bdi> : notSet}</dd>
        <dt>{ar ? "الكمية الشهرية المتوقعة" : "Expected monthly volume"}</dt>
        <dd>{needs.expectedMonthlyKg !== null ? <><span className="n">{Number(needs.expectedMonthlyKg)}</span> {ar ? "كغ" : "kg"}</> : notSet}</dd>
        <dt>{ar ? QUALIFICATION_FIELD_LABELS.nextStep.ar : QUALIFICATION_FIELD_LABELS.nextStep.en}</dt>
        <dd>{needs.agreedNextStep ? <bdi>{needs.agreedNextStep}</bdi> : notSet}</dd>
      </dl>
    </div>
  );
}

/** Edit the needs (PATCH /api/sales/opportunities/[id]/needs). */
export function NeedsDialog({ ar, dealId, needs, onClose, onDone }: {
  ar: boolean; dealId: string; needs: Needs; onClose: () => void; onDone: () => void;
}) {
  const [draft, setDraft] = useState<QualificationDraft>(() => draftFromLead(needs));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    setBusy(true); setErr("");
    const res = await api(`/api/sales/opportunities/${dealId}/needs`, {
      method: "PATCH",
      // Every key is sent: an emptied field clears the stored answer here (unlike the activity form).
      body: { businessType: draft.businessType || null, needSummary: draft.needSummary, expectedMonthlyKg: draft.expectedMonthlyKg, agreedNextStep: draft.nextStep },
    });
    setBusy(false);
    if (!res.ok) { setErr(res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
    onDone();
  }
  return (
    <Modal title={ar ? "تحليل الاحتياج" : "Needs analysis"} onClose={onClose} testId="needs-dialog"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
        <Button disabled={busy} onClick={save} testId="save-needs">{ar ? "حفظ" : "Save"}</Button>
      </>}>
      {err && <p className="notice er" role="alert">{err}</p>}
      <QualificationFields ar={ar} value={draft} onChange={setDraft} missing={qualificationMissing({
        businessType: draft.businessType, needSummary: draft.needSummary, agreedNextStep: draft.nextStep,
      })} idPrefix="deal-needs" disabled={busy} />
    </Modal>
  );
}

/**
 * Skip Sample Evaluation with the reason (POST …/transition `{ toStageId, skipReason }`). The
 * reason is stored on the stage event and shown in the deal's history.
 */
export function SkipSamplesDialog({ ar, busy, targetName, onClose, onSubmit }: {
  ar: boolean; busy: boolean; targetName: string; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal title={ar ? "تخطّي تجربة العيّنات" : "Skip the sample evaluation"} onClose={onClose} testId="skip-samples-dialog"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
        <Button disabled={busy || reason.trim().length < 2} onClick={() => onSubmit(reason.trim())} testId="confirm-skip-samples">
          {ar ? `التخطّي والانتقال إلى ${targetName}` : `Skip and move to ${targetName}`}
        </Button>
      </>}>
      <Field id="skip-reason" label={ar ? "لماذا لا يحتاج العميل عيّنة؟" : "Why does the customer not need a sample?"} required
        hint={ar ? "مثال: يعرف المنتج من طلبات سابقة. يُحفظ السبب في سجل الصفقة." : "e.g. knows the product from earlier orders. Kept in the deal's history."}>
        <TextArea id="skip-reason" value={reason} onChange={setReason} rows={3} />
      </Field>
    </Modal>
  );
}

/** The coded loss reason, beside the free text of the lost dialog. */
export function LostReasonCodeSelect({ ar, value, onChange }: { ar: boolean; value: string; onChange: (v: string) => void }) {
  return (
    <Field id="lost-reason-code" label={ar ? "سبب الخسارة الرئيسي" : "Main reason"}>
      <Select id="lost-reason-code" value={value} onChange={onChange}>
        <option value="">{ar ? "— اختر —" : "— choose —"}</option>
        {LOST_REASON_CODES.map((c) => <option key={c} value={c}>{ar ? LOST_REASON_LABELS[c].ar : LOST_REASON_LABELS[c].en}</option>)}
      </Select>
    </Field>
  );
}
