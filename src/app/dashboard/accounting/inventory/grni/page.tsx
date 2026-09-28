"use client";

// Figma: ACC-45. Goods received not invoiced (2120) as of a date, explained line by line; supplier
// bill lines waiting for a receipt; drafts from operational records (roasting batches, purchases);
// accounting vs operational quantities; and gross margin per invoice (revenue against cost of sales).
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useCan, useDay } from "../../_components/kit";
import { qty } from "../_ui";

type Grni = {
  openReceipts: { lineId: string; docNo: number; date: string; supplier: string; item: string; qty: string; value: string }[];
  openBills: { billLineId: string; billNo: number; date: string; supplier: string; description: string | null; net: string }[];
  landedAwaitingBill: { docId: string; docNo: number; date: string; description: string | null; amount: string }[];
  supplierReturns: { docId: string; docNo: number; date: string; supplier: string; value: string }[];
  receiptsTotal: string; billsTotal: string; landedTotal: string; returnsTotal: string; ledger: string | null;
};
type Sources = { roastingBatches: { id: string; batchNumber: string; date: string; greenBeanQuantity: string; roastedBeanQuantity: string; status: string }[]; purchases: { id: string; date: string; supplier: string; type: string; quantity: string; costPerUnit: string }[] };
type Agreement = { itemId: string; code: string; name: string; baseUnit: string; accounting: string; operational: string | null; source: string; difference: string | null }[];
type Margin = { rows: { invoiceId: string; invoiceNo: number; customer: string; date: string; revenue: string; cogs: string; margin: string; marginPercent: string | null }[]; totals: { revenue: string; cogs: string; margin: string } };
type Loc = { id: string; code: string; name: string; nameAr: string | null; isActive: boolean };

