"use client";

// «الموازنة»: the entry grid (accounts as rows, the 12 months as columns; «توزيع بالتساوي» from a row's annual amount,
// «نسخ من فعلي السنة السابقة» for the whole grid) and «الموازنة مقابل الفعلي» (a month and the year to date: budget,
// actual, variance, variance %; every row drills to the account's general ledger). A DRAFT is edited and approved; an
// APPROVED budget is locked (the database refuses any change) — «تعديل (نسخة جديدة)» opens a revision.
import Link from "next/link";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { spreadEvenly, sumAmounts } from "@/lib/accounting/deferral-math";
import { AcctShell, Msg, StatusTag, acctFetch, money, useApi, useLang, useWrite, type Setup } from "../../_ui/shell";
import { BUDGET_STATUS, MONTHS_AR, MONTHS_EN, type Branch } from "../../_ui/plan";

type Account = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; normalBalance: string; group: string };
type Budget = {
  id: string; name: string; fiscalYear: number; branchId: string | null; branch: Branch | null; status: string; rootId: string; revisionNo: number; revisionReason: string | null;
  notes: string | null; createdBy: string; updatedAt: string; updatedBy: string | null; approvedBy: string | null; approvedAt: string | null; sodBypass: boolean;
  grid: { accountId: string; months: string[] }[]; accounts: Account[];
  family: { id: string; revisionNo: number; status: string; approvedAt: string | null; revisionReason: string | null }[];
  can: { prepare: boolean; approve: boolean }; viewer: { id: string };
};
type Cell = { budget: string; actual: string; variance: string; variancePct: string | null; favourable: boolean | null };
type Report = {
  through: number;
  sections: { key: string; ar: string; en: string; rows: { accountId: string; code: string; name: string; nameEn: string; budgeted: boolean; months: Cell[]; ytd: Cell; fullYearBudget: string; ledgerHref: string; monthHrefs: string[] }[]; total: { months: Cell[]; ytd: Cell; fullYearBudget: string } }[];
  netProfit: { months: Cell[]; ytd: Cell; fullYearBudget: string };
};
const GROUP_AR: Record<string, [string, string]> = {
  REVENUE: ["الإيرادات", "Revenue"], COST_OF_SALES: ["تكلفة المبيعات", "Cost of sales"], OPERATING_EXPENSE: ["المصروفات التشغيلية", "Operating expenses"],
  OTHER_INCOME_EXPENSE: ["إيرادات ومصروفات أخرى وتمويلية", "Other income / finance costs"], ZAKAT: ["الزكاة", "Zakat"],
};
const GROUPS = Object.keys(GROUP_AR);
const blank = () => Array.from({ length: 12 }, () => "");
const clean = (v: string) => v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.-]/g, "");
const valid = (v: string) => v === "" || /^-?\d{1,14}(\.\d{1,2})?$/.test(v);

export default function BudgetPage() {
  return <Suspense fallback={<OpsLoading />}><BudgetPageScreen /></Suspense>;
}

