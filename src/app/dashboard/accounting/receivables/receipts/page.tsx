"use client";

// Figma: ACC-33. Customer bank lines (receipts and refunds): each is assigned to a customer (named by
// a finance-verified sales collection when one is linked), allocated to open invoices, and the rest
// is an advance. The bank line posts once; the sales collection never posts and keeps the commission.
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { useAmount, useCan, useDay, useExplain } from "../../_components/kit";

type Row = {
  id: string; txnDate: string; amount: string; classification: string; reviewStatus: string; bankReference: string | null; description: string | null; counterparty: string | null; cashAccount: string;
  collection: { id: string; reference: string | null; customerId: string | null; customer: string | null; orderNumber: number | null; status: string } | null;
  receipt: { id: string; receiptNo: number; customerId: string; customer: string; arAmount: string; advanceAmount: string; advanceVat: string; allocations: { invoiceNo: number; amount: string }[] } | null;
  posting: { status: string; reason: string | null } | null;
  beforeStart: boolean;
};
type Queue = { settings: { advanceVatTreatment: "AT_RECEIPT" | "NOT_AT_RECEIPT" | null; bankPostingFrom: string | null } | null; rows: Row[] };
type Customer = { id: string; name: string; vatNumber: string | null; openReceivables: string };
type Detail = { id: string; name: string; openInvoices: { id: string; invoiceNo: number; dueDate: string; gross: string; open: string }[]; advance: string; advanceVat: string };

const cents = (s: string | number) => Math.round(Number(s) * 100);
const fmt = (c: number) => (c / 100).toFixed(2);