export default function GrniPage() {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const router = useRouter();
  const { can } = useCan();
  const [asOf, setAsOf] = useState(riyadhToday);
  const [from, setFrom] = useState(() => `${riyadhToday().slice(0, 4)}-01-01`);
  const g = useApi<Grni>(`/api/accounting/inventory/reports/grni?asOf=${asOf}`);
  const src = useApi<Sources>(can("inv_doc_create") ? "/api/accounting/inventory/pickers?what=sources" : null);
  const agr = useApi<Agreement>("/api/accounting/inventory/reports/operational");
  const mg = useApi<Margin>(`/api/accounting/inventory/reports/gross-margin?from=${from}&to=${asOf}`);
  const locs = useApi<Loc[]>("/api/accounting/inventory/locations");
  const [loc, setLoc] = useState("");
  const [busy, setBusy] = useState(""); const [err, setErr] = useState<string | null>(null);
  const d = g.data;
  const explained = d ? Number(d.receiptsTotal) - Number(d.billsTotal) + Number(d.landedTotal) - Number(d.returnsTotal) : 0;
  const ok = d && d.ledger !== null && Math.abs(explained - Number(d.ledger)) < 0.005;
  const draft = async (path: string, id: string) => {
    setBusy(id); setErr(null);
    try { const r = await api<{ id: string }>(`/api/accounting/inventory/${path}/${id}`, { method: "POST", json: { locationId: loc || undefined } }); router.push(`/dashboard/accounting/inventory/documents/${r.id}`); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    setBusy("");
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L(`بضاعة مستلمة لم تصل فاتورتها (2120) — كما في ${asOf.split("-").reverse().join("/")}`, `Goods received not invoiced (2120) — as of ${asOf}`)}
          sub={d ? L(`رصيد الأستاذ ${amt(d.ledger)} = استلامات لم تُطابق ${amt(d.receiptsTotal)} − فواتير بلا استلام ${amt(d.billsTotal)} + تكاليف إضافية بلا فاتورة ${amt(d.landedTotal)} − مرتجعات بانتظار إشعار المورد ${amt(d.returnsTotal)}`,
            `Ledger ${amt(d.ledger)} = unmatched receipts ${amt(d.receiptsTotal)} − bills without receipt ${amt(d.billsTotal)} + landed costs without bill ${amt(d.landedTotal)} − returns awaiting supplier credit ${amt(d.returnsTotal)}`) : undefined}
          right={d ? <Badge tone={ok ? "ok" : "bad"}>{ok ? L("✓ مفسَّر بالكامل", "✓ Fully explained") : L(`فرق ${amt((explained - Number(d.ledger ?? 0)).toFixed(2))}`, `Difference ${amt((explained - Number(d.ledger ?? 0)).toFixed(2))}`)}</Badge> : undefined} />
        <Field label={L("كما في", "As of")}><input type="date" className={`${INPUT} max-w-[180px]`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        {g.error ? <ErrorState error={g.error} onRetry={g.reload} /> : !d ? <LoadingState /> : (d.openReceipts.length + d.supplierReturns.length + d.landedAwaitingBill.length === 0 ? <EmptyState title={L("لا استلامات مفتوحة", "No open receipts")} /> : (
          <Table>
            <thead><tr><Th>{L("المستند", "Document")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("المورد", "Supplier")}</Th><Th>{L("الصنف", "Item")}</Th><Th num>{L("الكمية", "Quantity")}</Th><Th num>{L("القيمة", "Value")}</Th><Th /></tr></thead>
            <tbody>
              {d.openReceipts.map((r) => (
                <tr key={r.lineId}><Td className="font-bold text-orange tabular-nums">#{r.docNo}</Td><Td>{day(r.date)}</Td><Td>{r.supplier}</Td><Td>{r.item}</Td><Td num>{qty(r.qty)}</Td><Td num>{amt(r.value)}</Td>
                  <Td>{can("inv_doc_create") && <Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/inventory/documents/new?type=BILL_MATCH&targetLineId=${r.lineId}`}>{L("مطابقة بفاتورة…", "Match to a bill…")}</Link>}</Td></tr>
              ))}
              {d.landedAwaitingBill.map((l) => (
                <tr key={l.docId}><Td><Link className="font-bold text-orange tabular-nums" href={`/dashboard/accounting/inventory/documents/${l.docId}`}>#{l.docNo}</Link></Td><Td>{day(l.date)}</Td><Td>—</Td><Td>{l.description ?? L("تكلفة إضافية", "Landed cost")}</Td><Td num /><Td num>{amt(l.amount)}</Td><Td><Badge tone="warn">{L("بانتظار فاتورة", "Awaiting bill")}</Badge></Td></tr>
              ))}
              {d.supplierReturns.map((r) => (
                <tr key={r.docId}><Td><Link className="font-bold text-orange tabular-nums" href={`/dashboard/accounting/inventory/documents/${r.docId}`}>#{r.docNo}</Link></Td><Td>{day(r.date)}</Td><Td>{r.supplier}</Td><Td>{L("مرتجع لمورد", "Return to supplier")}</Td><Td num /><Td num className="text-red-700">({amt(r.value)})</Td><Td><Badge tone="warn">{L("بانتظار إشعار المورد", "Awaiting supplier credit")}</Badge></Td></tr>
              ))}
            </tbody>
          </Table>
        ))}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Card>
          <CardTitle title={L("فواتير مورد بلا استلام", "Supplier bills without a receipt")} sub={L("بنود مخزون في فواتير مرحّلة لم تُطابق باستلام ولم تُستخدم كتكلفة إضافية", "Stock lines on posted bills not matched to a receipt nor used as a landed cost")} />
          {!d ? <LoadingState /> : d.openBills.length === 0 ? <EmptyState title={L("لا شيء مفتوح", "Nothing open")} /> : (
            <Table>
              <thead><tr><Th>{L("الفاتورة", "Bill")}</Th><Th>{L("المورد", "Supplier")}</Th><Th>{L("البند", "Line")}</Th><Th num>{L("الصافي", "Net")}</Th><Th /></tr></thead>
              <tbody>{d.openBills.map((b) => (
                <tr key={b.billLineId}><Td className="tabular-nums">{L(`ف-${b.billNo}`, `B-${b.billNo}`)} · {day(b.date)}</Td><Td>{b.supplier}</Td><Td>{b.description ?? "—"}</Td><Td num>{amt(b.net)}</Td>
                  <Td>{can("inv_doc_create") && <span className="flex gap-3 whitespace-nowrap">
                    <Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/inventory/documents/new?type=BILL_MATCH&billLineId=${b.billLineId}`}>{L("مطابقة", "Match")}</Link>
                    <Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/inventory/documents/new?type=LANDED_COST&billLineId=${b.billLineId}`}>{L("تكلفة إضافية", "Landed cost")}</Link></span>}</Td></tr>
              ))}</tbody>
            </Table>
          )}
          <Notice tone="warn">{L("فرق سعر الفاتورة عن الاستلام يُعالج حسب قرار D-1: رسملته على المتبقي في المخزون وتحميل المستهلك على تكلفة المبيعات، أو تحميله كله على فروقات المخزون.", "A bill-to-receipt price difference follows decision D-1: capitalised on the stock still held (the consumed share to cost of sales), or expensed in full to inventory variance.")}</Notice>
        </Card>

        {can("inv_doc_create") && (
          <Card>
            <CardTitle title={L("مسودات من سجلات التشغيل", "Drafts from operational records")} sub={L("دُفعات التحميص وسجلات الشراء لم تُستخدم بعد · تُنشأ مسودة تُراجع وتُعتمد ولا يُعدَّل السجل التشغيلي", "Roasting batches and purchase records not yet used · creates a draft to review and approve; the operational record is not changed")} />
            {err && <Notice tone="bad">{err}</Notice>}
            <Field label={L("الموقع", "Location")}>
              <select className={`${INPUT} max-w-[240px]`} value={loc} onChange={(e) => setLoc(e.target.value)}>
                <option value="">{L("— اختر —", "— choose —")}</option>
                {(locs.data ?? []).filter((l) => l.isActive).map((l) => <option key={l.id} value={l.id}>{l.code} · {L(l.nameAr ?? l.name, l.name)}</option>)}
              </select>
            </Field>
            {!src.data ? <LoadingState /> : (src.data.roastingBatches.length + src.data.purchases.length === 0 ? <EmptyState title={L("لا سجلات جديدة", "No new records")} /> : (
              <Table>
                <thead><tr><Th>{L("السجل", "Record")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("التفاصيل", "Details")}</Th><Th /></tr></thead>
                <tbody>
                  {src.data.roastingBatches.map((b) => (
                    <tr key={b.id}><Td>{L("دُفعة تحميص", "Roasting batch")} {b.batchNumber}</Td><Td>{day(b.date)}</Td><Td>{L(`${Number(b.greenBeanQuantity)} كغ أخضر → ${Number(b.roastedBeanQuantity)} كغ محمص`, `${Number(b.greenBeanQuantity)} kg green → ${Number(b.roastedBeanQuantity)} kg roasted`)}</Td>
                      <Td><Button kind="secondary" disabled={!loc} busy={busy === b.id} onClick={() => draft("from-roasting", b.id)}>{L("مسودة إنتاج", "Production draft")}</Button></Td></tr>
                  ))}
                  {src.data.purchases.map((p) => (
                    <tr key={p.id}><Td>{L("شراء", "Purchase")} · {p.supplier}</Td><Td>{day(p.date)}</Td><Td>{Number(p.quantity)} × {Number(p.costPerUnit)}</Td>
                      <Td><Button kind="secondary" disabled={!loc} busy={busy === p.id} onClick={() => draft("from-purchase", p.id)}>{L("مسودة استلام", "Receipt draft")}</Button></Td></tr>
                  ))}
                </tbody>
              </Table>
            ))}
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Card>
          <CardTitle title={L("التطابق مع سجلات التشغيل", "Agreement with operational records")} sub={L("للعلم فقط: لا يُعدَّل أي من السجلين", "Information only: neither record is changed")} />
          {agr.error ? <ErrorState error={agr.error} onRetry={agr.reload} /> : !agr.data ? <LoadingState /> : agr.data.length === 0 ? <EmptyState title={L("لا أصناف مربوطة", "No linked items")} /> : (
            <Table>
              <thead><tr><Th>{L("الصنف", "Item")}</Th><Th num>{L("محاسبياً", "Accounting")}</Th><Th num>{L("تشغيلياً", "Operational")}</Th><Th num>{L("الفرق", "Difference")}</Th></tr></thead>
              <tbody>{agr.data.map((r) => (
                <tr key={r.itemId}><Td>{r.code} · {r.name}<span className="block text-[11px] text-brown" dir="ltr">{r.source}</span></Td><Td num>{qty(r.accounting)} {r.baseUnit}</Td><Td num>{qty(r.operational)}</Td>
                  <Td num className={r.difference && Number(r.difference) !== 0 ? "text-amber-700 font-bold" : ""}>{qty(r.difference)}</Td></tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardTitle title={L("مجمل الربح لكل فاتورة", "Gross margin per invoice")} sub={L("الإيراد من قيد الفاتورة المرحّل وتكلفة المبيعات من حركات التكلفة، بتواريخ القيد", "Revenue from the invoice's posted journal and cost of sales from cost moves, by their ledger dates")} />
          <Field label={L("من", "From")}><input type="date" className={`${INPUT} max-w-[180px]`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          {mg.error ? <ErrorState error={mg.error} onRetry={mg.reload} /> : !mg.data ? <LoadingState /> : mg.data.rows.length === 0 ? <EmptyState title={L("لا مبيعات مكلفة في الفترة", "No costed sales in the period")} /> : (
            <Table>
              <thead><tr><Th>{L("الفاتورة", "Invoice")}</Th><Th>{L("العميل", "Customer")}</Th><Th num>{L("الإيراد", "Revenue")}</Th><Th num>{L("التكلفة", "Cost")}</Th><Th num>{L("الربح", "Margin")}</Th><Th num>%</Th></tr></thead>
              <tbody>
                {mg.data.rows.map((r) => (
                  <tr key={r.invoiceId}><Td><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/receivables/${r.invoiceId}`}>INV-{r.invoiceNo}</Link></Td><Td>{r.customer}</Td><Td num>{amt(r.revenue)}</Td><Td num>{amt(r.cogs)}</Td><Td num>{amt(r.margin)}</Td><Td num>{r.marginPercent ?? "—"}</Td></tr>
                ))}
                <tr className="bg-cream-dark font-extrabold"><Td>{L("المجموع", "Total")}</Td><Td /><Td num>{amt(mg.data.totals.revenue)}</Td><Td num>{amt(mg.data.totals.cogs)}</Td><Td num>{amt(mg.data.totals.margin)}</Td><Td num /></tr>
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
