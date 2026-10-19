"use client";

import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { riyadhDateString } from "@/lib/finance/dates";
import { useUser } from "../../user-context";
import { canEdit } from "@/lib/auth-shared";
import { Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Status, Table, Td, Th, api, useApi, useFinance, useHasSub, useL, withBranch } from "../_components/ui";

type Setup = {
  settings: { alertAmountThreshold: string; alertPercentThreshold: string; alertThresholdMode: string; reconciliationDueDays: number; obligationAlertDays: number; conservativeDelayWeeks: number; conservativeCollectPct: number };
  finCategories: { id: string; code: string; nameEn: string; nameAr: string | null; kind: string; isOperating: boolean; active: boolean }[];
  branches: { id: string; code: string; nameEn: string; nameAr: string | null }[];
  branchAccess: { employeeId: string; branchId: string }[];
  people: { id: string; name: string; duties: string[]; hasFinance: boolean }[];
  scope: { all: boolean; branchKeys: string[] };
};
type Audit = { id: string; action: string; entityType: string; entityId: string; reason: string | null; userId: string | null; createdAt: string; after: unknown };
type Accrual = { accrual: { available: boolean; reasons: string[] } };
type Budget = { id: string; month: string; branchKey: string };

const ACTION: Record<string, [string, string]> = {
"bank_txn.collection_linked": ["ربط تحصيل مبيعات", "Sales collection linked"], "bank_txn.statement_confirmed": ["تأكيد من كشف البنك", "Confirmed by statement"], "bank_txn.settled": ["تأكيد سطر معلّق", "Pending line settled"], "bank_txn.duplicate_resolved": ["دمج تكرار", "Duplicate merged"], "bank_txn.transfer_linked": ["ربط تحويل", "Transfer linked"],
"approval.requested": ["طلب موافقة", "Approval requested"], "approval.approved": ["اعتماد", "Approved"], "approval.rejected": ["رفض", "Rejected"], "approval.withdrawn": ["سحب طلب", "Request withdrawn"],
"forecast.snapshot": ["لقطة توقع", "Forecast snapshot"], "bank_import.committed": ["استيراد كشف", "Statement import"], "bank_txn.created": ["قيد بنكي", "Bank line"], "bank_txn.reviewed": ["مراجعة سطر", "Line reviewed"],
"bank_txn.voided": ["إلغاء سطر", "Line voided"], "bank_txn.matched": ["ربط بمستند", "Linked to document"], "allocation.run": ["تشغيل التخصيص", "Allocation run"], "allocation.manual": ["تخصيص يدوي", "Manual allocation"],
"reservation.created": ["طلب دفع", "Payment request"], "reservation.executed": ["تنفيذ دفع", "Payment executed"], "budget.created": ["إنشاء ميزانية", "Budget created"], "budget.lines_saved": ["حفظ بنود", "Lines saved"],
"budget.revision_started": ["مراجعة جديدة", "New revision"], "variance_note.created": ["تفسير انحراف", "Variance explanation"], "variance_note.resolved": ["حل انحراف", "Variance resolved"],
"forecast_item.created": ["بند متوقع", "Forecast item"], "forecast_item.realized": ["تحقق بند متوقع", "Forecast item realized"], "forecast_item.cancelled": ["إلغاء بند متوقع", "Forecast item cancelled"],
"obligation.created": ["التزام جديد", "Obligation created"], "obligation.superseded": ["استبدال التزام", "Obligation superseded"], "obligation.cancelled": ["إلغاء التزام", "Obligation cancelled"],
"bank_txn.transfer": ["تحويل بين الحسابات", "Account transfer"], "bank_txn.confirmed": ["تأكيد سطر", "Line confirmed"], "bank_txn.unmatched": ["إلغاء ربط", "Unlinked"], "attachment.added": ["مرفق", "Attachment"],
"allocation_rules.draft_created": ["مسودة قواعد", "Rules draft"], "allocation_rules.draft_updated": ["تعديل مسودة قواعد", "Rules draft edited"], "allocation_category.created": ["فئة جديدة", "Category created"], "allocation_category.updated": ["تعديل فئة", "Category edited"],
"reservation.released": ["إلغاء حجز", "Reservation released"], "category.payment": ["دفعة من فئة", "Category payment"], "category.swept": ["إعادة لغير المخصص", "Category swept"], "cash_account.created": ["حساب جديد", "Account created"],
"branch.created": ["فرع جديد", "Branch created"], "branch_access.granted": ["منح وصول", "Access granted"], "branch_access.revoked": ["سحب وصول", "Access revoked"], "fin_category.created": ["بند ميزانية", "Budget category"], "setup.recommended_installed": ["فئات مقترحة", "Suggested categories"], "cost_center.created": ["مركز تكلفة", "Cost centre"], "budget.closed": ["إغلاق فترة", "Period closed"], "settings.updated": ["تعديل الإعدادات", "Settings changed"], "reconciliation.completed": ["تسوية مكتملة", "Reconciliation completed"], "reconciliation.draft": ["تسوية بفرق", "Reconciliation with difference"],
};

