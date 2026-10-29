"use client";

// «المعاملات المتكررة» — the form (new and edit): what repeats (a journal from a template or a copied manual journal, or
// a sales-invoice draft copied from an invoice), the schedule (frequency, interval, start, end date or count) and a
// live preview of the next dates (the same date maths as the server, src/lib/accounting/recurring/schedule.ts).
// Purchase invoices / simple bills are phase 2 and shown disabled with the reason.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn, Field } from "@/components/ops/ui";
import { FREQUENCIES, parseRule, upcoming } from "@/lib/accounting/recurring/schedule";
import { FREQ_LABEL, PHASE_2_REASON } from "@/lib/accounting/recurring/shared";
import { Msg, acctFetch, money, todayRiyadh, useApi, useLang } from "./shell";

type Tpl = { id: string; name: string; amountMode: "FIXED" | "PERCENT"; fixedTotal: string | null };
type Je = { id: string; ref: string | null; entryNo: number; entryDate: string; description: string | null; totalDebit: string; status: string };
type Inv = { id: string; number: string | null; status: string; customerName: string; grandTotal: string; createdAt: string };

export type RecurringValue = {
  name: string; description: string; kind: "JOURNAL" | "SALES_INVOICE"; sourceType: "TEMPLATE" | "JOURNAL" | "SALES_INVOICE";
  templateId: string; totalAmount: string; sourceEntryId: string; sourceInvoiceId: string;
  frequency: string; interval: string; startDate: string; endMode: "NONE" | "DATE" | "COUNT"; endDate: string; maxOccurrences: string;
};

export const blankRecurring = (template?: string | null): RecurringValue => ({
  name: "", description: "", kind: "JOURNAL", sourceType: "TEMPLATE", templateId: template ?? "", totalAmount: "", sourceEntryId: "", sourceInvoiceId: "",
  frequency: "MONTHLY", interval: "1", startDate: todayRiyadh(), endMode: "NONE", endDate: "", maxOccurrences: "",
});

const TOTAL = /^\d{0,13}(\.\d{0,2})?$/;

