"use client";

// Figma: ACC-40. Inventory value as of a date, per item and location, from posted cost moves,
// tied to the inventory accounts 1171–1175; the D-1 status is always visible.
import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { riyadhToday, useAmount, useCan } from "../_components/kit";
import { KindBadge, qty } from "./_ui";

type Valuation = {
  lines: { itemId: string; code: string; name: string; kind: string; baseUnit: string; locationId: string; location: string; qty: string; value: string; unitCost: string | null }[];
  total: string; reconciled: boolean;
  accounts: { role: string; account: { code: string; name: string } | null; subledger: string; ledger: string | null; difference: string | null; reconciled: boolean | null }[];
  explanation: { documentsWaitingToPost: number; provisionalDocuments: number };
  settings: { costMethod: string | null; priceDifference: string | null };
};
type Loc = { id: string; code: string; name: string; nameAr: string | null };

export default function InventoryValuationPage() {
  const { L } = useL();
  const amt = useAmount();
  const { can } = useCan();
  const [asOf, setAsOf] = useState(riyadhToday);
  const [loc, setLoc] = useState("ALL");
  const locs = useApi<Loc[]>("/api/accounting/inventory/locations");
  const v = useApi<Valuation>(`/api/accounting/inventory/reports/valuation?asOf=${asOf}${loc !== "ALL" ? `&locationId=${loc}` : ""}`);
  const d = v.data;
  const method = d?.settings.costMethod;
  return (
    <Card>
      <CardTitle title={L(`قيمة المخزون — كما في ${asOf.split("-").reverse().join("/")}`, `Inventory value — as of ${asOf}`)}
        sub={L("من حركات التكلفة المرحّلة حتى التاريخ · لكل صنف وموقع · يطابق حسابات المخزون 1171–1175", "From posted cost moves up to the date · per item and location · agrees to inventory accounts 1171–1175")}
        right={<>
          <Link href="/dashboard/accounting/inventory/setup"><Button>{L("الأصناف وقرار D-1", "Items & decision D-1")}</Button></Link>
          <Link href="/dashboard/accounting/inventory/grni"><Button>{L("المطابقة والاستلام", "Matching & receipts")}</Button></Link>
          <Link href="/dashboard/accounting/inventory/documents"><Button>{L("المستندات", "Documents")}</Button></Link>
          {can("inv_doc_create") && <Link href="/dashboard/accounting/inventory/documents/new"><Button kind="primary" icon={Plus}>{L("مستند مخزون", "Inventory document")}</Button></Link>}
        </>} />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("كما في", "As of")}><input type="date" className={`${INPUT} max-w-[180px]`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Segmented<string> value={loc} onChange={setLoc} options={[{ value: "ALL", label: L("كل المواقع", "All locations") }, ...(locs.data ?? []).map((l) => ({ value: l.id, label: l.nameAr ?? l.name }))]} />
      </div>
      {v.error ? <ErrorState error={v.error} onRetry={v.reload} /> : !d ? <LoadingState /> : (<>
        {d.accounts.length > 0 && (
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[12px]" aria-label={L("المطابقة مع دفتر الأستاذ", "Tie-out to the ledger")}>
            <span className="text-[13px] font-extrabold text-charcoal">{L(`المجموع ${amt(d.total)} ر.س${loc === "ALL" ? " — يطابق دفتر الأستاذ:" : ""}`, `Total SAR ${amt(d.total)}${loc === "ALL" ? " — agrees to the ledger:" : ""}`)}</span>
            {d.accounts.map((a) => (
              <span key={a.role} className={`font-bold ${a.reconciled === false ? "text-red-700" : "text-green-700"}`}>
                {a.reconciled === false ? "✕" : "✓"} {a.account?.code} {a.account?.name} {amt(a.subledger)}{a.reconciled === false ? L(` (الأستاذ ${amt(a.ledger)})`, ` (ledger ${amt(a.ledger)})`) : ""}
              </span>
            ))}
          </div>
        )}
        {d.lines.length === 0 ? <EmptyState title={L("لا مخزون مرحّل حتى هذا التاريخ", "No posted stock up to this date")} body={L("ابدأ باستلام من مورد أو بجرد افتتاحي.", "Start with a goods receipt or an opening count.")} /> : (
          <Table>
            <thead><tr><Th>{L("الصنف", "Item")}</Th><Th>{L("النوع", "Kind")}</Th><Th>{L("الموقع", "Location")}</Th><Th num>{L("الكمية", "Quantity")}</Th><Th>{L("الوحدة", "Unit")}</Th><Th num>{L("متوسط التكلفة", "Average cost")}</Th><Th num>{L("القيمة", "Value")}</Th><Th /></tr></thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={`${l.itemId}-${l.locationId}`}>
                  <Td>{l.code} · {l.name}</Td><Td><KindBadge kind={l.kind} /></Td><Td>{l.location}</Td><Td num>{qty(l.qty)}</Td><Td>{l.baseUnit}</Td><Td num>{qty(l.unitCost)}</Td><Td num>{amt(l.value)}</Td>
                  <Td><Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/inventory/stock-card?itemId=${l.itemId}&locationId=${l.locationId}&to=${asOf}`}>{L("بطاقة الصنف", "Stock card")}</Link></Td>
                </tr>
              ))}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("المجموع", "Total")}</Td><Td /><Td /><Td /><Td /><Td /><Td num>{amt(d.total)}</Td><Td /></tr>
            </tbody>
          </Table>
        )}
        {(d.explanation.documentsWaitingToPost > 0) && <Notice tone="warn">{L(`${d.explanation.documentsWaitingToPost} مستند مرحّل لم يصل قيده لدفتر الأستاذ بعد (سياسة أو ربط حساب بانتظار الاعتماد) — لذلك قد يختلف الأستاذ عن المخزون.`, `${d.explanation.documentsWaitingToPost} posted documents have no journal yet (policy or mapping waiting) — the ledger may differ from the stock until they post.`)}</Notice>}
        <Notice tone={method ? "info" : "warn"}>{method
          ? L(`قرار D-1: طريقة التكلفة «${method === "FIFO" ? "الوارد أولاً صادر أولاً" : "المتوسط المرجح"}»${d.explanation.provisionalDocuments ? ` · ${d.explanation.provisionalDocuments} مستند مرحّل مؤقتاً (اختبار)` : ""}.`, `Decision D-1: costing method ${method === "FIFO" ? "FIFO" : "weighted average"}${d.explanation.provisionalDocuments ? ` · ${d.explanation.provisionalDocuments} documents posted provisionally (test)` : ""}.`)
          : L("قرار D-1 لم يُحسم: لا يُرحّل مستند مخزون إلا مؤقتاً في قاعدة اختبار معزولة. الأرقام هنا تجريبية.", "Decision D-1 is not settled: inventory documents post only provisionally in an isolated test database. Figures here are synthetic.")}</Notice>
        <p className="text-xs text-brown">{L("الكميات المحاسبية منفصلة عن سجلات التشغيل (البن الأخضر، مواد التغليف، الدُفعات) ومربوطة بها؛ تقرير «التطابق مع التشغيل» في صفحة المطابقة يبيّن الفروق دون تعديل أي منهما.", "Accounting quantities are kept apart from the operational records (green coffee, packaging materials, batches) and linked to them; the operational agreement report on the matching page shows differences without changing either.")}</p>
      </>)}
    </Card>
  );
}
