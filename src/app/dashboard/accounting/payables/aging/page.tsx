"use client";

// Figma: ACC-23. Payables aging (tied to the control account) and supplier statement.
import { useState } from "react";
import { Download } from "lucide-react";
import { Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useDay } from "../../_components/kit";

type Aging = { asOf: string; rows: { supplierId: string; supplier: string; bills: number; buckets: Record<string, string>; total: string }[]; totals: Record<string, string>; subledger: string; overpaidTotal: string; overpaid: { billId: string; billNo: number; supplier: string; amount: string }[]; ledger: string | null; difference: string | null; reconciled: boolean; explanation: { paymentsMatchedNotYetPostedFromBank: string; billsPostedWithoutJournal: number } };
type Statement = { supplier: { name: string; vatNumber: string | null; paymentTermsDays: number }; opening: string; closing: string; ledgerBalance: string | null; totals: { debit: string; credit: string }; lines: { date: string; kind: string; ref: string; refId: string; text: string; debit: string; credit: string; balance: string }[] };
type Tab = "AGING" | "STATEMENT";
const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90p"] as const;

export default function PayablesAgingPage() {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const [tab, setTab] = useState<Tab>("AGING");
  const [asOf, setAsOf] = useState(riyadhToday);
  const [supplierId, setSupplierId] = useState("");
  const [from, setFrom] = useState(() => `${riyadhToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(riyadhToday);
  const aging = useApi<Aging>(`/api/accounting/reports/ap-aging?asOf=${asOf}`);
  const suppliers = useApi<{ id: string; name: string }[]>("/api/accounting/suppliers");
  const sid = supplierId || aging.data?.rows[0]?.supplierId || suppliers.data?.[0]?.id || "";
  const st = useApi<Statement>(tab === "STATEMENT" && sid ? `/api/accounting/reports/supplier-statement?supplierId=${sid}&from=${from}&to=${to}` : null);
  const label = { current: L("غير مستحقة", "Not due"), d1_30: "1–30", d31_60: "31–60", d61_90: "61–90", d90p: "+90" } as Record<string, string>;
  const csv = () => {
    if (!st.data) return;
    const rows = [["date", "document", "text", "debit", "credit", "balance"], ...st.data.lines.map((l) => [String(l.date).slice(0, 10), l.ref, l.text, l.debit, l.credit, l.balance])];
    const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `supplier-statement-${to}.csv`; a.click();
  };
  const seg = <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: "AGING", label: L("أعمار الذمم الدائنة", "Payables aging") }, { value: "STATEMENT", label: L("كشف حساب مورد", "Supplier statement") }]} />;

  if (tab === "AGING") return (
    <Card>
      <CardTitle title={L(`أعمار الذمم الدائنة — كما في ${day(asOf)}`, `Payables aging — as of ${day(asOf)}`)} sub={L("من الفواتير المرحّلة ناقص المدفوعات المطابقة · يُطابَق مع حساب الذمم الدائنة", "Posted bills less matched payments · tied to the payables account")} right={seg} />
      <Field label={L("كما في", "As of")}><input type="date" className={`${INPUT} max-w-[180px]`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      {aging.error ? <ErrorState error={aging.error} onRetry={aging.reload} /> : !aging.data ? <LoadingState /> : aging.data.rows.length === 0 ? <EmptyState title={L("لا ذمم دائنة مفتوحة", "No open payables")} /> : (
        <Table>
          <thead><tr><Th>{L("المورد", "Supplier")}</Th>{BUCKETS.map((b) => <Th key={b} num>{label[b]}</Th>)}<Th num>{L("الإجمالي", "Total")}</Th></tr></thead>
          <tbody>
            {aging.data.rows.map((r) => (
              <tr key={r.supplierId}>
                <Td><button type="button" className="font-bold text-orange hover:underline" onClick={() => { setSupplierId(r.supplierId); setTab("STATEMENT"); }}>{r.supplier}</button></Td>
                {BUCKETS.map((b) => <Td key={b} num className={b !== "current" && Number(r.buckets[b]) > 0 ? "text-red-700 font-bold" : ""}>{amt(r.buckets[b])}</Td>)}
                <Td num>{amt(r.total)}</Td>
              </tr>
            ))}
            {aging.data.overpaid.length > 0 && <tr><Td>{L(`أرصدة مدينة لموردين (مدفوع بالزيادة): ${aging.data.overpaid.map((o) => `ف-${o.billNo}`).join("، ")}`, `Supplier debit balances (overpaid): ${aging.data.overpaid.map((o) => `B-${o.billNo}`).join(", ")}`)}</Td>{BUCKETS.map((b) => <Td key={b}>{""}</Td>)}<Td num>{amt(aging.data.overpaidTotal)}</Td></tr>}
            <tr className="bg-cream-dark font-extrabold"><Td>{L("المجموع", "Total")}</Td>{BUCKETS.map((b) => <Td key={b} num>{amt(aging.data!.totals[b])}</Td>)}<Td num>{amt(aging.data.subledger)}</Td></tr>
          </tbody>
        </Table>
      )}
      {aging.data && (aging.data.reconciled
        ? <div className="flex items-center gap-2 text-xs text-brown"><Badge tone="ok">✓ {L("مطابق", "Agrees")}</Badge>{L(`رصيد حساب الذمم الدائنة في دفتر الأستاذ: ${amt(aging.data.ledger)} · الفرق 0.00`, `Payables account in the ledger: ${amt(aging.data.ledger)} · difference 0.00`)}</div>
        : <Notice tone="warn">{L(`الفرق مع دفتر الأستاذ ${amt(aging.data.difference)}: مدفوعات مطابقة لم تُرحَّل من البنك بعد ${amt(aging.data.explanation.paymentsMatchedNotYetPostedFromBank)} · فواتير مرحّلة بلا قيد ${aging.data.explanation.billsPostedWithoutJournal}.`, `Difference with the ledger ${amt(aging.data.difference)}: matched payments not yet posted from the bank ${amt(aging.data.explanation.paymentsMatchedNotYetPostedFromBank)} · posted bills without a journal ${aging.data.explanation.billsPostedWithoutJournal}.`)}</Notice>)}
    </Card>
  );

  return (
    <Card>
      <CardTitle title={st.data ? L(`كشف حساب: ${st.data.supplier.name}`, `Statement: ${st.data.supplier.name}`) : L("كشف حساب مورد", "Supplier statement")}
        sub={st.data ? `${day(from)} – ${day(to)}${st.data.supplier.vatNumber ? ` · ${L("الرقم الضريبي", "VAT no.")} ${st.data.supplier.vatNumber}` : ""}` : undefined} right={seg} />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("المورد", "Supplier")}>
          <select className={INPUT} value={sid} onChange={(e) => setSupplierId(e.target.value)}>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        <Field label={L("من", "From")}><input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={L("إلى", "To")}><input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button icon={Download} onClick={csv} disabled={!st.data}>{L("تصدير CSV", "Export CSV")}</Button>
      </div>
      {st.error ? <ErrorState error={st.error} onRetry={st.reload} /> : !st.data ? <LoadingState /> : (
        <Table>
          <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("المستند", "Document")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th><Th num>{L("الرصيد", "Balance")}</Th></tr></thead>
          <tbody>
            <tr><Td>{day(from)}</Td><Td>—</Td><Td className="font-bold">{L("رصيد أول المدة", "Opening balance")}</Td><Td num></Td><Td num></Td><Td num>{amt(st.data.opening)}</Td></tr>
            {st.data.lines.map((l, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap">{day(l.date)}</Td>
                <Td>{l.kind === "payment" ? <span className="font-bold text-orange">{L("بنك", "Bank")} {l.ref}</span> : <a className="font-bold text-orange hover:underline" href={`/dashboard/accounting/payables/${l.refId}`}>{l.ref}</a>}</Td>
                <Td>{l.text}</Td><Td num>{Number(l.debit) ? amt(l.debit) : ""}</Td><Td num>{Number(l.credit) ? amt(l.credit) : ""}</Td><Td num>{amt(l.balance)}</Td>
              </tr>
            ))}
            <tr className="bg-cream-dark font-extrabold"><Td></Td><Td></Td><Td>{L("الرصيد الختامي (دائن)", "Closing balance (credit)")}</Td><Td num>{amt(st.data.totals.debit)}</Td><Td num>{amt(st.data.totals.credit)}</Td><Td num>{amt(st.data.closing)}</Td></tr>
          </tbody>
        </Table>
      )}
      {st.data?.ledgerBalance !== null && st.data?.ledgerBalance !== undefined && (
        <p className="text-xs text-brown">{L(`رصيد المورد في حساب الذمم الدائنة بدفتر الأستاذ: ${amt(st.data.ledgerBalance)}`, `Supplier balance on the payables account in the ledger: ${amt(st.data.ledgerBalance)}`)}{st.data.ledgerBalance === st.data.closing ? " ✓" : L(" — يختلف بقدر المدفوعات غير المرحّلة من البنك", " — differs by payments not yet posted from the bank")}</p>
      )}
    </Card>
  );
}
