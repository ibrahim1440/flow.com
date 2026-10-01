"use client";

// VAT return (Figma ACC-72): from posted sales documents and supplier bills, reconciled to the
// output and input VAT accounts. A report for review; nothing is filed from the system.
import { useState } from "react";
import { Badge, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount } from "../../_components/kit";
import { TaxNav } from "../_ui";

type Box = { amount: string; vat: string; en: string; ar: string; total?: boolean; notModelled?: boolean };
type Ret = { from: string; to: string; boxes: Record<string, Box>; excluded: Record<string, { amount: string; vat: string }>; notModelled: string[];
  reconciliation: { role: string; code: string; name: string; fromDocuments: string; ledger: string; difference: string; unexplained: string; bySource: { source: string; amount: string; entries: number[]; outsideDocuments: boolean }[] }[] };
const SRC: Record<string, [string, string]> = { receivables: ["الفواتير والإشعارات", "invoices and notes"], payables: ["فواتير الموردين", "supplier bills"], manual: ["قيود يدوية", "manual journals"], bank: ["البنك", "bank"], inventory: ["المخزون", "inventory"] };

function quarter(today: string) {
  const [y, m] = today.split("-").map(Number);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  const end = new Date(Date.UTC(y, q0 + 2, 0)).toISOString().slice(0, 10);
  return { from: `${y}-${String(q0).padStart(2, "0")}-01`, to: end };
}

export default function VatReturnPage() {
  const { L } = useL();
  const amt = useAmount();
  const [range, setRange] = useState(() => quarter(riyadhToday()));
  const r = useApi<Ret>(`/api/accounting/tax/vat-return?from=${range.from}&to=${range.to}`);
  const x = r.data;
  return (
    <div className="flex flex-col gap-4">
      <TaxNav />
      <Card>
        <CardTitle title={L(`إقرار ضريبة القيمة المضافة — ${range.from} إلى ${range.to}`, `VAT return — ${range.from} to ${range.to}`)}
          sub={L("من الفواتير والإشعارات وفواتير الموردين المرحّلة، مطابَق لحسابي ضريبة المخرجات والمدخلات · للمراجعة، لا يُقدَّم من النظام", "From posted invoices, notes and supplier bills, reconciled to the output and input VAT accounts · for review; nothing is filed from the system")}
          right={<div className="flex gap-2 items-end">
            <Field label={L("من", "From")}><input aria-label={L("من", "From")} type="date" className={INPUT} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label={L("إلى", "To")}><input aria-label={L("إلى", "To")} type="date" className={INPUT} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </div>} />
        {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !x ? <LoadingState /> : (<>
          <Table>
            <thead><tr><Th>{L("البند", "Box")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th>{L("ملاحظة", "Note")}</Th></tr></thead>
            <tbody>{Object.entries(x.boxes).map(([k, b]) => (
              <tr key={k} className={`border-t border-border ${b.total ? "bg-cream font-bold" : ""}`} data-testid={`box-${k}`}><Td>{k} · {L(b.ar, b.en)}</Td><Td num>{b.amount ? amt(b.amount) : ""}</Td><Td num>{amt(b.vat)}</Td><Td>{b.notModelled ? <span className="text-[12px] text-brown">{L("غير مُنمذج", "Not modelled")}</span> : ""}</Td></tr>))}</tbody>
          </Table>
          {(x.excluded.salesUnclassified.amount !== "0.00" || x.excluded.purchasesUnclassified.amount !== "0.00") && <Notice tone="warn">{L(`بنود بلا فئة ضريبية: مبيعات ${x.excluded.salesUnclassified.amount}، مشتريات ${x.excluded.purchasesUnclassified.amount} — خارج البنود حتى تُصنّف`, `Lines with no tax category: sales ${x.excluded.salesUnclassified.amount}, purchases ${x.excluded.purchasesUnclassified.amount} — outside the boxes until classified`)}</Notice>}
          <h3 className="font-extrabold text-[14px]">{L("المطابقة مع الأستاذ العام", "Reconciliation with the general ledger")}</h3>
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("من المستندات", "From documents")}</Th><Th num>{L("الأستاذ", "Ledger")}</Th><Th num>{L("الفرق", "Difference")}</Th><Th>{L("التفسير", "Explanation")}</Th></tr></thead>
            <tbody>{x.reconciliation.map((c) => (
              <tr key={c.role} className="border-t border-border align-top" data-testid={`recon-${c.role}`}><Td>{c.code} · {c.name}</Td><Td num>{amt(c.fromDocuments)}</Td><Td num>{amt(c.ledger)}</Td><Td num>{c.difference === "0.00" ? amt(c.difference) : <b>{amt(c.difference)}</b>}</Td>
                <Td>{c.difference === "0.00" ? <Badge tone="ok">{L("مطابق", "Agrees")}</Badge> : <ul>{c.bySource.filter((s) => s.outsideDocuments).map((s) => <li key={s.source}>{L(SRC[s.source]?.[0] ?? s.source, SRC[s.source]?.[1] ?? s.source)} · {amt(s.amount)} · {L("قيود", "entries")} #{s.entries.join(", #")}</li>)}
                  <li className={c.unexplained === "0.00" ? "text-brown" : "font-bold text-red-700"}>{L("غير مفسَّر", "Unexplained")}: {amt(c.unexplained)}</li></ul>}</Td></tr>))}</tbody>
          </Table>
          <Notice tone="warn">{L("هيكل البنود يتبع نموذج الإقرار كما هو معروف؛ يجب مطابقته مع النموذج الرسمي قبل الاعتماد عليه. الصادرات والاستيراد والاحتساب العكسي وتصحيحات الفترات السابقة والرصيد المرحّل غير مُنمذجة.", "The box structure follows the return as commonly published; check it against the official form before relying on it. Exports, imports, reverse charge, corrections of earlier periods and credit carried forward are not modelled.")}</Notice>
        </>)}
      </Card>
    </div>
  );
}
