"use client";

// Figma: ACC-32 (desktop) and ACC-36 (390 px). Sales invoice / credit note detail: approval
// timeline with the actions the signed-in user may take, lines, the journal it will post (or
// posted), what is allocated to it (receipts, credit notes, advances), credit notes issued
// against it, applying the customer's advance, and the audit trail.
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { BillStatus, EVENT_STATUS, docNo, useAmount, useCan, useDay, useExplain } from "../../_components/kit";

type Acc = { code: string; nameAr: string | null; nameEn: string } | null;
type Doc = {
  id: string; invoiceNo: number; kind: "INVOICE" | "CREDIT_NOTE"; status: string; customerId: string; issueDate: string; supplyDate: string | null; dueDate: string; description: string | null; reason: string | null;
  totalNet: string; totalVat: string; totalGross: string; createdBy: string; createdAt: string; submittedBy: string | null; submittedAt: string | null;
  approvedBy: string | null; approvedAt: string | null; postedBy: string | null; postedAt: string | null; rejectedReason: string | null; rejectedBy: string | null; reversalReason: string | null;
  customer: { name: string; nameAr: string | null; vatNumber: string | null };
  order: { id: string; orderNumber: number; status: string } | null; originalInvoice: { id: string; invoiceNo: number; totalGross: string } | null;
  creditNotes: { id: string; invoiceNo: number; status: string; totalGross: string; issueDate: string }[];
  lines: { lineNo: number; description: string | null; quantity: string; unitPrice: string; discountPercent: string; net: string; vatRate: string; vat: string; gross: string; account: Acc }[];
  names: Record<string, string>; preview: { account: Acc; debit: string; credit: string; party: string | null }[];
  events: { id: string; eventType: string; status: string; errorMessage: string | null; journalEntryId: string | null }[];
  journals: { id: string; entryNo: number; status: string; isProvisional: boolean }[];
  audit: { action: string; userId: string | null; createdAt: string; reason: string | null }[];
  open: string | null; allocatable: string | null; awaitingReceipt: string | null; creditable: string | null; customerAdvance: string;
  allocations: { id: string; amount: string; allocatedOn: string; active: boolean; invoiceNo: number; source: { kind: string; label: string } }[];
};
type Cust = { openInvoices: { id: string; invoiceNo: number; open: string }[] };

