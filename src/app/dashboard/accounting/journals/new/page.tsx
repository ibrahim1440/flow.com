"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Btn, Field, OpsLoading } from "@/components/ops/ui";
import { AcctShell, Msg, acctFetch, money, todayRiyadh, useApi, useLang, type Setup } from "../../_ui/shell";
import { JournalEditor, type EditorValue } from "../../_ui/journal-editor";

type Tpl = {
  id: string; name: string; description: string | null; amountMode: "FIXED" | "PERCENT"; isActive: boolean; fixedTotal: string | null;
  lines: { accountId: string; side: "D" | "C"; amount: string | null; description: string | null; branchId: string | null; costCenterId: string | null; partyType: string | null; partyId: string | null }[];
};
type Applied = { name: string; description: string; total: string; lines: { accountId: string; debit: string; credit: string; description: string | null; branchId: string | null; costCenterId: string | null; partyType: string | null; partyId: string | null }[] };
const TOTAL = /^\d{0,13}(\.\d{0,2})?$/;

/**
 * «القيود السهلة» → «استخدام القالب» (?template=<id>): the template's lines prefill the ordinary manual journal form. A
 * percentage template asks for the total first (the server splits it to the halala, the remainder on each side's last
 * line); a fixed one fills at once. The user picks the date, may still edit the lines, and saves — through
 * POST /api/accounting/journals, so every journal rule applies.
 */
function FromTemplate({ id }: { id: string }) {
  const { L } = useLang();
  const tpl = useApi<Tpl>(`/api/accounting/journal-templates/${id}`);
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<{ key: string; v: EditorValue } | null>(null);

  async function apply(t: Tpl, tot: string | null) {
    setBusy(true); setError(null);
    try {
      const a = await acctFetch<Applied>(`/api/accounting/journal-templates/${t.id}/apply`, { method: "POST", json: { total: tot } });
      setValue({
        key: `${t.id}:${a.total}:${Date.now()}`,
        v: {
          entryDate: todayRiyadh(), description: a.description,
          lines: a.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? "", debit: l.debit === "0.00" ? "" : l.debit, credit: l.credit === "0.00" ? "" : l.credit, branchId: l.branchId ?? "", costCenterId: l.costCenterId ?? "", partyType: l.partyType ?? "", partyId: l.partyId ?? "" })),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const t = tpl.data;
  // A fixed template's lines are its amounts: the form is filled from the template itself (no total to split).
  const fixed = useMemo<{ key: string; v: EditorValue } | null>(() => (t && t.amountMode === "FIXED" ? {
    key: `${t.id}:fixed`,
    v: {
      entryDate: todayRiyadh(), description: t.description ?? t.name,
      lines: t.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? "", debit: l.side === "D" ? l.amount ?? "" : "", credit: l.side === "C" ? l.amount ?? "" : "", branchId: l.branchId ?? "", costCenterId: l.costCenterId ?? "", partyType: l.partyType ?? "", partyId: l.partyId ?? "" })),
    },
  } : null), [t]);
  const shown = fixed ?? value;

  if (tpl.error) return <p role="alert" className="hr-err">{tpl.error}</p>;
  if (!t) return <OpsLoading />;
  if (!t.isActive) return <p role="alert" className="hr-err">{L("هذا القالب مؤرشف.", "This template is archived.")}</p>;
  return (
    <>
      <section className="acct-card" data-testid="tpl-apply">
        <Msg error={error} onClose={() => setError(null)} />
        <p><strong>{L("من القالب:", "From the template:")}</strong> {t.name} <span className="acct-hint">· {t.amountMode === "PERCENT" ? L("نسب من الإجمالي", "Percentages of the total") : L(`مبالغ ثابتة · ${money(t.fixedTotal)}`, `Fixed amounts · ${money(t.fixedTotal)}`)}</span></p>
        {t.amountMode === "PERCENT" ? (
          <div className="acct-row">
            <Field label={L("الإجمالي · ر.س", "Total · SAR")} help={L("يُقرَّب كل سطر لأقرب هللة؛ آخر سطر في كل جانب يأخذ الباقي.", "Each line is rounded to the halala; the last line of each side takes the remainder.")}>
              <input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={total} aria-invalid={!!total && !TOTAL.test(total)} onChange={(e) => setTotal(e.target.value.replace(/[^\d.]/g, ""))} data-testid="tpl-total" />
            </Field>
            <Btn variant="primary" busy={busy} disabled={!total || !TOTAL.test(total) || busy} onClick={() => apply(t, total)} data-testid="tpl-apply-total">{value ? L("إعادة التوزيع", "Split again") : L("توزيع على السطور", "Split across the lines")}</Btn>
          </div>
        ) : null}
      </section>
      {shown ? <JournalEditor key={shown.key} initial={shown.v} /> : null}
    </>
  );
}

function NewJournal() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const template = useSearchParams().get("template");
  return (
    <AcctShell setup={setup.data} title={template ? L("قيد من قالب", "Journal from a template") : L("قيد يدوي جديد", "New manual journal")}
      meta={<span className="acct-meta"><Link href="/dashboard/accounting/journals" className="acct-hint">→ {L("القيود", "Journals")}</Link>{template ? <> · <Link href="/dashboard/accounting/journal-templates" className="acct-hint">{L("القيود السهلة", "Journal templates")}</Link></> : null}</span>}>
      {setup.data && !setup.data.manualJournalsEnabled ? (
        <p role="alert" className="hr-err">{L("القيود اليدوية معطّلة في المرحلة الأولى.", "Manual journals are disabled in Phase 1.")}</p>
      ) : template ? <FromTemplate id={template} /> : <JournalEditor />}
    </AcctShell>
  );
}

export default function NewJournalPage() {
  return <Suspense fallback={<OpsLoading />}><NewJournal /></Suspense>;
}
