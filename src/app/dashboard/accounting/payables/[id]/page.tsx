"use client";

// Figma: ACC-22 (desktop) and ACC-26 (390 px). Supplier bill detail: approval timeline with the
// actions the signed-in user may take, lines, the journal it will post (or posted), its payment
// obligation and matched payments, and the audit trail. Stage 4b: a supplier credit note shows the
// bill it credits, what each line settles (supplier return / receipt line), the SUPPLIER_CREDIT
// inventory documents that settled its stock lines, and its application to open bills (apply,
// release); a bill shows the credit notes against it and the credits applied to it.
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { BillStatus, EVENT_STATUS, useAmount, useCan, useDay, useExplain } from "../../_components/kit";
import { InvStatus } from "../../inventory/_ui";

type Acc = { code: string; nameAr: string | null; nameEn: string } | null;
type Bill = {
  id: string; billNo: number; status: string; supplierId: string; supplierInvoiceNo: string; billDate: string; dueDate: string; description: string | null;
  totalNet: string; totalVat: string; totalGross: string; createdBy: string; createdAt: string; submittedBy: string | null; submittedAt: string | null;
  approvedBy: string | null; approvedAt: string | null; postedBy: string | null; postedAt: string | null; rejectedReason: string | null; rejectedBy: string | null;
  reversedAt: string | null; reversalReason: string | null;
  supplier: { name: string; vatNumber: string | null };
  lines: { id: string; lineNo: number; kind: string; description: string | null; quantity: string; unitPrice: string; net: string; vatRate: string; vat: string; gross: string; account: Acc }[];
  names: Record<string, string>; preview: { account: Acc; debit: string; credit: string; party: string | null }[];
  events: { id: string; eventType: string; status: string; errorMessage: string | null; journalEntryId: string | null }[];
  journals: { id: string; entryNo: number; status: string; isProvisional: boolean }[];
  obligation: { id: string; status: string; amount: string; dueDate: string; paid: string; remaining: string } | null;
  purchaseObligation: { description: string; amount: string; status: string } | null;
  payments: { transactionId: string; date: string; reference: string | null; amount: string }[];
  audit: { action: string; userId: string | null; createdAt: string; reason: string | null }[];
  kind: "BILL" | "CREDIT_NOTE"; reason: string | null;
  originalBill: { id: string; billNo: number; supplierInvoiceNo: string; totalGross: string; status: string } | null;
  creditNotes: { id: string; billNo: number; supplierInvoiceNo: string; status: string; totalGross: string; billDate: string }[];
  openBills: { id: string; billNo: number; supplierInvoiceNo: string; dueDate: string; open: string }[];
  creditable: string | null; creditApplied: string; creditLeft: string | null;
  creditAllocations: { id: string; creditNoteId: string; billId: string; counterpartNo: number | null; amount: string; allocatedOn: string; active: boolean; removedAt: string | null }[];
  settlements: { id: string; docNo: number; status: string; docDate: string; billLineId: string | null; provisional: boolean; lineNo: number | null; ledger: { status: string; reason: string | null } | null }[];
  lineRefs: Record<string, { documentId: string; label: string } | null>;
};
const LINE_KIND: Record<string, [string, string]> = {
  STOCK_RECEIPT: ["بضاعة مستلمة", "Goods received"], STOCK_RETURN: ["بضاعة مرتجعة للمورد", "Goods returned to supplier"], STOCK_PRICE_ADJUSTMENT: ["تخفيض سعر بضاعة مستلمة", "Price reduction on goods received"],
};