export default function SalesDocPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const explain = useExplain();
  const { can, user } = useCan();
  const { data: d, error, reload } = useApi<Doc>(`/api/accounting/receivables/invoices/${id}`);
  const cust = useApi<Cust>(d?.kind === "CREDIT_NOTE" && d.status === "POSTED" ? `/api/accounting/receivables/customers/${d.customerId}` : null);
  const [reason, setReason] = useState("");
  const [advance, setAdvance] = useState("");
  const [credit, setCredit] = useState({ invoiceId: "", amount: "" });
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!d) return <LoadingState />;
  const credit_ = d.kind === "CREDIT_NOTE";
  const who = (u: string | null) => (u ? d.names[u] ?? u : "—");
  const when = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " ·") : "");
  const acc = (a: Acc) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : L("غير مربوط", "Not mapped"));
  const mine = user?.id === d.createdBy || user?.id === d.submittedBy;
  const call = async (key: string, url: string, json: unknown = {}, method = "POST") => {
    setBusy(key); setMsg(null);
    try {
      const r = await api<{ ledger?: { status: string; message?: string } | null }>(url, { method, json });
      if (r?.ledger && r.ledger.status !== "TRANSLATED") setMsg({ tone: "warn", text: L(`تم، والقيد ${EVENT_STATUS[r.ledger.status]?.ar ?? r.ledger.status}: ${explain(r.ledger.message)}`, `Done; the journal is ${r.ledger.status.toLowerCase()}: ${r.ledger.message ?? ""}`) });
      setReason(""); setAdvance(""); setCredit({ invoiceId: "", amount: "" }); reload(); cust.reload();
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? explain(e.message) : String(e) }); }
    setBusy("");
  };
  const act = (path: string, json: unknown = {}) => call(path, `/api/accounting/receivables/invoices/${d.id}/${path}`, json);
  const et = credit_ ? "ar.credit_note" : "ar.invoice";
  const journal = (e: string) => { const ev = d.events.find((x) => x.eventType === e); return { ev, je: d.journals.find((j) => j.id === ev?.journalEntryId) }; };
  const posted = journal(`${et}.posted`), reversed = journal(`${et}.reversed`);
  const steps = [
    { title: L("أُعدّت كمسودة", "Drafted"), who: `${who(d.createdBy)} · ${when(d.createdAt)}`, state: "done" },
    { title: L("قُدّمت للاعتماد", "Submitted"), who: d.submittedBy ? `${who(d.submittedBy)} · ${when(d.submittedAt)}` : "", state: d.submittedBy || d.status !== "DRAFT" ? "done" : "todo" },
    { title: d.status === "SUBMITTED" ? L("بانتظار الاعتماد", "Awaiting approval") : L("اعتُمدت", "Approved"), who: d.approvedBy ? `${who(d.approvedBy)} · ${when(d.approvedAt)}` : L("أي معتمد عدا المُعِدّ", "Any approver except the preparer"), state: d.approvedBy ? "done" : d.status === "SUBMITTED" ? "now" : "todo" },
    { title: credit_ ? L("الترحيل: قيد المردودات والضريبة والذمم", "Posted: returns, VAT and receivables") : L("الترحيل: قيد الذمم والإيراد والضريبة", "Posted: receivables, revenue and VAT"), who: d.postedBy ? `${who(d.postedBy)} · ${when(d.postedAt)}` : L("بعد الاعتماد", "After approval"), state: d.postedBy ? "done" : d.status === "APPROVED" ? "now" : "todo" },
  ];
  const dot = { done: "bg-green-600", now: "bg-amber-600", todo: "bg-gray-300" } as Record<string, string>;
  const reasonOk = reason.trim().length >= 5;
  const unapplied = credit_ ? Number(d.totalGross) - d.allocations.filter((a) => a.active).reduce((s, a) => s + Number(a.amount), 0) : 0;
  const customerName = d.customer.nameAr ?? d.customer.name;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr] items-start">
      <Card className="order-2 lg:order-1">
        <CardTitle title={L("الاعتماد", "Approval")} sub={L("فصل المهام: من أعدّ المستند لا يعتمده", "Separation of duties: the preparer cannot approve")} />
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className={`mt-1.5 w-3 h-3 rounded-full flex-shrink-0 ${dot[s.state]}`} aria-hidden />
              <div><p className={`text-[13px] font-bold ${s.state === "todo" ? "text-brown" : "text-charcoal"}`}>{s.title}</p>{s.who && <p className="text-[11px] text-brown">{s.who}</p>}</div>
            </li>
          ))}
        </ol>
        {d.rejectedReason && d.status === "DRAFT" && <Notice tone="bad">{L(`رُفضت: ${d.rejectedReason} — ${who(d.rejectedBy)}`, `Rejected: ${d.rejectedReason} — ${who(d.rejectedBy)}`)}</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {d.status === "DRAFT" && can("ar_invoice_create") && (
          <div className="flex gap-2 flex-wrap">
            <Button kind="primary" busy={busy === "submit"} disabled={!!busy} onClick={() => act("submit")} className="min-h-11">{L("تقديم للاعتماد", "Submit for approval")}</Button>
            <Link href={`/dashboard/accounting/receivables/new?edit=${d.id}`}><Button className="min-h-11">{L("تعديل", "Edit")}</Button></Link>
            <Button kind="danger" disabled={!!busy} className="min-h-11" onClick={async () => { if (!confirm(L("حذف المسودة؟", "Delete the draft?"))) return; await api(`/api/accounting/receivables/invoices/${d.id}`, { method: "DELETE" }); router.push("/dashboard/accounting/receivables"); }}>{L("حذف", "Delete")}</Button>
          </div>
        )}
        {d.status === "SUBMITTED" && can("ar_invoice_approve") && (mine
          ? <Notice tone="info">{L("أنت من أعدّ أو قدّم هذا المستند؛ يعتمده شخص آخر.", "You prepared or submitted this document; someone else approves it.")}</Notice>
          : <>
            <Field label={L("سبب الرفض (مطلوب عند الرفض)", "Reason (required to reject)")} hint={L("5 أحرف على الأقل — يُحفظ في سجل التدقيق", "At least 5 characters — kept in the audit trail")}>
              <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button kind="primary" busy={busy === "approve"} disabled={!!busy} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("approve")}>{L("اعتماد", "Approve")}</Button>
              <Button kind="danger" busy={busy === "reject"} disabled={!!busy || !reasonOk} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("reject", { reason })}>{L("رفض وإرجاع كمسودة", "Reject to draft")}</Button>
            </div>
          </>)}
        {d.status === "APPROVED" && can("ar_invoice_post") && <Button kind="primary" busy={busy === "post"} disabled={!!busy} className="min-h-11" onClick={() => act("post")}>{credit_ ? L("ترحيل الإشعار", "Post the credit note") : L("ترحيل الفاتورة", "Post the invoice")}</Button>}
        {d.status === "POSTED" && !credit_ && can("ar_invoice_create") && Number(d.creditable) > 0 && <Link href={`/dashboard/accounting/receivables/new?creditFor=${d.id}`}><Button className="min-h-11 w-full">{L("إصدار إشعار دائن…", "Issue a credit note…")}</Button></Link>}
        {d.status === "POSTED" && !credit_ && can("ar_receipt_assign") && Number(d.customerAdvance) > 0 && Number(d.allocatable) > 0 && (
          <div className="flex flex-col gap-2 border-t border-border-light pt-3">
            <p className="text-[13px] font-bold">{L(`للعميل دفعة مقدمة ${amt(d.customerAdvance)} — تطبيقها على الفاتورة`, `The customer has an advance of ${amt(d.customerAdvance)} — apply it to this invoice`)}</p>
            <Field label={L("المبلغ", "Amount")}><input className={INPUT} dir="ltr" inputMode="decimal" placeholder={String(Math.min(Number(d.customerAdvance), Number(d.allocatable)).toFixed(2))} value={advance} onChange={(e) => setAdvance(e.target.value)} /></Field>
            <Button kind="primary" busy={busy === "advance"} disabled={!!busy} onClick={() => call("advance", "/api/accounting/receivables/advances", { invoiceId: d.id, amount: advance || Math.min(Number(d.customerAdvance), Number(d.allocatable)).toFixed(2) })}>{L("تطبيق الدفعة المقدمة", "Apply the advance")}</Button>
          </div>
        )}
        {credit_ && d.status === "POSTED" && unapplied > 0.004 && can("ar_receipt_assign") && cust.data && (
          <div className="flex flex-col gap-2 border-t border-border-light pt-3">
            <p className="text-[13px] font-bold">{L(`رصيد غير مستخدم ${amt(unapplied.toFixed(2))} — تخصيصه لفاتورة أخرى للعميل`, `Unused credit ${amt(unapplied.toFixed(2))} — use it on another invoice of the customer`)}</p>
            <Field label={L("الفاتورة", "Invoice")}><select className={INPUT} value={credit.invoiceId} onChange={(e) => setCredit({ ...credit, invoiceId: e.target.value })}><option value="">{L("اختر…", "Choose…")}</option>{cust.data.openInvoices.map((i) => <option key={i.id} value={i.id}>INV-{i.invoiceNo} · {amt(i.open)}</option>)}</select></Field>
            <Field label={L("المبلغ", "Amount")}><input className={INPUT} dir="ltr" inputMode="decimal" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} /></Field>
            <Button kind="primary" busy={busy === "credit"} disabled={!!busy || !credit.invoiceId || !credit.amount} onClick={() => call("credit", "/api/accounting/receivables/credits", { creditNoteId: d.id, ...credit })}>{L("تخصيص", "Allocate")}</Button>
          </div>
        )}
        {d.status === "POSTED" && can("ar_invoice_post") && (
          <details className="text-[13px]">
            <summary className="cursor-pointer font-bold text-red-700">{credit_ ? L("عكس الإشعار…", "Reverse the credit note…") : L("عكس الفاتورة…", "Reverse the invoice…")}</summary>
            <div className="flex flex-col gap-2 mt-2">
              <Field label={L("السبب", "Reason")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button kind="danger" busy={busy === "reverse"} disabled={!!busy || !reasonOk} onClick={() => act("reverse", { reason })}>{L("عكس بقيد مقابل", "Reverse with a mirror entry")}</Button>
              <p className="text-[11px] text-brown">{L("لا تُعكس فاتورة عليها تحصيلات أو إشعارات أو دفعات مخصصة — أصدر إشعاراً دائناً بدلاً من ذلك.", "An invoice with receipts, credits or advances allocated cannot be reversed — issue a credit note instead.")}</p>
            </div>
          </details>
        )}
      </Card>

      <div className="flex flex-col gap-4 order-1 lg:order-2 min-w-0">
        <Card>
          <CardTitle title={`${docNo(d)} · ${customerName}`}
            sub={credit_ ? L(`إشعار دائن مقابل INV-${d.originalInvoice?.invoiceNo} · ${day(d.issueDate)} · ${d.reason ?? ""}`, `Credit note against INV-${d.originalInvoice?.invoiceNo} · ${day(d.issueDate)} · ${d.reason ?? ""}`)
              : L(`${d.order ? `طلب ${d.order.orderNumber} · ` : ""}${day(d.issueDate)} · تستحق ${day(d.dueDate)}${d.customer.vatNumber ? ` · رقم ضريبي ${d.customer.vatNumber}` : " · فاتورة مبسطة"}`, `${d.order ? `Order ${d.order.orderNumber} · ` : ""}${day(d.issueDate)} · due ${day(d.dueDate)}${d.customer.vatNumber ? ` · VAT no. ${d.customer.vatNumber}` : " · simplified"}`)}
            right={<BillStatus sales creditNote={credit_} status={d.status} rejected={!!d.rejectedReason} remaining={d.open} gross={d.totalGross} />} />
          <div className="flex gap-6 flex-wrap">
            {[[L("الإجمالي", "Total"), `${amt(d.totalGross)} ${L("ر.س", "SAR")}`], [L("الضريبة", "VAT"), amt(d.totalVat)], [L("الصافي", "Net"), amt(d.totalNet)], ...(d.open !== null ? [[L("المتبقي", "Open"), amt(d.open)]] : []), ...(Number(d.awaitingReceipt) > 0 ? [[L("منه تحصيل بانتظار الترحيل", "of which receipt awaiting posting"), amt(d.awaitingReceipt)]] : [])].map(([l, v]) => (
              <div key={l}><p className="text-xs font-bold text-brown">{l}</p><p className="text-xl font-extrabold text-charcoal tabular-nums">{v}</p></div>
            ))}
          </div>
          <Table>
            <thead><tr><Th>#</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("الصافي", "Net")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.lineNo}><Td>{l.lineNo}</Td><Td>{credit_ ? L("مردودات (تلقائي)", "Returns (automatic)") : acc(l.account)}</Td><Td>{l.description ?? "—"}<span className="block text-[11px] text-brown tabular-nums" dir="ltr">{Number(l.quantity)} × {Number(l.unitPrice)}{Number(l.discountPercent) ? ` − ${Number(l.discountPercent)}%` : ""}{Number(l.vatRate) ? ` · ${Number(l.vatRate)}%` : ""}</span></Td><Td num>{amt(l.net)}</Td><Td num>{amt(l.vat)}</Td><Td num>{amt(l.gross)}</Td></tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle title={posted.je ? L(`القيد المرحّل #${posted.je.entryNo}`, `Posted journal #${posted.je.entryNo}`) : L("القيد الذي سيُرحَّل", "Journal it will post")}
            sub={L("يُنشأ آلياً عند الترحيل · قيد واحد لكل مستند · التحصيل من سطر البنك لا من هنا", "Created automatically on posting · one journal per document · collection comes from the bank line, not from here")}
            right={posted.je ? <Link className="text-[13px] font-bold text-orange hover:underline" href={`/dashboard/accounting/journals/${posted.je.id}`}>{L("فتح القيد", "Open journal")}{posted.je.isProvisional ? L(" (مؤقت)", " (provisional)") : ""}</Link> : undefined} />
          {posted.ev && posted.ev.status !== "TRANSLATED" && <Notice tone="warn">{L(`حالة القيد: ${EVENT_STATUS[posted.ev.status]?.ar ?? posted.ev.status} — ${explain(posted.ev.errorMessage)}`, `Journal status: ${posted.ev.status.toLowerCase()} — ${posted.ev.errorMessage ?? ""}`)}</Notice>}
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th>{L("الطرف", "Party")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {d.preview.map((p, i) => <tr key={i}><Td>{acc(p.account)}</Td><Td>{p.party ?? "—"}</Td><Td num>{p.debit ? amt(p.debit) : ""}</Td><Td num>{p.credit ? amt(p.credit) : ""}</Td></tr>)}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("متوازن ✓", "Balanced ✓")}</Td><Td></Td><Td num>{amt(d.totalGross)}</Td><Td num>{amt(d.totalGross)}</Td></tr>
            </tbody>
          </Table>
          {d.order && <div className="flex items-center gap-2 flex-wrap text-[13px]"><Badge tone="brand">{L("الطلب", "Order")}</Badge><span>{L(`طلب ${d.order.orderNumber} · ${d.order.status} · لا يُفوتر الطلب مرتين`, `Order ${d.order.orderNumber} · ${d.order.status} · an order is invoiced once`)}</span></div>}
          {reversed.je && <Notice tone="info">{L(`عُكس المستند بالقيد #${reversed.je.entryNo}: ${d.reversalReason ?? ""}`, `Reversed by journal #${reversed.je.entryNo}: ${d.reversalReason ?? ""}`)}</Notice>}
        </Card>
        {(d.allocations.length > 0 || d.creditNotes.length > 0) && (
          <Card>
            <CardTitle title={credit_ ? L("استخدام الإشعار", "Where the credit was used") : L("ما خُصِّص للفاتورة", "Allocated to this invoice")} sub={L("تحصيلات وإشعارات دائنة ودفعات مقدمة — لا تُحذف، تُلغى فقط", "Receipts, credit notes and advances — never deleted, only switched off")} />
            <Table>
              <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("المصدر", "Source")}</Th>{credit_ && <Th>{L("الفاتورة", "Invoice")}</Th>}<Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
              <tbody>{d.allocations.map((a) => (
                <tr key={a.id}><Td className="whitespace-nowrap">{day(a.allocatedOn)}</Td><Td className="tabular-nums">{a.source.label}</Td>{credit_ && <Td className="tabular-nums">INV-{a.invoiceNo}</Td>}<Td num>{amt(a.amount)}</Td><Td>{a.active ? <Badge tone="ok">{L("قائم", "Active")}</Badge> : <Badge tone="info">{L("أُلغي", "Released")}</Badge>}</Td></tr>
              ))}</tbody>
            </Table>
            {d.creditNotes.length > 0 && <p className="text-[13px]">{L("إشعارات دائنة:", "Credit notes:")} {d.creditNotes.map((c) => <Link key={c.id} className="font-bold text-orange hover:underline me-2 tabular-nums" href={`/dashboard/accounting/receivables/${c.id}`}>CN-{c.invoiceNo} ({amt(c.totalGross)})</Link>)}</p>}
          </Card>
        )}
        <Card>
          <CardTitle title={L("سجل التدقيق", "Audit trail")} sub={L("لا يمكن تعديله أو حذفه", "Cannot be edited or deleted")} />
          <Table>
            <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("المستخدم", "User")}</Th><Th>{L("السبب", "Reason")}</Th></tr></thead>
            <tbody>{d.audit.map((a, i) => <tr key={i}><Td className="whitespace-nowrap">{when(a.createdAt)}</Td><Td>{({ "invoice.create": L("إنشاء", "Create"), "credit_note.create": L("إنشاء", "Create"), "sales_document.update": L("تعديل", "Edit"), "sales_document.submit": L("تقديم", "Submit"), "sales_document.approve": L("اعتماد", "Approve"), "sales_document.reject": L("رفض", "Reject"), "sales_document.post": L("ترحيل", "Post"), "sales_document.reverse": L("عكس", "Reverse"), "credit.allocate": L("تخصيص رصيد", "Allocate credit") } as Record<string, string>)[a.action] ?? a.action}</Td><Td>{who(a.userId)}</Td><Td>{a.reason ?? "—"}</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
