"use client";

// Gross margin per sales document for a period (stage 4b): revenue from the posted ledger, cost of
// sales from the sale's inventory moves, and a row whose costing is not finished says so — never a
// silent zero. Below, the report is reconciled to the revenue, sales-returns (4900) and cost-of-sales
// accounts, every difference explained line by line.
import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL, type Tone } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useDay, useExplain } from "../../_components/kit";

type Row = {
  invoiceId: string; kind: "INVOICE" | "CREDIT_NOTE"; no: number; customer: string; date: string; status: string; creditType: string | null;
  revenue: string; cogs: string; margin: string | null; marginPercent: string | null; costStatus: string; costReason: string | null; costComplete: boolean; late: boolean;
};
type Explained = { label: string; amount: string }[];
type Margin = {
  rows: Row[];
  totals: { revenue: string; cogs: string; margin: string; pendingDocuments: number; pendingRevenue: string };
  complete: boolean;
  reconciliation: {
    revenue: { report: string; ledger: string; explained: Explained; difference: string };
    returns: { report: string; ledger: string; difference: string };
    cogs: { report: string; ledger: string; explained: Explained; difference: string };
  };
};

const COST: Record<string, [string, string, Tone]> = {
  COSTED: ["مكلفة", "Costed", "ok"], NOT_REQUIRED: ["لا تحتاج تكلفة", "No cost needed", "info"], CANCELLED: ["ملغاة", "Cancelled", "info"],
  UNCOSTED: ["بلا تكلفة (غير مخزنية)", "No cost (not stock)", "info"],
  BOOKED_LATER: ["التكلفة قُيّدت لاحقاً", "Cost booked later", "warn"], PENDING: ["التكلفة بانتظار الاحتساب", "Cost pending", "warn"],
  AWAITING_POLICY: ["بانتظار قرار توقيت التكلفة", "Awaiting the cost-timing decision", "warn"], AWAITING_DISPATCH: ["بانتظار التسليم", "Awaiting dispatch", "warn"],
  BLOCKED: ["التكلفة محجوبة", "Cost blocked", "bad"], FAILED: ["فشل احتساب التكلفة", "Costing failed", "bad"], UNCLASSIFIED: ["إشعار غير مصنّف", "Unclassified credit", "bad"],
};

/** Reconciliation labels come from the server in English; the known ones are shown in Arabic. */
function useLabel() {
  const { lang } = useL();
  return (s: string) => {
    if (lang !== "ar") return s;
    const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
      [/^manual journals on (\S+)$/, (m) => `قيود يدوية على ${m[1]}`], [/^(\S+) postings on (\S+)$/, (m) => `ترحيلات ${m[1]} على ${m[2]}`],
      [/^manual journals$/, () => "قيود يدوية"], [/^(\S+) postings$/, (m) => `ترحيلات ${m[1]}`],
      [/^café and internal use issues$/, () => "صرف المقهى والاستهلاك الداخلي"],
      [/^cost adjustments on goods sold/, () => "تسويات تكلفة على بضاعة مباعة لا تُنسب لبيع واحد (ترحيلات المرحلة 4)"],
      [/^inventory documents whose journal is waiting \((.+)\)$/, (m) => `مستندات مخزون قيدها بانتظار الترحيل (${m[1]})`],
      [/^(.+) documents not tied to a sale$/, (m) => `مستندات ${m[1]} غير مرتبطة ببيع`],
    ];
    for (const [re, f] of rules) { const m = s.match(re); if (m) return f(m); }
    return s;
  };
}

const sumOf = (rows: Row[]) => (rows.reduce((s, r) => s + Math.round(Number(r.revenue) * 100), 0) / 100).toFixed(2);