const ENTITY: Record<string, [string, string]> = {
  FinApprovalRequest: ["طلب موافقة", "Approval request"], FinBudget: ["ميزانية", "Budget"], BudgetRevision: ["مراجعة ميزانية", "Budget revision"], FinForecastSnapshot: ["لقطة توقع", "Forecast snapshot"],
  FinVarianceNote: ["تفسير انحراف", "Variance explanation"], BankTransaction: ["سطر بنكي", "Bank line"], BankImportBatch: ["دفعة استيراد", "Import batch"], AllocationRun: ["تشغيل تخصيص", "Allocation run"],
  AllocationEntry: ["قيد تخصيص", "Allocation entry"], AllocationCategory: ["فئة تخصيص", "Allocation category"], AllocationRuleVersion: ["قواعد التخصيص", "Allocation rules"], PaymentReservation: ["طلب دفع", "Payment request"],
  FinObligation: ["التزام", "Obligation"], FinForecastItem: ["بند متوقع", "Forecast item"], BankReconciliation: ["تسوية", "Reconciliation"], CashAccount: ["حساب", "Account"], FinSettings: ["الإعدادات", "Settings"],
  FinBranch: ["فرع", "Branch"], FinBranchAccess: ["وصول فرع", "Branch access"], FinCategory: ["بند ميزانية", "Budget category"], FinCostCenter: ["مركز تكلفة", "Cost centre"],
};