export default function ReceiptsPage() {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const { can } = useCan();
  const { data, error, reload } = useApi<Queue>("/api/accounting/receivables/receipts");
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const row = data?.rows.find((r) => r.id === sel) ?? null;

  const runPosting = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api<{ processed: number; translated: number; blocked: number; failed: number }>("/api/accounting/events/process", { method: "POST", json: {} }); setMsg({ tone: "ok", text: L(`عولج ${r.processed}: رُحّل ${r.translated}، محجوب ${r.blocked}، فشل ${r.failed}.`, `Processed ${r.processed}: posted ${r.translated}, blocked ${r.blocked}, failed ${r.failed}.`) }); reload(); }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy(false);
  };

  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (!data) return <Card><LoadingState /></Card>;
  const posted = data.rows.filter((r) => r.posting?.status === "TRANSLATED").length;
  const waiting = data.rows.filter((r) => !r.receipt && !r.beforeStart).length;
  const before = data.rows.filter((r) => r.beforeStart).length;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardTitle title={L("تحصيلات العملاء من البنك", "Customer receipts from the bank")}
          sub={L("حركات «تحصيل من عميل» و«رد لعميل» تُرحّل بعد إسنادها لعميل: ما يغطي فواتيره المفتوحة إلى الذمم المدينة، والباقي دفعة مقدمة", "“Customer receipt” and “customer refund” lines post once assigned to a customer: what covers open invoices goes to receivables, the rest is an advance")}
          right={<Link href="/dashboard/accounting/receivables/aging"><Button icon={ArrowLeft}>{L("أعمار الذمم المدينة", "Receivables aging")}</Button></Link>} />
        <AdvanceVatSetting value={data.settings?.advanceVatTreatment ?? null} canEdit={can("settings_manage")} onSaved={reload} />
        <div className="flex gap-2 flex-wrap text-[12px]">
          <Badge tone="ok">{L(`مرحّلة ${posted}`, `Posted ${posted}`)}</Badge>
          <Badge tone={waiting ? "bad" : "info"}>{L(`بانتظار الإسناد ${waiting}`, `Awaiting assignment ${waiting}`)}</Badge>
          <Badge tone="info">{L(`قبل البدء ${before}`, `Before start ${before}`)}</Badge>
        </div>
      </Card>

      {row && <AssignPanel key={row.id} row={row} canAssign={can("ar_receipt_assign")} onDone={(t) => { setMsg({ tone: "ok", text: t }); setSel(null); reload(); }} onClose={() => setSel(null)} />}

      <Card>
        <CardTitle title={L("حركات العملاء في البنك", "Customer bank lines")} sub={L("كل حركة مع حالتها — تُسنَد هنا للعميل ثم تُرحَّل؛ التصحيح بعد الترحيل من «تصحيح حركات مرحّلة»", "Each line with its state — assign it here, then it posts; after posting, correct it through “Bank corrections”")}
          right={can("events_process") ? <Button kind="primary" busy={busy} onClick={runPosting}>{L("تشغيل الترحيل الآن", "Run posting now")}</Button> : undefined} />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {data.rows.length === 0 ? <EmptyState title={L("لا توجد حركات عملاء", "No customer bank lines")} body={L("صنّف حركة بنكية في وحدة المالية كتحصيل من عميل.", "Classify a bank line in Finance as a customer receipt.")} /> : (
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("المرجع", "Reference")}</Th><Th>{L("البيان", "Description")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "State")}</Th><Th /></tr></thead>
            <tbody>
              {data.rows.map((r) => {
                const isPosted = r.posting?.status === "TRANSLATED";
                return (
                  <tr key={r.id} className={sel === r.id ? "bg-orange-light/40" : "hover:bg-cream/40"}>
                    <Td className="whitespace-nowrap">{day(r.txnDate)}</Td>
                    <Td className="tabular-nums">{r.cashAccount}</Td>
                    <Td className="tabular-nums">{r.bankReference ?? "—"}</Td>
                    <Td>{r.description ?? r.counterparty ?? "—"}</Td>
                    <Td num>{Number(r.amount) < 0 ? `(${amt(String(-Number(r.amount)))})` : amt(r.amount)}</Td>
                    <Td className="text-[12px]"><RowState r={r} /></Td>
                    <Td>{!isPosted && !r.beforeStart && can("ar_receipt_assign") && <button type="button" className="font-bold text-orange hover:underline min-h-8" onClick={() => setSel(r.id)}>{r.receipt ? L("تعديل الإسناد", "Reassign") : L("إسناد", "Assign")}</button>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-brown">{L("الحركات المرحّلة مجمّدة في قاعدة البيانات؛ أي تغيير يمر عبر طلب تصحيح معتمد يعكس القيد ويستبدله.", "Posted lines are frozen in the database; any change goes through an approved correction that reverses and replaces the entry.")}</p>
      </Card>
    </div>
  );
}

function RowState({ r }: { r: Row }) {
  const { L } = useL();
  const explain = useExplain();
  if (r.beforeStart) return <span className="text-slate-500">{L("قبل تاريخ بدء ترحيل البنك", "Before the bank posting start date")}</span>;
  if (r.posting?.status === "TRANSLATED" && r.receipt) {
    const inv = r.receipt.allocations.map((a) => `INV-${a.invoiceNo}`).join("، ");
    return <span className="text-green-700 font-bold">{L("مرحّل", "Posted")} · {r.receipt.customer}{inv ? ` · ${inv}` : ""}{Number(r.receipt.advanceAmount) !== 0 ? ` · ${L("دفعة مقدمة", "advance")}` : ""}</span>;
  }
  if (!r.receipt) return <span className="text-red-700 font-bold">{L("بانتظار الإسناد", "Awaiting assignment")}{r.collection ? ` — ${L("التحصيل", "collection")} ${r.collection.reference ?? ""} ${L("يقترح العميل", "suggests the customer")}` : ""}</span>;
  return <span className="text-amber-700 font-bold" title={explain(r.posting?.reason) || undefined}>{L("مُسنَد", "Assigned")} · {r.receipt.customer} — {r.posting?.status === "BLOCKED" ? L("محجوب: ", "blocked: ") + explain(r.posting.reason) : L("بانتظار الترحيل", "waiting to post")}</span>;
}

/** Decision D-2: whether VAT is due on an advance when it is received. Undecided = provisional. */
function AdvanceVatSetting({ value, canEdit, onSaved }: { value: "AT_RECEIPT" | "NOT_AT_RECEIPT" | null; canEdit: boolean; onSaved: () => void }) {
  const { L } = useL();
  const [v, setV] = useState<string>(value ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api("/api/accounting/settings", { method: "PATCH", json: { advanceVatTreatment: v || null } }); onSaved(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2 flex-wrap">
        <Field label={L("ضريبة الدفعات المقدمة (قرار D-2)", "VAT on advances (decision D-2)")}>
          <select className={`${INPUT} min-w-[220px]`} value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value)}>
            <option value="">{L("لم يُقرَّر بعد", "Not decided yet")}</option>
            <option value="AT_RECEIPT">{L("عند الاستلام", "At receipt")}</option>
            <option value="NOT_AT_RECEIPT">{L("ليس عند الاستلام", "Not at receipt")}</option>
          </select>
        </Field>
        {canEdit && <Button busy={busy} disabled={v === (value ?? "")} onClick={save}>{L("حفظ", "Save")}</Button>}
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <p className="text-[12px] text-brown">{value
        ? L("ينطبق على الإسنادات من الآن؛ التحصيلات المرحّلة تحتفظ بضريبتها. الترحيل يتطلب اعتماد سياسة الدفعات المقدمة.", "Applies to assignments from now on; posted receipts keep their VAT. Posting needs the advances policy to be approved.")
        : L("بانتظار قرار المحاسب — يُفترض «عند الاستلام» مؤقتاً، والترحيل المؤقت في قاعدة الاختبار فقط.", "Awaiting the accountant’s decision — “at receipt” is assumed provisionally, and provisional posting happens only in the test database.")}</p>
    </div>
  );
}

function AssignPanel({ row, canAssign, onDone, onClose }: { row: Row; canAssign: boolean; onDone: (msg: string) => void; onClose: () => void }) {
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const fixedCustomer = row.collection?.customerId ?? null;
  const [customerId, setCustomerId] = useState<string>(fixedCustomer ?? row.receipt?.customerId ?? "");
  const [q, setQ] = useState("");
  const customers = useApi<Customer[]>(fixedCustomer ? null : `/api/accounting/receivables/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const detail = useApi<Detail>(customerId ? `/api/accounting/receivables/customers/${customerId}` : null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = cents(row.amount);
  const refund = total < 0;
  const invoices = detail.data?.openInvoices ?? [];
  const allocated = invoices.reduce((s, i) => s + (alloc[i.id] ? cents(alloc[i.id]) : 0), 0);
  const advance = refund ? 0 : total - allocated;
  const over = allocated > total && !refund;

  const autoFill = () => {
    let left = total; const next: Record<string, string> = {};
    for (const i of invoices) { if (left <= 0) break; const take = Math.min(left, cents(i.open)); next[i.id] = fmt(take); left -= take; }
    setAlloc(next);
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const allocations = refund ? [] : invoices.filter((i) => alloc[i.id] && cents(alloc[i.id]) > 0).map((i) => ({ invoiceId: i.id, amount: alloc[i.id] }));
      const r = await api<{ receipt: { receiptNo: number }; ledger: { status?: string } | null }>(`/api/accounting/receivables/receipts/${row.id}`, { method: "PUT", json: { customerId, allocations, salesCollectionId: row.collection?.id } });
      onDone(L(`أُسند التحصيل RC-${r.receipt.receiptNo}. ${r.ledger?.status === "TRANSLATED" ? "رُحّل." : "بانتظار الترحيل."}`, `Receipt RC-${r.receipt.receiptNo} assigned. ${r.ledger?.status === "TRANSLATED" ? "Posted." : "Waiting to post."}`));
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardTitle title={L(`إسناد التحصيل ${row.bankReference ?? ""}`, `Assign receipt ${row.bankReference ?? ""}`)}
          sub={row.collection ? L(`العميل من تحصيل المبيعات المعتمد ${row.collection.reference ?? ""} — التحصيل نفسه لا يُرحّل ولا تتكرر العمولة`, `Customer from approved sales collection ${row.collection.reference ?? ""} — the collection itself does not post and the commission is not duplicated`) : L("اختر العميل ثم وزّع المبلغ على فواتيره المفتوحة", "Choose the customer, then spread the amount over their open invoices")}
          right={<Button onClick={onClose}>{L("إغلاق", "Close")}</Button>} />
        {fixedCustomer ? (
          <p className="text-[13px]"><span className="font-bold">{L("العميل:", "Customer:")}</span> {row.collection?.customer} <Badge tone="brand">{L("من التحصيل", "from collection")}</Badge></p>
        ) : (
          <div className="flex gap-2 flex-wrap items-end">
            <Field label={L("بحث عن عميل", "Find a customer")}><input className={`${INPUT} min-w-[200px]`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("الاسم أو الرقم الضريبي", "Name or VAT number")} /></Field>
            <Field label={L("العميل", "Customer")}>
              <select className={`${INPUT} min-w-[240px]`} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setAlloc({}); }}>
                <option value="">{L("— اختر —", "— choose —")}</option>
                {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.vatNumber ? ` · ${c.vatNumber}` : ""}</option>)}
              </select>
            </Field>
          </div>
        )}
        {customerId && (detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : !detail.data ? <LoadingState /> : refund ? (
          <Notice tone="info">{L(`رد مبلغ: يُخصم من الدفعة المقدمة أولاً (رصيدها ${amt(detail.data.advance)})، والباقي من رصيد العميل الدائن.`, `Refund: taken from the advance first (balance ${amt(detail.data.advance)}), the rest from the customer's credit on account.`)}</Notice>
        ) : invoices.length === 0 ? (
          <Notice tone="info">{L("لا توجد فواتير مرحّلة مفتوحة — المبلغ كله دفعة مقدمة.", "No open posted invoices — the whole amount is an advance.")}</Notice>
        ) : (
          <>
            <Table>
              <thead><tr><Th>{L("الفاتورة", "Invoice")}</Th><Th>{L("الاستحقاق", "Due")}</Th><Th num>{L("المفتوح", "Open")}</Th><Th num>{L("المخصّص", "Allocated")}</Th><Th num>{L("المتبقي بعده", "Left after")}</Th></tr></thead>
              <tbody>
                {invoices.map((i) => {
                  const a = alloc[i.id] ? cents(alloc[i.id]) : 0;
                  return (
                    <tr key={i.id}>
                      <Td className="tabular-nums font-bold">INV-{i.invoiceNo}</Td>
                      <Td className="whitespace-nowrap">{day(i.dueDate)}</Td>
                      <Td num>{amt(i.open)}</Td>
                      <Td num><input aria-label={L(`المخصّص للفاتورة INV-${i.invoiceNo}`, `Allocated to INV-${i.invoiceNo}`)} inputMode="decimal" className={`${INPUT} w-28 text-end tabular-nums`} value={alloc[i.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} /></Td>
                      <Td num className={a > cents(i.open) ? "text-red-700 font-bold" : ""}>{amt(fmt(cents(i.open) - a))}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div><Button onClick={autoFill}>{L("توزيع تلقائي على الأقدم", "Allocate oldest first")}</Button></div>
          </>
        ))}
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="flex gap-2">
          <Button kind="primary" disabled={!canAssign || !customerId || over || !detail.data} busy={busy} onClick={submit}>{L("إسناد وترحيل", "Assign and post")}</Button>
        </div>
      </Card>
      <Card>
        <CardTitle title={L(`ملخص الإسناد — ${row.bankReference ?? ""}`, `Assignment summary — ${row.bankReference ?? ""}`)} sub={L(`${amt(row.amount)} ر.س · يُرحّل مرة واحدة من سطر البنك`, `SAR ${amt(row.amount)} · posts once from the bank line`)} />
        <Table>
          <thead><tr><Th>{L("الجزء", "Part")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
          <tbody>
            {refund ? (
              <tr><Td>{L("رد مبلغ (مدين الدفعات المقدمة/الذمم، دائن البنك)", "Refund (Dr advances/receivables, Cr bank)")}</Td><Td num>{amt(fmt(-total))}</Td></tr>
            ) : (<>
              <tr><Td>{L("ذمم مدينة مخصّصة (دائن 1130)", "Receivables allocated (Cr 1130)")}</Td><Td num className={over ? "text-red-700 font-bold" : ""}>{amt(fmt(allocated))}</Td></tr>
              <tr><Td>{L("دفعة مقدمة (دائن 2410)", "Advance (Cr 2410)")}</Td><Td num>{amt(fmt(Math.max(advance, 0)))}</Td></tr>
            </>)}
          </tbody>
        </Table>
        {over && <Notice tone="bad">{L("المخصّص يتجاوز مبلغ التحصيل.", "Allocations exceed the receipt.")}</Notice>}
        {!refund && advance > 0 && <p className="text-[12px] text-brown">{L("ضريبة الدفعة المقدمة (إن وُجبت عند الاستلام) تُستخرج من المبلغ بنسبة الضريبة الافتراضية وتُقيد دائناً على 2170 للعميل؛ تُطبَّق الدفعة لاحقاً على فاتورة من صفحة الفاتورة.", "The advance's VAT (when due at receipt) is extracted at the default rate and credited to 2170 for the customer; the advance is applied to an invoice later from the invoice page.")}</p>}
      </Card>
    </div>
  );
}
