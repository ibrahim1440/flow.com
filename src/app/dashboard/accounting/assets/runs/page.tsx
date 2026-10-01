"use client";

// Monthly depreciation runs (Figma ACC-62): compute for a period, approve and post (someone
// other than the preparer), discard a draft, request and decide the reversal of the latest run.
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { useAmount, useCan } from "../../_components/kit";
import { DOC_STATUS, LEDGER, METHOD, Pill } from "../_ui";

type Period = { id: string; label: string; status: string; end: string };
type RunRow = { id: string; runNo: number; period: string; status: string; total: string; preparedBy: string; preparedByName: string | null; approvedByName: string | null; reversalRequestedBy: string | null; reversalReason: string | null; ledger: { eventType: string; status: string; message: string | null; entryNo: number | null }[] };
type Line = { assetId: string; number: string; name: string; classCode: string; method?: string; amount: string; months: number; accumulatedAfter: string; nbvAfter: string; note: string | null };
type Detail = RunRow & { periodStatus: string | null; periodEnd: string; lines: Line[]; journal: { account?: { code: string; name: string }; debit: string; credit: string }[] };

export default function DepreciationRunsPage() {
  const { L } = useL();
  const amt = useAmount();
  const { can, user } = useCan();
  const search = useSearchParams();
  const periods = useApi<Period[]>("/api/accounting/fixed-assets/pickers?what=periods");
  const runs = useApi<RunRow[]>("/api/accounting/fixed-assets/runs");
  const [pickedPeriod, setPeriodId] = useState("");
  const [open, setOpen] = useState<string | null>(search.get("run"));
  const detail = useApi<Detail>(open ? `/api/accounting/fixed-assets/runs/${open}` : null);
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [rev, setRev] = useState<RunRow | null>(null); const [reason, setReason] = useState("");
  const me = user?.id;
  const openPeriods = (periods.data ?? []).filter((p) => p.status === "OPEN");
  const periodId = pickedPeriod || openPeriods[openPeriods.length - 1]?.id || "";

  const post = async (path: string, json: unknown, done: string) => {
    setBusy(path); setMsg(null);
    try {
      const out = await api<{ id?: string; ledger?: { status: string; message?: string } | null }>(path, { method: "POST", json });
      setRev(null); runs.reload(); detail.reload();
      if (path.endsWith("/runs") && out?.id) setOpen(out.id);
      const l = out?.ledger;
      setMsg(l && (l.status === "BLOCKED" || l.status === "FAILED") ? { tone: "warn", text: L(`تمت العملية، لكن القيد لم يُرحَّل بعد: ${l.message ?? ""}`, `Done, but the journal has not posted yet: ${l.message ?? ""}`) } : { tone: "ok", text: done });
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const d = detail.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("قيود الإهلاك الشهرية", "Monthly depreciation runs")} sub={L("يُحسب القيد لفترة مفتوحة، ويعتمده شخص آخر بعد إعادة الحساب، ثم يُرحَّل مرة واحدة", "A run is computed for an open period, approved by someone else after recomputation, then posted once")}
          right={<Link href="/dashboard/accounting/assets"><Button>{L("السجل", "Register")}</Button></Link>} />
        {can("fa_prepare") && (
          <div className="flex gap-3 items-end flex-wrap">
            <Field label={L("الفترة", "Period")}><select aria-label={L("الفترة", "Period")} className={INPUT} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>{openPeriods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
            <Button kind="primary" busy={busy.endsWith("/runs")} disabled={!periodId} onClick={() => post("/api/accounting/fixed-assets/runs", { periodId }, L("حُسب قيد الإهلاك؛ بانتظار اعتماد شخص آخر.", "Run computed; waiting for someone else to approve it."))}>{L("حساب قيد الإهلاك", "Compute the run")}</Button>
          </div>)}
        <Notice tone="info">{L("لا يُنشأ قيد ثانٍ للفترة نفسها، ولا يُحسب شهر إذا كان قيد شهر لاحق مرحّلاً، ولا يُرحَّل في فترة مقفلة. الأشهر التي فاتت أصلاً رُسمل متأخراً تُعوَّض في أول قيد يشمله.", "No second run for the same period, no month once a later month has posted, nothing into a locked period. Months missed by an asset capitalised late are caught up in the first run that includes it.")}</Notice>
        {msg && !rev && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </Card>

      {open && (d ? (
        <Card>
          <CardTitle title={L(`قيد الإهلاك — ${d.period} · #${d.runNo}`, `Depreciation run ${d.period} · #${d.runNo}`)}
            sub={L(`الفترة ${d.periodStatus === "OPEN" ? "مفتوحة" : d.periodStatus} · أعدّه: ${d.preparedByName ?? "—"}${d.approvedByName ? ` · اعتمده: ${d.approvedByName}` : " · يعتمده شخص آخر"}`, `Period ${d.periodStatus?.toLowerCase()} · prepared by ${d.preparedByName ?? "—"}${d.approvedByName ? ` · approved by ${d.approvedByName}` : " · approved by someone else"}`)}
            right={<Pill map={DOC_STATUS} v={d.status} />} />
          <Table>
            <thead><tr><Th>{L("الأصل", "Asset")}</Th><Th>{L("الطريقة", "Method")}</Th><Th num>{L("إهلاك الشهر", "Charge")}</Th><Th num>{L("المجمع بعده", "Accumulated after")}</Th><Th num>{L("صافي القيمة بعده", "NBV after")}</Th><Th>{L("ملاحظة", "Note")}</Th></tr></thead>
            <tbody>
              {d.lines.map((l) => <tr key={l.assetId} className="border-t border-border"><Td><Link className="text-orange hover:underline" href={`/dashboard/accounting/assets/${l.assetId}`}>{l.number}</Link> · {l.name}</Td><Td>{l.method ? L(METHOD[l.method][0], METHOD[l.method][1]) : ""}</Td><Td num>{amt(l.amount)}</Td><Td num>{amt(l.accumulatedAfter)}</Td><Td num>{amt(l.nbvAfter)}</Td><Td>{l.months > 1 ? L(`يشمل تعويض ${l.months - 1} شهر سابق`, `includes ${l.months - 1} earlier month(s)`) : ""}{l.note?.includes("last month") ? L(" · آخر شهر في العمر", " · last month of life") : ""}</Td></tr>)}
              <tr className="border-t border-border bg-cream"><Td><b>{L("المجموع", "Total")}</b></Td><Td /><Td num><b>{amt(d.total)}</b></Td><Td /><Td /><Td /></tr>
            </tbody>
          </Table>
          <h3 className="font-extrabold text-[14px]">{L(`القيد ${d.status === "DRAFT" ? "المتوقع" : ""} (${d.periodEnd})`, `${d.status === "DRAFT" ? "Expected " : ""}journal (${d.periodEnd})`)}</h3>
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>{d.journal.map((j, i) => <tr key={i} className="border-t border-border"><Td>{j.account?.code} · {j.account?.name}</Td><Td num>{j.debit !== "0.00" ? amt(j.debit) : ""}</Td><Td num>{j.credit !== "0.00" ? amt(j.credit) : ""}</Td></tr>)}</tbody>
          </Table>
          <div className="flex gap-2 justify-end flex-wrap items-center">
            {d.ledger.map((e, i) => <span key={i} className="text-[12px] flex items-center gap-1"><Pill map={LEDGER} v={e.status} />{e.entryNo ? ` #${e.entryNo}` : ""}{e.message ? ` · ${e.message}` : ""}</span>)}
            {d.status === "DRAFT" && can("fa_prepare") && <Button onClick={() => post(`/api/accounting/fixed-assets/runs/${d.id}/discard`, {}, L("أُلغيت المسودة.", "Draft discarded."))}>{L("إلغاء المسودة", "Discard draft")}</Button>}
            {d.status === "DRAFT" && can("fa_approve") && d.preparedBy !== me && <Button kind="primary" busy={busy.endsWith("approve")} onClick={() => post(`/api/accounting/fixed-assets/runs/${d.id}/approve`, {}, L("اعتُمد قيد الإهلاك ورُحّل.", "Run approved and posted."))}>{L("اعتماد وترحيل", "Approve and post")}</Button>}
            {d.status === "DRAFT" && d.preparedBy === me && <span className="text-[12px] text-brown">{L("أنت أعددت هذا القيد؛ يعتمده شخص آخر.", "You prepared this run; someone else approves it.")}</span>}
          </div>
        </Card>) : detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : <LoadingState />)}

      <Card>
        <CardTitle title={L("قيود الإهلاك", "Runs")} />
        {runs.error ? <ErrorState error={runs.error} onRetry={runs.reload} /> : !runs.data ? <LoadingState /> : runs.data.length === 0 ? <EmptyState title={L("لا قيود إهلاك بعد", "No runs yet")} /> : (
          <Table>
            <thead><tr><Th>{L("الفترة", "Period")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("أعدّه / اعتمده", "Prepared / approved")}</Th><Th>{L("القيد", "Journal")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("إجراء", "Action")}</Th></tr></thead>
            <tbody>{runs.data.map((r) => {
              const latestLive = runs.data!.filter((x) => ["DRAFT", "POSTED", "REVERSAL_REQUESTED"].includes(x.status))[0]?.id === r.id;
              return (
                <tr key={r.id} className="border-t border-border" data-testid={`run-${r.period}-${r.status}`}>
                  <Td><button type="button" className="font-bold text-orange hover:underline" onClick={() => setOpen(r.id)}>{r.period} · #{r.runNo}</button></Td>
                  <Td num>{amt(r.total)}</Td><Td>{r.preparedByName ?? "—"} / {r.approvedByName ?? "—"}</Td>
                  <Td>{r.ledger.map((e, k) => <span key={k} className="block">{e.entryNo ? `#${e.entryNo}` : ""} <Pill map={LEDGER} v={e.status} /></span>)}</Td>
                  <Td><Pill map={DOC_STATUS} v={r.status} />{r.reversalReason && <span className="block text-[11px] text-brown">{r.reversalReason}</span>}</Td>
                  <Td><div className="flex gap-1 flex-wrap">
                    {r.status === "POSTED" && can("fa_prepare") && (latestLive ? <Button onClick={() => { setReason(""); setMsg(null); setRev(r); }}>{L("طلب عكس", "Request reversal")}</Button> : <span className="text-[12px] text-brown">{L("العكس للأحدث فقط", "Only the latest reverses")}</span>)}
                    {r.status === "REVERSAL_REQUESTED" && can("fa_approve") && r.reversalRequestedBy !== me && <>
                      <Button kind="primary" onClick={() => post(`/api/accounting/fixed-assets/runs/${r.id}/reversal-decision`, { approve: true }, L("عُكس قيد الإهلاك؛ يمكن حساب الفترة من جديد.", "Run reversed; the period can be run again."))}>{L("اعتماد العكس", "Approve reversal")}</Button>
                      <Button onClick={() => post(`/api/accounting/fixed-assets/runs/${r.id}/reversal-decision`, { approve: false }, L("رُفض طلب العكس.", "Reversal rejected."))}>{L("رفض", "Reject")}</Button></>}
                  </div></Td>
                </tr>);
            })}</tbody>
          </Table>)}
      </Card>

      <Dialog open={!!rev} onClose={() => setRev(null)} title={L("طلب عكس قيد الإهلاك", "Request reversal of the run")} sub={rev ? `${rev.period} · #${rev.runNo}` : ""}>
        <Field label={L("السبب", "Reason")}><textarea aria-label={L("السبب", "Reason")} className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
        <div className="flex gap-2 justify-end mt-3">
          <Button onClick={() => setRev(null)}>{L("إغلاق", "Close")}</Button>
          <Button kind="primary" onClick={() => rev && post(`/api/accounting/fixed-assets/runs/${rev.id}/reverse`, { reason }, L("طُلب العكس؛ يقرّه شخص آخر.", "Reversal requested; someone else decides it."))}>{L("تأكيد", "Confirm")}</Button>
        </div>
      </Dialog>
    </div>
  );
}
