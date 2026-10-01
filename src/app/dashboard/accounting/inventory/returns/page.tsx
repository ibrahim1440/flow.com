"use client";

// Customer returns (stage 4b): goods physically coming back from a customer, separate from
// correcting the invoice. Recorded (DRAFT) → received by the warehouse with its evidence
// (RECEIVED) → approved by someone other than the recorder or receiver (APPROVED) → posted
// (POSTED): the goods come back at the cost they left at, damaged goods are written off.
import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL, type Tone } from "../../../finance/_components/ui";
import { riyadhToday, useCan, useDay } from "../../_components/kit";
import { qty } from "../_ui";

type ReturnRow = {
  id: string; returnNo: number; invoiceId: string; invoiceNo: number | null; invoiceStatus: string | null; customer: string; locationId: string;
  status: "DRAFT" | "RECEIVED" | "APPROVED" | "POSTED"; reason: string; createdBy: string; createdAt: string;
  receivedBy: string | null; receivedOn: string | null; evidenceRef: string | null; approvedBy: string | null; postedAt: string | null; documentId: string | null;
  names: { createdBy: string; receivedBy: string | null; approvedBy: string | null };
  lines: { id: string; invoiceLineId: string; quantity: string; condition: string; item: string; unit: string }[];
  creditNote: { invoiceNo: number; status: string } | null;
};
type Returnable = { invoice: { id: string; invoiceNo: number; status: string }; lines: { invoiceLineId: string; lineNo: number; item: string; unit: string; sold: string; returned: string; pending: string; out: string }[] };
type Invoices = { rows: { id: string; invoiceNo: number; customer: string; issueDate: string; status: string; totalGross: string }[] };
type Loc = { id: string; code: string; name: string; nameAr: string | null; isActive: boolean; isDelivered?: boolean; isSalesDefault?: boolean };
type Seg = "ALL" | ReturnRow["status"];

const STATUS: Record<ReturnRow["status"], [string, string, Tone]> = {
  DRAFT: ["مسجّل · بانتظار المستودع", "Recorded · awaiting the warehouse", "info"],
  RECEIVED: ["مستلم · بانتظار الاعتماد", "Received · awaiting approval", "warn"],
  APPROVED: ["معتمد · للترحيل", "Approved · to post", "brand"],
  POSTED: ["مرحّل", "Posted", "ok"],
};

