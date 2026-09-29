"use client";

// Year-end close (Figma ACC-65): the conditions, the closing entry as computed now, prepare →
// approve and post by someone else (recomputed first) → the balances carried into the next year.
// Reopening is requested by one person and decided by another while the year's last period is
// still locked.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { useAmount, useCan } from "../../_components/kit";
import { DOC_STATUS, LEDGER, Pill } from "../../assets/_ui";

type Year = { year: number; start: string | null; end: string | null; ended: boolean };
type Line = { accountId: string; code: string; name: string; nameAr?: string | null; branchId: string | null; costCenterId: string | null; net: string };
type Close = { id: string; status: string; netIncome: string; preparedBy: string; preparedByName: string | null; approvedByName: string | null; reversalRequestedBy: string | null; reversalReason: string | null; snapshot: Line[]; ledger: { eventType: string; status: string; message: string | null }[] };
type Status = { year: number; start: string; end: string; blockers: { code: string; en: string; ar: string; items?: string[] }[]; preview: Line[]; netIncome: string; closes: Close[] };
type Opening = { year: number; carriedInto: number; asOf: string; lines: { code: string; name: string; nameAr: string | null; type: string; net: string }[]; profitAndLossNotClosed: number; balanced: boolean };
const CHECKS: [string, string, string][] = [
  ["PERIODS_OPEN", "الفترات كلها مقفلة (لا يُرحَّل فيها شيء آخر)", "Every period is locked (nothing else can post)"],
  ["PENDING_ENTRIES", "لا قيود معلّقة بتاريخ السنة", "No unposted journal entries dated in the year"],
  ["WAITING_EVENTS", "لا ترحيلات آلية معلّقة بتاريخ السنة", "No automatic postings waiting in the year"],
  ["DEPRECIATION_MISSING", "الإهلاك مرحّل لكل الأشهر لكل أصل في الخدمة", "Depreciation posted for every month of every asset in service"],
  ["PREVIOUS_OPEN", "السنة السابقة مُقفلة أو بلا قيود", "The previous year is closed or has no postings"],
  ["NO_NEXT_YEAR", "السنة التالية موجودة", "The next year exists"],
  ["NOT_ENDED", "انتهت السنة", "The year has ended"],
];

