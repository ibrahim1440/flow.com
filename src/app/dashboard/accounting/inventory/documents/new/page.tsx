"use client";

// Figma: ACC-42 (goods receipt; the same editor serves every manual document type). Lines are
// entered in any unit the item converts from and kept in its base unit; the journal preview of a
// receipt is exact before posting, other documents are costed when they post. `?edit=` edits a
// draft; `?type=` preselects the type (`?targetLineId=` and `?billLineId=` prefill a match). Drafts from roasting batches and purchase records are
// made on the matching page.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../../finance/_components/ui";
import { riyadhToday, useAmount } from "../../../_components/kit";
import { DOC_TYPE, ISSUE_REASON } from "../../_ui";

type Item = { id: string; code: string; name: string; kind: string; baseUnit: string; account: string | null; isActive: boolean; units: { unit: string; factor: string }[] };
type Masters = { items: Item[]; locations: { id: string; code: string; name: string; nameAr: string | null; isActive: boolean }[]; bands: { id: string; code: string; name: string; nameAr: string | null; process: string; maxLossPercent: string; status: string }[]; settings: { costMethod: string | null } };
type Line = { itemId: string; quantity: string; unit: string; unitCost: string; countedQty: string; role: "INPUT" | "OUTPUT" | "LINE"; targetLineId: string };
type Target = { id: string; docNo: number; item: string; itemId: string; qty: string; value?: string; qtyLeft?: string; returnable?: string; supplier?: string; baseUnit: string };
const TYPES = ["RECEIPT", "ISSUE", "TRANSFER", "PRODUCTION", "COUNT", "SUPPLIER_RETURN", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH"] as const;
const blank = (role: Line["role"] = "LINE"): Line => ({ itemId: "", quantity: "", unit: "", unitCost: "", countedQty: "", role, targetLineId: "" });

export default function InventoryDocEditor() {
  const { L } = useL();
  const amt = useAmount();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get("edit");
  const m = useApi<Masters>("/api/accounting/inventory/items");
  const [type, setType] = useState<string>(sp.get("type") && TYPES.includes(sp.get("type") as never) ? sp.get("type")! : "RECEIPT");
  const [docDate, setDocDate] = useState(riyadhToday);
  const [locationId, setLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [issueReason, setIssueReason] = useState("INTERNAL_USE");
  const [lossBandId, setLossBandId] = useState("");
  const [billLineId, setBillLineId] = useState(sp.get("billLineId") ?? "");
  const [amount, setAmount] = useState("");
  const [basis, setBasis] = useState("VALUE");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [{ ...blank(), targetLineId: sp.get("targetLineId") ?? "" }]);
  const [busy, setBusy] = useState(""); const [err, setErr] = useState<string | null>(null);
  const [requestKey] = useState(() => `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const suppliers = useApi<{ id: string; name: string }[]>("/api/accounting/inventory/pickers?what=suppliers");
  const customers = useApi<{ id: string; name: string }[]>(type === "CUSTOMER_RETURN" ? "/api/accounting/inventory/pickers?what=customers" : null);
  const receiptTargets = useApi<Target[]>(["SUPPLIER_RETURN", "LANDED_COST", "BILL_MATCH"].includes(type) ? "/api/accounting/inventory/pickers?what=receipt-lines" : null);
  const saleTargets = useApi<Target[]>(type === "CUSTOMER_RETURN" ? `/api/accounting/inventory/pickers?what=sale-lines${customerId ? `&customerId=${customerId}` : ""}` : null);
  const billLines = useApi<{ id: string; billNo: number; supplier: string; description: string | null; qty: string; net: string }[]>(["LANDED_COST", "BILL_MATCH"].includes(type) ? "/api/accounting/inventory/pickers?what=bill-lines" : null);
  const items = useMemo(() => (m.data?.items ?? []).filter((i) => i.isActive), [m.data]);
  const itemOf = (id: string) => items.find((i) => i.id === id);

  // Load a draft for editing.
  useEffect(() => {
    if (!editId) return;
    api<{ type: string; docDate: string; locationId: string; toLocationId: string | null; supplierId: string | null; customerId: string | null; issueReason: string | null; lossBandId: string | null; billLineId: string | null; amount: string | null; allocationBasis: string | null; description: string | null; reason: string | null;
      lines: { itemId: string; quantity: string; unit: string; unitCost: string | null; countedQty: string | null; role: Line["role"]; targetLineId: string | null }[] }>(`/api/accounting/inventory/documents/${editId}`).then((d) => {
      setType(d.type); setDocDate(String(d.docDate).slice(0, 10)); setLocationId(d.locationId); setToLocationId(d.toLocationId ?? ""); setSupplierId(d.supplierId ?? ""); setCustomerId(d.customerId ?? "");
      setIssueReason(d.issueReason ?? "INTERNAL_USE"); setLossBandId(d.lossBandId ?? ""); setBillLineId(d.billLineId ?? ""); setAmount(d.amount ?? ""); setBasis(d.allocationBasis ?? "VALUE"); setDescription(d.description ?? ""); setReason(d.reason ?? "");
      setLines(d.lines.map((l) => ({ itemId: l.itemId, quantity: String(Number(l.quantity)), unit: l.unit, unitCost: l.unitCost ? String(Number(l.unitCost)) : "", countedQty: l.countedQty ? String(Number(l.countedQty)) : "", role: l.role, targetLineId: l.targetLineId ?? "" })));
    }).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [editId]);
  const firstLocation = m.data?.locations.find((l) => l.isActive)?.id ?? "";
  const loc = locationId || firstLocation;

  const factorOf = (l: Line) => { const it = itemOf(l.itemId); if (!it) return 1; if (!l.unit || l.unit === it.baseUnit) return 1; return Number(it.units.find((u) => u.unit === l.unit)?.factor ?? 1); };
  const baseQty = (l: Line) => (Number(l.quantity) || 0) * factorOf(l);
  const lineValue = (l: Line) => Math.round(baseQty(l) * (Number(l.unitCost) || 0) * 100) / 100;
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const targets = type === "CUSTOMER_RETURN" ? saleTargets.data ?? [] : receiptTargets.data ?? [];
  const receiptPreview = useMemo(() => {
    if (type !== "RECEIPT") return null;
    const by = new Map<string, number>();
    for (const l of lines) { const it = itemOf(l.itemId); if (!it || !it.account) continue; by.set(it.account, (by.get(it.account) ?? 0) + lineValue(l)); }
    const tot = [...by.values()].reduce((s, v) => s + v, 0);
    return { rows: [...by.entries()], tot };
  }, [type, lines, items]);   // eslint-disable-line react-hooks/exhaustive-deps

  const payload = () => ({
    type, docDate, locationId: loc, toLocationId: type === "TRANSFER" ? toLocationId : undefined, supplierId: ["RECEIPT", "SUPPLIER_RETURN"].includes(type) ? supplierId : undefined,
    customerId: type === "CUSTOMER_RETURN" ? customerId : undefined, issueReason: type === "ISSUE" ? issueReason : undefined, lossBandId: type === "PRODUCTION" ? lossBandId || undefined : undefined,
    billLineId: ["LANDED_COST", "BILL_MATCH"].includes(type) ? billLineId || undefined : undefined, amount: type === "LANDED_COST" && !billLineId ? amount : undefined, allocationBasis: type === "LANDED_COST" ? basis : undefined,
    description: description || undefined, reason: reason || undefined, requestKey: editId ? undefined : requestKey,
    lines: lines.map((l) => {
      const t = targets.find((x) => x.id === l.targetLineId);
      return { itemId: l.itemId || t?.itemId, quantity: ["LANDED_COST", "BILL_MATCH"].includes(type) ? "0" : type === "COUNT" ? "0" : l.quantity, unit: l.unit || undefined, unitCost: l.unitCost || undefined, countedQty: type === "COUNT" ? l.quantity : undefined, role: type === "PRODUCTION" ? l.role : undefined, targetLineId: l.targetLineId || undefined };
    }),
  });
  const save = async (submit: boolean) => {
    setBusy(submit ? "submit" : "save"); setErr(null);
    try {
      const d = editId ? await api<{ id: string }>(`/api/accounting/inventory/documents/${editId}`, { method: "PATCH", json: payload() }) : await api<{ id: string }>("/api/accounting/inventory/documents", { method: "POST", json: payload() });
      if (submit) await api(`/api/accounting/inventory/documents/${d.id}/submit`, { method: "POST", json: {} });
      router.push(`/dashboard/accounting/inventory/documents/${d.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); setBusy(""); }
  };

  if (m.error) return <Card><ErrorState error={m.error} onRetry={m.reload} /></Card>;
  if (!m.data) return <Card><LoadingState /></Card>;
  const tt = DOC_TYPE[type];
  const locs = m.data.locations.filter((l) => l.isActive);
  const bands = m.data.bands.filter((b) => b.status === "APPROVED");
  const targetLabel = type === "CUSTOMER_RETURN" ? L("البيع الذي يُرجع منه", "Sale it returns from") : L("سطر الاستلام", "Receipt line");
  const itemLabel = (it: Item) => `${it.code} · ${it.name}`;

  return (
    <Card>
      <CardTitle title={`${editId ? L("تعديل", "Edit") : L("جديد", "New")}: ${L(tt[0], tt[1])}`}
        sub={L("يُعتمد من شخص غير مُعدّه · الكميات تُحفظ بالوحدة الأساس · التكلفة تُحسب عند الترحيل بطريقة قرار D-1", "Approved by someone other than the preparer · quantities are kept in the base unit · cost is computed at posting by the D-1 method")} />
      {!m.data.settings.costMethod && <Notice tone="warn">{L("قرار D-1 (طريقة التكلفة) لم يُحسم: يمكن إعداد المستندات واعتمادها، لكن الترحيل ينتظر القرار (إلا مؤقتاً في قاعدة اختبار معزولة).", "Decision D-1 (costing method) is not settled: documents can be prepared and approved, but posting waits for it (except provisionally in an isolated test database).")}</Notice>}
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("نوع المستند", "Document type")}>
          <select className={INPUT} value={type} disabled={!!editId} onChange={(e) => { setType(e.target.value); setLines([e.target.value === "PRODUCTION" ? blank("INPUT") : blank()].concat(e.target.value === "PRODUCTION" ? [blank("OUTPUT")] : [])); }}>
            {TYPES.map((t) => <option key={t} value={t}>{L(DOC_TYPE[t][0], DOC_TYPE[t][1])}</option>)}
          </select>
        </Field>
        <Field label={type === "TRANSFER" ? L("من الموقع", "From location") : L("الموقع", "Location")}><select className={INPUT} value={loc} onChange={(e) => setLocationId(e.target.value)}>{locs.map((l) => <option key={l.id} value={l.id}>{l.nameAr ?? l.name}</option>)}</select></Field>
        {type === "TRANSFER" && <Field label={L("إلى الموقع", "To location")}><select className={INPUT} value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}><option value="">{L("اختر…", "Choose…")}</option>{locs.filter((l) => l.id !== loc).map((l) => <option key={l.id} value={l.id}>{l.nameAr ?? l.name}</option>)}</select></Field>}
        <Field label={L("التاريخ", "Date")} hint={L("لا يسبق آخر حركة مرحّلة للصنف", "Not before the item's last posted movement")}><input type="date" className={INPUT} value={docDate} onChange={(e) => setDocDate(e.target.value)} /></Field>
        {["RECEIPT", "SUPPLIER_RETURN"].includes(type) && <Field label={L("المورد", "Supplier")}><select className={`${INPUT} min-w-[220px]`} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">{L("اختر…", "Choose…")}</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
        {type === "CUSTOMER_RETURN" && <Field label={L("العميل", "Customer")}><select className={`${INPUT} min-w-[220px]`} value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">{L("اختر…", "Choose…")}</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        {type === "ISSUE" && <Field label={L("سبب الصرف", "Reason")}><select className={INPUT} value={issueReason} onChange={(e) => setIssueReason(e.target.value)}>{Object.entries(ISSUE_REASON).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>}
        {type === "PRODUCTION" && <Field label={L("نطاق الفاقد المعتمد", "Approved loss band")} hint={L("مطلوب إذا نقص وزن المخرجات عن المدخلات", "Required when output weighs less than inputs")}><select className={`${INPUT} min-w-[220px]`} value={lossBandId} onChange={(e) => setLossBandId(e.target.value)}><option value="">{L("بلا نطاق", "No band")}</option>{bands.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.nameAr ?? b.name} · {b.maxLossPercent}%</option>)}</select></Field>}
        {["LANDED_COST", "BILL_MATCH"].includes(type) && <Field label={type === "BILL_MATCH" ? L("بند فاتورة المورد", "Supplier bill line") : L("بند فاتورة (اختياري)", "Bill line (optional)")}>
          <select className={`${INPUT} min-w-[280px]`} value={billLineId} onChange={(e) => setBillLineId(e.target.value)}><option value="">{type === "BILL_MATCH" ? L("اختر…", "Choose…") : L("بلا فاتورة بعد — أدخل المبلغ", "No bill yet — enter the amount")}</option>{(billLines.data ?? []).map((b) => <option key={b.id} value={b.id}>ف-{b.billNo} · {b.supplier} · {b.description ?? ""} · {amt(b.net)}</option>)}</select></Field>}
        {type === "LANDED_COST" && !billLineId && <Field label={L("المبلغ", "Amount")}><input className={INPUT} dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        {type === "LANDED_COST" && <Field label={L("أساس التوزيع", "Allocate by")}><select className={INPUT} value={basis} onChange={(e) => setBasis(e.target.value)}><option value="VALUE">{L("بالقيمة", "By value")}</option><option value="QUANTITY">{L("بالكمية", "By quantity")}</option></select></Field>}
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("البيان", "Description")}><input className={`${INPUT} min-w-[320px]`} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {["COUNT", "SUPPLIER_RETURN", "CUSTOMER_RETURN"].includes(type) && <Field label={L("السبب", "Reason")}><input className={`${INPUT} min-w-[260px]`} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </div>

      <Table>
        <thead><tr>
          <Th>#</Th>{type === "PRODUCTION" && <Th>{L("الدور", "Role")}</Th>}
          {["SUPPLIER_RETURN", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH"].includes(type) && <Th>{targetLabel}</Th>}
          {!["LANDED_COST", "BILL_MATCH"].includes(type) && <><Th>{L("الصنف", "Item")}</Th><Th num>{type === "COUNT" ? L("الكمية المعدودة", "Counted") : L("الكمية", "Quantity")}</Th><Th>{L("الوحدة", "Unit")}</Th><Th num>{L("بالوحدة الأساس", "In base unit")}</Th></>}
          {(type === "RECEIPT" || type === "COUNT") && <Th num>{type === "COUNT" ? L("تكلفة الفائض (إن لم يوجد رصيد)", "Surplus cost (if no stock)") : L("تكلفة الوحدة الأساس", "Cost per base unit")}</Th>}
          {type === "RECEIPT" && <Th num>{L("القيمة", "Value")}</Th>}<Th />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const it = itemOf(l.itemId);
            return (
              <tr key={i}>
                <Td>{i + 1}</Td>
                {type === "PRODUCTION" && <Td><select aria-label={L(`دور البند ${i + 1}`, `Line ${i + 1} role`)} className={INPUT} value={l.role} onChange={(e) => setLine(i, { role: e.target.value as Line["role"] })}><option value="INPUT">{L("مدخل", "Input")}</option><option value="OUTPUT">{L("مخرج", "Output")}</option></select></Td>}
                {["SUPPLIER_RETURN", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH"].includes(type) && <Td>
                  <select aria-label={targetLabel} className={`${INPUT} min-w-[280px]`} value={l.targetLineId} onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); setLine(i, { targetLineId: e.target.value, itemId: t?.itemId ?? l.itemId }); }}>
                    <option value="">{L("اختر…", "Choose…")}</option>
                    {targets.map((t) => <option key={t.id} value={t.id}>#{t.docNo} · {t.item} · {Number(t.qty)} {t.baseUnit}{t.returnable ? L(` · يمكن إرجاع ${Number(t.returnable)}`, ` · ${Number(t.returnable)} returnable`) : t.qtyLeft ? L(` · متبقٍ ${Number(t.qtyLeft)}`, ` · ${Number(t.qtyLeft)} left`) : ""}{t.value ? ` · ${amt(t.value)}` : ""}</option>)}
                  </select></Td>}
                {!["LANDED_COST", "BILL_MATCH"].includes(type) && <>
                  <Td><select aria-label={L(`صنف البند ${i + 1}`, `Line ${i + 1} item`)} className={`${INPUT} min-w-[220px]`} value={l.itemId} disabled={["SUPPLIER_RETURN", "CUSTOMER_RETURN"].includes(type) && !!l.targetLineId} onChange={(e) => setLine(i, { itemId: e.target.value, unit: "" })}><option value="">{L("اختر…", "Choose…")}</option>{items.map((x) => <option key={x.id} value={x.id}>{itemLabel(x)}</option>)}</select></Td>
                  <Td num><input aria-label={L(`كمية البند ${i + 1}`, `Line ${i + 1} quantity`)} className={`${INPUT} w-24 text-end`} dir="ltr" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Td>
                  <Td><select aria-label={L(`وحدة البند ${i + 1}`, `Line ${i + 1} unit`)} className={INPUT} value={l.unit || it?.baseUnit || ""} onChange={(e) => setLine(i, { unit: e.target.value })}>{it ? [<option key="b" value={it.baseUnit}>{it.baseUnit}</option>, ...it.units.map((u) => <option key={u.unit} value={u.unit}>{u.unit} (= {Number(u.factor)} {it.baseUnit})</option>)] : <option value="">—</option>}</select></Td>
                  <Td num>{it ? `${baseQty(l).toFixed(4)} ${it.baseUnit}` : "—"}</Td>
                </>}
                {(type === "RECEIPT" || type === "COUNT") && <Td num><input aria-label={L(`تكلفة البند ${i + 1}`, `Line ${i + 1} cost`)} className={`${INPUT} w-28 text-end`} dir="ltr" inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} /></Td>}
                {type === "RECEIPT" && <Td num>{amt(lineValue(l).toFixed(2))}</Td>}
                <Td>{lines.length > 1 && type !== "BILL_MATCH" && <button type="button" className="text-brown hover:text-red-700 px-2" aria-label={L("حذف البند", "Remove line")} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>✕</button>}</Td>
              </tr>
            );
          })}
          {type === "RECEIPT" && <tr className="bg-cream-dark font-extrabold"><Td /><Td>{L("المجموع", "Total")}</Td><Td /><Td /><Td /><Td /><Td num>{amt((receiptPreview?.tot ?? 0).toFixed(2))}</Td><Td /></tr>}
        </tbody>
      </Table>
      {type !== "BILL_MATCH" && <button type="button" className="self-start font-bold text-orange" onClick={() => setLines((ls) => [...ls, blank(type === "PRODUCTION" ? "INPUT" : "LINE")])}>+ {L("بند", "Line")}</button>}

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {receiptPreview && receiptPreview.rows.length > 0 && (
          <div className="border border-border rounded-2xl p-4 flex flex-col gap-3">
            <p className="font-extrabold text-charcoal">{L("معاينة القيد عند الترحيل", "Journal on posting")}</p>
            <Table>
              <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
              <tbody>
                {receiptPreview.rows.map(([a, v]) => <tr key={a}><Td>{a}</Td><Td num>{amt(v.toFixed(2))}</Td><Td num /></tr>)}
                <tr><Td>2120 · {L("بضاعة مستلمة لم تصل فاتورتها", "Goods received not invoiced")}</Td><Td num /><Td num>{amt(receiptPreview.tot.toFixed(2))}</Td></tr>
              </tbody>
            </Table>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {type === "RECEIPT" && <Notice tone="info">{L("فاتورة المورد تُطابق لاحقاً مع هذا الاستلام (مطابقة الفواتير): فرق السعر يُعالَج حسب قرار D-1.", "The supplier bill is matched to this receipt later (bill match): the price difference follows decision D-1.")}</Notice>}
          {type === "PRODUCTION" && <Notice tone="info">{L("المدخلات تُصرف بتكلفتها؛ الفاقد داخل النطاق يُمتص في المخرجات وما يتجاوزه يُحمَّل على «فاقد إنتاج غير طبيعي». مواد التغليف لا تُعدّ في العائد.", "Inputs leave at cost; loss within the band is absorbed by the outputs and loss beyond it goes to abnormal production loss. Packaging does not count toward yield.")}</Notice>}
          {type === "TRANSFER" && <Notice tone="info">{L("التحويل ينقل الكمية بتكلفتها نفسها؛ لا قيد لأن الحسابات حسب نوع الصنف.", "A transfer moves stock at the same cost; no journal, as accounts are by item kind.")}</Notice>}
          {type === "COUNT" && <Notice tone="info">{L("الفرق بين المعدود والرصيد الدفتري يُقيَّد على «فروقات المخزون» (5700): العجز بمتوسط التكلفة، والفائض بمتوسط التكلفة أو بالتكلفة المدخلة إن لم يوجد رصيد.", "The difference between the count and the book quantity goes to inventory variance (5700): shortages at average cost, surpluses at average cost or at the entered cost when there is no stock.")}</Notice>}
          {type === "LANDED_COST" && <Notice tone="info">{L("تُوزَّع التكلفة على أسطر الاستلام المختارة؛ ما بقي منها في المخزون يُضاف لقيمته، وما استُهلك يُحمَّل على تكلفة المبيعات.", "The cost is spread over the chosen receipt lines; the part still in stock is added to its value, the part already used goes to cost of sales.")}</Notice>}
        </div>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2 flex-wrap">
        <Button kind="primary" busy={busy === "submit"} disabled={!!busy} onClick={() => save(true)}>{L("حفظ وتقديم للاعتماد", "Save and submit")}</Button>
        <Button busy={busy === "save"} disabled={!!busy} onClick={() => save(false)}>{L("حفظ كمسودة", "Save as draft")}</Button>
        <Link href="/dashboard/accounting/inventory/documents"><Button kind="ghost">{L("إلغاء", "Cancel")}</Button></Link>
      </div>
    </Card>
  );
}