export default function CustomerReturnsPage() {
  const { L } = useL();
  const day = useDay();
  const { can, user } = useCan();
  const [seg, setSeg] = useState<Seg>("ALL");
  const list = useApi<ReturnRow[]>("/api/accounting/inventory/returns");
  const locs = useApi<Loc[]>("/api/accounting/inventory/locations");
  const [adding, setAdding] = useState(false);
  const [dlg, setDlg] = useState<{ kind: "receive" | "reject"; row: ReturnRow } | null>(null);
  const [f, setF] = useState<{ receivedOn: string; evidenceRef: string; reason: string }>({ receivedOn: "", evidenceRef: "", reason: "" });
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const rows = list.data ?? [];
  const n = (s: ReturnRow["status"]) => rows.filter((r) => r.status === s).length;
  const shown = seg === "ALL" ? rows : rows.filter((r) => r.status === seg);
  const locName = (id: string) => { const l = (locs.data ?? []).find((x) => x.id === id); return l ? `${l.code} · ${L(l.nameAr ?? l.name, l.name)}` : "—"; };
  const canReceive = can("inv_return_receive");

  const act = async (row: ReturnRow, path: string, json: unknown = {}, done?: string) => {
    setBusy(row.id + path); setMsg(null);
    try { await api(`/api/accounting/inventory/returns/${row.id}/${path}`, { method: "POST", json }); setDlg(null); list.reload(); if (done) setMsg({ tone: "ok", text: done }); }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const openDlg = (kind: "receive" | "reject", row: ReturnRow) => { setMsg(null); setF({ receivedOn: riyadhToday(), evidenceRef: "", reason: "" }); setDlg({ kind, row }); };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("مرتجعات العملاء", "Customer returns")}
          sub={L("بضاعة تعود فعلياً من العميل: تُسجَّل، ويستلمها المستودع بدليل، ويعتمدها غير من سجّلها أو استلمها، ثم تُرحّل", "Goods physically coming back from a customer: recorded, received by the warehouse with evidence, approved by someone other than the recorder or receiver, then posted")}
          right={<>
            <Link href="/dashboard/accounting/inventory"><Button>{L("قيمة المخزون", "Inventory value")}</Button></Link>
            <Link href="/dashboard/accounting/inventory/margin"><Button>{L("مجمل الربح", "Gross margin")}</Button></Link>
            {can("inv_doc_create") && <Button kind="primary" icon={Plus} onClick={() => { setAdding((a) => !a); setMsg(null); }}>{L("تسجيل مرتجع", "Record a return")}</Button>}
          </>} />
        <Notice tone="info">{L("المرتجع منفصل عن تصحيح الفاتورة: عكس الفاتورة أو الإشعار الدائن لا يُعيد أي بضاعة للمخزون. البضاعة تعود فقط بمرتجع استلمه المستودع واعتُمد، وبالتكلفة التي خرجت بها. البضاعة التالفة تعود ثم تُشطب على فروقات المخزون في الخطوة نفسها. لا يتجاوز المرتجع ما بقي لدى العميل.",
          "A return is separate from correcting an invoice: reversing an invoice or issuing a credit note never brings goods back into stock. Only a return that the warehouse received and that was approved does, at the cost the goods left at. Damaged goods come back and are written off to inventory variance in the same step. A return never exceeds what is still with the customer.")}</Notice>
        {msg && !dlg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {adding && <NewReturn locs={(locs.data ?? []).filter((l) => l.isActive && !l.isDelivered)} onClose={() => setAdding(false)} onDone={(no) => { setAdding(false); list.reload(); setMsg({ tone: "ok", text: L(`سُجّل المرتجع R-${no}؛ بانتظار استلام المستودع.`, `Return R-${no} recorded; waiting for the warehouse to receive it.`) }); }} />}
        <Segmented<Seg> value={seg} onChange={setSeg} options={[
          { value: "ALL", label: L(`الكل · ${rows.length}`, `All · ${rows.length}`) },
          { value: "DRAFT", label: L(`بانتظار المستودع · ${n("DRAFT")}`, `Awaiting warehouse · ${n("DRAFT")}`) },
          { value: "RECEIVED", label: L(`بانتظار الاعتماد · ${n("RECEIVED")}`, `Awaiting approval · ${n("RECEIVED")}`) },
          { value: "APPROVED", label: L(`للترحيل · ${n("APPROVED")}`, `To post · ${n("APPROVED")}`) },
          { value: "POSTED", label: L(`مرحّلة · ${n("POSTED")}`, `Posted · ${n("POSTED")}`) }]} />
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <LoadingState /> : shown.length === 0 ? <EmptyState title={L("لا مرتجعات بهذه الحالة", "No returns with this status")} /> : (
          <Table>
            <thead><tr><Th>{L("المرتجع", "Return")}</Th><Th>{L("الفاتورة", "Invoice")}</Th><Th>{L("العميل", "Customer")}</Th><Th>{L("البنود", "Lines")}</Th><Th>{L("الموقع", "Location")}</Th><Th>{L("السبب", "Reason")}</Th><Th>{L("دليل المستودع", "Warehouse evidence")}</Th><Th>{L("الحالة", "Status")}</Th><Th /></tr></thead>
            <tbody>{shown.map((r) => {
              const s = STATUS[r.status];
              const mine = user?.id === r.createdBy || user?.id === r.receivedBy;
              return (
                <tr key={r.id} className="align-top">
                  <Td className="font-bold tabular-nums whitespace-nowrap">R-{r.returnNo}<span className="block text-[11px] font-normal text-brown">{day(r.createdAt)} · {r.names.createdBy}</span></Td>
                  <Td className="whitespace-nowrap">{r.invoiceNo !== null ? <Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/receivables/${r.invoiceId}`}>INV-{r.invoiceNo}</Link> : "—"}
                    {r.invoiceStatus === "REVERSED" && <span className="block"><Badge tone="info">{L("فاتورة معكوسة", "Invoice reversed")}</Badge></span>}</Td>
                  <Td>{r.customer}</Td>
                  <Td>{r.lines.map((l) => (
                    <span key={l.id} className="block whitespace-nowrap">{l.item} · {qty(l.quantity)} {l.unit} {l.condition === "DAMAGED" ? <Badge tone="bad">{L("تالف · يُشطب", "Damaged · written off")}</Badge> : <Badge tone="ok">{L("صالح للبيع", "Resalable")}</Badge>}</span>
                  ))}</Td>
                  <Td>{locName(r.locationId)}</Td>
                  <Td className="max-w-[220px]">{r.reason}</Td>
                  <Td>{r.evidenceRef ? <>{r.evidenceRef}<span className="block text-[11px] text-brown">{L(`وصلت ${day(r.receivedOn)} · استلمها ${r.names.receivedBy ?? "—"}`, `Arrived ${day(r.receivedOn)} · received by ${r.names.receivedBy ?? "—"}`)}</span></> : "—"}</Td>
                  <Td><Badge tone={s[2]}>{L(s[0], s[1])}</Badge>
                    {r.names.approvedBy && <span className="block text-[11px] text-brown">{L(`اعتمده ${r.names.approvedBy}`, `Approved by ${r.names.approvedBy}`)}</span>}
                    {r.creditNote && <span className="block text-[11px] text-brown tabular-nums">{L(`إشعار دائن CN-${r.creditNote.invoiceNo}`, `Credit note CN-${r.creditNote.invoiceNo}`)}</span>}</Td>
                  <Td><span className="flex flex-col gap-1 whitespace-nowrap">
                    {r.status === "DRAFT" && canReceive && <button className="font-bold text-orange hover:underline text-start" disabled={!!busy} onClick={() => openDlg("receive", r)}>{L("تأكيد الاستلام…", "Confirm receipt…")}</button>}
                    {r.status === "RECEIVED" && can("inv_doc_approve") && (mine
                      ? <span className="text-[11px] text-brown">{L("يعتمده شخص آخر", "Someone else approves")}</span>
                      : <button className="font-bold text-orange hover:underline text-start" disabled={!!busy} onClick={() => act(r, "approve", {}, L(`اعتُمد المرتجع R-${r.returnNo}.`, `Return R-${r.returnNo} approved.`))}>{busy === r.id + "approve" ? "…" : L("اعتماد", "Approve")}</button>)}
                    {r.status === "RECEIVED" && can("inv_doc_approve") && <button className="font-bold text-red-700 hover:underline text-start" disabled={!!busy} onClick={() => openDlg("reject", r)}>{L("إعادة للمستودع…", "Send back…")}</button>}
                    {r.status === "APPROVED" && can("inv_doc_post") && <button className="font-bold text-orange hover:underline text-start" disabled={!!busy} onClick={() => act(r, "post", {}, L(`رُحّل المرتجع R-${r.returnNo}.`, `Return R-${r.returnNo} posted.`))}>{busy === r.id + "post" ? "…" : L("ترحيل", "Post")}</button>}
                    {r.status === "POSTED" && r.documentId && <Link className="font-bold text-orange hover:underline" href={`/dashboard/accounting/inventory/documents/${r.documentId}`}>{L("مستند المخزون", "Inventory document")}</Link>}
                  </span></Td>
                </tr>
              );
            })}</tbody>
          </Table>
        )}
        <p className="text-xs text-brown">{L("عند الترحيل: إن كانت الفاتورة قائمة تعود التكلفة من تكلفة المبيعات (والإشعار الدائن للبضاعة المرتجعة يشير لهذا المرتجع)، وإن كانت معكوسة تنتقل التكلفة من «مسلّمة لم تُفوتر» إلى المخزون.", "On posting: while the invoice stands the cost comes back from cost of sales (a credit note for returned goods then names this return); if the invoice was reversed, the cost moves from “delivered, not invoiced” back to stock.")}</p>
      </Card>

      <Dialog open={dlg?.kind === "receive"} onClose={() => setDlg(null)} title={L(`استلام المرتجع R-${dlg?.row.returnNo ?? ""}`, `Receive return R-${dlg?.row.returnNo ?? ""}`)} sub={L("يؤكد المستودع وصول البضاعة: متى، ومن، وبأي دليل", "The warehouse confirms the goods arrived: when, who, and with what evidence")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("تاريخ الوصول", "Arrival day")}><input type="date" className={INPUT} value={f.receivedOn} onChange={(e) => setF((x) => ({ ...x, receivedOn: e.target.value }))} /></Field>
        <Field label={L("الدليل", "Evidence")} hint={L("رقم إذن الاستلام أو مرجع الصورة — 3 أحرف على الأقل", "Goods receipt note number or photo reference — at least 3 characters")}><input className={INPUT} value={f.evidenceRef} onChange={(e) => setF((x) => ({ ...x, evidenceRef: e.target.value }))} /></Field>
        <Button kind="primary" disabled={!f.receivedOn || f.evidenceRef.trim().length < 3} busy={!!dlg && busy === dlg.row.id + "receive"} onClick={() => dlg && act(dlg.row, "receive", { receivedOn: f.receivedOn, evidenceRef: f.evidenceRef.trim() }, L("سُجّل الاستلام؛ بانتظار الاعتماد.", "Receipt recorded; awaiting approval."))}>{L("تأكيد الاستلام", "Confirm receipt")}</Button>
      </Dialog>

      <Dialog open={dlg?.kind === "reject"} onClose={() => setDlg(null)} title={L(`إعادة المرتجع R-${dlg?.row.returnNo ?? ""}`, `Send back return R-${dlg?.row.returnNo ?? ""}`)} sub={L("يعود مسودة ويستلمه المستودع من جديد", "It goes back to draft and the warehouse receives it again")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("السبب", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")}><input className={INPUT} value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} /></Field>
        <Button kind="danger" disabled={f.reason.trim().length < 5} busy={!!dlg && busy === dlg.row.id + "reject"} onClick={() => dlg && act(dlg.row, "reject", { reason: f.reason.trim() })}>{L("إعادة", "Send back")}</Button>
      </Dialog>
    </div>
  );
}

/** Record a return: invoice → returnable lines (quantity + condition), location, reason. */
function NewReturn({ locs, onClose, onDone }: { locs: Loc[]; onClose: () => void; onDone: (returnNo: number) => void }) {
  const { L, money } = useL();
  const day = useDay();
  const [invStatus, setInvStatus] = useState<"POSTED" | "REVERSED">("POSTED");
  const [q, setQ] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [loc, setLoc] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Record<string, { quantity: string; condition: "RESALABLE" | "DAMAGED" }>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const invs = useApi<Invoices>(`/api/accounting/receivables/invoices?status=${invStatus}&kind=INVOICE&pageSize=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
  const rl = useApi<Returnable>(invoiceId ? `/api/accounting/inventory/returns?returnableFor=${invoiceId}` : null);
  const location = loc || locs.find((l) => l.isSalesDefault)?.id || "";
  const chosen = Object.entries(lines).filter(([, v]) => Number(v.quantity) > 0);
  const over = (rl.data?.lines ?? []).some((l) => Number(lines[l.invoiceLineId]?.quantity || 0) > Number(l.out));
  const setLine = (id: string, patch: Partial<{ quantity: string; condition: "RESALABLE" | "DAMAGED" }>) => setLines((x) => ({ ...x, [id]: { quantity: x[id]?.quantity ?? "", condition: x[id]?.condition ?? "RESALABLE", ...patch } }));
  const pickInvoice = (id: string) => { setInvoiceId(id); setLines({}); setErr(null); };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ returnNo: number }>("/api/accounting/inventory/returns", { method: "POST", json: { invoiceId, locationId: location, reason: reason.trim(), lines: chosen.map(([invoiceLineId, v]) => ({ invoiceLineId, quantity: v.quantity, condition: v.condition })) } });
      onDone(r.returnNo);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="rounded-xl border-2 border-orange/30 bg-cream/40 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[14px] font-extrabold text-charcoal">{L("تسجيل مرتجع من عميل", "Record a customer return")}</p>
        <Button kind="ghost" onClick={onClose}>{L("إغلاق", "Close")}</Button>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex items-end gap-3 flex-wrap">
        <Segmented<"POSTED" | "REVERSED"> value={invStatus} onChange={(v) => { setInvStatus(v); pickInvoice(""); }} options={[{ value: "POSTED", label: L("فواتير مرحّلة", "Posted invoices") }, { value: "REVERSED", label: L("فواتير معكوسة", "Reversed invoices") }]} />
        <Field label={L("بحث", "Search")}><input className={`${INPUT} min-w-[200px]`} placeholder={L("رقم الفاتورة أو العميل…", "Invoice number or customer…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label={L("الفاتورة", "Invoice")}>
          <select className={`${INPUT} min-w-[280px]`} value={invoiceId} onChange={(e) => pickInvoice(e.target.value)}>
            <option value="">{invs.data ? L("— اختر —", "— choose —") : L("جارٍ التحميل…", "Loading…")}</option>
            {(invs.data?.rows ?? []).map((i) => <option key={i.id} value={i.id}>INV-{i.invoiceNo} · {i.customer} · {day(i.issueDate)} · {money(Math.round(Number(i.totalGross) * 100))}</option>)}
          </select>
        </Field>
      </div>
      {invs.error && <ErrorState error={invs.error} onRetry={invs.reload} />}
      {invoiceId && (rl.error ? <ErrorState error={rl.error} onRetry={rl.reload} /> : !rl.data ? <LoadingState /> : rl.data.lines.length === 0 ? <EmptyState title={L("لا بنود بضاعة في هذه الفاتورة", "No goods lines on this invoice")} body={L("بنود الخدمات أو البنود غير المربوطة بصنف مخزون لا تُرتجع.", "Service lines and lines not linked to an inventory item cannot be returned.")} /> : (
        <Table>
          <thead><tr><Th>#</Th><Th>{L("الصنف", "Item")}</Th><Th num>{L("خرج من المخزون", "Left stock")}</Th><Th num>{L("مرتجع / قيد الإرجاع", "Returned / in progress")}</Th><Th num>{L("لدى العميل", "Still out")}</Th><Th>{L("الكمية المرتجعة", "Quantity returned")}</Th><Th>{L("الحالة", "Condition")}</Th></tr></thead>
          <tbody>{rl.data.lines.map((l) => {
            const v = lines[l.invoiceLineId];
            const bad = Number(v?.quantity || 0) > Number(l.out);
            return (
              <tr key={l.invoiceLineId}>
                <Td className="tabular-nums">{l.lineNo}</Td><Td>{l.item}</Td><Td num>{qty(l.sold)} {l.unit}</Td><Td num>{qty((Number(l.returned) + Number(l.pending)).toFixed(4))}</Td><Td num className="font-bold">{qty(l.out)}</Td>
                <Td><input className={`${INPUT} max-w-[140px] ${bad ? "border-red-400" : ""}`} inputMode="decimal" disabled={Number(l.out) <= 0} value={v?.quantity ?? ""} onChange={(e) => setLine(l.invoiceLineId, { quantity: e.target.value })} aria-label={L("الكمية", "Quantity")} /></Td>
                <Td><select className={`${INPUT} max-w-[180px]`} disabled={Number(l.out) <= 0} value={v?.condition ?? "RESALABLE"} onChange={(e) => setLine(l.invoiceLineId, { condition: e.target.value as "RESALABLE" | "DAMAGED" })} aria-label={L("الحالة", "Condition")}>
                  <option value="RESALABLE">{L("صالح للبيع", "Resalable")}</option><option value="DAMAGED">{L("تالف (يُشطب)", "Damaged (written off)")}</option>
                </select></Td>
              </tr>
            );
          })}</tbody>
        </Table>
      ))}
      {over && <Notice tone="bad">{L("كمية تتجاوز ما بقي لدى العميل.", "A quantity is more than what is still with the customer.")}</Notice>}
      <div className="flex items-end gap-3 flex-wrap">
        <Field label={L("موقع العودة", "Location the goods come back to")}>
          <select className={`${INPUT} min-w-[220px]`} value={location} onChange={(e) => setLoc(e.target.value)}>
            <option value="">{L("— اختر —", "— choose —")}</option>
            {locs.map((l) => <option key={l.id} value={l.id}>{l.code} · {L(l.nameAr ?? l.name, l.name)}</option>)}
          </select>
        </Field>
        <Field label={L("السبب", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")}><input className={`${INPUT} min-w-[280px]`} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button kind="primary" busy={busy} disabled={!invoiceId || !location || reason.trim().length < 5 || chosen.length === 0 || over} onClick={save}>{L("تسجيل المرتجع", "Record the return")}</Button>
      </div>
    </div>
  );
}