export default function YearEndPage() {
  const { L } = useL();
  const amt = useAmount();
  const { can, user } = useCan();
  const years = useApi<Year[]>("/api/accounting/fixed-assets/pickers?what=years");
  const [picked, setYear] = useState<number | null>(null);
  const year = picked ?? (years.data?.length ? (years.data.find((y) => y.ended) ?? years.data[0]).year : null);
  const st = useApi<Status>(year ? `/api/accounting/year-end?year=${year}` : null);
  const live = st.data?.closes.find((c) => ["DRAFT", "POSTED", "REVERSAL_REQUESTED"].includes(c.status));
  const opening = useApi<Opening>(live?.status === "POSTED" ? `/api/accounting/year-end/opening?year=${year}` : null);
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [reopen, setReopen] = useState(false); const [reason, setReason] = useState("");
  const me = user?.id;
  const post = async (path: string, json: unknown, done: string) => {
    setBusy(path); setMsg(null);
    try {
      const out = await api<{ ledger?: { status: string; message?: string } | null }>(path, { method: "POST", json });
      setReopen(false); st.reload(); opening.reload();
      const l = out?.ledger;
      setMsg(l && (l.status === "BLOCKED" || l.status === "FAILED") ? { tone: "warn", text: L(`تمت العملية، لكن قيد الإقفال لم يُرحَّل بعد: ${l.message ?? ""}`, `Done, but the closing entry has not posted yet: ${l.message ?? ""}`) } : { tone: "ok", text: done });
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const s = st.data;
  const lines = live?.snapshot ?? s?.preview ?? [];
  const net = live?.netIncome ?? s?.netIncome ?? "0.00";
  const blockersOnly = (s?.blockers ?? []).filter((b) => b.code !== "ALREADY");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L(`إقفال السنة المالية ${year ?? ""}`, `Year-end close ${year ?? ""}`)}
          sub={L("الأستاذ مستمر: أرصدة الميزانية تنتقل إلى السنة التالية دون قيد؛ الإقفال ينقل إيرادات السنة ومصروفاتها إلى الأرباح المبقاة", "The ledger is perpetual: balance-sheet balances carry into the next year without an entry; the close moves the year's revenue and expense into retained earnings")}
          right={<>
            {live && <Pill map={{ ...DOC_STATUS, DRAFT: ["معدّ — بانتظار اعتماد شخص آخر", "Prepared — awaiting someone else's approval", "warn"], REVERSAL_REQUESTED: ["طلب إعادة فتح بانتظار القرار", "Reopening awaiting decision", "warn"] }} v={live.status} />}
            <Field label={L("السنة", "Year")}><select aria-label={L("السنة المالية", "Fiscal year")} className={INPUT} value={year ?? ""} onChange={(e) => { setYear(Number(e.target.value)); setMsg(null); }}>{(years.data ?? []).map((y) => <option key={y.year} value={y.year}>{y.year}</option>)}</select></Field>
            <Link href="/dashboard/accounting/periods"><Button>{L("الفترات", "Periods")}</Button></Link></>} />
        {msg && !reopen && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {st.error ? <ErrorState error={st.error} onRetry={st.reload} /> : !s ? <LoadingState /> : (<>
          {!live && <Table>
            <thead><tr><Th>{L("الشرط", "Condition")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
            <tbody>{CHECKS.map(([code, ar, en]) => {
              const b = blockersOnly.find((x) => x.code === code || (code === "PERIODS_OPEN" && x.code === "LAST_CLOSED"));
              return <tr key={code} className="border-t border-border" data-testid={`check-${code}`}><Td>{L(ar, en)}{b && <span className="block text-[12px] text-red-700 mt-1">{L(b.ar, b.en)}{b.items?.length ? ` · ${b.items.slice(0, 6).join("، ")}` : ""}</span>}</Td><Td>{b ? <Badge tone="bad">{L("✗ غير متحقق", "✗ Not met")}</Badge> : <Badge tone="ok">{L("✓ متحقق", "✓ Met")}</Badge>}</Td></tr>;
            })}</tbody>
          </Table>}
          <h3 className="font-extrabold text-[14px]">{L(`قيد الإقفال ${live ? "" : "المحسوب"} (${s.end})`, `${live ? "" : "Computed "}closing entry (${s.end})`)}</h3>
          {lines.length === 0 ? <EmptyState title={L("لا إيرادات أو مصروفات في السنة", "No revenue or expense in the year")} /> : (
            <Table>
              <thead><tr><Th>{L("الحساب", "Account")}</Th><Th>{L("الفرع / مركز التكلفة", "Branch / cost centre")}</Th><Th num>{L("صافي السنة", "Year's balance")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
              <tbody>
                {lines.map((l, i) => { const n = Number(l.net); return (
                  <tr key={i} className="border-t border-border"><Td>{l.code} · {L(l.nameAr ?? l.name, l.name)}</Td><Td>{l.branchId || l.costCenterId ? L("محدد", "Set") : "—"}</Td><Td num>{amt(l.net.replace("-", ""))} {n < 0 ? L("دائن", "Cr") : L("مدين", "Dr")}</Td><Td num>{n < 0 ? amt(l.net.replace("-", "")) : ""}</Td><Td num>{n > 0 ? amt(l.net) : ""}</Td></tr>); })}
                <tr className="border-t border-border bg-cream"><Td><b>{L(`3200 · الأرباح المبقاة (${Number(net) >= 0 ? "صافي الربح" : "صافي الخسارة"})`, `Retained earnings (${Number(net) >= 0 ? "net income" : "net loss"})`)}</b></Td><Td /><Td num><b>{amt(net.replace("-", ""))}</b></Td><Td num>{Number(net) < 0 ? <b>{amt(net.replace("-", ""))}</b> : ""}</Td><Td num>{Number(net) >= 0 ? <b>{amt(net)}</b> : ""}</Td></tr>
              </tbody>
            </Table>)}
          <Notice tone="info">{L("عند الاعتماد يُعاد الحساب؛ أي اختلاف عن النسخة المعدّة يرفض الاعتماد. يُرحَّل قيد الإقفال من نوع «إقفال» في الفترة الأخيرة المقفلة فقط، ولا يُرحَّل أي قيد آخر فيها.", "On approval the figures are recomputed; any difference from the prepared version refuses the approval. The closing entry is a CLOSING entry posted only into the locked last period, where nothing else can post.")}</Notice>
          {live?.ledger.map((e, i) => <div key={i} className="flex gap-2 items-center text-[13px]"><Pill map={LEDGER} v={e.status} /> {e.eventType}{e.message ? ` · ${e.message}` : ""}</div>)}
          <div className="flex gap-2 justify-end flex-wrap items-center">
            {!live && can("year_close_prepare") && <Button kind="primary" disabled={blockersOnly.length > 0} busy={!!busy} onClick={() => post("/api/accounting/year-end", { year }, L("أُعدّ الإقفال؛ بانتظار اعتماد شخص آخر.", "Close prepared; waiting for someone else to approve it."))}>{L("إعداد الإقفال", "Prepare the close")}</Button>}
            {live?.status === "DRAFT" && can("year_close_prepare") && <Button onClick={() => post(`/api/accounting/year-end/${live.id}/cancel`, {}, L("أُلغي الإقفال المعدّ.", "Prepared close cancelled."))}>{L("إلغاء", "Cancel")}</Button>}
            {live?.status === "DRAFT" && can("year_close_approve") && live.preparedBy !== me && <Button kind="primary" busy={!!busy} onClick={() => post(`/api/accounting/year-end/${live.id}/approve`, {}, L("اعتُمد الإقفال ورُحّل.", "Close approved and posted."))}>{L("اعتماد وترحيل الإقفال", "Approve and post the close")}</Button>}
            {live?.status === "DRAFT" && live.preparedBy === me && <span className="text-[12px] text-brown">{L("أنت أعددت الإقفال؛ يعتمده شخص آخر.", "You prepared this close; someone else approves it.")}</span>}
            {live?.status === "POSTED" && can("year_close_prepare") && <Button onClick={() => { setReason(""); setMsg(null); setReopen(true); }}>{L("طلب إعادة فتح السنة", "Request reopening")}</Button>}
            {live?.status === "REVERSAL_REQUESTED" && can("year_close_approve") && live.reversalRequestedBy !== me && <>
              <Button kind="primary" onClick={() => post(`/api/accounting/year-end/${live.id}/reopen-decision`, { approve: true }, L("أُعيد فتح السنة؛ عُكس قيد الإقفال.", "Year reopened; the closing entry was reversed."))}>{L("اعتماد إعادة الفتح", "Approve reopening")}</Button>
              <Button onClick={() => post(`/api/accounting/year-end/${live.id}/reopen-decision`, { approve: false }, L("رُفض طلب إعادة الفتح.", "Reopening rejected."))}>{L("رفض", "Reject")}</Button></>}
          </div>
        </>)}
      </Card>
      {s && (
        <Card>
          <CardTitle title={live?.status === "POSTED" ? L(`الأرصدة المنقولة إلى ${Number(year) + 1}`, `Balances carried into ${Number(year) + 1}`) : L("الأثر المتوقع بعد الترحيل", "Expected effect after posting")} />
          {live?.status === "POSTED" && opening.data ? (<>
            <Notice tone={opening.data.profitAndLossNotClosed === 0 ? "ok" : "bad"}>{opening.data.profitAndLossNotClosed === 0 ? L("كل حسابات الإيرادات والمصروفات صفر في بداية السنة التالية · حسابات الميزانية = أرصدة نهاية السنة", "Every revenue and expense account opens at zero · balance-sheet accounts = year-end balances") : L(`${opening.data.profitAndLossNotClosed} حساب إيرادات أو مصروفات لم يُقفل`, `${opening.data.profitAndLossNotClosed} revenue or expense account(s) not closed`)}</Notice>
            <Table>
              <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("الرصيد الافتتاحي", "Opening balance")}</Th></tr></thead>
              <tbody>{opening.data.lines.map((l) => <tr key={l.code} className="border-t border-border"><Td>{l.code} · {L(l.nameAr ?? l.name, l.name)}</Td><Td num>{amt(l.net)}</Td></tr>)}</tbody>
            </Table></>) : (
            <Table>
              <thead><tr><Th>{L("التقرير", "Report")}</Th><Th>{L("النتيجة", "Result")}</Th></tr></thead>
              <tbody>
                <tr className="border-t border-border"><Td>{L(`قائمة الدخل ${year}`, `Income statement ${year}`)}</Td><Td>{L(`دون تغيير — صافي الربح ${amt(net)} (قيود الإقفال مستبعدة)`, `Unchanged — net income ${amt(net)} (closing entries excluded)`)}</Td></tr>
                <tr className="border-t border-border"><Td>{L(`الميزانية في ${s.end}`, `Balance sheet at ${s.end}`)}</Td><Td>{L(`أرباح السنة الجارية 0.00 · الأرباح المبقاة تتغير بـ ${amt(net)}`, `Current earnings 0.00 · retained earnings change by ${amt(net)}`)}</Td></tr>
                <tr className="border-t border-border"><Td>{L(`ميزان المراجعة الافتتاحي ${Number(year) + 1}`, `Opening trial balance ${Number(year) + 1}`)}</Td><Td>{L("كل حسابات الإيرادات والمصروفات صفر · حسابات الميزانية = أرصدة نهاية السنة", "Every revenue and expense account at zero · balance sheet = year-end balances")}</Td></tr>
                <tr className="border-t border-border"><Td>{L("عكس الإقفال", "Reopening")}</Td><Td>{L("متاح ما دامت الفترة الأخيرة مقفلة ولم تُغلق نهائياً", "Available while the last period is locked, not closed")}</Td></tr>
              </tbody>
            </Table>)}
        </Card>)}
      <Dialog open={reopen} onClose={() => setReopen(false)} title={L(`طلب إعادة فتح سنة ${year}`, `Request reopening ${year}`)}>
        <Field label={L("السبب", "Reason")}><textarea aria-label={L("السبب", "Reason")} className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
        <div className="flex gap-2 justify-end mt-3"><Button onClick={() => setReopen(false)}>{L("إغلاق", "Close")}</Button><Button kind="primary" onClick={() => live && post(`/api/accounting/year-end/${live.id}/reopen`, { reason }, L("طُلبت إعادة الفتح؛ يقرّها شخص آخر.", "Reopening requested; someone else decides it."))}>{L("تأكيد", "Confirm")}</Button></div>
      </Dialog>
    </div>
  );
}
