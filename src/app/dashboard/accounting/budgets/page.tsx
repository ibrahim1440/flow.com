"use client";

// «الموازنات» (feat/budgets-deferrals): the GL budgets — a name, a fiscal year, an optional branch, a status (مسودة ·
// معتمدة · مؤرشفة) and amounts per P&L account per month. A budget never posts; it is compared with the ledger
// («الموازنة مقابل الفعلي» on its page). Approval (accounting › journal_approve) locks it; a change is a new revision.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OpsLoading, OpsEmpty, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, StatusTag, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { BUDGET_STATUS, type Branch } from "../_ui/plan";

type Row = {
  id: string; name: string; fiscalYear: number; branchId: string | null; branch: Branch | null; status: string; revisionNo: number; lineCount: number;
  approvedAt: string | null; totals: { creditNatural: string; debitNatural: string; net: string };
};
type List = { items: Row[]; branches: Branch[]; can: { prepare: boolean; approve: boolean } };

export default function BudgetsPage() {
  const { L, ar } = useLang();
  const router = useRouter();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [year, setYear] = useState("");
  const list = useApi<List>(`/api/accounting/budgets${year ? `?year=${year}` : ""}`);
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", fiscalYear: todayRiyadh().slice(0, 4), branchId: "" });
  const bname = (b: Branch | null) => (b ? `${b.code} · ${ar ? b.nameAr ?? b.nameEn : b.nameEn}` : L("الشركة كلها", "Whole company"));

  async function create() {
    const r = await w.run<{ id: string }>("create", "/api/accounting/budgets", "POST", { name: form.name, fiscalYear: Number(form.fiscalYear), branchId: form.branchId || null }, L("أُنشئت الموازنة مسودة.", "The budget is created as a draft."));
    if (r) router.push(`/dashboard/accounting/budgets/${r.id}`);
  }

  return (
    <AcctShell setup={setup.data} title={L("الموازنات", "Budgets")}
      actions={list.data?.can.prepare ? <Btn variant="primary" onClick={() => setOpen(true)} data-testid="budget-new">{L("موازنة جديدة", "New budget")}</Btn> : undefined}>
      <Msg error={w.error ?? list.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p className="acct-scope">{L("الموازنة لا تُرحِّل قيودًا: تُقارَن بدفتر الأستاذ فقط. الاعتماد يقفلها، والتعديل بعده نسخة جديدة.", "A budget posts nothing: it is compared with the general ledger. Approval locks it; a change after that is a new revision.")}</p>
      <div className="acct-filters">
        <Field label={L("السنة المالية", "Fiscal year")}>
          <input className="hr-input" dir="ltr" inputMode="numeric" placeholder={L("كل السنوات", "All years")} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} data-testid="budget-year-filter" />
        </Field>
        {year ? <Btn variant="ghost" onClick={() => setYear("")}>{L("إعادة تعيين", "Reset")}</Btn> : null}
      </div>
      {!list.data ? <OpsLoading /> : list.data.items.length === 0 ? (
        <OpsEmpty title={year ? L("لا موازنات لهذه السنة", "No budget for this year") : L("لا موازنات بعد", "No budget yet")} body={L("أنشئ موازنة للسنة المالية، ثم أدخل مبالغ كل حساب شهرًا بشهر أو انسخها من فعلي السنة السابقة.", "Create a budget for a fiscal year, then enter each account's amounts month by month or copy last year's actuals.")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table" data-testid="budget-list">
            <thead><tr>
              <th>{L("الموازنة", "Budget")}</th><th>{L("السنة", "Year")}</th><th className="acct-hide-m">{L("الفرع", "Branch")}</th><th>{L("الحالة", "Status")}</th>
              <th className="num acct-hide-m">{L("الإيرادات", "Revenue")}</th><th className="num acct-hide-m">{L("التكاليف والمصروفات", "Costs & expenses")}</th><th className="num">{L("صافي الربح المقدر", "Budgeted profit")}</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((b) => (
                <tr key={b.id} className="is-clickable" data-testid={`budget-row-${b.id}`}>
                  <td><Link href={`/dashboard/accounting/budgets/${b.id}`}>{b.name}</Link>{b.revisionNo > 1 ? <span className="acct-sub">{L(`النسخة ${b.revisionNo}`, `Revision ${b.revisionNo}`)}</span> : null}</td>
                  <td className="hr-num">{b.fiscalYear}</td>
                  <td className="acct-hide-m">{bname(b.branch)}</td>
                  <td><StatusTag map={BUDGET_STATUS} value={b.status} /></td>
                  <td className="num hr-num acct-hide-m">{money(b.totals.creditNatural)}</td>
                  <td className="num hr-num acct-hide-m">{money(b.totals.debitNatural)}</td>
                  <td className={`num hr-num${Number(b.totals.net) < 0 ? " acct-bad" : ""}`}>{money(b.totals.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={open} title={L("موازنة جديدة", "New budget")} onClose={() => setOpen(false)}
        actions={<><Btn variant="primary" busy={w.busy === "create"} disabled={!form.name.trim() || !/^\d{4}$/.test(form.fiscalYear)} onClick={create} data-testid="budget-create">{L("إنشاء المسودة", "Create the draft")}</Btn><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <Field label={L("اسم الموازنة", "Budget name")}><input className="hr-input" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="budget-name" /></Field>
        <Field label={L("السنة المالية", "Fiscal year")}><input className="hr-input" dir="ltr" inputMode="numeric" value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} data-testid="budget-fy" /></Field>
        <Field label={L("الفرع (اختياري)", "Branch (optional)")} help={L("موازنة فرع تُقارن بقيود ذلك الفرع فقط.", "A branch budget is compared with that branch's journal lines only.")}>
          <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} data-testid="budget-branch">
            <option value="">{L("الشركة كلها", "Whole company")}</option>
            {(list.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{bname(b)}</option>)}
          </Select>
        </Field>
      </Dialog>
    </AcctShell>
  );
}
