"use client";

// Figma: ACC-28 — corrections of posted bank lines (reversal and replacement, four-eyes).
// A posted line cannot be edited (database guard); a correction voids it (mirror journal) and,
// for a replacement, creates the corrected line, which posts normally.
import { useState } from "react";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { useAmount, useCan, useDay, useExplain } from "../_components/kit";
import { CLASS_LABELS, type TxnClass } from "@/lib/finance/classes";

type Split = { finCategoryId: string; amount: string; costCenterId: string | null };
type Match = { targetType: "OBLIGATION"; targetId: string; amount: string };
type Line = { id: string; txnDate: string; amount: string; classification: string; bankReference: string | null; description: string | null; cashAccount: { code: string; nameAr: string | null; nameEn: string };
  transfer: boolean; pendingCorrection: number | null; splits: Split[]; matches: Match[] };
type Posted = { lines: Line[]; obligations: { id: string; label: string; gross: string }[] };
type Correction = { id: string; correctionNo: number; kind: "VOID" | "REPLACE"; reason: string; status: "PENDING" | "APPROVED" | "REJECTED" | "APPLIED";
  replacement: { txnDate: string; amount: string; classification: string; splits: Split[]; matches: Match[] } | null;
  requestedBy: string; requestedByName: string | null; requestedAt: string; approvedByName: string | null; approvedAt: string | null; rejectedByName: string | null; rejectReason: string | null; replacementTransactionId: string | null;
  transaction: { id: string; txnDate: string; amount: string; status: string; classification: string; bankReference: string | null; description: string | null; cashAccount: { code: string } } };
type Cat = { id: string; code: string; nameAr: string | null; nameEn: string; kind: string; active: boolean };

const CLASSES = ["SUPPLIER_PAYMENT", "RENT", "PAYROLL", "UTILITIES", "TAX_PAYMENT", "BANK_FEE", "OTHER_OPERATING_PAYMENT", "OTHER_OPERATING_RECEIPT", "CUSTOMER_RECEIPT", "LOAN_PROCEEDS", "LOAN_PRINCIPAL_REPAYMENT", "OWNER_CONTRIBUTION", "OWNER_DRAWING"];

