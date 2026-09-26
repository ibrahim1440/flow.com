"use client";

import { Fragment, useMemo, useState } from "react";
import { Plus, FileDown, Camera, Lock, Unlock, Send, Pencil, GitBranch, MessageSquareText, AlertTriangle, CheckCircle2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import { useUser } from "../../user-context";
import { Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, api, useApi, useFinance, useHasSub, useL, withBranch, type Tone } from "../_components/ui";
import { monthName } from "../_components/helpers";
import { addMonths, riyadhDateString } from "@/lib/finance/dates";

type V = { planned: number; actual: number; variance: number; percentBp: number | null; state: string; adverse: boolean };
type Row = {
  lineKey: string; kind: "RECEIPT" | "PAYMENT"; code: string; nameEn: string; nameAr: string | null; finCategoryId: string;
  originalApproved: number | null; revisedApproved: number | null; baseline: number; plannedToDate: number; actualToDate: number;
  toDate: V; fullMonth: V; openCommitments: number; additionalForecast: number; remainingForecast: number; fac: number; forecastVariance: V;
  alert: boolean; ownerName: string | null; phasing: string | null; dueDate: string | null; unbudgeted: boolean;
  note: { id: string; explanation: string; correctiveAction: string | null; responsibleEmployeeId: string | null; followUpDate: string | null; status: string } | null;
};
type Report = {
  budget: { id: string; month: string; branchKey: string; status: string; basis: string; title: string | null };
  revisions: { id: string; revisionNo: number; status: string; reason: string | null; createdBy: string | null; createdAt: string; submittedBy: string | null; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null }[];
  workingRevision: { id: string; revisionNo: number; status: string; lines: { finCategoryId: string; kind: string; plannedAmount: string; dueDate: string | null; phasing: string; phasingWeights: Record<string, number> | null; ownerEmployeeId: string | null; assumptions: string | null; costCenterId: string | null }[] } | null;
  reportDate: string; monthOver: boolean; rows: Row[];
  totals: { receipts: { toDate: V; fullMonth: V; forecast: V }; payments: { toDate: V; fullMonth: V; forecast: V } };
  netCashFlow: { toDate: number; forecast: number; planned: number };
  memo: { lineKey: string; finCategoryId: string; planned: number; assumptions: string | null }[];
  completeness: { needsReview: number; pending: number; reconciledThrough: string | null; complete: boolean; refreshedAt: string };
};
type BudgetListItem = { id: string; month: string; branchKey: string; status: string; title: string | null };
type Setup = { branches: { id: string; nameEn: string; nameAr: string | null }[]; finCategories: { id: string; code: string; nameEn: string; nameAr: string | null; kind: string; active: boolean }[]; people: { id: string; name: string }[]; scope: { all: boolean } };

const STATE: Record<string, [string, string, Tone]> = {
  OVERRUN: ["تجاوز", "Overrun", "bad"], SHORTFALL: ["نقص", "Shortfall", "warn"], BELOW_BUDGET: ["أقل من الميزانية", "Below budget", "info"],
  ABOVE_PLAN: ["فوق الخطة", "Above plan", "ok"], ON_PLAN: ["مطابق", "On plan", "ok"], NO_ACTIVITY: ["لا نشاط بعد", "No activity yet", "info"], UNBUDGETED: ["غير مدرج", "Unbudgeted", "warn"],
};
const BSTATUS: Record<string, [string, string, Tone]> = { DRAFT: ["مسودة", "Draft", "info"], SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warn"], APPROVED: ["معتمدة", "Approved", "ok"], CLOSED: ["مغلقة", "Closed", "info"] };

export default function BudgetPage() {
  const { L, lang, money, pct, name } = useL();
  const user = useUser();
  const { branch, refresh } = useFinance();
  const canPrepare = useHasSub(user?.permissions, "budget_prepare");
  const canClose = useHasSub(user?.permissions, "period_close");
  const list = useApi<BudgetListItem[]>("/api/finance/budgets");
  const setup = useApi<Setup>("/api/finance/setup");
  const [idPick, setId] = useState<string>("");
  const [thisMonth] = useState(() => riyadhDateString().slice(0, 7));
  const id = idPick && list.data?.some((x) => x.id === idPick) ? idPick : (list.data?.find((x) => x.month === thisMonth) ?? list.data?.[0])?.id ?? "";
  const [date, setDate] = useState<string>("");
  const [kind, setKind] = useState<"PAYMENT" | "RECEIPT">("PAYMENT");
  const [dlg, setDlg] = useState<null | "new" | "lines" | "revise" | "reopen">(null);
  const [noteRow, setNoteRow] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const rep = useApi<Report>(id ? `/api/finance/budgets/${id}${date ? `?date=${date}` : ""}` : null);
  const r = rep.data;
  const branchName = (k: string) => (k === "COMPANY" ? L("مستوى الشركة", "Company level") : name(setup.data?.branches.find((b) => b.id === k) ?? { nameEn: k }));
  const person = (pid: string | null) => setup.data?.people.find((p) => p.id === pid)?.name ?? "—";
  const reload = () => { rep.reload(); list.reload(); refresh(); };

  async function act(path: string, json: unknown, ok: string) {
    setBusy(true); setErr(null); setMsg(null);
    try { await api(withBranch(path, branch), { method: "POST", json }); setMsg(ok); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (list.loading && !list.data) return <LoadingState />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  if (list.data && list.data.length === 0) return (
    <>
      <EmptyState title={L("لا توجد ميزانيات بعد", "No budgets yet")} body={L("أنشئ ميزانية شهرية نقدية (مقبوضات ومدفوعات). يمكنك البدء من ميزانية الشهر السابق أو من الفعلي التاريخي.", "Create a monthly cash budget (receipts and payments). Start from last month's budget or from historical actuals.")}>
        {canPrepare && <Button kind="primary" icon={Plus} onClick={() => setDlg("new")}>{L("ميزانية جديدة", "New budget")}</Button>}
      </EmptyState>
      <NewBudgetDialog open={dlg === "new"} onClose={() => setDlg(null)} setup={setup.data} onCreated={(nid) => { setId(nid); list.reload(); }} />
    </>
  );

  const working = r?.workingRevision;
  const draft = r?.revisions.find((x) => x.status === "DRAFT" || x.status === "REJECTED");
  const submitted = r?.revisions.find((x) => x.status === "SUBMITTED");
  const rows = r?.rows ?? [];
  const chartRows = rows.filter((x) => x.kind === kind).map((x) => ({ n: name(x), p: x.plannedToDate / 100, a: x.actualToDate / 100, over: x.kind === "PAYMENT" ? x.actualToDate > x.plannedToDate : x.actualToDate < x.plannedToDate }));
  const vColor = (v: V, k: string) => (v.state === "OVERRUN" ? "text-red-600" : v.state === "SHORTFALL" ? "text-amber-700" : v.state === "ABOVE_PLAN" && k === "RECEIPT" ? "text-green-600" : "text-charcoal");

  return (
    <div className="flex flex-col gap-5">
      <Card pad="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <select aria-label={L("الشهر", "Month")} className={`${INPUT} !w-auto font-bold !text-sm`} value={id} onChange={(e) => { setId(e.target.value); setDate(""); }}>
              {list.data?.map((b) => <option key={b.id} value={b.id}>{monthName(b.month, lang)} {b.month.slice(0, 4)} · {branchName(b.branchKey)}</option>)}
            </select>
            {r && <Badge tone={BSTATUS[r.budget.status][2]}>{L(BSTATUS[r.budget.status][0], BSTATUS[r.budget.status][1])}</Badge>}
            {working && working.revisionNo > 1 && <Badge tone="brand">{L(`المراجعة ${working.revisionNo}`, `Revision ${working.revisionNo}`)}</Badge>}
            <span className="text-xs text-brown">{L("أساس نقدي", "Cash basis")}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {r && (
              <label className="flex items-center gap-2 bg-white border border-border rounded-[10px] px-3 py-1.5">
                <span className="text-xs text-brown">{L("تاريخ التقرير", "Report date")}</span>
                <input type="date" className="text-[13px] font-bold outline-none bg-transparent" value={date || r.reportDate} min={`${r.budget.month}-01`} max={`${r.budget.month}-31`} onChange={(e) => setDate(e.target.value)} />
              </label>
            )}
            {canPrepare && <Button icon={Plus} onClick={() => setDlg("new")}>{L("ميزانية جديدة", "New budget")}</Button>}
            {canPrepare && r?.budget.status === "APPROVED" && !draft && !submitted && <Button icon={GitBranch} onClick={() => setDlg("revise")}>{L("مراجعة جديدة", "New revision")}</Button>}
            {canPrepare && draft && <Button icon={Pencil} onClick={() => setDlg("lines")}>{L("تعديل البنود", "Edit lines")}</Button>}
            {canPrepare && draft && <Button kind="primary" icon={Send} busy={busy} onClick={() => act(`/api/finance/budgets/${id}/submit`, {}, L("أُرسلت للاعتماد.", "Sent for approval."))}>{L("إرسال للاعتماد", "Submit for approval")}</Button>}
            {canPrepare && r && r.budget.status !== "DRAFT" && <Button icon={Camera} busy={busy} onClick={() => act(`/api/finance/budgets/${id}/snapshots`, { date: date || r.reportDate }, L("حُفظت لقطة التوقع دون تغيير الميزانية المعتمدة.", "Forecast snapshot saved; the approved budget is unchanged."))}>{L("لقطة توقع", "Forecast snapshot")}</Button>}
            {canClose && r?.budget.status === "APPROVED" && <Button icon={Lock} busy={busy} onClick={() => { if (confirm(L("إغلاق الفترة؟ إعادة الفتح تتطلب موافقة.", "Close the period? Reopening needs approval."))) act(`/api/finance/budgets/${id}/close`, {}, L("أُغلقت الفترة.", "Period closed.")); }}>{L("إغلاق الفترة", "Close period")}</Button>}
            {canClose && r?.budget.status === "CLOSED" && <Button icon={Unlock} onClick={() => setDlg("reopen")}>{L("طلب إعادة فتح", "Request reopen")}</Button>}
            {r && <a href={withBranch(`/api/finance/export?kind=budget&id=${id}&format=xlsx${date ? `&date=${date}` : ""}`, branch)} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-bold bg-orange text-white"><FileDown size={16} />{L("تصدير", "Export")}</a>}
          </div>
        </div>
        {submitted && <Notice tone="warn">{L(`المراجعة ${submitted.revisionNo} بانتظار الاعتماد.`, `Revision ${submitted.revisionNo} is awaiting approval.`)}</Notice>}
        {draft && <Notice tone="info">{L(`المراجعة ${draft.revisionNo} مسودة${draft.status === "REJECTED" ? " (مرفوضة — عدّل وأعد الإرسال)" : ""}. الأرقام أدناه ${r?.revisions.some((x) => x.status === "APPROVED") ? "تستخدم آخر مراجعة معتمدة" : "من المسودة ولم تُعتمد"}.`, `Revision ${draft.revisionNo} is a draft${draft.status === "REJECTED" ? " (rejected — edit and resubmit)" : ""}. Figures below ${r?.revisions.some((x) => x.status === "APPROVED") ? "use the latest approved revision" : "come from the unapproved draft"}.`)}</Notice>}
        {err && <Notice tone="bad">{err}</Notice>}
        {msg && <Notice tone="ok" icon={CheckCircle2}>{msg}</Notice>}
      </Card>

      {rep.loading && !r ? <LoadingState /> : rep.error ? <ErrorState error={rep.error} onRetry={rep.reload} /> : r && (
        <>
          {!r.completeness.complete ? (
            <Notice tone="warn" icon={AlertTriangle}>
              {L(`الأرقام الفعلية أولية: ${r.completeness.needsReview} سطر بحاجة لمراجعة · ${r.completeness.pending} معلّق · ${r.completeness.reconciledThrough ? `الحسابات مُسوّاة حتى ${r.completeness.reconciledThrough}` : "لم تُسوَّ جميع الحسابات"} حتى ${r.reportDate}. آخر تحديث ${r.completeness.refreshedAt.slice(11, 16)} UTC.`,
                `Actuals are provisional: ${r.completeness.needsReview} lines need review · ${r.completeness.pending} pending · ${r.completeness.reconciledThrough ? `accounts reconciled through ${r.completeness.reconciledThrough}` : "not every account is reconciled"} to ${r.reportDate}. Refreshed ${r.completeness.refreshedAt.slice(11, 16)} UTC.`)}
            </Notice>
          ) : (
            <Notice tone="ok" icon={CheckCircle2}>{L(`الأرقام الفعلية مكتملة: كل السطور مُراجعة وكل الحسابات مُسوّاة حتى ${r.reportDate}. الصفر هنا صفر مؤكد.`, `Actuals are complete: every line is reviewed and every account reconciled to ${r.reportDate}. A zero here is a verified zero.`)}</Notice>
          )}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <SummaryCard title={L("المقبوضات حتى تاريخه", "Receipts to date")} v={r.totals.receipts.toDate} kind="RECEIPT" note={L("تشمل التمويل إن وُجد (مساهمات، قروض)", "Includes financing if any (contributions, loans)")} />
            <SummaryCard title={L("المدفوعات حتى تاريخه", "Payments to date")} v={r.totals.payments.toDate} kind="PAYMENT" note={L("أقل من الميزانية ≠ وفر بالضرورة", "Below budget is not necessarily a saving")} />
            <Card pad="p-4"><p className="text-xs font-bold text-brown">{L("صافي التدفق النقدي حتى تاريخه", "Net cash flow to date")}</p><p className="text-xl font-extrabold tabular-nums">{money(r.netCashFlow.toDate)}</p><p className="text-[11px] font-bold text-amber-700">{L("ليس ربحاً محاسبياً", "Not accounting profit")}</p></Card>
            <Card pad="p-4"><p className="text-xs font-bold text-brown">{L("المتوقع عند نهاية الشهر", "Expected at month end")}</p><p className="text-sm font-bold tabular-nums">{L(`مقبوضات ${money(r.totals.receipts.forecast.actual)} · مدفوعات ${money(r.totals.payments.forecast.actual)}`, `Receipts ${money(r.totals.receipts.forecast.actual)} · payments ${money(r.totals.payments.forecast.actual)}`)}</p><p className="text-[11px] text-brown-light">{L(`الميزانية الكاملة: ${money(r.totals.receipts.fullMonth.planned)} / ${money(r.totals.payments.fullMonth.planned)}`, `Full budget: ${money(r.totals.receipts.fullMonth.planned)} / ${money(r.totals.payments.fullMonth.planned)}`)}</p></Card>
          </div>

          <Card>
            <CardTitle title={L("المخطط حتى تاريخه مقابل الفعلي", "Planned to date vs actual")} sub={L(`حتى ${r.reportDate} · الخطة مجزأة زمنياً حسب تاريخ الاستحقاق`, `To ${r.reportDate} · the plan is phased by due date`)}
              right={<Segmented value={kind} onChange={setKind} options={[{ value: "PAYMENT", label: L("المدفوعات", "Payments") }, { value: "RECEIPT", label: L("المقبوضات", "Receipts") }]} />} />
            <div className="h-[240px]" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={4}>
                  <CartesianGrid stroke="#F3F4F6" vertical={false} />
                  <XAxis dataKey="n" reversed={lang === "ar"} tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis orientation={lang === "ar" ? "right" : "left"} tick={{ fontSize: 11, fill: "#9CA3AF" }} axisLine={false} tickLine={false} tickFormatter={(v) => (v ? `${Math.round(v / 1000)}k` : "0")} width={44} />
                  <Tooltip formatter={(v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })} />
                  <Bar dataKey="p" name={L("المخطط حتى تاريخه", "Planned to date")} fill="#C4B5FD" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="a" name={L("الفعلي", "Actual")} radius={[4, 4, 0, 0]} maxBarSize={22}>
                    {chartRows.map((c, i) => <Cell key={i} fill={c.over ? "#DC2626" : "#7C3AED"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex gap-4 text-xs text-brown">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-[#C4B5FD]" />{L("المخطط حتى تاريخه", "Planned to date")}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-orange" />{L("الفعلي", "Actual")}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-red-600" />{kind === "PAYMENT" ? L("الفعلي فوق الخطة", "Actual above plan") : L("الفعلي دون الخطة", "Actual below plan")}</span>
            </div>
          </Card>

          <Card pad="p-4">
            <CardTitle title={L("المقارنة الشهرية", "Monthly comparison")} sub={L("الانحراف = الفعلي − المخطط المقابل · النسبة على القيمة المطلقة للمخطط · المتوقع عند الإكمال = الفعلي + المتبقي المتوقع", "Variance = actual − corresponding plan · percent of |plan| · forecast at completion = actual + remaining forecast")} />
            <Table>
              <thead><tr>
                <Th>{L("البند", "Line")}</Th><Th num>{L("الميزانية المعتمدة", "Approved budget")}</Th><Th num>{L("المخطط حتى تاريخه", "Planned to date")}</Th><Th num>{L("الفعلي حتى تاريخه", "Actual to date")}</Th>
                <Th num>{L("الانحراف حتى تاريخه", "Variance to date")}</Th><Th>{L("الحالة", "Status")}</Th><Th num>{L("المتبقي المتوقع", "Remaining forecast")}</Th><Th num>{L("المتوقع عند الإكمال", "Forecast at completion")}</Th><Th num>{L("انحراف التوقع", "Forecast variance")}</Th><Th />
              </tr></thead>
              <tbody>
                {(["RECEIPT", "PAYMENT"] as const).map((k) => (
                  <Fragment key={k}>
                    <tr><td colSpan={10} className="bg-orange-light px-3 py-1.5 text-xs font-extrabold text-orange">{k === "RECEIPT" ? L("المقبوضات", "Receipts") : L("المدفوعات", "Payments")}</td></tr>
                    {rows.filter((x) => x.kind === k).map((x) => {
                      const st = STATE[x.toDate.state];
                      return (
                        <tr key={x.lineKey} className="hover:bg-cream cursor-pointer" onClick={() => setNoteRow(x)}>
                          <Td className="min-w-[180px]"><span className="font-medium">{name(x)}</span>{x.alert && <span className="ms-1.5"><Badge tone="bad">{L("تنبيه", "Alert")}</Badge></span>}{x.ownerName && <p className="text-[11px] text-brown-light">{x.ownerName}</p>}</Td>
                          <Td num><b>{x.unbudgeted ? "—" : money(x.baseline)}</b>{x.revisedApproved !== null && x.originalApproved !== null && x.revisedApproved !== x.originalApproved && <p className="text-[11px] text-brown-light">{L("الأصلية", "Original")} {money(x.originalApproved)}</p>}</Td>
                          <Td num className="text-brown">{money(x.plannedToDate)}</Td>
                          <Td num className="font-bold">{money(x.actualToDate)}{x.actualToDate === 0 && <p className="text-[10px] font-normal text-brown-light">{r.completeness.complete ? L("صفر مؤكد", "verified zero") : L("قد تكون البيانات ناقصة", "data may be incomplete")}</p>}</Td>
                          <Td num><b className={vColor(x.toDate, k)}>{money(x.toDate.variance, { sign: true })}</b><p className={`text-[11px] ${vColor(x.toDate, k)}`}>{pct(x.toDate.percentBp)}</p></Td>
                          <Td><Badge tone={st[2]}>{L(st[0], st[1])}</Badge></Td>
                          <Td num><b>{money(x.remainingForecast)}</b>{x.openCommitments > 0 && <p className="text-[11px] text-brown-light">{L("التزامات", "Commitments")} {money(x.openCommitments)}</p>}{x.additionalForecast > 0 && <p className="text-[11px] text-brown-light">{L("توقعات", "Forecast")} {money(x.additionalForecast)}</p>}</Td>
                          <Td num className="font-bold">{money(x.fac)}</Td>
                          <Td num>{money(x.forecastVariance.variance, { sign: true })}</Td>
                          <Td><span className={`inline-flex w-6 h-6 rounded-md items-center justify-center ${x.note ? "bg-orange-light text-orange" : "text-brown-light"}`}><MessageSquareText size={14} /></span></Td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
                {(["RECEIPT", "PAYMENT"] as const).map((k) => {
                  const t = k === "RECEIPT" ? r.totals.receipts : r.totals.payments;
                  const st = STATE[t.toDate.state];
                  const rem = rows.filter((x) => x.kind === k).reduce((s, x) => s + x.remainingForecast, 0);
                  return (
                    <tr key={k} className="bg-cream-dark">
                      <Td className="font-extrabold">{k === "RECEIPT" ? L("إجمالي المقبوضات", "Total receipts") : L("إجمالي المدفوعات", "Total payments")}</Td>
                      <Td num className="font-bold">{money(t.fullMonth.planned)}</Td><Td num className="font-bold">{money(t.toDate.planned)}</Td><Td num className="font-bold">{money(t.toDate.actual)}</Td>
                      <Td num><b className={vColor(t.toDate, k)}>{money(t.toDate.variance, { sign: true })}</b><p className={`text-[11px] ${vColor(t.toDate, k)}`}>{pct(t.toDate.percentBp)}</p></Td>
                      <Td><Badge tone={st[2]}>{L(st[0], st[1])}</Badge></Td>
                      <Td num className="font-bold">{money(rem)}</Td><Td num className="font-bold">{money(t.forecast.actual)}</Td><Td num className="font-bold">{money(t.forecast.variance, { sign: true })}</Td><Td />
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="text-xs text-brown">{L("المقارنة الكاملة للشهر (الفعلي مقابل كامل الميزانية) معروضة في التصدير وتفاصيل البند؛ لا تُعد مقارنة عادلة منتصف الشهر.", "The full-month comparison (actual vs the whole budget) is in the export and line details; it is not a fair comparison mid-month.")}</p>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_460px] gap-4 items-start">
            <NotesSummary rows={rows} person={person} onOpen={setNoteRow} />
            <Card>
              <CardTitle title={L("سجل المراجعات", "Revision history")} sub={L("النسخة الأصلية المعتمدة هي خط الأساس ولا تُعدّل", "The original approved version is the baseline and is never edited")} />
              {[...r.revisions].reverse().map((v) => (
                <div key={v.id} className="rounded-[10px] bg-cream-dark px-3 py-2.5 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2"><span className="text-[13px] font-extrabold">{L(`المراجعة ${v.revisionNo}`, `Revision ${v.revisionNo}`)}</span>
                    <Badge tone={v.status === "APPROVED" ? (v.revisionNo === 1 ? "ok" : "brand") : v.status === "REJECTED" ? "bad" : v.status === "SUBMITTED" ? "warn" : "info"}>
                      {v.status === "APPROVED" ? (v.revisionNo === 1 ? L("أصلية معتمدة", "Original approved") : L("معتمدة", "Approved")) : L(BSTATUS[v.status]?.[0] ?? v.status, BSTATUS[v.status]?.[1] ?? v.status)}
                    </Badge></div>
                  <p className="text-xs">{v.reason ?? "—"}</p>
                  <p className="text-[11px] text-brown-light">{L(`أعدّها ${person(v.createdBy)}${v.decidedBy ? ` · ${v.status === "REJECTED" ? "رفضها" : "اعتمدها"} ${person(v.decidedBy)}` : ""} · ${(v.decidedAt ?? v.createdAt).slice(0, 10)}`, `Prepared by ${person(v.createdBy)}${v.decidedBy ? ` · ${v.status === "REJECTED" ? "rejected" : "approved"} by ${person(v.decidedBy)}` : ""} · ${(v.decidedAt ?? v.createdAt).slice(0, 10)}`)}{v.decisionNote ? ` · ${v.decisionNote}` : ""}</p>
                </div>
              ))}
              {r.memo.length > 0 && (
                <div className="rounded-[10px] border border-border px-3 py-2.5">
                  <p className="text-xs font-bold text-brown">{L("مبيعات متوقعة (مذكرة — ليست تحصيلات)", "Expected sales (memo — not collections)")}</p>
                  {r.memo.map((m) => <p key={m.lineKey} className="text-[13px]">{name(setup.data?.finCategories.find((c) => c.id === m.finCategoryId) ?? null)}: {money(m.planned)}</p>)}
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      <NewBudgetDialog open={dlg === "new"} onClose={() => setDlg(null)} setup={setup.data} onCreated={(nid) => { setId(nid); list.reload(); }} />
      {r && <LinesDialog open={dlg === "lines"} onClose={() => setDlg(null)} report={r} setup={setup.data} onSaved={reload} />}
      <ReasonDialog open={dlg === "revise"} onClose={() => setDlg(null)} title={L("مراجعة جديدة للميزانية المعتمدة", "New revision of the approved budget")} sub={L("تُنسخ البنود من آخر مراجعة معتمدة. تبقى النسخ السابقة كما هي.", "Lines are copied from the latest approved revision. Earlier versions stay as they are.")}
        onSubmit={(reason) => act(`/api/finance/budgets/${id}/revise`, { reason }, L("أُنشئت مراجعة جديدة كمسودة.", "A new draft revision was created."))} />
      <ReasonDialog open={dlg === "reopen"} onClose={() => setDlg(null)} title={L("طلب إعادة فتح الفترة", "Request to reopen the period")} sub={L("يتطلب موافقة صاحب صلاحية الإغلاق غيرك.", "Needs approval from another holder of the close duty.")}
        onSubmit={(reason) => act(`/api/finance/budgets/${id}/reopen`, { reason }, L("أُرسل الطلب للموافقة.", "Sent for approval."))} />
      {r && <NoteDialog key={noteRow?.lineKey ?? "none"} row={noteRow} budgetId={id} reportDate={date || r.reportDate} people={setup.data?.people ?? []} canPrepare={canPrepare} onClose={() => setNoteRow(null)} onSaved={rep.reload} />}
    </div>
  );
}

function SummaryCard({ title, v, kind, note }: { title: string; v: V; kind: string; note: string }) {
  const { L, money, pct } = useL();
  const tone: Tone = v.state === "OVERRUN" ? "bad" : v.state === "SHORTFALL" ? "warn" : v.state === "ABOVE_PLAN" && kind === "RECEIPT" ? "ok" : "info";
  return (
    <Card pad="p-4">
      <p className="text-xs font-bold text-brown">{title}</p>
      <div className="flex items-end gap-2"><span className="text-xl font-extrabold tabular-nums">{money(v.actual)}</span><span className="text-xs text-brown-light">{L("من", "of")} {money(v.planned)}</span></div>
      <div className="flex items-center gap-1.5"><span className={`text-[13px] font-bold tabular-nums ${tone === "ok" ? "text-green-600" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-700" : "text-charcoal"}`}>{money(v.variance, { sign: true })}</span><Badge tone={tone}>{pct(v.percentBp)}</Badge></div>
      <p className="text-[11px] text-brown-light">{note}</p>
    </Card>
  );
}

function NotesSummary({ rows, person, onOpen }: { rows: Row[]; person: (id: string | null) => string; onOpen: (r: Row) => void }) {
  const { L, money, pct, name } = useL();
  const noted = rows.filter((r) => r.note || r.alert);
  const first = noted.find((r) => r.note) ?? noted[0];
  if (!first) return <Card><CardTitle title={L("تفسيرات الانحراف", "Variance explanations")} sub={L("لا توجد انحرافات تتجاوز حدود التنبيه.", "No variance crosses the alert thresholds.")} /></Card>;
  const n = first.note;
  return (
    <Card>
      <CardTitle title={L(`تفسير الانحراف — ${name(first)}`, `Variance explanation — ${name(first)}`)} sub={L(`${STATE[first.toDate.state][0]} ${money(Math.abs(first.toDate.variance))} (${pct(first.toDate.percentBp)}) حتى تاريخه`, `${STATE[first.toDate.state][1]} ${money(Math.abs(first.toDate.variance))} (${pct(first.toDate.percentBp)}) to date`)}
        right={n ? <Badge tone={n.status === "OPEN" ? "warn" : "ok"}>{n.status === "OPEN" ? L("مفتوح", "Open") : L("محلول", "Resolved")}</Badge> : <Badge tone="bad">{L("بلا تفسير", "Unexplained")}</Badge>} />
      {n ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-xs font-bold text-brown">{L("السبب", "Cause")}</dt><dd>{n.explanation}</dd>
          <dt className="text-xs font-bold text-brown">{L("الإجراء التصحيحي", "Corrective action")}</dt><dd>{n.correctiveAction ?? "—"}</dd>
          <dt className="text-xs font-bold text-brown">{L("المسؤول", "Responsible")}</dt><dd>{person(n.responsibleEmployeeId)}</dd>
          <dt className="text-xs font-bold text-brown">{L("تاريخ المتابعة", "Follow-up date")}</dt><dd>{n.followUpDate ?? "—"}</dd>
        </dl>
      ) : <p className="text-[13px] text-brown">{L("سجّل السبب والإجراء التصحيحي والمسؤول وتاريخ المتابعة.", "Record the cause, corrective action, owner and follow-up date.")}</p>}
      <div className="flex gap-2 flex-wrap">
        <Button kind="primary" onClick={() => onOpen(first)}>{n ? L("عرض وإضافة تفسير", "View and add explanation") : L("إضافة تفسير", "Add explanation")}</Button>
        {noted.filter((r) => r !== first).map((r) => <Button key={r.lineKey} kind="ghost" onClick={() => onOpen(r)}>{name(r)}</Button>)}
      </div>
    </Card>
  );
}

function NoteDialog({ row, budgetId, reportDate, people, canPrepare, onClose, onSaved }: { row: Row | null; budgetId: string; reportDate: string; people: { id: string; name: string }[]; canPrepare: boolean; onClose: () => void; onSaved: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const [f, setF] = useState({ explanation: "", correctiveAction: "", responsibleEmployeeId: "", followUpDate: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const dd = useApi<{ splits: { id: string; amount: string; transaction: { id: string; txnDate: string; description: string | null; bankReference: string | null; cashAccount: { code: string } } }[]; obligations: { id: string; description: string; amount: string; dueDate: string }[]; forecastItems: { id: string; description: string; amount: string; expectedDate: string }[] }>(row ? `/api/finance/budgets/${budgetId}/drilldown?lineKey=${encodeURIComponent(row.lineKey)}&date=${reportDate}` : null);
  if (!row) return null;
  async function save() {
    setBusy(true); setErr(null);
    try { await api(withBranch(`/api/finance/budgets/${budgetId}/notes`, branch), { method: "POST", json: { lineKey: row!.lineKey, ...f, responsibleEmployeeId: f.responsibleEmployeeId || undefined, followUpDate: f.followUpDate || undefined } }); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function resolve() {
    if (!row?.note) return;
    setBusy(true);
    try { await api(withBranch(`/api/finance/notes/${row.note.id}/resolve`, branch), { method: "POST", json: {} }); onSaved(); onClose(); } finally { setBusy(false); }
  }
  const M = (s: string) => Math.round(Number(s) * 100);
  const sign = row.kind === "PAYMENT" ? -1 : 1;
  return (
    <Dialog open={!!row} onClose={onClose} width="max-w-[760px]" title={name(row)} sub={L("تفاصيل البند: السطور البنكية المصدر، والالتزامات، والتوقعات. تُصحح الأرقام الفعلية من مستنداتها فقط.", "Line detail: source bank lines, commitments and forecasts. Actuals are corrected only through their source documents.")}>
      {dd.loading && !dd.data ? <LoadingState /> : dd.data && (
        <Table>
          <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("المصدر", "Source")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
          <tbody>
            {dd.data.splits.map((s) => <tr key={s.id}><Td className="text-brown">{s.transaction.txnDate.slice(0, 10)}</Td><Td>{s.transaction.cashAccount.code} · {s.transaction.description ?? ""}{s.transaction.bankReference ? ` · ${s.transaction.bankReference}` : ""}</Td><Td num className="font-bold">{money(sign * M(s.amount))}</Td></tr>)}
            {dd.data.obligations.map((o) => <tr key={o.id}><Td className="text-brown">{o.dueDate.slice(0, 10)}</Td><Td>{L("التزام مفتوح", "Open obligation")}: {o.description}</Td><Td num>{money(M(o.amount))}</Td></tr>)}
            {dd.data.forecastItems.map((o) => <tr key={o.id}><Td className="text-brown">{o.expectedDate.slice(0, 10)}</Td><Td>{L("توقع", "Forecast")}: {o.description}</Td><Td num>{money(M(o.amount))}</Td></tr>)}
            {dd.data.splits.length + dd.data.obligations.length + dd.data.forecastItems.length === 0 && <tr><Td className="text-brown">{L("لا توجد حركات لهذا البند.", "Nothing recorded for this line.")}</Td><Td /><Td /></tr>}
          </tbody>
        </Table>
      )}
      {row.note && (
        <div className="rounded-[10px] bg-cream-dark px-3 py-2.5 text-[13px] flex flex-col gap-1">
          <p><b>{L("آخر تفسير", "Latest explanation")}:</b> {row.note.explanation}</p>
          {row.note.correctiveAction && <p>{L("الإجراء", "Action")}: {row.note.correctiveAction}</p>}
          {canPrepare && row.note.status === "OPEN" && <Button kind="ghost" busy={busy} onClick={resolve}>{L("تم الحل", "Mark resolved")}</Button>}
        </div>
      )}
      {canPrepare && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={L("السبب", "Cause")}><input className={INPUT} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field>
            <Field label={L("الإجراء التصحيحي", "Corrective action")}><input className={INPUT} value={f.correctiveAction} onChange={(e) => setF({ ...f, correctiveAction: e.target.value })} /></Field>
            <Field label={L("المسؤول", "Responsible")}><select className={INPUT} value={f.responsibleEmployeeId} onChange={(e) => setF({ ...f, responsibleEmployeeId: e.target.value })}><option value="">—</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label={L("تاريخ المتابعة", "Follow-up date")}><input type="date" className={INPUT} value={f.followUpDate} onChange={(e) => setF({ ...f, followUpDate: e.target.value })} /></Field>
          </div>
          {err && <Notice tone="bad">{err}</Notice>}
          <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={!f.explanation} onClick={save}>{L("إضافة تفسير", "Add explanation")}</Button><Button onClick={onClose}>{L("إغلاق", "Close")}</Button></div>
        </>
      )}
    </Dialog>
  );
}

type NewBudgetProps = { open: boolean; onClose: () => void; setup: Setup | null; onCreated: (id: string) => void };
function NewBudgetDialog(props: NewBudgetProps) {
  return props.open ? <NewBudgetBody {...props} /> : null;
}

function NewBudgetBody({ open, onClose, setup, onCreated }: NewBudgetProps) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const [form, setF] = useState(() => ({ month: addMonths(riyadhDateString().slice(0, 7), 1), branchKey: "", startFrom: "COPY_PREVIOUS", title: "" }));
  const f = { ...form, branchKey: form.branchKey || (setup?.scope.all ? "COMPANY" : setup?.branches[0]?.id ?? "") };
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try { const b = await api<{ id: string }>(withBranch("/api/finance/budgets", branch), { method: "POST", json: f }); onCreated(b.id); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={L("ميزانية شهرية جديدة", "New monthly budget")} sub={L("ميزانية نقدية: مقبوضات ومدفوعات. عرض الاستحقاق غير متاح حتى تُرحّل الوحدات قيودها المحاسبية.", "Cash budget: receipts and payments. The accrual view is unavailable until operational modules post accounting entries.")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("الشهر", "Month")}><input type="month" className={INPUT} value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
        <Field label={L("النطاق", "Scope")}><select className={INPUT} value={f.branchKey} onChange={(e) => setF({ ...f, branchKey: e.target.value })}>{setup?.scope.all && <option value="COMPANY">{L("الشركة (موحّد)", "Company (consolidated)")}</option>}{setup?.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
      </div>
      <Field label={L("نقطة البداية", "Starting point")}><select className={INPUT} value={f.startFrom} onChange={(e) => setF({ ...f, startFrom: e.target.value })}><option value="COPY_PREVIOUS">{L("نسخ الميزانية المعتمدة للشهر السابق", "Copy last month's approved budget")}</option><option value="HISTORICAL_ACTUALS">{L("الفعلي التاريخي للشهر السابق", "Last month's actuals")}</option><option value="EMPTY">{L("فارغة", "Empty")}</option></select></Field>
      <Field label={L("العنوان (اختياري)", "Title (optional)")}><input className={INPUT} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("إنشاء", "Create")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

type LineF = { kind: string; finCategoryId: string; plannedAmount: string; phasing: string; dueDate: string; weights: string; ownerEmployeeId: string; assumptions: string };
type LinesProps = { open: boolean; onClose: () => void; report: Report; setup: Setup | null; onSaved: () => void };
function LinesDialog(props: LinesProps) {
  const draft = props.report.revisions.find((x) => x.status === "DRAFT" || x.status === "REJECTED");
  const draftLines = useApi<{ lines: NonNullable<Report["workingRevision"]>["lines"] }>(props.open && draft ? `/api/finance/budgets/${props.report.budget.id}/lines` : null);
  if (!props.open || !draft || (draftLines.loading && !draftLines.data)) return null;
  return <LinesBody key={draft.id} {...props} src={draftLines.data?.lines ?? []} />;
}

function LinesBody({ open, onClose, report, setup, onSaved, src }: LinesProps & { src: NonNullable<Report["workingRevision"]>["lines"] }) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const [lines, setLines] = useState<LineF[]>(() => src.map((l) => ({ kind: l.kind, finCategoryId: l.finCategoryId, plannedAmount: Number(l.plannedAmount).toFixed(2), phasing: l.phasing, dueDate: l.dueDate?.slice(0, 10) ?? "", weights: l.phasingWeights ? JSON.stringify(l.phasingWeights) : "", ownerEmployeeId: l.ownerEmployeeId ?? "", assumptions: l.assumptions ?? "" })));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const cats = useMemo(() => setup?.finCategories.filter((c) => c.active) ?? [], [setup]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body = lines.map((l) => ({ kind: l.kind, finCategoryId: l.finCategoryId, plannedAmount: l.plannedAmount, phasing: l.phasing, dueDate: l.dueDate || null, phasingWeights: l.phasing === "CUSTOM_WEIGHTS" && l.weights ? JSON.parse(l.weights) : undefined, ownerEmployeeId: l.ownerEmployeeId || null, assumptions: l.assumptions || null }));
      await api(withBranch(`/api/finance/budgets/${report.budget.id}/lines`, branch), { method: "PUT", json: { lines: body } }); onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const set = (i: number, k: keyof LineF, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[1000px]" title={L(`بنود ميزانية ${report.budget.month}`, `Budget lines — ${report.budget.month}`)} sub={L("التجزئة الافتراضية حسب تاريخ الاستحقاق؛ التوزيع الخطي يُختار صراحةً. المبيعات المتوقعة مذكرة ولا تدخل الإجماليات النقدية.", "Default phasing is by due date; straight-line must be chosen explicitly. Expected sales are a memo and never enter cash totals.")}>
      <div className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[0.8fr_1.6fr_0.9fr_1fr_1fr_1fr_auto] gap-2 items-center">
            <select aria-label={L("النوع", "Kind")} className={INPUT} value={l.kind} onChange={(e) => set(i, "kind", e.target.value)}><option value="RECEIPT">{L("مقبوضات", "Receipt")}</option><option value="PAYMENT">{L("مدفوعات", "Payment")}</option><option value="SALES_MEMO">{L("مبيعات (مذكرة)", "Sales (memo)")}</option></select>
            <select aria-label={L("البند", "Category")} className={INPUT} value={l.finCategoryId} onChange={(e) => set(i, "finCategoryId", e.target.value)}><option value="">—</option>{cats.filter((c) => l.kind === "SALES_MEMO" || c.kind === l.kind).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select>
            <input aria-label={L("المخطط", "Planned")} className={`${INPUT} font-bold`} value={l.plannedAmount} onChange={(e) => set(i, "plannedAmount", e.target.value)} inputMode="decimal" />
            <select aria-label={L("التجزئة", "Phasing")} className={INPUT} value={l.phasing} onChange={(e) => set(i, "phasing", e.target.value)}><option value="DUE_DATE">{L("تاريخ الاستحقاق", "Due date")}</option><option value="CUSTOM_WEIGHTS">{L("أوزان مخصصة", "Custom weights")}</option><option value="STRAIGHT_LINE">{L("خطي", "Straight line")}</option></select>
            {l.phasing === "CUSTOM_WEIGHTS" ? <input aria-label={L("الأوزان", "Weights")} className={INPUT} placeholder='{"5":1,"15":1}' value={l.weights} onChange={(e) => set(i, "weights", e.target.value)} /> : <input aria-label={L("الاستحقاق", "Due")} type="date" className={INPUT} disabled={l.phasing !== "DUE_DATE"} value={l.dueDate} min={`${report.budget.month}-01`} max={`${report.budget.month}-31`} onChange={(e) => set(i, "dueDate", e.target.value)} />}
            <select aria-label={L("المسؤول", "Owner")} className={INPUT} value={l.ownerEmployeeId} onChange={(e) => set(i, "ownerEmployeeId", e.target.value)}><option value="">{L("المسؤول", "Owner")}</option>{setup?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button type="button" className="text-xs font-bold text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{L("حذف", "Remove")}</button>
          </div>
        ))}
        <button type="button" className="self-start text-xs font-bold text-orange" onClick={() => setLines([...lines, { kind: "PAYMENT", finCategoryId: "", plannedAmount: "0.00", phasing: "DUE_DATE", dueDate: "", weights: "", ownerEmployeeId: "", assumptions: "" }])}>{L("+ إضافة بند", "+ Add line")}</button>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={save}>{L("حفظ المسودة", "Save draft")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function ReasonDialog({ open, onClose, title, sub, onSubmit }: { open: boolean; onClose: () => void; title: string; sub: string; onSubmit: (reason: string) => Promise<void> }) {
  const { L } = useL();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} sub={sub}>
      <Field label={L("السبب", "Reason")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex gap-2"><Button kind="primary" busy={busy} disabled={!reason} onClick={async () => { setBusy(true); await onSubmit(reason); setBusy(false); setReason(""); onClose(); }}>{L("متابعة", "Continue")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}