export function RecurringForm({ initial, id, expectedUpdatedAt, canSales }: { initial: RecurringValue; id?: string; expectedUpdatedAt?: string; canSales: boolean }) {
  const { L } = useLang();
  const router = useRouter();
  const [v, setV] = useState<RecurringValue>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tpls = useApi<{ items: Tpl[] }>("/api/accounting/journal-templates");
  const jes = useApi<{ items: Je[] }>(v.kind === "JOURNAL" && v.sourceType === "JOURNAL" ? "/api/accounting/journals?type=MANUAL&take=100" : null);
  const invs = useApi<{ items: Inv[] }>(v.kind === "SALES_INVOICE" && canSales ? "/api/sales/invoices?take=100" : null);
  const tpl = tpls.data?.items.find((t) => t.id === v.templateId);
  const set = (p: Partial<RecurringValue>) => setV((x) => ({ ...x, ...p }));

  const ruleInput = { frequency: v.frequency, interval: v.interval, startDate: v.startDate, endDate: v.endMode === "DATE" ? v.endDate : null, maxOccurrences: v.endMode === "COUNT" ? v.maxOccurrences : null };
  const parsed = useMemo(() => parseRule(ruleInput), [v.frequency, v.interval, v.startDate, v.endMode, v.endDate, v.maxOccurrences]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = parsed.rule ? upcoming(parsed.rule, 0, 6) : [];
  const freq = FREQ_LABEL[v.frequency];
  const sourceOk = v.kind === "SALES_INVOICE" ? !!v.sourceInvoiceId : v.sourceType === "TEMPLATE" ? !!v.templateId && (tpl?.amountMode !== "PERCENT" || (!!v.totalAmount && TOTAL.test(v.totalAmount))) : !!v.sourceEntryId;

  async function save() {
    setBusy(true); setError(null);
    try {
      const body = {
        name: v.name, description: v.description || null, kind: v.kind, sourceType: v.kind === "SALES_INVOICE" ? "SALES_INVOICE" : v.sourceType,
        templateId: v.sourceType === "TEMPLATE" ? v.templateId : null, totalAmount: v.sourceType === "TEMPLATE" && tpl?.amountMode === "PERCENT" ? v.totalAmount : null,
        sourceEntryId: v.sourceType === "JOURNAL" ? v.sourceEntryId : null, sourceInvoiceId: v.kind === "SALES_INVOICE" ? v.sourceInvoiceId : null,
        ...ruleInput, expectedUpdatedAt,
      };
      const saved = id ? await acctFetch<{ id: string }>(`/api/accounting/recurring/${id}`, { method: "PATCH", json: body }) : await acctFetch<{ id: string }>("/api/accounting/recurring", { method: "POST", json: body });
      router.push(`/dashboard/accounting/recurring/${saved.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="acct-card" data-testid="recurring-form">
      <Msg error={error} onClose={() => setError(null)} />
      <h3>{L("ما الذي يتكرر", "What repeats")}</h3>
      <div className="acct-row">
        <div className="acct-grow"><Field label={L("الإسم", "Name")}><input className="hr-input" maxLength={120} value={v.name} onChange={(e) => set({ name: e.target.value })} data-testid="rec-name" /></Field></div>
        <Field label={L("النوع", "Type")}>
          <Select value={v.kind} onChange={(e) => set({ kind: e.target.value as RecurringValue["kind"], sourceType: e.target.value === "SALES_INVOICE" ? "SALES_INVOICE" : "TEMPLATE" })} aria-label={L("النوع", "Type")} disabled={!!id} data-testid="rec-kind">
            <option value="JOURNAL">{L("قيد محاسبي", "Journal entry")}</option>
            <option value="SALES_INVOICE" disabled={!canSales}>{L("فاتورة مبيعات (مسودة)", "Sales invoice (draft)")}</option>
            <option value="PURCHASE_INVOICE" disabled>{L("فاتورة مشتريات — قريبًا", "Purchase invoice — soon")}</option>
            <option value="SIMPLE_BILL" disabled>{L("فاتورة بسيطة — قريبًا", "Simple bill — soon")}</option>
          </Select>
        </Field>
      </div>
      <p className="acct-hint">{L(PHASE_2_REASON.ar, PHASE_2_REASON.en)}</p>
      {v.kind === "JOURNAL" ? (
        <div className="acct-row">
          <Field label={L("المصدر", "Source")}>
            <Select value={v.sourceType} onChange={(e) => set({ sourceType: e.target.value as RecurringValue["sourceType"] })} aria-label={L("المصدر", "Source")} data-testid="rec-source">
              <option value="TEMPLATE">{L("من قالب (القيود السهلة)", "From a template")}</option>
              <option value="JOURNAL">{L("نسخة من قيد يدوي", "A copy of a manual journal")}</option>
            </Select>
          </Field>
          {v.sourceType === "TEMPLATE" ? (
            <>
              <div className="acct-grow"><Field label={L("القالب", "Template")}>
                <Select value={v.templateId} onChange={(e) => set({ templateId: e.target.value })} aria-label={L("القالب", "Template")} placeholder={L("اختر القالب", "Choose the template")} data-testid="rec-template">
                  <option value="">{L("اختر القالب", "Choose the template")}</option>
                  {(tpls.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.fixedTotal ? ` · ${money(t.fixedTotal)}` : ` · ${L("نسب", "percent")}`}</option>)}
                </Select>
              </Field></div>
              {tpl?.amountMode === "PERCENT" ? (
                <Field label={L("الإجمالي في كل مرة · ر.س", "Total each time · SAR")}>
                  <input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={v.totalAmount} aria-invalid={!!v.totalAmount && !TOTAL.test(v.totalAmount)} onChange={(e) => set({ totalAmount: e.target.value.replace(/[^\d.]/g, "") })} data-testid="rec-total" />
                </Field>
              ) : null}
            </>
          ) : (
            <div className="acct-grow"><Field label={L("القيد المنسوخ", "Journal to copy")}>
              <Select value={v.sourceEntryId} onChange={(e) => set({ sourceEntryId: e.target.value })} aria-label={L("القيد المنسوخ", "Journal to copy")} placeholder={L("اختر القيد", "Choose the journal")} data-testid="rec-entry">
                <option value="">{L("اختر القيد", "Choose the journal")}</option>
                {(jes.data?.items ?? []).map((j) => <option key={j.id} value={j.id}>{`${j.ref ?? `#${j.entryNo}`} · ${j.entryDate} · ${j.description ?? "—"} · ${money(j.totalDebit)}`}</option>)}
              </Select>
            </Field></div>
          )}
        </div>
      ) : (
        <div className="acct-row">
          <div className="acct-grow"><Field label={L("الفاتورة المنسوخة", "Invoice to copy")} help={L("يُنسخ العميل والبنود والأسعار؛ كل مرة تُنشأ مسودة تُراجع ثم تُصدر يدويًا.", "The customer, lines and prices are copied; each run creates a draft to review and issue by hand.")}>
            <Select value={v.sourceInvoiceId} onChange={(e) => set({ sourceInvoiceId: e.target.value })} aria-label={L("الفاتورة المنسوخة", "Invoice to copy")} placeholder={L("اختر الفاتورة", "Choose the invoice")} data-testid="rec-invoice">
              <option value="">{L("اختر الفاتورة", "Choose the invoice")}</option>
              {(invs.data?.items ?? []).map((i) => <option key={i.id} value={i.id}>{`${i.number ?? L("مسودة", "Draft")} · ${i.customerName} · ${money(i.grandTotal)}`}</option>)}
            </Select>
          </Field></div>
        </div>
      )}
      <Field label={L("الوصف", "Description")} help={L("اختياري · حتى 500 حرف", "Optional · up to 500 characters")}>
        <input className="hr-input" maxLength={500} value={v.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <h3>{L("الجدول", "Schedule")}</h3>
      <div className="acct-row">
        <Field label={L("التكرار", "Frequency")}>
          <Select value={v.frequency} onChange={(e) => set({ frequency: e.target.value })} aria-label={L("التكرار", "Frequency")} data-testid="rec-frequency">
            {FREQUENCIES.map((f) => <option key={f} value={f}>{L(FREQ_LABEL[f][0], FREQ_LABEL[f][1])}</option>)}
          </Select>
        </Field>
        <Field label={L(`كل (${freq?.[2] ?? ""})`, `Every (${freq?.[3] ?? ""}s)`)}>
          <input className="hr-input acct-amount" inputMode="numeric" dir="ltr" value={v.interval} onChange={(e) => set({ interval: e.target.value.replace(/\D/g, "") })} data-testid="rec-interval" />
        </Field>
        <Field label={L("تاريخ البدء", "Start date")}><input type="date" className="hr-input" value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} data-testid="rec-start" /></Field>
        <Field label={L("الانتهاء", "Ends")}>
          <Select value={v.endMode} onChange={(e) => set({ endMode: e.target.value as RecurringValue["endMode"] })} aria-label={L("الانتهاء", "Ends")} data-testid="rec-endmode">
            <option value="NONE">{L("بلا نهاية", "Never")}</option>
            <option value="DATE">{L("في تاريخ", "On a date")}</option>
            <option value="COUNT">{L("بعد عدد مرات", "After a number of times")}</option>
          </Select>
        </Field>
        {v.endMode === "DATE" ? <Field label={L("تاريخ الانتهاء", "End date")}><input type="date" className="hr-input" value={v.endDate} onChange={(e) => set({ endDate: e.target.value })} data-testid="rec-end" /></Field> : null}
        {v.endMode === "COUNT" ? <Field label={L("عدد المرات", "Occurrences")}><input className="hr-input acct-amount" inputMode="numeric" dir="ltr" value={v.maxOccurrences} onChange={(e) => set({ maxOccurrences: e.target.value.replace(/\D/g, "") })} data-testid="rec-count" /></Field> : null}
      </div>
      {parsed.problems.length ? <ul className="hr-err" role="alert">{parsed.problems.map((p) => <li key={p.field}>{L(p.ar, p.en)}</li>)}</ul> : null}
      {preview.length ? (
        <p className="acct-hint" data-testid="rec-preview">{L("التواريخ القادمة:", "Next dates:")} <span className="hr-num" dir="ltr">{preview.map((p) => p.date).join(" · ")}</span>
          {v.startDate < todayRiyadh() ? <> — {L("التواريخ الماضية تُنشأ عند أول تشغيل.", "Past dates are made on the first run.")}</> : null}</p>
      ) : null}
      <p className="acct-hint">{L("كل تشغيل يُنشئ مسودة تُراجع وتُعتمد كالمعتاد. الترحيل التلقائي للقيود فقط، ويفعّله من يملك صلاحية الترحيل من صفحة المعاملة بعد الحفظ. أي تعديل يلغي الترحيل التلقائي.", "Each run creates a draft that is reviewed and approved as usual. Auto-post is for journals only, switched on after saving by someone who may post, from the transaction's page. Any edit withdraws auto-post.")}</p>
      <div className="acct-foot">
        <span className="acct-actions">
          <Btn variant="primary" busy={busy} disabled={busy || !v.name.trim() || !sourceOk || !parsed.rule} onClick={save} data-testid="rec-save">{id ? L("حفظ التغييرات", "Save changes") : L("حفظ المعاملة المتكررة", "Save recurring transaction")}</Btn>
          <Btn variant="ghost" onClick={() => router.back()}>{L("إلغاء", "Cancel")}</Btn>
        </span>
      </div>
    </section>
  );
}