export default function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const explain = useExplain();
  const { can, user } = useCan();
  const { data: b, error, reload } = useApi<Bill>(`/api/accounting/bills/${id}`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [apply, setApply] = useState({ billId: "", amount: "", allocatedOn: "" });

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!b) return <LoadingState />;
  const who = (u: string | null) => (u ? b.names[u] ?? u : "—");
  const when = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " ·") : "");
  const acc = (a: Acc) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : L("غير مربوط", "Not mapped"));
  const mine = user?.id === b.createdBy || user?.id === b.submittedBy;
  const act = async (path: string, key: string, json: unknown = {}) => {
    setBusy(key); setMsg(null);
    try {
      const r = await api<{ ledger?: { status: string; message?: string } | null }>(`/api/accounting/bills/${b.id}/${path}`, { method: "POST", json });
      if (r?.ledger && r.ledger.status !== "TRANSLATED") setMsg({ tone: "warn", text: L(`رُحّلت الفاتورة، والقيد ${EVENT_STATUS[r.ledger.status]?.ar ?? r.ledger.status}: ${explain(r.ledger.message)}`, `Bill posted; the journal is ${r.ledger.status.toLowerCase()}: ${r.ledger.message ?? ""}`) });
      setReason(""); reload();
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const cn = b.kind === "CREDIT_NOTE";
  const journal = (et: string) => { const ev = b.events.find((e) => e.eventType === et); return { ev, je: b.journals.find((j) => j.id === ev?.journalEntryId) }; };
  const posted = journal(cn ? "ap.credit_note.posted" : "ap.bill.posted");
  const reversed = journal(cn ? "ap.credit_note.reversed" : "ap.bill.reversed");
  // Supplier credit applications (POST …/credit-allocations, release …/{id}/release; duty ap_bill_post).
  const allocCall = async (key: string, url: string, json: unknown = {}) => {
    setBusy(key); setMsg(null);
    try {
      const r = await api<{ ledger?: { status: string; message?: string } | null }>(url, { method: "POST", json });
      if (r?.ledger && r.ledger.status !== "TRANSLATED") setMsg({ tone: "warn", text: L(`تم، والقيد ${EVENT_STATUS[r.ledger.status]?.ar ?? r.ledger.status}: ${explain(r.ledger.message)}`, `Done; the journal is ${r.ledger.status.toLowerCase()}: ${r.ledger.message ?? ""}`) });
      setApply({ billId: "", amount: "", allocatedOn: "" }); reload();
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const chosenOpen = b.openBills?.find((x) => x.id === apply.billId);
  const suggested = chosenOpen && b.creditLeft ? Math.min(Number(chosenOpen.open), Number(b.creditLeft)).toFixed(2) : "";
  const steps = [
    { title: L("أُعدّت كمسودة", "Drafted"), who: `${who(b.createdBy)} · ${when(b.createdAt)}`, state: "done" },
    { title: L("قُدّمت للاعتماد", "Submitted"), who: b.submittedBy ? `${who(b.submittedBy)} · ${when(b.submittedAt)}` : "", state: b.submittedBy || b.status !== "DRAFT" ? "done" : "todo" },
    { title: b.status === "SUBMITTED" ? L("بانتظار الاعتماد", "Awaiting approval") : L("اعتُمدت", "Approved"), who: b.approvedBy ? `${who(b.approvedBy)} · ${when(b.approvedAt)}` : L("أي معتمد عدا المُعِدّ", "Any approver except the preparer"), state: b.approvedBy ? "done" : b.status === "SUBMITTED" ? "now" : "todo" },
    { title: cn ? L("الترحيل: تخفيض الذمم وتسوية بنود المخزون", "Posted: payables reduced, stock lines settled") : L("الترحيل وإنشاء التزام الدفع", "Posted; payment obligation created"), who: b.postedBy ? `${who(b.postedBy)} · ${when(b.postedAt)}` : L("بعد الاعتماد", "After approval"), state: b.postedBy ? "done" : b.status === "APPROVED" ? "now" : "todo" },
  ];
  const dot = { done: "bg-green-600", now: "bg-amber-600", todo: "bg-gray-300" } as Record<string, string>;
  const reasonOk = reason.trim().length >= 5;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr] items-start">
      <Card className="order-2 lg:order-1">
        <CardTitle title={L("الاعتماد", "Approval")} sub={L("فصل المهام: من أعدّ الفاتورة لا يعتمدها", "Separation of duties: the preparer cannot approve")} />
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className={`mt-1.5 w-3 h-3 rounded-full flex-shrink-0 ${dot[s.state]}`} aria-hidden />
              <div><p className={`text-[13px] font-bold ${s.state === "todo" ? "text-brown" : "text-charcoal"}`}>{s.title}</p>{s.who && <p className="text-[11px] text-brown">{s.who}</p>}</div>
            </li>
          ))}
        </ol>
        {b.rejectedReason && b.status === "DRAFT" && <Notice tone="bad">{L(`رُفضت: ${b.rejectedReason} — ${who(b.rejectedBy)}`, `Rejected: ${b.rejectedReason} — ${who(b.rejectedBy)}`)}</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {b.status === "DRAFT" && can("ap_bill_create") && (
          <div className="flex gap-2 flex-wrap">
            <Button kind="primary" busy={busy === "submit"} disabled={!!busy} onClick={() => act("submit", "submit")} className="min-h-11">{L("تقديم للاعتماد", "Submit for approval")}</Button>
            <Link href={`/dashboard/accounting/payables/new?edit=${b.id}`}><Button className="min-h-11">{L("تعديل", "Edit")}</Button></Link>
            <Button kind="danger" disabled={!!busy} className="min-h-11" onClick={async () => { if (!confirm(L("حذف المسودة؟", "Delete the draft?"))) return; await api(`/api/accounting/bills/${b.id}`, { method: "DELETE" }); router.push("/dashboard/accounting/payables"); }}>{L("حذف", "Delete")}</Button>
          </div>
        )}
        {b.status === "SUBMITTED" && can("ap_bill_approve") && (mine
          ? <Notice tone="info">{L("أنت من أعدّ أو قدّم هذه الفاتورة؛ يعتمدها شخص آخر.", "You prepared or submitted this bill; someone else approves it.")}</Notice>
          : <>
            <Field label={L("سبب الرفض (مطلوب عند الرفض)", "Reason (required to reject)")} hint={L("5 أحرف على الأقل — يُحفظ في سجل التدقيق", "At least 5 characters — kept in the audit trail")}>
              <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button kind="primary" busy={busy === "approve"} disabled={!!busy} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("approve", "approve")}>{L("اعتماد", "Approve")}</Button>
              <Button kind="danger" busy={busy === "reject"} disabled={!!busy || !reasonOk} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("reject", "reject", { reason })}>{L("رفض وإرجاع كمسودة", "Reject to draft")}</Button>
            </div>
          </>)}
        {b.status === "APPROVED" && can("ap_bill_post") && <Button kind="primary" busy={busy === "post"} disabled={!!busy} className="min-h-11" onClick={() => act("post", "post")}>{cn ? L("ترحيل الإشعار", "Post the credit note") : L("ترحيل الفاتورة", "Post the bill")}</Button>}
        {!cn && b.status === "POSTED" && can("ap_bill_create") && Number(b.creditable) > 0 && <Link href={`/dashboard/accounting/payables/new?creditFor=${b.id}`}><Button className="min-h-11 w-full">{L("تسجيل إشعار دائن من المورد…", "Record a supplier credit note…")}</Button></Link>}
        {cn && b.status === "POSTED" && Number(b.creditLeft) > 0 && can("ap_bill_post") && (
          <div className="flex flex-col gap-2 border-t border-border-light pt-3">
            <p className="text-[13px] font-bold">{L(`رصيد غير مطبّق ${amt(b.creditLeft)} — تطبيقه على فاتورة مفتوحة للمورد`, `Unapplied credit ${amt(b.creditLeft)} — apply it to an open bill of the supplier`)}</p>
            {b.openBills.length === 0 ? <p className="text-[11px] text-brown">{L("لا فواتير مرحّلة مفتوحة لهذا المورد.", "The supplier has no open posted bills.")}</p> : <>
              <Field label={L("الفاتورة", "Bill")}>
                <select className={INPUT} value={apply.billId} onChange={(e) => setApply({ ...apply, billId: e.target.value })}>
                  <option value="">{L("اختر…", "Choose…")}</option>
                  {b.openBills.map((x) => <option key={x.id} value={x.id}>ف-{x.billNo} · {x.supplierInvoiceNo} · {L("مفتوح", "open")} {amt(x.open)}</option>)}
                </select>
              </Field>
              <Field label={L("المبلغ", "Amount")} hint={suggested ? L(`المقترح ${suggested}`, `Suggested ${suggested}`) : undefined}><input className={INPUT} dir="ltr" inputMode="decimal" placeholder={suggested} value={apply.amount} onChange={(e) => setApply({ ...apply, amount: e.target.value })} /></Field>
              <Field label={L("تاريخ التطبيق (اختياري)", "Applied on (optional)")} hint={L("افتراضياً: الأحدث من تاريخي الإشعار والفاتورة", "Default: the later of the credit note and bill dates")}><input type="date" className={INPUT} value={apply.allocatedOn} onChange={(e) => setApply({ ...apply, allocatedOn: e.target.value })} /></Field>
              <Button kind="primary" busy={busy === "apply"} disabled={!!busy || !apply.billId || !(apply.amount || suggested)} onClick={() => allocCall("apply", "/api/accounting/bills/credit-allocations", { creditNoteId: b.id, billId: apply.billId, amount: apply.amount || suggested, ...(apply.allocatedOn ? { allocatedOn: apply.allocatedOn } : {}) })}>{L("تطبيق الإشعار", "Apply the credit")}</Button>
              <p className="text-[11px] text-brown">{L("قيد تسوية داخل حساب الموردين (صافي صفر): يُخفّض المفتوح على الفاتورة دون حركة بنكية.", "A net-zero reclassification inside trade payables: it reduces what is open on the bill without a bank movement.")}</p>
            </>}
          </div>
        )}
        {b.status === "POSTED" && can("ap_bill_post") && (
          <details className="text-[13px]">
            <summary className="cursor-pointer font-bold text-red-700">{L("عكس الفاتورة…", "Reverse the bill…")}</summary>
            <div className="flex flex-col gap-2 mt-2">
              <Field label={L("السبب", "Reason")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button kind="danger" busy={busy === "reverse"} disabled={!!busy || !reasonOk} onClick={() => act("reverse", "reverse", { reason })}>{L("عكس بقيد مقابل", "Reverse with a mirror entry")}</Button>
              <p className="text-[11px] text-brown">{cn
                ? L("لا يُعكس إشعار سوّى مرتجعات أو خفّض سعر مخزون، ولا إشعار مطبّق على فواتير قبل إلغاء تطبيقه.", "A credit note that settled returns or repriced stock cannot be reversed, nor one applied to bills until the applications are released.")
                : L("لا تُعكس فاتورة عليها مدفوعات مطابقة أو إشعارات مطبّقة.", "A bill with matched payments or applied credits cannot be reversed.")}</p>
            </div>
          </details>
        )}
      </Card>

      <div className="flex flex-col gap-4 order-1 lg:order-2 min-w-0">
        <Card>
          <CardTitle title={`ف-${b.billNo} · ${b.supplier.name}`} sub={cn
              ? L(`إشعار المورد ${b.supplierInvoiceNo} · ${day(b.billDate)} · ${b.reason ?? ""}`, `Supplier credit note ${b.supplierInvoiceNo} · ${day(b.billDate)} · ${b.reason ?? ""}`)
              : L(`فاتورة المورد ${b.supplierInvoiceNo} · ${day(b.billDate)} · تستحق ${day(b.dueDate)}`, `Supplier invoice ${b.supplierInvoiceNo} · ${day(b.billDate)} · due ${day(b.dueDate)}`)}
            right={<BillStatus creditNote={cn} status={b.status} rejected={!!b.rejectedReason} remaining={b.obligation?.remaining} gross={b.totalGross} />} />
          {cn && b.originalBill && <p className="text-[13px]">{L("يُشعَر عن الفاتورة", "Credits bill")} <Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/payables/${b.originalBill.id}`}>ف-{b.originalBill.billNo}</Link> <span className="text-brown">· {b.originalBill.supplierInvoiceNo} · {amt(b.originalBill.totalGross)}</span></p>}
          <div className="flex gap-6 flex-wrap">
            {[[L("الإجمالي", "Total"), `${amt(b.totalGross)} ${L("ر.س", "SAR")}`], [L("الضريبة", "VAT"), amt(b.totalVat)], [L("الصافي", "Net"), amt(b.totalNet)],
              ...(cn && b.status === "POSTED" ? [[L("مطبّق", "Applied"), amt(b.creditApplied)], [L("غير مطبّق", "Unapplied"), amt(b.creditLeft)]] : []),
              ...(!cn && Number(b.creditApplied) > 0 ? [[L("إشعارات مطبّقة", "Credits applied"), amt(b.creditApplied)]] : [])].map(([l, v]) => (
              <div key={l}><p className="text-xs font-bold text-brown">{l}</p><p className="text-xl font-extrabold text-charcoal tabular-nums">{v}</p></div>
            ))}
            {!b.supplier.vatNumber && Number(b.totalVat) > 0 && <Badge tone="warn">{L("المورد بلا رقم ضريبي", "Supplier has no VAT number")}</Badge>}
          </div>
          <Table>
            <thead><tr><Th>#</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("الصافي", "Net")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th></tr></thead>
            <tbody>{b.lines.map((l) => (
              <tr key={l.lineNo}><Td>{l.lineNo}</Td><Td>{acc(l.account)}{LINE_KIND[l.kind] && <span className="block text-[11px] text-brown">{L(...LINE_KIND[l.kind])}{b.lineRefs?.[l.id] ? <> · <Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/inventory/documents/${b.lineRefs[l.id]!.documentId}`}>{b.lineRefs[l.id]!.label}</Link></> : null}</span>}</Td><Td>{l.description ?? "—"}<span className="block text-[11px] text-brown tabular-nums" dir="ltr">{Number(l.quantity)} × {Number(l.unitPrice)}{Number(l.vatRate) ? ` · ${Number(l.vatRate)}%` : ""}</span></Td><Td num>{amt(l.net)}</Td><Td num>{amt(l.vat)}</Td><Td num>{amt(l.gross)}</Td></tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle title={posted.je ? L(`القيد المرحّل #${posted.je.entryNo}`, `Posted journal #${posted.je.entryNo}`) : L("القيد الذي سيُرحَّل", "Journal it will post")}
            sub={cn ? L("يُنشأ آلياً عند الترحيل · مدين الموردين ودائن البنود والضريبة", "Created automatically on posting · Dr payables, Cr lines and VAT") : L("يُنشأ آلياً عند الترحيل · قيد واحد لكل فاتورة", "Created automatically on posting · one journal per bill")}
            right={posted.je ? <Link className="text-[13px] font-bold text-orange hover:underline" href={`/dashboard/accounting/journals/${posted.je.id}`}>{L("فتح القيد", "Open journal")}{posted.je.isProvisional ? L(" (مؤقت)", " (provisional)") : ""}</Link> : undefined} />
          {posted.ev && posted.ev.status !== "TRANSLATED" && <Notice tone="warn">{L(`حالة القيد: ${EVENT_STATUS[posted.ev.status]?.ar ?? posted.ev.status} — ${explain(posted.ev.errorMessage)}`, `Journal status: ${posted.ev.status.toLowerCase()} — ${posted.ev.errorMessage ?? ""}`)}</Notice>}
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th>{L("الطرف", "Party")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {b.preview.map((p, i) => <tr key={i}><Td>{acc(p.account)}</Td><Td>{p.party ?? "—"}</Td><Td num>{p.debit ? amt(p.debit) : ""}</Td><Td num>{p.credit ? amt(p.credit) : ""}</Td></tr>)}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("متوازن ✓", "Balanced ✓")}</Td><Td></Td><Td num>{amt(b.totalGross)}</Td><Td num>{amt(b.totalGross)}</Td></tr>
            </tbody>
          </Table>
          {b.purchaseObligation && <p className="text-xs text-brown">{L(`يحلّ محل التزام ${b.purchaseObligation.description} (${amt(b.purchaseObligation.amount)})`, `Replaces obligation ${b.purchaseObligation.description} (${amt(b.purchaseObligation.amount)})`)}</p>}
          {b.obligation && (
            <div className="flex items-center gap-2 flex-wrap text-[13px]">
              <Badge tone="brand">{L("التزام دفع", "Payment obligation")}</Badge>
              <span>{L(`المستحق ${amt(b.obligation.amount)} · المدفوع ${amt(b.obligation.paid)} · المتبقي ${amt(b.obligation.remaining)} · يستحق ${day(b.obligation.dueDate)}`, `Due ${amt(b.obligation.amount)} · paid ${amt(b.obligation.paid)} · remaining ${amt(b.obligation.remaining)} · on ${day(b.obligation.dueDate)}`)}</span>
            </div>
          )}
          {b.payments.length > 0 && (
            <Table>
              <thead><tr><Th>{L("تاريخ الدفعة", "Payment date")}</Th><Th>{L("مرجع البنك", "Bank reference")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
              <tbody>{b.payments.map((p) => <tr key={p.transactionId}><Td>{day(p.date)}</Td><Td>{p.reference ?? "—"}</Td><Td num>{amt(p.amount)}</Td></tr>)}</tbody>
            </Table>
          )}
          {reversed.je && <Notice tone="info">{L(`عُكست الفاتورة بالقيد #${reversed.je.entryNo}: ${b.reversalReason ?? ""}`, `Reversed by journal #${reversed.je.entryNo}: ${b.reversalReason ?? ""}`)}</Notice>}
        </Card>
        {cn && b.status !== "DRAFT" && b.lines.some((l) => l.kind === "STOCK_RETURN" || l.kind === "STOCK_PRICE_ADJUSTMENT") && (
          <Card>
            <CardTitle title={L("تسوية المخزون", "Stock settlement")} sub={L("مستند «إشعار دائن من مورد» لكل بند مخزون: يسوّي المرتجع أو يتتبّع تخفيض السعر عبر المخزون والإنتاج والمبيعات", "One “supplier credit” inventory document per stock line: settles the return or traces the price reduction through stock, production and sales")} />
            {b.settlements.length === 0
              ? <p className="text-[13px] text-brown">{b.status === "POSTED" ? L("لم تُنشأ مستندات التسوية بعد — تُنشأ عند الترحيل وتُعاد محاولتها عند التعثر.", "No settlement documents yet — they are made on posting and retried if they fail.") : L("تُنشأ عند ترحيل الإشعار.", "Made when the credit note posts.")}</p>
              : <Table>
                <thead><tr><Th>{L("المستند", "Document")}</Th><Th>{L("البند", "Line")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
                <tbody>{b.settlements.map((x) => <tr key={x.id}><Td><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/inventory/documents/${x.id}`}>#{x.docNo}</Link></Td><Td className="tabular-nums">{x.lineNo ?? "—"}</Td><Td className="whitespace-nowrap">{day(x.docDate)}</Td><Td><span title={x.ledger?.reason ?? undefined}><InvStatus status={x.status} ledger={x.ledger} provisional={x.provisional} /></span>{x.ledger?.reason && x.ledger.status !== "TRANSLATED" ? <span className="block text-[11px] text-brown">{explain(x.ledger.reason)}</span> : null}</Td></tr>)}</tbody>
              </Table>}
          </Card>
        )}
        {(b.creditAllocations.length > 0 || (!cn && b.creditNotes.length > 0)) && (
          <Card>
            <CardTitle title={cn ? L("تطبيق الإشعار على الفواتير", "Where the credit was applied") : L("إشعارات دائنة من المورد", "Supplier credit notes")} sub={L("التطبيقات لا تُحذف — تُلغى فقط بقيد مقابل", "Applications are never deleted — only released with a mirror entry")} />
            {b.creditAllocations.length > 0 && (
              <Table>
                <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{cn ? L("الفاتورة", "Bill") : L("الإشعار", "Credit note")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة", "Status")}</Th><Th></Th></tr></thead>
                <tbody>{b.creditAllocations.map((a) => (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap">{day(a.allocatedOn)}</Td>
                    <Td><Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/payables/${cn ? a.billId : a.creditNoteId}`}>ف-{a.counterpartNo ?? "?"}</Link></Td>
                    <Td num>{amt(a.amount)}</Td>
                    <Td>{a.active ? <Badge tone="ok">{L("قائم", "Active")}</Badge> : <Badge tone="info">{L("أُلغي", "Released")}</Badge>}</Td>
                    <Td>{a.active && can("ap_bill_post") && <Button kind="danger" busy={busy === "release" + a.id} disabled={!!busy} onClick={() => { if (confirm(L("إلغاء تطبيق الإشعار على هذه الفاتورة؟", "Release this credit application?"))) allocCall("release" + a.id, `/api/accounting/bills/credit-allocations/${a.id}/release`); }}>{L("إلغاء التطبيق", "Release")}</Button>}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
            {!cn && b.creditNotes.length > 0 && <p className="text-[13px]">{L("إشعارات المورد على هذه الفاتورة:", "Supplier credit notes against this bill:")} {b.creditNotes.map((c) => <Link key={c.id} className="font-bold text-orange hover:underline me-2 tabular-nums" href={`/dashboard/accounting/payables/${c.id}`}>ف-{c.billNo} ({amt(c.totalGross)}{c.status !== "POSTED" ? ` · ${L(...(({ DRAFT: ["مسودة", "draft"], SUBMITTED: ["بانتظار الاعتماد", "awaiting approval"], APPROVED: ["معتمد", "approved"], REVERSED: ["معكوس", "reversed"] } as Record<string, [string, string]>)[c.status] ?? [c.status, c.status]))}` : ""})</Link>)}</p>}
          </Card>
        )}
        <Card>
          <CardTitle title={L("سجل التدقيق", "Audit trail")} sub={L("لا يمكن تعديله أو حذفه", "Cannot be edited or deleted")} />
          <Table>
            <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("المستخدم", "User")}</Th><Th>{L("السبب", "Reason")}</Th></tr></thead>
            <tbody>{b.audit.map((a, i) => <tr key={i}><Td className="whitespace-nowrap">{when(a.createdAt)}</Td><Td>{({ "bill.create": L("إنشاء", "Create"), "bill.update": L("تعديل", "Edit"), "bill.submit": L("تقديم", "Submit"), "bill.approve": L("اعتماد", "Approve"), "bill.reject": L("رفض", "Reject"), "bill.post": L("ترحيل", "Post"), "bill.reverse": L("عكس", "Reverse"), "bill.credit_allocate": L("تطبيق إشعار", "Credit applied"), "bill.credit_release": L("إلغاء تطبيق إشعار", "Credit released") } as Record<string, string>)[a.action] ?? a.action}</Td><Td>{who(a.userId)}</Td><Td>{a.reason ?? "—"}</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