function BudgetPageScreen() {
  const { L, ar } = useLang();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const view = sp.get("view") === "report" ? "report" : "grid";
  const setup = useApi<Setup>("/api/accounting/setup");
  const b = useApi<Budget>(`/api/accounting/budgets/${id}`);
  const w = useWrite();
  // The grid as loaded, and the viewer's unsaved edits of THAT version (a reload after a save starts from the new one).
  const stamp = b.data ? `${b.data.id}@${b.data.updatedAt}` : "";
  const base = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const r of b.data?.grid ?? []) g[r.accountId] = r.months.map((m) => (Number(m) === 0 ? "" : m));
    return g;
  }, [b.data]);
  const [local, setLocal] = useState<{ stamp: string; grid: Record<string, string[]> } | null>(null);
  const dirty = !!local && local.stamp === stamp;
  const grid = dirty ? local!.grid : base;
  const setGrid = (f: (g: Record<string, string[]>) => Record<string, string[]>) => setLocal({ stamp, grid: f(grid) });
  const [annual, setAnnual] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [dialog, setDialog] = useState<null | "approve" | "revise" | "archive" | "delete">(null);
  const [reason, setReason] = useState("");
  const [copying, setCopying] = useState(false);
  const editable = b.data?.status === "DRAFT" && !!b.data?.can.prepare;

  const accounts = useMemo(() => b.data?.accounts ?? [], [b.data]);
  const rows = editable && showAll ? accounts : accounts.filter((a) => grid[a.id]?.some((v) => v !== ""));
  const setCell = (acc: string, i: number, v: string) => { const c = clean(v); setGrid((g) => ({ ...g, [acc]: (g[acc] ?? blank()).map((x, j) => (j === i ? c : x)) })); };
  const spread = (acc: string) => { const t = annual[acc]; if (!t || !valid(t)) return; setGrid((g) => ({ ...g, [acc]: spreadEvenly(t).map((x) => (Number(x) === 0 ? "" : x)) })); };
  const rowTotal = (acc: string) => sumAmounts((grid[acc] ?? []).filter(valid));
  const anyInvalid = Object.values(grid).some((r) => r.some((v) => !valid(v)));
  // Profit by month: credit-normal accounts add, debit-normal ones subtract.
  const profit = Array.from({ length: 12 }, (_, i) => sumAmounts(accounts.map((a) => { const v = grid[a.id]?.[i]; if (!v || !valid(v)) return "0"; return a.normalBalance === "CREDIT" ? v : v.startsWith("-") ? v.slice(1) : `-${v}`; })));

  async function save() {
    const payload = Object.entries(grid).filter(([, m]) => m.some((v) => v !== "")).map(([accountId, m]) => ({ accountId, months: m.map((v) => v || "0") }));
    const r = await w.run("save", `/api/accounting/budgets/${id}`, "PUT", { grid: payload }, L("حُفظت الموازنة.", "The budget is saved."));
    if (r) { setLocal(null); setAnnual({}); b.reload(); }
  }
  async function copyActuals() {
    if (!b.data) return;
    let r: { year: number; grid: { accountId: string; months: string[] }[] };
    setCopying(true); w.setError(null); w.setDone(null);
    try { r = await acctFetch(`/api/accounting/budgets/actuals?year=${b.data.fiscalYear}${b.data.branchId ? `&branchId=${encodeURIComponent(b.data.branchId)}` : ""}`); }
    catch (e) { w.setError(e instanceof Error ? e.message : String(e)); return; }
    finally { setCopying(false); }
    if (!r.grid.length) { w.setDone(L(`لا حركات فعلية في ${r.year}.`, `No actuals in ${r.year}.`)); return; }
    const g: Record<string, string[]> = {};
    for (const row of r.grid) g[row.accountId] = row.months.map((m) => (Number(m) === 0 ? "" : m));
    setLocal({ stamp, grid: g }); setShowAll(false);
    w.setDone(L(`نُسخ فعلي ${r.year} إلى الجدول — راجعه ثم احفظ.`, `${r.year} actuals copied into the grid — review, then save.`));
  }
  async function act() {
    if (!dialog || !b.data) return;
    if (dialog === "approve") { if (await w.run("act", `/api/accounting/budgets/${id}/approve`, "POST", {}, L("اعتُمدت الموازنة وأُقفلت.", "Approved and locked."))) { setDialog(null); b.reload(); } }
    if (dialog === "archive") { if (await w.run("act", `/api/accounting/budgets/${id}/archive`, "POST", {}, L("أُرشفت الموازنة.", "Archived."))) { setDialog(null); b.reload(); } }
    if (dialog === "delete") { if (await w.run("act", `/api/accounting/budgets/${id}`, "DELETE", {}, L("حُذفت المسودة.", "Draft deleted."))) router.push("/dashboard/accounting/budgets"); }
    if (dialog === "revise") { const r = await w.run<{ id: string }>("act", `/api/accounting/budgets/${id}/revise`, "POST", { reason }, L("أُنشئت نسخة جديدة مسودة.", "A new draft revision is created.")); if (r) { setDialog(null); setReason(""); router.push(`/dashboard/accounting/budgets/${r.id}`); } }
  }
  const go = (v: string) => router.replace(`${path}${v === "report" ? "?view=report" : ""}`);
  const d = b.data;
  const self = !!d && (d.createdBy === d.viewer.id || d.updatedBy === d.viewer.id);

  return (
    <AcctShell setup={setup.data} title={d ? d.name : L("الموازنة", "Budget")}
      meta={d ? <span className="acct-meta"><Link href="/dashboard/accounting/budgets">{L("الموازنات", "Budgets")}</Link><span aria-hidden="true">/</span><span className="hr-num">{d.fiscalYear}</span><span aria-hidden="true">·</span><span>{d.branch ? `${d.branch.code} · ${ar ? d.branch.nameAr ?? d.branch.nameEn : d.branch.nameEn}` : L("الشركة كلها", "Whole company")}</span><span aria-hidden="true">·</span><span>{L(`النسخة ${d.revisionNo}`, `Revision ${d.revisionNo}`)}</span><StatusTag map={BUDGET_STATUS} value={d.status} /></span> : undefined}
      actions={d ? <span className="acct-actions">
        {d.status === "DRAFT" && d.can.approve ? <Btn variant="primary" disabled={dirty} onClick={() => setDialog("approve")} data-testid="budget-approve">{L("اعتماد", "Approve")}</Btn> : null}
        {d.status === "APPROVED" && d.can.prepare ? <Btn onClick={() => setDialog("revise")} data-testid="budget-revise">{L("تعديل (نسخة جديدة)", "Revise (new version)")}</Btn> : null}
        {d.status !== "ARCHIVED" && d.can.prepare && (d.status === "DRAFT" || d.can.approve) ? <Btn variant="ghost" onClick={() => setDialog("archive")} data-testid="budget-archive">{L("أرشفة", "Archive")}</Btn> : null}
        {d.status === "DRAFT" && d.can.prepare ? <Btn variant="ghost" onClick={() => setDialog("delete")} data-testid="budget-delete">{L("حذف المسودة", "Delete draft")}</Btn> : null}
      </span> : undefined}>
      <Msg error={w.error ?? b.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!d ? <OpsLoading /> : <>
        {d.status === "APPROVED" ? <p className="acct-scope" data-testid="budget-locked">{L("معتمدة ومقفلة: لا تتغير أرقامها. للتعديل أنشئ نسخة جديدة؛ اعتمادها يؤرشف هذه النسخة.", "Approved and locked: its amounts never change. To change it, open a new revision; approving it archives this one.")}{d.sodBypass ? L(" · اعتمدها مُعدّها (مسموح في الإعدادات).", " · Approved by its preparer (allowed by the settings).") : null}</p> : null}
        {d.revisionReason ? <p className="acct-hint">{L("سبب التعديل: ", "Reason for the revision: ")}{d.revisionReason}</p> : null}
        {d.family.length > 1 ? <div className="acct-chips" aria-label={L("النسخ", "Versions")}>{d.family.map((f) => <button key={f.id} type="button" aria-pressed={f.id === d.id} onClick={() => router.push(`/dashboard/accounting/budgets/${f.id}${view === "report" ? "?view=report" : ""}`)}>{L(`النسخة ${f.revisionNo}`, `Rev. ${f.revisionNo}`)} · {L(BUDGET_STATUS[f.status][0], BUDGET_STATUS[f.status][1])}</button>)}</div> : null}
        <div className="acct-seg" role="group" aria-label={L("العرض", "View")}>
          <button type="button" aria-pressed={view === "grid"} onClick={() => go("grid")} data-testid="budget-view-grid">{L("أرقام الموازنة", "Budget amounts")}</button>
          <button type="button" aria-pressed={view === "report"} onClick={() => go("report")} data-testid="budget-view-report">{L("الموازنة مقابل الفعلي", "Budget vs actual")}</button>
        </div>
        {view === "grid" ? (
          <section className="acct-card">
            <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
              <span className="acct-hint">{L("المبالغ بالريال على طبيعة كل حساب: الإيرادات دائنة موجبة، والتكاليف والمصروفات مدينة موجبة.", "Amounts in SAR on each account's natural side: revenue credit-positive, costs and expenses debit-positive.")}</span>
              {editable ? <span className="acct-actions">
                <Btn onClick={() => setShowAll((s) => !s)} aria-pressed={showAll} data-testid="budget-show-all">{showAll ? L("إخفاء الحسابات بلا مبالغ", "Hide empty accounts") : L("كل حسابات الإيرادات والمصروفات", "All revenue & expense accounts")}</Btn>
                <Btn busy={copying} onClick={copyActuals} data-testid="budget-copy-actuals">{L("نسخ من فعلي السنة السابقة", "Copy last year's actuals")}</Btn>
                <Btn variant="primary" busy={w.busy === "save"} disabled={!dirty || anyInvalid} onClick={save} data-testid="budget-save">{L("حفظ التغييرات", "Save changes")}</Btn>
              </span> : null}
            </div>
            {rows.length === 0 ? <p className="acct-hint" data-testid="budget-grid-empty">{editable ? L("لا مبالغ بعد. اعرض كل الحسابات لإدخالها، أو انسخ فعلي السنة السابقة.", "No amounts yet. Show all accounts to enter them, or copy last year's actuals.") : L("لا مبالغ في هذه الموازنة.", "This budget has no amounts.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense acct-lines" data-testid="budget-grid">
                  <thead><tr>
                    <th>{L("الحساب", "Account")}</th>
                    {editable ? <th>{L("السنوي ← توزيع", "Annual → spread")}</th> : null}
                    {(ar ? MONTHS_AR : MONTHS_EN).map((m) => <th key={m} className="num">{m}</th>)}
                    <th className="num">{L("الإجمالي", "Total")}</th>
                  </tr></thead>
                  <tbody>
                    {GROUPS.map((g) => {
                      const rs = rows.filter((a) => a.group === g);
                      if (!rs.length) return null;
                      return [
                        <tr key={g} className="is-sub"><td colSpan={editable ? 15 : 14}>{L(GROUP_AR[g][0], GROUP_AR[g][1])}</td></tr>,
                        ...rs.map((a) => (
                          <tr key={a.id} data-testid={`budget-row-${a.code}`}>
                            <td className="acct-acc"><span className="acct-code">{a.code}</span> {ar ? a.nameAr ?? a.nameEn : a.nameEn}</td>
                            {editable ? <td className="acct-nowrap">
                              <input className="hr-input acct-amount" style={{ minWidth: 96, width: 96 }} inputMode="decimal" dir="ltr" aria-label={L(`المبلغ السنوي ${a.code}`, `Annual amount ${a.code}`)} value={annual[a.id] ?? ""} onChange={(e) => setAnnual({ ...annual, [a.id]: clean(e.target.value) })} data-testid={`budget-annual-${a.code}`} />
                              <Btn size="sm" variant="ghost" disabled={!annual[a.id] || !valid(annual[a.id])} onClick={() => spread(a.id)} data-testid={`budget-spread-${a.code}`} aria-label={L(`توزيع بالتساوي ${a.code}`, `Spread evenly ${a.code}`)}>{L("توزيع", "Spread")}</Btn>
                            </td> : null}
                            {Array.from({ length: 12 }, (_, i) => {
                              const v = grid[a.id]?.[i] ?? "";
                              return <td key={i} className="num">{editable
                                ? <input className="hr-input acct-amount" style={{ minWidth: 92, width: 92 }} inputMode="decimal" dir="ltr" aria-invalid={!valid(v) || undefined} aria-label={`${a.code} ${(ar ? MONTHS_AR : MONTHS_EN)[i]}`} value={v} onChange={(e) => setCell(a.id, i, e.target.value)} data-testid={`budget-cell-${a.code}-${i + 1}`} />
                                : <span className="hr-num">{money(v, true)}</span>}</td>;
                            })}
                            <td className="num hr-num" data-testid={`budget-total-${a.code}`}>{money(rowTotal(a.id))}</td>
                          </tr>
                        )),
                      ];
                    })}
                    <tr className="is-total is-grand"><td>{L("صافي الربح المقدر", "Budgeted net profit")}</td>{editable ? <td /> : null}{profit.map((p, i) => <td key={i} className={`num hr-num${Number(p) < 0 ? " acct-bad" : ""}`}>{money(p)}</td>)}<td className="num hr-num" data-testid="budget-profit-total">{money(sumAmounts(profit))}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : <BudgetReport id={d.id} year={d.fiscalYear} />}
      </>}
      <Dialog open={!!dialog} title={dialog === "approve" ? L("اعتماد الموازنة", "Approve the budget") : dialog === "revise" ? L("نسخة جديدة للتعديل", "New revision") : dialog === "archive" ? L("أرشفة الموازنة", "Archive the budget") : L("حذف المسودة", "Delete the draft")} onClose={() => setDialog(null)}
        actions={<><Btn variant={dialog === "delete" || dialog === "archive" ? "danger" : "primary"} busy={w.busy === "act"} disabled={dialog === "revise" && reason.trim().length < 3} onClick={act} data-testid="budget-confirm">{dialog === "approve" ? L("اعتماد وقفل", "Approve and lock") : dialog === "revise" ? L("إنشاء النسخة", "Create the revision") : dialog === "archive" ? L("أرشفة", "Archive") : L("حذف", "Delete")}</Btn><Btn onClick={() => setDialog(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {dialog === "approve" ? <p>{L("بعد الاعتماد تُقفل الموازنة في قاعدة البيانات ولا تتغير أرقامها؛ أي تعديل يكون بنسخة جديدة.", "Once approved the database locks the budget; any change is a new revision.")}{self ? L(" أنت مُعدّ هذه الموازنة: يُسمح بالاعتماد إن كانت إعدادات فصل المهام تسمح، ويُسجَّل ذلك.", " You prepared this budget: approval is allowed only if the SoD settings allow it, and it is recorded.") : null}</p> : null}
        {dialog === "revise" ? <Field label={L("سبب التعديل (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="budget-reason" /></Field> : null}
        {dialog === "archive" ? <p>{L("الأرشفة نهائية؛ تبقى الموازنة للاطلاع فقط.", "Archiving is final; the budget stays for reference only.")}</p> : null}
        {dialog === "delete" ? <p>{L("تُحذف المسودة وأرقامها.", "The draft and its amounts are deleted.")}</p> : null}
      </Dialog>
    </AcctShell>
  );
}

function Pct({ c }: { c: Cell }) {
  const { L } = useLang();
  if (c.variancePct === null) return <span className="acct-hint">—</span>;
  return <span className={c.favourable === true ? "acct-good" : c.favourable === false ? "acct-bad" : ""} title={c.favourable === null ? undefined : c.favourable ? L("ملائم", "Favourable") : L("غير ملائم", "Unfavourable")}>{c.variancePct}%{c.favourable === null ? "" : c.favourable ? " ▲" : " ▼"}</span>;
}

function BudgetReport({ id, year }: { id: string; year: number }) {
  const { L, ar } = useLang();
  const [through, setThrough] = useState<string>("");
  const r = useApi<Report>(`/api/accounting/budgets/${id}/report${through ? `?through=${through}` : ""}`);
  const [month, setMonth] = useState<string>("");
  const t = r.data?.through ?? 12;
  const m = Number(month || String(Math.max(t, 1)));
  const cols = (c: Cell, href?: string) => <>
    <td className="num hr-num">{money(c.budget)}</td>
    <td className="num hr-num">{href ? <Link href={href}>{money(c.actual)}</Link> : money(c.actual)}</td>
    <td className={`num hr-num${c.favourable === false ? " acct-bad" : c.favourable ? " acct-good" : ""}`}>{money(c.variance)}</td>
    <td className="num hr-num"><Pct c={c} /></td>
  </>;
  return (
    <section className="acct-card" data-testid="budget-report">
      <div className="acct-row">
        <Field label={L("الشهر المعروض", "Month shown")}><Select value={String(m)} onChange={(e) => setMonth(e.target.value)} data-testid="bva-month">{(ar ? MONTHS_AR : MONTHS_EN).map((n, i) => <option key={i} value={String(i + 1)}>{n} {year}</option>)}</Select></Field>
        <Field label={L("منذ بداية السنة حتى", "Year to date through")}><Select value={through || String(t)} onChange={(e) => setThrough(e.target.value)} data-testid="bva-through">{(ar ? MONTHS_AR : MONTHS_EN).map((n, i) => <option key={i} value={String(i + 1)}>{n}</option>)}</Select></Field>
      </div>
      <p className="acct-hint">{L("الفعلي من دفتر الأستاذ (القيود المرحّلة، دون قيد إقفال السنة)، لكل حساب على طبيعته. الانحراف = الفعلي − الموازنة؛ النسبة من الموازنة. انقر الفعلي لفتح دفتر الأستاذ.", "Actuals from the general ledger (posted entries, the year-end closing entry excluded), each account on its natural side. Variance = actual − budget; % of budget. Click an actual to open the ledger.")}</p>
      {r.error ? <Msg error={r.error} /> : !r.data ? <OpsLoading /> : r.data.sections.length === 0 ? <p className="acct-hint">{L("لا مبالغ في الموازنة ولا حركات فعلية في السنة.", "No budget amounts and no actuals in the year.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="bva-table">
            <thead>
              <tr><th rowSpan={2}>{L("الحساب", "Account")}</th><th colSpan={4} className="num">{(ar ? MONTHS_AR : MONTHS_EN)[m - 1]} {year}</th><th colSpan={4} className="num">{L(`منذ بداية السنة (حتى ${MONTHS_AR[t - 1] ?? "—"})`, `Year to date (through ${MONTHS_EN[t - 1] ?? "—"})`)}</th><th rowSpan={2} className="num acct-hide-m">{L("موازنة السنة", "Full-year budget")}</th></tr>
              <tr>{[0, 1].flatMap((k) => [<th key={`b${k}`} className="num">{L("الموازنة", "Budget")}</th>, <th key={`a${k}`} className="num">{L("الفعلي", "Actual")}</th>, <th key={`v${k}`} className="num">{L("الانحراف", "Variance")}</th>, <th key={`p${k}`} className="num">%</th>])}</tr>
            </thead>
            <tbody>
              {r.data.sections.map((s) => [
                <tr key={s.key} className="is-sub"><td colSpan={10}>{L(s.ar, s.en)}</td></tr>,
                ...s.rows.map((row) => (
                  <tr key={row.accountId} className="is-clickable" data-testid={`bva-row-${row.code}`}>
                    <td className="acct-acc"><Link href={row.ledgerHref}><span className="acct-code">{row.code}</span> {ar ? row.name : row.nameEn}</Link>{row.budgeted ? null : <span className="acct-sub">{L("خارج الموازنة", "Not budgeted")}</span>}</td>
                    {cols(row.months[m - 1], row.monthHrefs[m - 1])}
                    {cols(row.ytd, row.ledgerHref)}
                    <td className="num hr-num acct-hide-m">{money(row.fullYearBudget)}</td>
                  </tr>
                )),
                <tr key={`${s.key}-t`} className="is-total"><td>{L(`إجمالي ${s.ar}`, `Total ${s.en.toLowerCase()}`)}</td>{cols(s.total.months[m - 1])}{cols(s.total.ytd)}<td className="num hr-num acct-hide-m">{money(s.total.fullYearBudget)}</td></tr>,
              ])}
              <tr className="is-total is-grand" data-testid="bva-net"><td>{L("صافي الربح", "Net profit")}</td>{cols(r.data.netProfit.months[m - 1])}{cols(r.data.netProfit.ytd)}<td className="num hr-num acct-hide-m">{money(r.data.netProfit.fullYearBudget)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
