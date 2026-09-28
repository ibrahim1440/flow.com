"use client";

// Figma: ACC-34. Receivables aging (tied to the receivables control account), customer advances
// (tied to the advances account and the customers' advance VAT) and the customer statement (tied
// to the customer's party lines in the ledger).
import { useState } from "react";
import { Download } from "lucide-react";
import { Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useDay } from "../../_components/kit";

const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90p"] as const;
type Aging = {
  asOf: string; rows: { customerId: string; customer: string; invoices: number; buckets: Record<string, string>; credits: string; total: string }[];
  totals: Record<string, string>; credits: string; subledger: string; ledger: string | null; difference: string | null; reconciled: boolean;
  explanation: { receiptsAssignedNotYetPosted: number; documentsWaitingToPost: number };
  advances: { rows: { customerId: string; customer: string; amount: string; vat: string }[]; total: string; ledger: string | null; reconciled: boolean };
};
type Statement = { customer: { id: string; name: string; vatNumber: string | null }; opening: string; closing: string; ledgerBalance: string; reconciled: boolean;
  lines: { date: string; kind: string; ref: string; refId: string; text: string; debit: string; credit: string; balance: string }[] };
type Tab = "AGING" | "STATEMENT";

export default function ReceivablesAgingPage() {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const [tab, setTabRaw] = useState<Tab>("AGING");
  const [asOf, setAsOf] = useState(riyadhToday);
  const [customerId, setCustomerId] = useState("");
  const [from, setFrom] = useState(() => `${riyadhToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(riyadhToday);
  const aging = useApi<Aging>(`/api/accounting/reports/ar-aging?asOf=${asOf}`);
  const customers = useApi<{ id: string; name: string }[]>("/api/accounting/receivables/customers");
  const cid = customerId || aging.data?.rows[0]?.customerId || customers.data?.[0]?.id || "";
  const st = useApi<Statement>(cid ? `/api/accounting/reports/customer-statement?customerId=${cid}&from=${from}&to=${to}` : null);
  const label = { current: L("غير مستحقة", "Not due"), d1_30: "1–30", d31_60: "31–60", d61_90: "61–90", d90p: "+90" } as Record<string, string>;
  const setTab = (t: Tab) => { setTabRaw(t); document.getElementById(t === "AGING" ? "ar-aging" : "ar-statement")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const sums = st.data ? st.data.lines.reduce((s, l) => ({ d: s.d + Number(l.debit), c: s.c + Number(l.credit) }), { d: 0, c: 0 }) : null;
  const csv = () => {
    if (!st.data) return;
    const rows = [["date", "document", "text", "debit", "credit", "balance"], [from, "", "opening", "", "", st.data.opening], ...st.data.lines.map((l) => [String(l.date).slice(0, 10), l.ref, l.text, l.debit, l.credit, l.balance])];
    const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `customer-statement-${to}.csv`; a.click();
  };
  const seg = <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: "AGING", label: L("أعمار الذمم المدينة", "Receivables aging") }, { value: "STATEMENT", label: L("كشف حساب عميل", "Customer statement") }]} />;
  const a = aging.data;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div id="ar-aging" className="scroll-mt-4" />
        <CardTitle title={L(`أعمار الذمم المدينة — كما في ${day(asOf)}`, `Receivables aging — as of ${day(asOf)}`)}
          sub={L("من الفواتير المرحّلة ناقص التحصيلات والإشعارات والدفعات المقدمة المخصّصة · يطابق رصيد 1130 · الدفعات المقدمة تطابق 2410", "Posted invoices less allocated receipts, credit notes and advances · agrees to 1130 · advances agree to 2410")} right={seg} />
        <Field label={L("كما في", "As of")}><input type="date" className={`${INPUT} max-w-[180px]`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        {aging.error ? <ErrorState error={aging.error} onRetry={aging.reload} /> : !a ? <LoadingState /> : a.rows.length === 0 ? <EmptyState title={L("لا ذمم مدينة مفتوحة", "No open receivables")} /> : (
          <Table>
            <thead><tr><Th>{L("العميل", "Customer")}</Th>{BUCKETS.map((b) => <Th key={b} num>{label[b]}</Th>)}<Th num>{L("أرصدة دائنة", "Credits")}</Th><Th num>{L("الإجمالي", "Total")}</Th></tr></thead>
            <tbody>
              {a.rows.map((r) => (
                <tr key={r.customerId}>
                  <Td><button type="button" className="font-bold text-orange hover:underline" onClick={() => { setCustomerId(r.customerId); setTab("STATEMENT"); }}>{r.customer}</button></Td>
                  {BUCKETS.map((b) => <Td key={b} num className={b !== "current" && Number(r.buckets[b]) > 0 ? "text-red-700 font-bold" : ""}>{amt(r.buckets[b])}</Td>)}
                  <Td num>{Number(r.credits) ? `(${amt(r.credits)})` : amt("0")}</Td>
                  <Td num>{amt(r.total)}</Td>
                </tr>
              ))}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("المجموع", "Total")}</Td>{BUCKETS.map((b) => <Td key={b} num>{amt(a.totals[b])}</Td>)}<Td num>{Number(a.credits) ? `(${amt(a.credits)})` : amt("0")}</Td><Td num>{amt(a.subledger)}</Td></tr>
            </tbody>
          </Table>
        )}
        {a && (a.reconciled && a.advances.reconciled
          ? <div className="flex items-center gap-2 text-xs text-brown flex-wrap"><Badge tone="ok">✓ {L("مطابق", "Agrees")}</Badge>{L(`رصيد الحساب 1130 في دفتر الأستاذ: ${amt(a.ledger)} · الفرق 0.00 · الدفعات المقدمة ${amt(a.advances.total)} = رصيد 2410 وضريبتها`, `Account 1130 in the ledger: ${amt(a.ledger)} · difference 0.00 · advances ${amt(a.advances.total)} = 2410 and its VAT`)}</div>
          : <Notice tone="warn">{L(`الفرق مع دفتر الأستاذ ${amt(a.difference)} (الدفعات المقدمة: ${amt(a.advances.total)} مقابل ${amt(a.advances.ledger)}): تحصيلات مُسندة لم تُرحَّل ${a.explanation.receiptsAssignedNotYetPosted} · مستندات بانتظار الترحيل ${a.explanation.documentsWaitingToPost}.`, `Difference with the ledger ${amt(a.difference)} (advances ${amt(a.advances.total)} vs ${amt(a.advances.ledger)}): receipts assigned but not posted ${a.explanation.receiptsAssignedNotYetPosted} · documents waiting to post ${a.explanation.documentsWaitingToPost}.`)}</Notice>)}
      </Card>

      {a && a.advances.rows.length > 0 && (
        <Card>
          <CardTitle title={L("الدفعات المقدمة من العملاء", "Customer advances")} sub={L("المستلم ولم يُطبَّق بعد على فاتورة — الضريبة حسب قرار D-2", "Received and not yet applied to an invoice — VAT per decision D-2")} />
          <Table>
            <thead><tr><Th>{L("العميل", "Customer")}</Th><Th num>{L("الصافي (2410)", "Net (2410)")}</Th><Th num>{L("الضريبة (2170)", "VAT (2170)")}</Th><Th num>{L("الإجمالي", "Total")}</Th></tr></thead>
            <tbody>
              {a.advances.rows.map((r) => (
                <tr key={r.customerId}><Td>{r.customer}</Td><Td num>{amt(String(Number(r.amount) - Number(r.vat)))}</Td><Td num>{amt(r.vat)}</Td><Td num>{amt(r.amount)}</Td></tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <div id="ar-statement" className="scroll-mt-4" />
        <CardTitle title={st.data ? L(`كشف حساب: ${st.data.customer.name}`, `Statement: ${st.data.customer.name}`) : L("كشف حساب عميل", "Customer statement")}
          sub={st.data ? `${day(from)} – ${day(to)}${st.data.customer.vatNumber ? ` · ${L("الرقم الضريبي", "VAT no.")} ${st.data.customer.vatNumber}` : ""} · ${L("يطابق أطراف العميل في الأستاذ", "agrees to the customer's ledger lines")}` : undefined}
          right={<Button icon={Download} onClick={csv} disabled={!st.data}>{L("تصدير CSV", "Export CSV")}</Button>} />
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("العميل", "Customer")}>
            <select className={INPUT} value={cid} onChange={(e) => setCustomerId(e.target.value)}>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </Field>
          <Field label={L("من", "From")}><input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={L("إلى", "To")}><input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {!cid ? <EmptyState title={L("لا يوجد عملاء", "No customers")} /> : st.error ? <ErrorState error={st.error} onRetry={st.reload} /> : !st.data ? <LoadingState /> : (
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("المستند", "Document")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th><Th num>{L("الرصيد", "Balance")}</Th></tr></thead>
            <tbody>
              <tr><Td>{day(from)}</Td><Td>—</Td><Td className="font-bold">{L("رصيد أول المدة", "Opening balance")}</Td><Td num></Td><Td num></Td><Td num>{amt(st.data.opening)}</Td></tr>
              {st.data.lines.map((l, i) => (
                <tr key={i}>
                  <Td className="whitespace-nowrap">{day(l.date)}</Td>
                  <Td>{l.kind === "invoice" || l.kind === "credit_note" || (l.kind === "reversal" && /^(INV|CN)-/.test(l.ref)) ? <a className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/receivables/${l.refId}`}>{l.ref}</a> : <span className="font-bold text-orange tabular-nums">{l.ref}</span>}</Td>
                  <Td>{l.text}</Td><Td num>{Number(l.debit) ? amt(l.debit) : ""}</Td><Td num>{Number(l.credit) ? amt(l.credit) : ""}</Td><Td num>{amt(l.balance)}</Td>
                </tr>
              ))}
              <tr className="bg-cream-dark font-extrabold"><Td></Td><Td></Td><Td>{Number(st.data.closing) >= 0 ? L("الرصيد الختامي (مدين)", "Closing balance (debit)") : L("الرصيد الختامي (دائن)", "Closing balance (credit)")}</Td><Td num>{amt(sums!.d.toFixed(2))}</Td><Td num>{amt(sums!.c.toFixed(2))}</Td><Td num>{amt(st.data.closing)}</Td></tr>
            </tbody>
          </Table>
        )}
        {st.data && <p className="text-xs text-brown">{L(`رصيد العميل على 1130 و2410 وضريبة الدفعات في دفتر الأستاذ: ${amt(st.data.ledgerBalance)}`, `Customer balance on 1130, 2410 and advance VAT in the ledger: ${amt(st.data.ledgerBalance)}`)}{st.data.reconciled ? " ✓" : L(" — يختلف بقدر مستندات أو تحصيلات لم تُرحَّل", " — differs by documents or receipts not yet posted")}</p>}
      </Card>
    </div>
  );
}
