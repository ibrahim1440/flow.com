"use client";

import { Field, TextInput, Select, TextArea } from "./ui";
import {
  BUSINESS_TYPES, BUSINESS_TYPE_LABELS, QUALIFICATION_FIELD_LABELS, type QualificationField,
} from "@/lib/services/sales/needs";

/**
 * The qualification minimum as form fields — the ONE control behind every activity form that can
 * qualify a lead (the lead page here; the workspace's «تسجيل النتيجة» and LogActivityPicker reuse
 * it). Migration 20261204100000_pipeline_qualification; the rule is in services/sales/qualification.ts.
 *
 * Wiring, wherever an activity is logged on a LEAD with a qualifying outcome:
 *   1. render <QualificationFields value={draft} onChange={setDraft} ar={ar} /> under the outcome
 *      (prefill `draft` from the lead's stored businessType / needSummary / expectedMonthlyKg /
 *      agreedNextStep with `draftFromLead`, so known answers are not asked again);
 *   2. send `qualification: qualificationPayload(draft)` in the POST /api/sales/activities body;
 *   3. if the response's `qualification.converted === false`, keep the form open, pass
 *      `missing={qualification.missing}` (those fields are marked required), and on submit call
 *      POST /api/sales/leads/<leadId>/qualify with `{ activityId: <response.activity.id>,
 *      qualification: qualificationPayload(draft) }` — this completes THAT activity's
 *      qualification instead of logging a second one. Its response has the same `qualification`.
 *
 * Purely presentational: no request, no state of its own.
 */
export type QualificationDraft = {
  businessType: string;
  needSummary: string;
  expectedMonthlyKg: string;
  nextStep: string;
};

export const EMPTY_QUALIFICATION: QualificationDraft = { businessType: "", needSummary: "", expectedMonthlyKg: "", nextStep: "" };

/** A draft prefilled from what a lead (or deal) already holds. */
export function draftFromLead(l: {
  businessType?: string | null; needSummary?: string | null;
  expectedMonthlyKg?: string | number | null; agreedNextStep?: string | null;
} | null | undefined): QualificationDraft {
  return {
    businessType: l?.businessType ?? "",
    needSummary: l?.needSummary ?? "",
    expectedMonthlyKg: l?.expectedMonthlyKg === null || l?.expectedMonthlyKg === undefined ? "" : String(Number(l.expectedMonthlyKg)),
    nextStep: l?.agreedNextStep ?? "",
  };
}

/** The request's `qualification`: answered fields only, or undefined when nothing was answered. */
export function qualificationPayload(d: QualificationDraft): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (d.businessType) out.businessType = d.businessType;
  if (d.needSummary.trim()) out.needSummary = d.needSummary.trim();
  if (d.expectedMonthlyKg.trim()) out.expectedMonthlyKg = d.expectedMonthlyKg.trim();
  if (d.nextStep.trim()) out.nextStep = d.nextStep.trim();
  return Object.keys(out).length ? out : undefined;
}

/** «ينقص: نوع النشاط، الاحتياج» — what the server said is missing, in words. */
export function missingText(missing: readonly string[], ar: boolean): string {
  const names = missing.map((m) => {
    const l = QUALIFICATION_FIELD_LABELS[m as QualificationField];
    return l ? (ar ? l.ar : l.en) : m;
  });
  return ar ? `لم تتحوّل إلى فرصة بعد. ينقص: ${names.join("، ")}.` : `Not a qualified opportunity yet. Missing: ${names.join(", ")}.`;
}

export function QualificationFields({
  ar, value, onChange, missing, idPrefix = "qual", disabled,
}: {
  ar: boolean;
  value: QualificationDraft;
  onChange: (next: QualificationDraft) => void;
  /** Fields the server reported missing: marked required. */
  missing?: readonly string[];
  idPrefix?: string;
  disabled?: boolean;
}) {
  const set = (k: keyof QualificationDraft) => (v: string) => onChange({ ...value, [k]: v });
  const req = (k: string) => !!missing?.includes(k);
  const L = (k: keyof typeof QUALIFICATION_FIELD_LABELS) => (ar ? QUALIFICATION_FIELD_LABELS[k].ar : QUALIFICATION_FIELD_LABELS[k].en);
  return (
    <div className="space-y-2" data-testid={`${idPrefix}-fields`}>
      <Field id={`${idPrefix}-businessType`} label={L("businessType")} required={req("businessType")}>
        <Select id={`${idPrefix}-businessType`} value={value.businessType} onChange={set("businessType")} disabled={disabled}>
          <option value="">{ar ? "— اختر —" : "— choose —"}</option>
          {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{ar ? BUSINESS_TYPE_LABELS[t].ar : BUSINESS_TYPE_LABELS[t].en}</option>)}
        </Select>
      </Field>
      <Field id={`${idPrefix}-needSummary`} label={L("needSummary")} required={req("needSummary")}
        hint={ar ? "مثال: بن مختص لمقهى، توريد أسبوعي" : "e.g. specialty beans for a café, weekly supply"}>
        <TextArea id={`${idPrefix}-needSummary`} value={value.needSummary} onChange={set("needSummary")} rows={2} disabled={disabled} />
      </Field>
      <Field id={`${idPrefix}-expectedMonthlyKg`} label={L("expectedMonthlyKg")} hint={ar ? "اختياري" : "Optional"}>
        <TextInput id={`${idPrefix}-expectedMonthlyKg`} value={value.expectedMonthlyKg} onChange={set("expectedMonthlyKg")} inputMode="decimal" disabled={disabled} />
      </Field>
      <Field id={`${idPrefix}-nextStep`} label={L("nextStep")} required={req("nextStep")}
        hint={ar ? "مثال: إرسال عيّنة يوم الأحد" : "e.g. send a sample on Sunday"}>
        <TextInput id={`${idPrefix}-nextStep`} value={value.nextStep} onChange={set("nextStep")} disabled={disabled} />
      </Field>
    </div>
  );
}