export default function GrossMarginPage() {
  const { L } = useL();
  const explain = useExplain();
  const amt = useAmount();
  const day = useDay();
  const [to, setTo] = useState(riyadhToday);
  const [from, setFrom] = useState(() => `${riyadhToday().slice(0, 4)}-01-01`);
  const { data: d, error, reload } = useApi<Margin>(`/api/accounting/inventory/reports/gross-margin?from=${from}&to=${to}`);
  const pending = d?.rows.filter((r) => !r.costComplete) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("مجمل الربح لكل مستند مبيعات", "Gross margin per sales document")}
          sub={L("الإيراد من قيود المبيعات المرحّلة (فواتير، إشعارات دائنة، عكس) وتكلفة المبيعات من حركات مخزون البيع، بتواريخ القيد", "Revenue from posted sales journals (invoices, credit notes, reversals) and cost of sales from the sale's inventory moves, by their ledger dates")}
          right={<>
            <Link href="/dashboard/accounting/inventory/returns"><Button>{L("مرتجعات العملاء", "Customer returns")}</Button></Link>
            <Link href="/dashboard/accounting/inventory/grni"><Button>{L("المطابقة والاستلام", "Matching & receipts")}</Button></Link>
            {d && <Badge tone={d.complete ? "ok" : "warn"}>{d.complete ? L("✓ مكتمل", "✓ Complete") : L(`غير مكتمل · ${d.totals.pendingDocuments}`, `Incomplete · ${d.totals.pendingDocuments}`)}</Badge>}
          </>} />
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("من", "From")}><input type="date" className={`${INPUT} max-w-[180px]`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={L("إلى", "To")}><input type="date" className={`${INPUT} max-w-[180px]`} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {error ? <ErrorState error={error} onRetry={reload} /> : !d ? <LoadingState /> : (<>
          {!d.complete && (
            <Notice tone="warn">
              <p className="font-bold">{L(`التقرير غير مكتمل: ${d.totals.pendingDocuments} مستند لم تكتمل تكلفته (إيراده ${amt(d.totals.pendingRevenue)} ر.س). لا يُعرض له ربح، ولا تُعامل تكلفته كصفر.`, `The report is incomplete: ${d.totals.pendingDocuments} documents have unfinished costing (revenue SAR ${amt(d.totals.pendingRevenue)}). No margin is shown for them, and their cost is not treated as zero.`)}</p>
              <ul className="mt-1 list-disc ps-5">{pending.map((r) => (
                <li key={r.invoiceId}>{r.kind === "CREDIT_NOTE" ? "CN" : "INV"}-{r.no} · {r.customer} — {L(COST[r.costStatus]?.[0] ?? r.costStatus, COST[r.costStatus]?.[1] ?? r.costStatus)}{r.costReason ? <span> · {explain(r.costReason)}</span> : null}</li>
              ))}</ul>
            </Notice>
          )}
          {d.rows.length === 0 ? <EmptyState title={L("لا مبيعات في الفترة", "No sales in the period")} /> : (
            <Table>
              <thead><tr><Th>{L("المستند", "Document")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("العميل", "Customer")}</Th><Th num>{L("الإيراد", "Revenue")}</Th><Th num>{L("مرتجعات وإشعارات", "Returns & credits")}</Th><Th num>{L("تكلفة المبيعات", "Cost of sales")}</Th><Th num>{L("مجمل الربح", "Margin")}</Th><Th num>%</Th><Th>{L("التكلفة", "Cost status")}</Th></tr></thead>
              <tbody>
                {d.rows.map((r) => {
                  const c = COST[r.costStatus] ?? [r.costStatus, r.costStatus, "info" as Tone];
                  const credit = r.kind === "CREDIT_NOTE";
                  return (
                    <tr key={r.invoiceId} className={r.costComplete ? "" : "bg-amber-50/60"}>
                      <Td className="whitespace-nowrap"><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/receivables/${r.invoiceId}`}>{credit ? "CN" : "INV"}-{r.no}</Link>
                        {r.status === "REVERSED" && <span className="ms-1"><Badge tone="info">{L("معكوسة", "Reversed")}</Badge></span>}
                        {credit && r.creditType && <span className="block text-[11px] text-brown">{r.creditType === "RETURN_OF_GOODS" ? L("بضاعة مرتجعة", "Goods returned") : r.creditType === "PRICE_ADJUSTMENT" ? L("تعديل سعر", "Price adjustment") : r.creditType}</span>}</Td>
                      <Td className="whitespace-nowrap">{day(r.date)}</Td>
                      <Td>{r.customer}</Td>
                      <Td num>{credit ? "" : amt(r.revenue)}</Td>
                      <Td num>{credit ? amt(r.revenue) : ""}</Td>
                      <Td num>{r.costComplete ? amt(r.cogs) : <span className="text-amber-700 font-bold" title={r.costReason ?? undefined}>{Number(r.cogs) !== 0 ? `${amt(r.cogs)} + ؟` : L("غير معروفة", "Unknown")}</span>}</Td>
                      <Td num className="font-bold">{r.margin === null ? "—" : amt(r.margin)}</Td>
                      <Td num>{r.marginPercent === null ? "—" : `${r.marginPercent}%`}</Td>
                      <Td><span title={r.costReason ?? undefined}><Badge tone={c[2]}>{L(c[0], c[1])}</Badge></span>
                        {r.late && r.costStatus !== "BOOKED_LATER" && <span className="block text-[11px] text-brown">{L("تكلفة متأخرة", "Late costing")}</span>}
                        {r.costReason && <span className="block text-[11px] text-brown max-w-[260px]">{explain(r.costReason)}</span>}</Td>
                    </tr>
                  );
                })}
                <tr className="bg-cream-dark font-extrabold">
                  <Td>{L("المجموع", "Total")}</Td><Td /><Td />
                  <Td num>{amt(sumOf(d.rows.filter((r) => r.kind !== "CREDIT_NOTE")))}</Td><Td num>{amt(sumOf(d.rows.filter((r) => r.kind === "CREDIT_NOTE")))}</Td>
                  <Td num>{amt(d.totals.cogs)}{d.complete ? "" : " + ؟"}</Td>
                  <Td num>{amt(d.totals.margin)}{d.complete ? "" : <span className="block text-[11px] font-normal text-brown">{L("للمستندات المكتملة فقط", "complete documents only")}</span>}</Td><Td num /><Td />
                </tr>
              </tbody>
            </Table>
          )}
          <Reconciliation d={d} />
        </>)}
      </Card>
    </div>
  );
}

const zero = (s: string) => Math.abs(Number(s)) < 0.005;

function RecLine({ text, value, strong }: { text: string; value: string; strong?: boolean }) {
  const amt = useAmount();
  return <div className={`flex items-baseline justify-between gap-3 ${strong ? "font-extrabold text-charcoal" : "text-brown"}`}><span>{text}</span><span className="tabular-nums whitespace-nowrap">{amt(value)}</span></div>;
}

function Block({ title, report, ledger, explained, difference, reportText }: { title: string; report: string; ledger: string; explained?: Explained; difference: string; reportText: string }) {
  const { L } = useL();
  const amt = useAmount();
  const label = useLabel();
  return (
    <div className="rounded-xl border border-border p-3 flex flex-col gap-1.5 text-[13px]">
      <p className={`text-[13px] font-extrabold ${zero(difference) ? "text-green-700" : "text-red-700"}`}>{zero(difference) ? "✓" : "✕"} <span className="text-charcoal">{title}</span></p>
      <RecLine text={L("رصيد الحسابات في الأستاذ", "Ledger accounts")} value={ledger} strong />
      <RecLine text={reportText} value={report} />
      {(explained ?? []).map((e) => <RecLine key={e.label} text={label(e.label)} value={e.amount} />)}
      <div className={`flex items-baseline justify-between gap-3 font-bold ${zero(difference) ? "text-green-700" : "text-red-700"}`}>
        <span>{zero(difference) ? L("✓ لا فرق غير مفسَّر", "✓ No unexplained difference") : L("✕ فرق غير مفسَّر", "✕ Unexplained difference")}</span><span className="tabular-nums">{amt(difference)}</span>
      </div>
    </div>
  );
}

function Reconciliation({ d }: { d: Margin }) {
  const { L } = useL();
  const rc = d.reconciliation;
  return (
    <div className="flex flex-col gap-2" aria-label={L("المطابقة مع دفتر الأستاذ", "Reconciliation to the ledger")}>
      <p className="text-[14px] font-extrabold text-charcoal">{L("المطابقة مع دفتر الأستاذ", "Reconciliation to the ledger")}</p>
      <div className="grid gap-3 lg:grid-cols-3 items-start">
        <Block title={L("الإيراد (حسابات الإيرادات)", "Revenue (revenue accounts)")} report={rc.revenue.report} ledger={rc.revenue.ledger} explained={rc.revenue.explained} difference={rc.revenue.difference} reportText={L("إيراد مستندات المبيعات في التقرير", "Sales documents' revenue in the report")} />
        <Block title={L("مرتجعات المبيعات (4900)", "Sales returns (4900)")} report={rc.returns.report} ledger={rc.returns.ledger} difference={rc.returns.difference} reportText={L("قيود مستندات المبيعات عليه في التقرير", "Sales documents' entries on it in the report")} />
        <Block title={L("تكلفة المبيعات", "Cost of sales")} report={rc.cogs.report} ledger={rc.cogs.ledger} explained={rc.cogs.explained} difference={rc.cogs.difference} reportText={L("تكلفة مستندات المبيعات في التقرير", "Sales documents' cost in the report")} />
      </div>
      <p className="text-xs text-brown">{L("الإيراد يُقرأ دائناً ناقص مدين، وتكلفة المبيعات مديناً ناقص دائن. كل بند مفسَّر يُضاف لرقم التقرير ليطابق الأستاذ؛ أي باقٍ يظهر فرقاً غير مفسَّر.", "Revenue reads credit less debit; cost of sales debit less credit. Each explained line is added to the report figure to reach the ledger; anything left shows as an unexplained difference.")}</p>
    </div>
  );
}
