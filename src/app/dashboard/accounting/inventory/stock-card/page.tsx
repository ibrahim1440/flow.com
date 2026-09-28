"use client";

// Figma: ACC-44. Stock card: every posted cost move of one item (optionally one location) in a
// date range with running quantity and value. A balance on any date is the sum of the moves up to it.
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useDay } from "../../_components/kit";
import { DocTypeLabel, KIND, qty } from "../_ui";

type Masters = { items: { id: string; code: string; name: string; kind: string; baseUnit: string }[]; locations: { id: string; code: string; name: string; nameAr: string | null }[] };
type StockCard = {
  item: { id: string; code: string; name: string; kind: string; baseUnit: string };
  opening: { qty: string; value: string }; closing: { qty: string; value: string };
  rows: { date: string; docId: string; docNo: number; type: string; issueReason: string | null; text: string | null; location: string; kind: string; qty: string; value: string; unitCost: string | null; balanceQty: string; balanceValue: string }[];
};

export default function StockCardPage() {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const sp = useSearchParams();
  const to0 = sp.get("to") ?? riyadhToday();
  const [itemId, setItemId] = useState(sp.get("itemId") ?? "");
  const [locationId, setLocationId] = useState(sp.get("locationId") ?? "");
  const [from, setFrom] = useState(`${to0.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(to0);
  const m = useApi<Masters>("/api/accounting/inventory/items");
  const params = new URLSearchParams({ itemId, from, to });
  if (locationId) params.set("locationId", locationId);
  const c = useApi<StockCard>(itemId ? `/api/accounting/inventory/reports/stock-card?${params}` : null);
  const d = c.data;
  const neg = (s: string) => Number(s) < 0;
  const paren = (s: string, f: (x: string) => string) => (neg(s) ? `(${f(String(Math.abs(Number(s))))})` : f(s));
  const locName = (id: string) => { const l = m.data?.locations.find((x) => x.id === id); return l ? L(l.nameAr ?? l.name, l.name) : L("كل المواقع", "All locations"); };
  const csv = () => {
    if (!d) return;
    const rows = [["date", "document", "type", "text", "location", "qty", "value", "unit cost", "balance qty", "balance value"], [from, "", "opening", "", "", "", "", "", d.opening.qty, d.opening.value],
      ...d.rows.map((r) => [r.date.slice(0, 10), r.docNo, r.type, r.text ?? "", r.location, r.qty, r.value, r.unitCost ?? "", r.balanceQty, r.balanceValue]), [to, "", "closing", "", "", "", "", "", d.closing.qty, d.closing.value]];
    const blob = new Blob(["﻿" + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `stock-card-${d.item.code}-${to}.csv`; a.click();
  };

  return (
    <Card>
      <CardTitle title={d ? L(`بطاقة صنف: ${d.item.code} · ${d.item.name}`, `Stock card: ${d.item.code} · ${d.item.name}`) : L("بطاقة صنف", "Stock card")}
        sub={d ? L(`${KIND[d.item.kind]?.[0] ?? d.item.kind} · الوحدة الأساسية: ${d.item.baseUnit} · ${day(from)} – ${day(to)} · ${locName(locationId)}`, `${KIND[d.item.kind]?.[1] ?? d.item.kind} · base unit ${d.item.baseUnit} · ${from} – ${to} · ${locName(locationId)}`) : L("اختر صنفاً", "Choose an item")}
        right={<Button icon={Download} onClick={csv} disabled={!d}>{L("تصدير CSV", "Export CSV")}</Button>} />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("الصنف", "Item")}>
          <select className={`${INPUT} min-w-[260px]`} value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{L("— اختر —", "— choose —")}</option>
            {m.data?.items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
          </select>
        </Field>
        <Field label={L("من", "From")}><input type="date" className={`${INPUT} max-w-[170px]`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={L("إلى", "To")}><input type="date" className={`${INPUT} max-w-[170px]`} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={L("الموقع", "Location")}>
          <select className={`${INPUT} min-w-[180px]`} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">{L("كل المواقع", "All locations")}</option>
            {m.data?.locations.map((l) => <option key={l.id} value={l.id}>{L(l.nameAr ?? l.name, l.name)}</option>)}
          </select>
        </Field>
      </div>
      {!itemId ? <EmptyState title={L("اختر صنفاً لعرض حركاته", "Choose an item to see its movements")} /> : c.error ? <ErrorState error={c.error} onRetry={c.reload} /> : !d ? <LoadingState /> : (
        <Table>
          <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("المستند", "Document")}</Th><Th>{L("النوع", "Type")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("الكمية", "Quantity")}</Th><Th num>{L("القيمة", "Value")}</Th><Th num>{L("تكلفة الوحدة", "Unit cost")}</Th><Th num>{L("رصيد الكمية", "Balance qty")}</Th><Th num>{L("رصيد القيمة", "Balance value")}</Th></tr></thead>
          <tbody>
            <tr><Td className="whitespace-nowrap">{day(from)}</Td><Td>—</Td><Td /><Td className="font-bold">{L("رصيد أول المدة", "Opening balance")}</Td><Td num /><Td num /><Td num /><Td num>{qty(d.opening.qty)}</Td><Td num>{amt(d.opening.value)}</Td></tr>
            {d.rows.map((r, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap">{day(r.date)}</Td>
                <Td><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/inventory/documents/${r.docId}`}>#{r.docNo}</Link></Td>
                <Td><DocTypeLabel type={r.type} reason={r.issueReason} /></Td>
                <Td>{r.text ?? "—"}{locationId ? "" : <span className="text-[11px] text-brown"> · {r.location}</span>}</Td>
                <Td num className={neg(r.qty) ? "text-red-700" : ""}>{paren(r.qty, qty)}</Td>
                <Td num className={neg(r.value) ? "text-red-700" : ""}>{paren(r.value, amt)}</Td>
                <Td num>{qty(r.unitCost)}</Td><Td num>{qty(r.balanceQty)}</Td><Td num>{amt(r.balanceValue)}</Td>
              </tr>
            ))}
            <tr className="bg-cream-dark font-extrabold"><Td /><Td /><Td /><Td>{L("رصيد آخر المدة", "Closing balance")}</Td><Td num /><Td num /><Td num /><Td num>{qty(d.closing.qty)}</Td><Td num>{amt(d.closing.value)}</Td></tr>
          </tbody>
        </Table>
      )}
      <p className="text-xs text-brown">{L("كل سطر حركة تكلفة مرحّلة لا تتغيّر: الرصيد في أي تاريخ هو مجموع الحركات حتى ذلك التاريخ، فيطابق حساب المخزون في دفتر الأستاذ.", "Each row is a posted cost move that never changes: the balance on any date is the sum of the moves up to it, so it agrees to the inventory account in the ledger.")}</p>
    </Card>
  );
}
