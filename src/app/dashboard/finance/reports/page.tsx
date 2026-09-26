"use client";

import { useState } from "react";
import { riyadhDateString } from "@/lib/finance/dates";
import { Save, Plus, Sparkles, UserPlus } from "lucide-react";
import { useUser } from "../../user-context";
import { canEdit } from "@/lib/auth-shared";
import { Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, api, useApi, useFinance, useHasSub, useL, withBranch } from "../_components/ui";

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
    <div className="flex flex-col gap-5">
      {err && <Notice tone="bad">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start">
        <Card>
          <CardTitle title={L("التصدير", "Exports")} sub={L("Excel أو CSV من الأرقام المحسوبة نفسها", "Excel or CSV from the same computed figures")} />
          {exports.map(([t, sub, kind, extra]) => (
            <div key={kind} className="flex items-center justify-between gap-2 rounded-[10px] bg-cream-dark px-3 py-2.5">
              <div><p className="text-[13px] font-bold">{t}</p><p className="text-[11px] text-brown">{sub}</p></div>
              <div className="flex gap-1.5">
                {kind === "budget" && !cur ? <span className="text-xs text-brown-light">{L("لا توجد ميزانية", "No budget")}</span> : <>
                  <a className="px-3 py-1.5 rounded-lg border border-border bg-white text-[13px] font-bold" href={exp(kind, "xlsx", extra)}>Excel</a>
                  <a className="px-3 py-1.5 rounded-lg border border-border bg-white text-[13px] font-bold" href={exp(kind, "csv", extra)}>CSV</a>
                </>}
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <CardTitle title={L("عرض الاستحقاق المحاسبي", "Accrual accounting view")} sub={ov.data?.accrual.available ? L("متاح", "Available") : L("غير متاح حالياً", "Not available yet")} right={<Badge tone={ov.data?.accrual.available ? "ok" : "warn"}>{ov.data?.accrual.available ? L("متاح", "On") : L("متوقف", "Off")}</Badge>} />
          <ul className="flex flex-col gap-1.5">
            {(ov.data?.accrual.reasons ?? []).map((r) => (
              <li key={r} className="flex gap-2 text-xs"><span className="w-1.5 h-1.5 rounded-full bg-amber-700 mt-1.5 flex-shrink-0" />
                {r.startsWith("Accounting setup") ? L("إعداد المحاسبة غير مكتمل.", r) : r.startsWith("No operational") ? L("لا تُرحّل وحدات المبيعات والمشتريات والمخزون والرواتب قيوداً محاسبية بعد.", r) : r.startsWith("There are no posted") ? L("لا توجد قيود يومية مُرحّلة.", r) : r}
              </li>
            ))}
          </ul>
          <p className="text-xs font-bold text-slate-600">{L("الميزانية النقدية تقارن المقبوضات والمدفوعات فقط، ولا تستنتج صافي الربح منها.", "The cash budget compares receipts and payments only and never derives net profit from them.")}</p>
        </Card>
      </div>

      {s && (
        <Card>
          <CardTitle title={L("إعدادات المالية", "Finance settings")} sub={L("تغييرها يُسجّل في سجل التدقيق", "Changes are recorded in the audit log")}
            right={canSettings && <Button kind="primary" icon={Save} busy={busy} onClick={() => call("/api/finance/setup/settings", s, L("حُفظت الإعدادات.", "Settings saved."), "PATCH")}>{L("حفظ الإعدادات", "Save settings")}</Button>} />
          <fieldset disabled={!canSettings} className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label={L("حد التنبيه بالمبلغ (ر.س)", "Alert amount threshold (SAR)")}><input className={INPUT} value={s.alertAmountThreshold} onChange={(e) => setS({ ...s, alertAmountThreshold: e.target.value })} /></Field>
            <Field label={L("حد التنبيه بالنسبة (%)", "Alert percent threshold (%)")}><input className={INPUT} value={s.alertPercentThreshold} onChange={(e) => setS({ ...s, alertPercentThreshold: e.target.value })} /></Field>
            <Field label={L("منطق الحدين", "Threshold logic")}><select className={INPUT} value={s.alertThresholdMode} onChange={(e) => setS({ ...s, alertThresholdMode: e.target.value })}><option value="EITHER">{L("أيهما تجاوز", "Either is crossed")}</option><option value="BOTH">{L("كلاهما معاً", "Both are crossed")}</option></select></Field>
            <Field label={L("التسوية متأخرة بعد (يوم)", "Reconciliation overdue after (days)")}><input className={INPUT} value={s.reconciliationDueDays} onChange={(e) => setS({ ...s, reconciliationDueDays: Number(e.target.value) })} /></Field>
            <Field label={L("تنبيه الالتزامات قبل (يوم)", "Obligation alert before (days)")}><input className={INPUT} value={s.obligationAlertDays} onChange={(e) => setS({ ...s, obligationAlertDays: Number(e.target.value) })} /></Field>
            <Field label={L("تأخر التحصيل — متحفظ (أسبوع)", "Collection delay — conservative (weeks)")}><input className={INPUT} value={s.conservativeDelayWeeks} onChange={(e) => setS({ ...s, conservativeDelayWeeks: Number(e.target.value) })} /></Field>
            <Field label={L("نسبة التحصيل — متحفظ (%)", "Collection rate — conservative (%)")}><input className={INPUT} value={s.conservativeCollectPct} onChange={(e) => setS({ ...s, conservativeCollectPct: Number(e.target.value) })} /></Field>
          </fieldset>
        </Card>
      )}

      {canSettings && <AccountsCard setup={d} onDone={() => { setup.reload(); refresh(); }} />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <BranchesCard setup={d} canSettings={canSettings} canAccess={canAccess} selfId={user?.id ?? ""} onCall={call} busy={busy} />
        <Card>
          <CardTitle title={L("بنود الميزانية النقدية", "Cash budget categories")} sub={L("بنود التمويل (قروض، مساهمات المالك) مستبعدة من الإجماليات التشغيلية", "Financing categories (loans, owner money) are excluded from operating totals")}
            right={canSettings && <Button icon={Sparkles} busy={busy} onClick={() => call("/api/finance/setup/recommended", { branchKey: d.scope.all ? "COMPANY" : d.branches[0]?.id }, L("أُضيفت الفئات المقترحة (أسماء فقط، دون مبالغ).", "Suggested categories added (names only, no amounts)."))}>{L("إضافة المقترحة (اختياري)", "Add suggested (optional)")}</Button>} />
          {d.finCategories.length === 0 ? <p className="text-[13px] text-brown">{L("لا توجد بنود بعد. أنشئ بنودك أدناه، أو أضف المقترحة إن ناسبتك — ليست مطلوبة.", "No categories yet. Create your own below, or add the suggested ones if they fit — they are not required.")}</p> : (
            <Table>
              <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("البند", "Category")}</Th><Th>{L("النوع", "Kind")}</Th></tr></thead>
              <tbody>{(allCats ? d.finCategories : d.finCategories.slice(0, 6)).map((c) => (
                <tr key={c.id}><Td className="text-brown">{c.code}</Td><Td>{name(c)}</Td><Td>{!c.isOperating ? <Badge tone="info">{L("تمويل", "Financing")}</Badge> : c.kind === "RECEIPT" ? <Badge tone="ok">{L("مقبوضات", "Receipts")}</Badge> : <Badge tone="warn">{L("مدفوعات", "Payments")}</Badge>}</Td></tr>
              ))}</tbody>
            </Table>
          )}
          {d.finCategories.length > 6 && <button type="button" className="self-start text-xs font-bold text-orange" onClick={() => setAllCats(!allCats)}>{allCats ? L("عرض أقل", "Show fewer") : L(`+ ${d.finCategories.length - 6} بنداً آخر`, `+ ${d.finCategories.length - 6} more`)}</button>}
          {canSettings && <NewFinCategory onCall={call} busy={busy} />}
        </Card>
      </div>

      <Card>
        <CardTitle title={L("سجل التدقيق", "Audit log")} sub={L("القيم قبل وبعد، والسبب، والمستخدم، والوقت", "Before and after values, reason, user and time")} />
        {audit.loading && !audit.data ? <LoadingState /> : audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} /> : (
          <Table>
            <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("السجل", "Record")}</Th><Th>{L("المستخدم", "User")}</Th></tr></thead>
            <tbody>{(audit.data ?? []).slice(0, allAudit ? 100 : 10).map((a) => (
              <tr key={a.id}>
                <Td className="text-brown whitespace-nowrap">{a.createdAt.slice(0, 16).replace("T", " ")}</Td>
                <Td>{ACTION[a.action] ? L(ACTION[a.action][0], ACTION[a.action][1]) : a.action}</Td>
                <Td className="text-xs">{ENTITY[a.entityType] ? L(ENTITY[a.entityType][0], ENTITY[a.entityType][1]) : a.entityType}{a.reason ? ` · ${a.reason}` : ""}</Td>
                <Td>{person(a.userId)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
        {(audit.data?.length ?? 0) > 10 && <button type="button" className="self-start text-xs font-bold text-orange" onClick={() => setAllAudit(!allAudit)}>{allAudit ? L("عرض أقل", "Show fewer") : L("عرض المزيد", "Show more")}</button>}
      </Card>
    </div>
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
    <Card>
      <CardTitle title={L("الحسابات البنكية والنقدية", "Bank and cash accounts")} sub={L("آخر أربعة أرقام فقط — لا تُحفظ أرقام حسابات كاملة ولا بيانات دخول الخدمات المصرفية.", "Last four digits only — no full account numbers and no online-banking credentials are stored.")} />
      {(accounts.data?.length ?? 0) > 0 && (
        <Table>
          <thead><tr><Th>{L("الحساب", "Account")}</Th><Th>{L("النوع", "Type")}</Th><Th num>{L("الافتتاحي", "Opening")}</Th><Th num>{L("الرصيد الدفتري", "Book balance")}</Th></tr></thead>
          <tbody>{accounts.data!.map((a) => (
            <tr key={a.id}><Td>{a.code} · {name(a)} {a.isRestricted && <Badge tone="info">{L("مقيد", "Restricted")}</Badge>}</Td><Td className="text-brown">{a.type}</Td><Td num>{money(a.opening)}</Td><Td num className="font-bold">{money(a.bookBalance)}</Td></tr>
          ))}</tbody>
        </Table>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code} onChange={set("code")} /></Field>
        <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={f.nameAr} onChange={set("nameAr")} /></Field>
        <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={f.nameEn} onChange={set("nameEn")} /></Field>
        <Field label={L("النوع", "Type")}><select className={INPUT} value={f.type} onChange={set("type")}><option value="BANK">{L("بنك", "Bank")}</option><option value="CASH">{L("نقد", "Cash")}</option><option value="GATEWAY_CLEARING">{L("تسويات بوابة", "Gateway clearing")}</option></select></Field>
        <Field label={L("النطاق", "Scope")}><select className={INPUT} value={f.branchKey} onChange={set("branchKey")}>{setup.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
        <Field label={L("البنك", "Bank")}><input className={INPUT} value={f.bankName} onChange={set("bankName")} /></Field>
        <Field label={L("آخر 4 أرقام", "Last 4 digits")}><input className={INPUT} maxLength={4} value={f.accountLast4} onChange={set("accountLast4")} /></Field>
        <Field label={L("الرصيد الافتتاحي", "Opening balance")}><input className={INPUT} value={f.openingBalance} onChange={set("openingBalance")} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الرصيد الافتتاحي", "Opening balance date")}><input type="date" className={INPUT} value={f.openingBalanceDate} onChange={set("openingBalanceDate")} /></Field>
        <label className="flex items-center gap-2 text-[13px] self-end pb-2"><input type="checkbox" checked={f.isRestricted} onChange={(e) => setF({ ...f, isRestricted: e.target.checked })} />{L("نقد مقيد", "Restricted cash")}</label>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <Button kind="primary" icon={Plus} busy={busy} className="self-start" disabled={!f.code || !f.nameEn} onClick={submit}>{L("إضافة حساب", "Add account")}</Button>
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
      <Table>
        <thead><tr><Th>{L("الفرع", "Branch")}</Th><Th>{L("الرمز", "Code")}</Th><Th>{L("المستخدمون", "Users")}</Th></tr></thead>
        <tbody>
          {setup.branches.map((b) => <tr key={b.id}><Td>{name(b)}</Td><Td className="text-brown">{b.code}</Td><Td className="text-xs">{who(b.id).join("، ") || "—"}</Td></tr>)}
          {setup.scope.all && <tr><Td>{L("مستوى الشركة", "Company level")}</Td><Td className="text-brown">COMPANY</Td><Td className="text-xs">{L("أصحاب صلاحية كل الفروع", "Holders of company-wide access")}</Td></tr>}
        </tbody>
      </Table>
      {canSettings && setup.scope.all && (
        <>
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
            <Field label={L("رمز الفرع", "Branch code")}><input className={INPUT} value={nb.code} onChange={(e) => setNb({ ...nb, code: e.target.value })} /></Field>
            <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={nb.nameAr} onChange={(e) => setNb({ ...nb, nameAr: e.target.value })} /></Field>
            <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={nb.nameEn} onChange={(e) => setNb({ ...nb, nameEn: e.target.value })} /></Field>
            <Button icon={Plus} busy={busy} disabled={!nb.code || !nb.nameEn} onClick={() => onCall("/api/finance/setup/branches", nb, L("أُضيف الفرع.", "Branch added."))}>{L("فرع جديد", "New branch")}</Button>
          </div>
          {canAccess ? (
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
              <Field label={L("الموظف", "Employee")}><select className={INPUT} value={acc.employeeId} onChange={(e) => setAcc({ ...acc, employeeId: e.target.value })}><option value="">—</option>{setup.people.filter((p) => p.hasFinance && p.id !== selfId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              <Field label={L("الفرع", "Branch")}><select className={INPUT} value={acc.branchId} onChange={(e) => setAcc({ ...acc, branchId: e.target.value })}><option value="">—</option>{setup.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
              <Button icon={UserPlus} busy={busy} disabled={!acc.employeeId || !acc.branchId} onClick={() => onCall("/api/finance/setup/branch-access", { ...acc, grant: true }, L("مُنح الوصول.", "Access granted."))}>{L("منح", "Grant")}</Button>
              <Button kind="danger" busy={busy} disabled={!acc.employeeId || !acc.branchId} onClick={() => onCall("/api/finance/setup/branch-access", { ...acc, grant: false }, L("سُحب الوصول.", "Access revoked."))}>{L("سحب", "Revoke")}</Button>
            </div>
          ) : <p data-testid="access-admin-only" className="text-[11px] text-brown-light">{L("منح وسحب وصول الفروع يقوم به مسؤول النظام الذي يملك صلاحية تعديل الموظفين، ويُسجَّل في سجل التدقيق.", "Granting and revoking branch access is done by an administrator who may edit employees, and is recorded in the audit log.")}</p>}
        </>
      )}
    </Card>
  );
}

function NewFinCategory({ onCall, busy }: { onCall: (p: string, j: unknown, ok: string) => Promise<void>; busy: boolean }) {
  const { L } = useL();
  const [f, setF] = useState({ code: "", nameEn: "", nameAr: "", kind: "PAYMENT", isOperating: true });
  return (
    <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end">
      <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
      <Field label={L("النوع", "Kind")}><select className={INPUT} value={`${f.kind}:${f.isOperating}`} onChange={(e) => { const [k, o] = e.target.value.split(":"); setF({ ...f, kind: k, isOperating: o === "true" }); }}><option value="RECEIPT:true">{L("مقبوضات تشغيلية", "Operating receipts")}</option><option value="PAYMENT:true">{L("مدفوعات تشغيلية", "Operating payments")}</option><option value="RECEIPT:false">{L("مقبوضات تمويل", "Financing receipts")}</option><option value="PAYMENT:false">{L("مدفوعات تمويل", "Financing payments")}</option></select></Field>
      <Button icon={Plus} busy={busy} disabled={!f.code || !f.nameEn} onClick={() => onCall("/api/finance/setup/fin-categories", f, L("أُضيف البند.", "Category added."))}>{L("بند جديد", "New category")}</Button>
    </div>
  );
}
