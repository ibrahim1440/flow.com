"use client";

import { useState } from "react";
import { Dialog, Field } from "@/components/hr/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { contractValidity, hasValidity, isRenewed, toDateOnly, validityLabel, dateText } from "@/lib/services/customers/contract-rules";
import { longDate } from "@/components/d21/format";
import type { CustomerFile } from "../types";

/**
 * «صلاحية العقد» on the customer's files tab (batch 24 WP-C): the validity pill of a contract / price agreement,
 * the two optional date fields of the upload form, and «تعديل التواريخ». The dates go to PATCH
 * /api/customers/[id]/files/[fileId], which re-checks who may (the account owner or a sales manager) and audits it.
 */

const day = (v: string | null | undefined) => {
  const d = toDateOnly(v ?? null);
  return d ? dateText(d) : "";
};

/** The pill: ساري / ينتهي بعد X يوم / منتهي / جُدّد / يبدأ …; nothing for a file without dates. */
export function ValidityPill({ ar, file, files, noticeDays }: { ar: boolean; file: CustomerFile; files: CustomerFile[]; noticeDays?: number }) {
  if (!hasValidity(file.category) || (!file.validUntil && !file.validFrom)) return null;
  const v = contractValidity(
    { category: file.category, validFrom: file.validFrom ?? null, validUntil: file.validUntil ?? null, renewalNoticeDays: file.renewalNoticeDays ?? null },
    { defaultNoticeDays: noticeDays, renewed: isRenewed({ ...file, validUntil: file.validUntil ?? null }, files.map((f) => ({ ...f, validUntil: f.validUntil ?? null }))) },
  );
  const l = validityLabel(v, file.validFrom);
  if (!l) return null;
  return <span className={`st ${l.tone}`} data-testid={`file-validity-${file.id}`} data-state={v.state}>{ar ? l.ar : l.en}</span>;
}

/** «يبدأ من … · ينتهي في …» under the pill, as plain dates. */
export function ValidityDates({ ar, file }: { ar: boolean; file: CustomerFile }) {
  // One date format on the sales screens: «10 أكتوبر 2026» (council fix round 1).
  const show = (v: string | null | undefined) => { const d = toDateOnly(v ?? null); return d ? longDate(d, ar ? "ar" : "en") : ""; };
  const from = show(file.validFrom), until = show(file.validUntil);
  if (!from && !until) return null;
  const parts = [from ? `${ar ? "من" : "from"} \u2066${from}\u2069` : null, until ? `${ar ? "إلى" : "to"} \u2066${until}\u2069` : null].filter(Boolean);
  return <div className="acc-muted sm" style={{ marginTop: 2 }}>{parts.join(" ")}</div>;
}

export type DateDraft = { validFrom: string; validUntil: string };

/** The two optional date fields of the upload / edit forms (contracts and price agreements only). */
export function ValidityFields({ ar, value, onChange, disabled }: { ar: boolean; value: DateDraft; onChange: (v: DateDraft) => void; disabled?: boolean }) {
  const L = (a: string, e: string) => (ar ? a : e);
  return (
    <>
      <Field label={L("يبدأ من", "Starts on")} help={L("اختياري", "Optional")}>
        <input type="date" className="hr-input" value={value.validFrom} disabled={disabled} onChange={(e) => onChange({ ...value, validFrom: e.target.value })} data-testid="file-valid-from" />
      </Field>
      <Field label={L("ينتهي في", "Ends on")} help={L("اختياري · ننبّهك قبل نهايته", "Optional · you are reminded before it ends")}>
        <input type="date" className="hr-input" value={value.validUntil} disabled={disabled} onChange={(e) => onChange({ ...value, validUntil: e.target.value })} data-testid="file-valid-until" />
      </Field>
    </>
  );
}

/** A client-side check before sending (the server checks again). Arabic first. */
export function draftProblem(ar: boolean, d: DateDraft): string {
  if (d.validFrom && d.validUntil && d.validUntil < d.validFrom) return ar ? "تاريخ الانتهاء قبل تاريخ البداية." : "The end date is before the start date.";
  return "";
}

/** Send the dates of one file. Returns an error text, or "" when saved. */
export async function saveValidity(ar: boolean, customerId: string, fileId: string, d: DateDraft): Promise<string> {
  const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ validFrom: d.validFrom || null, validUntil: d.validUntil || null }),
  }).catch(() => null);
  if (!res) return ar ? "تعذّر الاتصال." : "Could not connect.";
  if (res.ok) return "";
  const data = (await res.json().catch(() => null)) ?? {};
  return localizeApiError(data, ar ? "ar" : "en") || (ar ? "تعذّر حفظ التواريخ." : "Could not save the dates.");
}

/** «تعديل التواريخ» — one file's start and end dates. */
export function ValidityDialog({ ar, customerId, file, onClose, onDone }: { ar: boolean; customerId: string; file: CustomerFile; onClose: () => void; onDone: () => void }) {
  const L = (a: string, e: string) => (ar ? a : e);
  const [draft, setDraft] = useState<DateDraft>({ validFrom: day(file.validFrom), validUntil: day(file.validUntil) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const p = draftProblem(ar, draft);
    if (p) { setErr(p); return; }
    setBusy(true); setErr("");
    const problem = await saveValidity(ar, customerId, file.id, draft);
    setBusy(false);
    if (problem) { setErr(problem); return; }
    onDone();
  }
  return (
    <Dialog open title={L("تواريخ العقد", "Contract dates")} sub={<bdi>{file.title}</bdi>} onClose={onClose} testId="validity-dialog"
      actions={<>
        <button type="submit" form="acc-validity" className="hr-btn is-primary" disabled={busy} data-testid="validity-save">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ التواريخ", "Save dates")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("إلغاء", "Cancel")}</button>
      </>}>
      <form id="acc-validity" className="hr-form" onSubmit={save} noValidate>
        {err ? <p className="hr-err is-wide" role="alert" data-testid="dialog-error" style={{ gridColumn: "1 / -1" }}>{err}</p> : null}
        <ValidityFields ar={ar} value={draft} onChange={(v) => { setDraft(v); setErr(""); }} disabled={busy} />
        <p className="hr-help is-wide" style={{ gridColumn: "1 / -1" }}>{L("الملف نفسه لا يتغيّر؛ التواريخ فقط. اترك الحقل فاضي لإزالة التاريخ.", "The file itself does not change — only the dates. Leave a field empty to remove its date.")}</p>
      </form>
    </Dialog>
  );
}