export function Corrections({ onBack }: { onBack: () => void }) {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const explain = useExplain();
  const { can, user } = useCan();
  const [q, setQ] = useState("");
  const list = useApi<Correction[]>("/api/accounting/bank/corrections");
  const posted = useApi<Posted>(`/api/accounting/bank/posted-lines?q=${encodeURIComponent(q)}`);
  const cats = useApi<{ categories: Cat[] }>("/api/accounting/bank");
  const [target, setTarget] = useState<Line | null>(null);
  const [reject, setReject] = useState<Correction | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: ok }); list.reload(); posted.reload(); } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? explain(e.message) : String(e) }); }
    setBusy("");
  };
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const catName = (id: string) => { const c = cats.data?.categories.find((x) => x.id === id); return c ? L(c.nameAr ?? c.nameEn, c.nameEn) : id; };
  const statusBadge = (s: Correction["status"]) => s === "PENDING" ? <Badge tone="warn">{L("بانتظار الاعتماد", "Awaiting approval")}</Badge> : s === "APPLIED" ? <Badge tone="ok">{L("طُبّق", "Applied")}</Badge> : s === "REJECTED" ? <Badge tone="bad">{L("مرفوض", "Rejected")}</Badge> : <Badge tone="info">{L("معتمد", "Approved")}</Badge>;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("تصحيح حركات بنكية مرحّلة", "Corrections of posted bank lines")}
          sub={L("الحركة المرحّلة لا تُعدّل. التصحيح يلغيها بقيد عكسي ويُنشئ حركة بديلة تُرحّل من جديد — بطلب واعتماد من شخصين مختلفين، ويبقى كل ذلك في سجل التدقيق.", "A posted line is never edited. A correction voids it with a mirror journal and creates a replacement that posts again — requested and approved by two different people, all in the audit trail.")}
          right={<Button onClick={onBack}>{L("← العودة للربط", "← Back to mapping")}</Button>} />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {!list.data ? <LoadingState /> : list.data.length === 0 ? <Notice tone="info">{L("لا توجد طلبات تصحيح.", "No correction requests.")}</Notice> : (
          <Table>
            <thead><tr><Th>#</Th><Th>{L("الحركة", "Line")}</Th><Th>{L("التصحيح", "Correction")}</Th><Th>{L("السبب", "Reason")}</Th><Th>{L("الطلب", "Requested")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{""}</Th></tr></thead>
            <tbody>{list.data.map((c) => (
              <tr key={c.id}>
                <Td className="tabular-nums">{c.correctionNo}</Td>
                <Td><span className="whitespace-nowrap">{day(c.transaction.txnDate)} · {c.transaction.cashAccount.code}</span><span className="block text-[11px] text-brown tabular-nums">{c.transaction.bankReference ?? "—"} · {amt(c.transaction.amount)}</span></Td>
                <Td>{c.kind === "VOID" ? L("إلغاء فقط", "Void only") : <>{L("استبدال بـ", "Replace with")} <span className="tabular-nums">{amt(c.replacement!.amount)}</span><span className="block text-[11px] text-brown">{day(c.replacement!.txnDate)} · {c.replacement!.splits.map((s) => `${catName(s.finCategoryId)} ${amt(s.amount)}`).join(" · ")}{c.replacement!.matches.length ? ` · ${L("مطابقة", "matched")} ${c.replacement!.matches.length}` : ""}</span></>}</Td>
                <Td className="max-w-[240px]">{c.reason}{c.rejectReason && <span className="block text-[11px] text-red-700">{L("سبب الرفض: ", "Rejected: ")}{c.rejectReason}</span>}</Td>
                <Td className="whitespace-nowrap">{c.requestedByName ?? "—"}<span className="block text-[11px] text-brown">{day(c.requestedAt)}</span></Td>
                <Td>{statusBadge(c.status)}{c.approvedByName && <span className="block text-[11px] text-brown">{c.approvedByName}</span>}</Td>
                <Td>{c.status === "PENDING" && can("bank_correction_approve") && c.requestedBy !== user?.id && (
                  <div className="flex gap-2 justify-end">
                    <Button kind="primary" busy={busy === `a${c.id}`} onClick={() => run(`a${c.id}`, () => api(`/api/accounting/bank/corrections/${c.id}/approve`, { method: "POST", json: {} }), L(`طُبّق التصحيح ${c.correctionNo}`, `Correction ${c.correctionNo} applied`))}>{L("اعتماد وتطبيق", "Approve and apply")}</Button>
                    <Button onClick={() => setReject(c)}>{L("رفض", "Reject")}</Button>
                  </div>)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle title={L("حركات مرحّلة", "Posted bank lines")} sub={L("ابحث بالمرجع أو البيان، ثم اطلب التصحيح", "Search by reference or description, then request a correction")} />
        <Field label={L("بحث", "Search")}><input className={INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("مرجع البنك أو البيان", "Bank reference or description")} /></Field>
        {!posted.data ? <LoadingState /> : (
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("المرجع", "Reference")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{""}</Th></tr></thead>
            <tbody>{posted.data.lines.map((t) => (
              <tr key={t.id}>
                <Td className="whitespace-nowrap">{day(t.txnDate)}</Td><Td>{t.cashAccount.code}</Td><Td className="tabular-nums">{t.bankReference ?? "—"}</Td>
                <Td>{t.description ?? "—"}{t.transfer && <span className="block text-[11px] text-brown">{L("تحويل بين حسابات الشركة", "Transfer between company accounts")}</span>}</Td>
                <Td num>{amt(t.amount)}</Td>
                <Td>{t.pendingCorrection ? <Badge tone="warn">{L(`طلب ${t.pendingCorrection} قائم`, `Request ${t.pendingCorrection} open`)}</Badge> : can("bank_correction_request") && <Button onClick={() => setTarget(t)}>{L("طلب تصحيح", "Request correction")}</Button>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      {target && cats.data && posted.data && <RequestDialog line={target} cats={cats.data.categories} obligations={posted.data.obligations} onClose={() => setTarget(null)}
        onDone={(n) => { setTarget(null); setMsg({ tone: "ok", text: L(`قُدّم طلب التصحيح ${n} — يعتمده شخص آخر`, `Correction request ${n} submitted — someone else approves it`) }); list.reload(); posted.reload(); }} />}
      <Dialog open={!!reject} onClose={() => setReject(null)} title={L("رفض طلب التصحيح", "Reject the correction request")}>
        {reject && <RejectForm c={reject} onDone={() => { setReject(null); list.reload(); }} />}
      </Dialog>
    </div>
  );
}

function RejectForm({ c, onDone }: { c: Correction; onDone: () => void }) {
  const { L } = useL();
  const explain = useExplain();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Field label={L("السبب (5 أحرف على الأقل)", "Reason (at least 5 characters)")}><textarea className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex justify-end"><Button kind="primary" busy={busy} disabled={reason.trim().length < 5} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api(`/api/accounting/bank/corrections/${c.id}/reject`, { method: "POST", json: { reason } }); onDone(); } catch (e) { setErr(e instanceof ApiError ? explain(e.message) : String(e)); }
        setBusy(false);
      }}>{L("رفض", "Reject")}</Button></div>
    </div>
  );
}

function RequestDialog({ line, cats, obligations, onClose, onDone }: { line: Line; cats: Cat[]; obligations: Posted["obligations"]; onClose: () => void; onDone: (n: number) => void }) {
  const { L } = useL();
  const amt = useAmount();
  const explain = useExplain();
  const [kind, setKind] = useState<"VOID" | "REPLACE">(line.transfer ? "VOID" : "REPLACE");
  const [reason, setReason] = useState("");
  const [txnDate, setTxnDate] = useState(line.txnDate.slice(0, 10));
  const [amount, setAmount] = useState(line.amount);
  const [classification, setClassification] = useState(line.classification);
  const [splits, setSplits] = useState<Split[]>(line.splits.length ? line.splits : [{ finCategoryId: "", amount: line.amount, costCenterId: null }]);
  const [matches, setMatches] = useState<Match[]>(line.matches);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const out = Number(amount) < 0;
  const activeCats = cats.filter((c) => c.active && (out ? c.kind === "PAYMENT" : c.kind === "RECEIPT"));
  const splitSum = splits.reduce((s, x) => s + Number(x.amount || 0), 0);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const c = await api<{ correctionNo: number }>(`/api/accounting/bank/lines/${line.id}/corrections`, { method: "POST", json: kind === "VOID" ? { kind, reason } : { kind, reason, replacement: { txnDate, amount, classification, splits, matches } } });
      onDone(c.correctionNo);
    } catch (e) { setErr(e instanceof ApiError ? explain(e.message) : String(e)); }
    setBusy(false);
  };
  return (
    <Dialog open onClose={onClose} width="max-w-[760px]" title={L("طلب تصحيح حركة مرحّلة", "Request a correction of a posted line")} sub={`${line.cashAccount.code} · ${line.bankReference ?? "—"} · ${amt(line.amount)}`}>
      <div className="flex flex-col gap-3">
        {!line.transfer && <Segmented<"VOID" | "REPLACE"> value={kind} onChange={setKind} options={[{ value: "REPLACE", label: L("إلغاء واستبدال", "Void and replace") }, { value: "VOID", label: L("إلغاء فقط", "Void only") }]} />}
        {line.transfer && <Notice tone="info">{L("التحويل يُصحّح بإلغاء طرفيه؛ سجّل التحويل الصحيح في وحدة المالية بعد ذلك.", "A transfer is corrected by voiding both legs; record the correct transfer in Finance afterwards.")}</Notice>}
        <Field label={L("السبب", "Reason")}><textarea className={INPUT} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {kind === "REPLACE" && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={L("التاريخ", "Date")}><input type="date" className={INPUT} value={txnDate} onChange={(e) => setTxnDate(e.target.value)} /></Field>
            <Field label={L("المبلغ (سالب للمدفوع)", "Amount (negative when paid out)")}><input className={INPUT} dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label={L("التصنيف", "Classification")}><select className={INPUT} value={classification} onChange={(e) => setClassification(e.target.value)}>{CLASSES.map((c) => <option key={c} value={c}>{L(CLASS_LABELS[c as TxnClass]?.ar ?? c, CLASS_LABELS[c as TxnClass]?.en ?? c)}</option>)}</select></Field>
          </div>
          <div className="text-[13px] font-bold">{L("تقسيمات الميزانية", "Budget splits")} <span className={`font-normal tabular-nums ${Math.abs(splitSum - Number(amount)) < 0.005 ? "text-green-700" : "text-red-700"}`}>({amt(splitSum.toFixed(2))} / {amt(Number(amount || 0).toFixed(2))})</span></div>
          {splits.map((s, i) => (
            <div key={i} className="grid gap-2 grid-cols-[1fr_140px_auto] items-end">
              <select aria-label={L(`فئة التقسيم ${i + 1}`, `Split ${i + 1} category`)} className={INPUT} value={s.finCategoryId} onChange={(e) => setSplits(splits.map((x, j) => j === i ? { ...x, finCategoryId: e.target.value } : x))}>
                <option value="">{L("اختر الفئة", "Choose a category")}</option>{activeCats.map((c) => <option key={c.id} value={c.id}>{L(c.nameAr ?? c.nameEn, c.nameEn)} · {c.code}</option>)}
              </select>
              <input aria-label={L(`مبلغ التقسيم ${i + 1}`, `Split ${i + 1} amount`)} className={INPUT} dir="ltr" value={s.amount} onChange={(e) => setSplits(splits.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
              <Button disabled={splits.length === 1} onClick={() => setSplits(splits.filter((_, j) => j !== i))}>{L("حذف", "Remove")}</Button>
            </div>
          ))}
          <div><Button onClick={() => setSplits([...splits, { finCategoryId: "", amount: "0", costCenterId: null }])}>{L("+ تقسيم", "+ Split")}</Button></div>
          {out && <>
            <div className="text-[13px] font-bold">{L("مطابقة مع فواتير موردين", "Matches to supplier bills")}</div>
            {matches.map((m, i) => (
              <div key={i} className="grid gap-2 grid-cols-[1fr_140px_auto] items-end">
                <select aria-label={L(`الفاتورة ${i + 1}`, `Bill ${i + 1}`)} className={INPUT} value={m.targetId} onChange={(e) => setMatches(matches.map((x, j) => j === i ? { ...x, targetId: e.target.value } : x))}>
                  <option value="">{L("اختر الفاتورة", "Choose a bill")}</option>
                  {[...obligations, ...(obligations.some((o) => o.id === m.targetId) || !m.targetId ? [] : [{ id: m.targetId, label: L("الفاتورة المطابقة حالياً", "Currently matched bill"), gross: "" }])].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                <input aria-label={L(`مبلغ المطابقة ${i + 1}`, `Match ${i + 1} amount`)} className={INPUT} dir="ltr" value={m.amount} onChange={(e) => setMatches(matches.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                <Button onClick={() => setMatches(matches.filter((_, j) => j !== i))}>{L("حذف", "Remove")}</Button>
              </div>
            ))}
            <div><Button onClick={() => setMatches([...matches, { targetType: "OBLIGATION", targetId: "", amount: "0" }])}>{L("+ مطابقة", "+ Match")}</Button></div>
          </>}
        </>}
        <Notice tone="info">{L("يعتمد التصحيح شخص غير مقدّم الطلب. عند الاعتماد: تُلغى الحركة بقيد عكسي مؤرخ باليوم، وتُنشأ البديلة وتُرحّل بتاريخها (يجب أن تكون الفترتان مفتوحتين).", "Someone other than the requester approves. On approval the line is voided with a mirror journal dated today, and the replacement is created and posts on its own date (both periods must be open).")}</Notice>
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button kind="primary" busy={busy} disabled={reason.trim().length < 5} onClick={submit}>{L("تقديم الطلب", "Submit request")}</Button></div>
      </div>
    </Dialog>
  );
}