export default function ReportsPage() {
  const { L, name } = useL();
  const user = useUser();
  const { branch, refresh } = useFinance();
  const canSettings = useHasSub(user?.permissions, "settings_manage");
  // Branch access is an administrator's change (same rule as the server): finance settings,
  // company-wide access, and the ERP authority to edit employees.
  const companyWide = useHasSub(user?.permissions, "all_branches");
  const canAccess = canSettings && companyWide && !!user && canEdit(user.permissions, "employees");
  const setup = useApi<Setup>("/api/finance/setup");
  const audit = useApi<Audit[]>("/api/finance/audit");
  const ov = useApi<Accrual>("/api/finance/overview");
  const budgets = useApi<Budget[]>("/api/finance/budgets");
  const [edits, setS] = useState<Setup["settings"] | null>(null);
  const [thisMonth] = useState(() => riyadhDateString().slice(0, 7));
  const [allCats, setAllCats] = useState(false); const [allAudit, setAllAudit] = useState(false);
  const s = edits ?? setup.data?.settings ?? null;
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (setup.loading && !setup.data) return <LoadingState />;
  if (setup.error) return <ErrorState error={setup.error} onRetry={setup.reload} />;
  const d = setup.data!;
  const person = (id: string | null) => d.people.find((p) => p.id === id)?.name ?? "—";
  const cur = budgets.data?.find((b) => b.month === thisMonth) ?? budgets.data?.[0];
  async function call(path: string, json: unknown, ok: string, method = "POST") {
    setBusy(true); setErr(null); setMsg(null);
    try { await api(withBranch(path, branch), { method, json }); setMsg(ok); setup.reload(); audit.reload(); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const exp = (kind: string, fmt: string, extra = "") => withBranch(`/api/finance/export?kind=${kind}&format=${fmt}${extra}`, branch);
  const exports: [string, string, string, string][] = [
    [L(`الميزانية الشهرية${cur ? ` — ${cur.month}` : ""}`, `Monthly budget${cur ? ` — ${cur.month}` : ""}`), L("المقارنة كاملة مع الانحرافات والتوقعات", "Full comparison with variances and forecasts"), "budget", cur ? `&id=${cur.id}` : ""],
    [L("السطور البنكية", "Bank lines"), L("كل السطور ضمن نطاق فروعك", "Every line within your branches"), "transactions", ""],
    [L("التوقع النقدي — 13 أسبوعاً", "Cash forecast — 13 weeks"), L("الأساسي والمتحفظ", "Base and conservative"), "forecast", ""],
    [L("أرصدة فئات التخصيص", "Allocation category balances"), L("معادلة الرصيد لكل فئة", "The balance formula for every category"), "categories", ""],
  ];

  return (
    <>
      {err && <Notice tone="bad">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="fin-grid-2">
        <Card>
          <CardTitle title={L("التصدير", "Exports")} sub={L("Excel أو CSV من الأرقام المحسوبة نفسها", "Excel or CSV from the same computed figures")} />
          <Table className="is-mrow" label={L("التصدير", "Exports")}>
            <thead><tr><Th>{L("التقرير", "Report")}</Th><Th /></tr></thead>
            <tbody>
              {exports.map(([t, sub, kind, extra]) => (
                <tr key={kind}>
                  <Td className="m-title fin-wrap"><span className="strong">{t}</span><span className="fin-sub">{sub}</span></Td>
                  <Td className="fin-acts m-end">
                    {kind === "budget" && !cur ? <span className="fin-cap">{L("لا توجد ميزانية", "No budget")}</span> : <>
                      <a className="hr-btn is-sm" href={exp(kind, "xlsx", extra)}>Excel</a>
                      <a className="hr-btn is-sm" href={exp(kind, "csv", extra)}>CSV</a>
                    </>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle title={L("عرض الاستحقاق المحاسبي", "Accrual accounting view")} />
          <div className="fin-row"><Status tone={ov.data?.accrual.available ? "ok" : "info"}>{ov.data?.accrual.available ? L("متاح", "On") : L("متوقف", "Off")}</Status><span className="fin-strong fin-t1">{ov.data?.accrual.available ? L("متاح", "Available") : L("غير متاح حالياً", "Not available yet")}</span></div>
          <ul className="fin-stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 4 }}>
            {(ov.data?.accrual.reasons ?? []).map((r) => (
              <li key={r} className="fin-cap fin-t2">
                {r.startsWith("Accounting setup") ? L("إعداد المحاسبة غير مكتمل.", r) : r.startsWith("No operational") ? L("لا تُرحّل وحدات المبيعات والمشتريات والمخزون والرواتب قيوداً محاسبية بعد.", r) : r.startsWith("There are no posted") ? L("لا توجد قيود يومية مُرحّلة.", r) : r}
              </li>
            ))}
          </ul>
          <p className="fin-cap">{L("الميزانية النقدية تقارن المقبوضات والمدفوعات فقط، ولا تستنتج صافي الربح منها.", "The cash budget compares receipts and payments only and never derives net profit from them.")}</p>
        </Card>
      </div>

      {s && (
        <Card className="is-ruled">
          <CardTitle title={L("إعدادات المالية", "Finance settings")} sub={L("تغييرها يُسجّل في سجل التدقيق", "Changes are recorded in the audit log")} />
          <fieldset disabled={!canSettings} className="fin-grid" style={{ ["--fin-cols" as string]: 3, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <Field label={L("حد التنبيه بالمبلغ (ر.س)", "Alert amount threshold (SAR)")}><input className={`${INPUT} is-num`} value={s.alertAmountThreshold} onChange={(e) => setS({ ...s, alertAmountThreshold: e.target.value })} /></Field>
            <Field label={L("حد التنبيه بالنسبة (%)", "Alert percent threshold (%)")}><input className={`${INPUT} is-num`} value={s.alertPercentThreshold} onChange={(e) => setS({ ...s, alertPercentThreshold: e.target.value })} /></Field>
            <Field label={L("منطق الحدين", "Threshold logic")}><Select className={INPUT} value={s.alertThresholdMode} onChange={(e) => setS({ ...s, alertThresholdMode: e.target.value })}><option value="EITHER">{L("أيهما تجاوز", "Either is crossed")}</option><option value="BOTH">{L("كلاهما معاً", "Both are crossed")}</option></Select></Field>
            <Field label={L("التسوية متأخرة بعد (يوم)", "Reconciliation overdue after (days)")}><input className={`${INPUT} is-num`} value={s.reconciliationDueDays} onChange={(e) => setS({ ...s, reconciliationDueDays: Number(e.target.value) })} /></Field>
            <Field label={L("تنبيه الالتزامات قبل (يوم)", "Obligation alert before (days)")}><input className={`${INPUT} is-num`} value={s.obligationAlertDays} onChange={(e) => setS({ ...s, obligationAlertDays: Number(e.target.value) })} /></Field>
            <Field label={L("تأخر التحصيل — متحفظ (أسبوع)", "Collection delay — conservative (weeks)")}><input className={`${INPUT} is-num`} value={s.conservativeDelayWeeks} onChange={(e) => setS({ ...s, conservativeDelayWeeks: Number(e.target.value) })} /></Field>
            <Field label={L("نسبة التحصيل — متحفظ (%)", "Collection rate — conservative (%)")}><input className={`${INPUT} is-num`} value={s.conservativeCollectPct} onChange={(e) => setS({ ...s, conservativeCollectPct: Number(e.target.value) })} /></Field>
          </fieldset>
          {canSettings && <div className="fin-row"><Button kind="primary" busy={busy} onClick={() => call("/api/finance/setup/settings", s, L("حُفظت الإعدادات.", "Settings saved."), "PATCH")}>{L("حفظ الإعدادات", "Save settings")}</Button></div>}
        </Card>
      )}

      <div className="fin-grid-2 fin-sec is-ruled">
        <BranchesCard setup={d} canSettings={canSettings} canAccess={canAccess} selfId={user?.id ?? ""} onCall={call} busy={busy} />
        <Card>
          <CardTitle title={L("سجل التدقيق", "Audit log")} sub={L("القيم قبل وبعد، والسبب، والمستخدم، والوقت", "Before and after values, reason, user and time")} />
          {audit.loading && !audit.data ? <LoadingState /> : audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} /> : (
            <Table className="is-mrow" label={L("سجل التدقيق", "Audit log")}>
              <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("السجل", "Record")}</Th><Th>{L("المستخدم", "User")}</Th></tr></thead>
              <tbody>{(audit.data ?? []).slice(0, allAudit ? 100 : 10).map((a) => (
                <tr key={a.id}>
                  <Td className="hr-num fin-t2">{a.createdAt.slice(0, 16).replace("T", " ")}</Td>
                  <Td className="m-title"><span className="strong hr-nowrap">{ACTION[a.action] ? L(ACTION[a.action][0], ACTION[a.action][1]) : a.action}</span><span className="hr-msub"><span className="hr-num">{a.createdAt.slice(0, 16).replace("T", " ")}</span> · {person(a.userId)}</span></Td>
                  <Td className="fin-wrap fin-t2">{ENTITY[a.entityType] ? L(ENTITY[a.entityType][0], ENTITY[a.entityType][1]) : a.entityType}{a.reason ? ` · ${a.reason}` : ""}</Td>
                  <Td>{person(a.userId)}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
          {(audit.data?.length ?? 0) > 10 && <button type="button" className="fin-lk" style={{ alignSelf: "flex-start" }} onClick={() => setAllAudit(!allAudit)}>{allAudit ? L("عرض أقل", "Show fewer") : L("عرض المزيد", "Show more")}</button>}
        </Card>
      </div>

      {canSettings && <AccountsCard setup={d} onDone={() => { setup.reload(); refresh(); }} />}

      <Card className="is-ruled">
        <CardTitle title={L("بنود الميزانية النقدية", "Cash budget categories")} sub={L("بنود التمويل (قروض، مساهمات المالك) مستبعدة من الإجماليات التشغيلية", "Financing categories (loans, owner money) are excluded from operating totals")}
          right={canSettings && <Button size="sm" busy={busy} onClick={() => call("/api/finance/setup/recommended", { branchKey: d.scope.all ? "COMPANY" : d.branches[0]?.id }, L("أُضيفت الفئات المقترحة (أسماء فقط، دون مبالغ).", "Suggested categories added (names only, no amounts)."))}>{L("إضافة المقترحة (اختياري)", "Add suggested (optional)")}</Button>} />
        {d.finCategories.length === 0 ? <p className="fin-cap">{L("لا توجد بنود بعد. أنشئ بنودك أدناه، أو أضف المقترحة إن ناسبتك — ليست مطلوبة.", "No categories yet. Create your own below, or add the suggested ones if they fit — they are not required.")}</p> : (
          <Table className="is-mrow" label={L("بنود الميزانية النقدية", "Cash budget categories")}>
            <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("البند", "Category")}</Th><Th>{L("النوع", "Kind")}</Th></tr></thead>
            <tbody>{(allCats ? d.finCategories : d.finCategories.slice(0, 6)).map((c) => (
              <tr key={c.id}><Td className="hr-id fin-t2">{c.code}</Td><Td className="m-title"><span className="strong">{name(c)}</span><span className="hr-msub hr-id">{c.code}</span></Td><Td className="m-end">{!c.isOperating ? <Badge tone="info">{L("تمويل", "Financing")}</Badge> : c.kind === "RECEIPT" ? <Badge tone="ok">{L("مقبوضات", "Receipts")}</Badge> : <Badge tone="warn">{L("مدفوعات", "Payments")}</Badge>}</Td></tr>
            ))}</tbody>
          </Table>
        )}
        {d.finCategories.length > 6 && <button type="button" className="fin-lk" style={{ alignSelf: "flex-start" }} onClick={() => setAllCats(!allCats)}>{allCats ? L("عرض أقل", "Show fewer") : L(`+ ${d.finCategories.length - 6} بنداً آخر`, `+ ${d.finCategories.length - 6} more`)}</button>}
        {canSettings && <NewFinCategory onCall={call} busy={busy} />}
      </Card>
    </>
  );
}

function AccountsCard({ setup, onDone }: { setup: Setup; onDone: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const accounts = useApi<{ id: string; code: string; nameEn: string; nameAr: string | null; type: string; isRestricted: boolean; opening: number; bookBalance: number; branchKey: string }[]>("/api/finance/accounts");
  const [f, setF] = useState(() => ({ code: "", nameEn: "", nameAr: "", type: "BANK", branchKey: setup.scope.all ? "COMPANY" : setup.branches[0]?.id ?? "", bankName: "", accountLast4: "", openingBalance: "0.00", openingBalanceDate: riyadhDateString().slice(0, 8) + "01", isRestricted: false }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/accounts", branch), { method: "POST", json: f }); accounts.reload(); onDone(); setF({ ...f, code: "", nameEn: "", nameAr: "", accountLast4: "" }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Card className="is-ruled">
      <CardTitle title={L("الحسابات البنكية والنقدية", "Bank and cash accounts")} sub={L("آخر أربعة أرقام فقط — لا تُحفظ أرقام حسابات كاملة ولا بيانات دخول الخدمات المصرفية.", "Last four digits only — no full account numbers and no online-banking credentials are stored.")} />
      {(accounts.data?.length ?? 0) > 0 && (
        <Table className="is-mrow" label={L("الحسابات البنكية والنقدية", "Bank and cash accounts")}>
          <thead><tr><Th>{L("الحساب", "Account")}</Th><Th>{L("النوع", "Type")}</Th><Th num>{L("الافتتاحي", "Opening")}</Th><Th num>{L("الرصيد الدفتري", "Book balance")}</Th></tr></thead>
          <tbody>{accounts.data!.map((a) => (
            <tr key={a.id}><Td className="m-title"><span className="strong">{name(a)}</span> {a.isRestricted && <Badge tone="info">{L("مقيد", "Restricted")}</Badge>}<span className="fin-sub is-mono">{a.code}</span></Td><Td className="fin-t2">{a.type}</Td><Td num>{money(a.opening)}</Td><Td num className="m-end fin-strong">{money(a.bookBalance)}</Td></tr>
          ))}</tbody>
        </Table>
      )}
      <div className="fin-grid" style={{ ["--fin-cols" as string]: 5 }}>
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code} onChange={set("code")} /></Field>
        <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={f.nameAr} onChange={set("nameAr")} /></Field>
        <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={f.nameEn} onChange={set("nameEn")} /></Field>
        <Field label={L("النوع", "Type")}><Select className={INPUT} value={f.type} onChange={set("type")}><option value="BANK">{L("بنك", "Bank")}</option><option value="CASH">{L("نقد", "Cash")}</option><option value="GATEWAY_CLEARING">{L("تسويات بوابة", "Gateway clearing")}</option></Select></Field>
        <Field label={L("النطاق", "Scope")}><Select className={INPUT} value={f.branchKey} onChange={set("branchKey")}>{setup.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</Select></Field>
        <Field label={L("البنك", "Bank")}><input className={INPUT} value={f.bankName} onChange={set("bankName")} /></Field>
        <Field label={L("آخر 4 أرقام", "Last 4 digits")}><input className={INPUT} maxLength={4} value={f.accountLast4} onChange={set("accountLast4")} /></Field>
        <Field label={L("الرصيد الافتتاحي", "Opening balance")}><input className={INPUT} value={f.openingBalance} onChange={set("openingBalance")} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الرصيد الافتتاحي", "Opening balance date")}><input type="date" className={INPUT} value={f.openingBalanceDate} onChange={set("openingBalanceDate")} /></Field>
        <label className="fin-check" style={{ alignSelf: "end", paddingBottom: 8 }}><input type="checkbox" checked={f.isRestricted} onChange={(e) => setF({ ...f, isRestricted: e.target.checked })} />{L("نقد مقيد", "Restricted cash")}</label>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="fin-row"><Button kind="primary" busy={busy} disabled={!f.code || !f.nameEn} onClick={submit}>{L("إضافة حساب", "Add account")}</Button></div>
    </Card>
  );
}

function BranchesCard({ setup, canSettings, canAccess, selfId, onCall, busy }: { setup: Setup; canSettings: boolean; canAccess: boolean; selfId: string; onCall: (p: string, j: unknown, ok: string) => Promise<void>; busy: boolean }) {
  const { L, name } = useL();
  const [nb, setNb] = useState({ code: "", nameEn: "", nameAr: "" });
  const [acc, setAcc] = useState({ employeeId: "", branchId: "" });
  const who = (bid: string) => setup.branchAccess.filter((a) => a.branchId === bid).map((a) => setup.people.find((p) => p.id === a.employeeId)?.name ?? "—");
  return (
    <Card>
      <CardTitle title={L("الفروع والوصول", "Branches and access")} sub={L("المستخدم بلا صلاحية «كل الفروع» يرى فروعه فقط — ويُفرض ذلك على الخادم", "A user without company-wide access sees only their branches — enforced on the server")} />
      <Table className="is-mrow" label={L("الفروع والوصول", "Branches and access")}>
        <thead><tr><Th>{L("الفرع", "Branch")}</Th><Th>{L("الرمز", "Code")}</Th><Th>{L("المستخدمون", "Users")}</Th></tr></thead>
        <tbody>
          {setup.branches.map((b) => <tr key={b.id}><Td className="m-title"><span className="strong">{name(b)}</span><span className="hr-msub">{who(b.id).join("، ") || "—"}</span></Td><Td className="hr-id fin-t2 m-end">{b.code}</Td><Td className="fin-wrap">{who(b.id).join("، ") || "—"}</Td></tr>)}
          {setup.scope.all && <tr><Td className="m-title"><span className="strong">{L("مستوى الشركة", "Company level")}</span><span className="hr-msub">{L("أصحاب صلاحية كل الفروع", "Holders of company-wide access")}</span></Td><Td className="hr-id fin-t2 m-end">COMPANY</Td><Td className="fin-wrap">{L("أصحاب صلاحية كل الفروع", "Holders of company-wide access")}</Td></tr>}
        </tbody>
      </Table>
      {canSettings && setup.scope.all && (
        <>
          <div className="fin-grid" style={{ ["--fin-cols" as string]: 4 }}>
            <Field label={L("رمز الفرع", "Branch code")}><input className={INPUT} value={nb.code} onChange={(e) => setNb({ ...nb, code: e.target.value })} /></Field>
            <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={nb.nameAr} onChange={(e) => setNb({ ...nb, nameAr: e.target.value })} /></Field>
            <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={nb.nameEn} onChange={(e) => setNb({ ...nb, nameEn: e.target.value })} /></Field>
            <Button busy={busy} disabled={!nb.code || !nb.nameEn} onClick={() => onCall("/api/finance/setup/branches", nb, L("أُضيف الفرع.", "Branch added."))}>{L("فرع جديد", "New branch")}</Button>
          </div>
          {canAccess ? (
            <div className="fin-grid" style={{ ["--fin-cols" as string]: 4 }}>
              <Field label={L("الموظف", "Employee")}><Select className={INPUT} value={acc.employeeId} onChange={(e) => setAcc({ ...acc, employeeId: e.target.value })}><option value="">—</option>{setup.people.filter((p) => p.hasFinance && p.id !== selfId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              <Field label={L("الفرع", "Branch")}><Select className={INPUT} value={acc.branchId} onChange={(e) => setAcc({ ...acc, branchId: e.target.value })}><option value="">—</option>{setup.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</Select></Field>
              <Button busy={busy} disabled={!acc.employeeId || !acc.branchId} onClick={() => onCall("/api/finance/setup/branch-access", { ...acc, grant: true }, L("مُنح الوصول.", "Access granted."))}>{L("منح", "Grant")}</Button>
              <Button kind="danger" busy={busy} disabled={!acc.employeeId || !acc.branchId} onClick={() => onCall("/api/finance/setup/branch-access", { ...acc, grant: false }, L("سُحب الوصول.", "Access revoked."))}>{L("سحب", "Revoke")}</Button>
            </div>
          ) : <p data-testid="access-admin-only" className="fin-cap">{L("منح وسحب وصول الفروع يقوم به مسؤول النظام الذي يملك صلاحية تعديل الموظفين، ويُسجَّل في سجل التدقيق.", "Granting and revoking branch access is done by an administrator who may edit employees, and is recorded in the audit log.")}</p>}
        </>
      )}
    </Card>
  );
}

function NewFinCategory({ onCall, busy }: { onCall: (p: string, j: unknown, ok: string) => Promise<void>; busy: boolean }) {
  const { L } = useL();
  const [f, setF] = useState({ code: "", nameEn: "", nameAr: "", kind: "PAYMENT", isOperating: true });
  return (
    <div className="fin-grid" style={{ ["--fin-cols" as string]: 5 }}>
      <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
      <Field label={L("النوع", "Kind")}><Select className={INPUT} value={`${f.kind}:${f.isOperating}`} onChange={(e) => { const [k, o] = e.target.value.split(":"); setF({ ...f, kind: k, isOperating: o === "true" }); }}><option value="RECEIPT:true">{L("مقبوضات تشغيلية", "Operating receipts")}</option><option value="PAYMENT:true">{L("مدفوعات تشغيلية", "Operating payments")}</option><option value="RECEIPT:false">{L("مقبوضات تمويل", "Financing receipts")}</option><option value="PAYMENT:false">{L("مدفوعات تمويل", "Financing payments")}</option></Select></Field>
      <Button busy={busy} disabled={!f.code || !f.nameEn} onClick={() => onCall("/api/finance/setup/fin-categories", f, L("أُضيف البند.", "Category added."))}>{L("بند جديد", "New category")}</Button>
    </div>
  );
}
