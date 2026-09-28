"use client";

// Figma: ACC-30 (desktop) and ACC-36 (mobile approval). Sales invoices and credit notes: status
// segments with counts, search, aging chips tied to the receivables control account.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, BarChart3, Landmark } from "lucide-react";
import { api, ApiError, Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { BillStatus, Pager, docNo, useAmount, useCan, useDay } from "../_components/kit";

type Row = { id: string; invoiceNo: number; kind: "INVOICE" | "CREDIT_NOTE"; customer: string; customerHasVat: boolean; orderNumber: number | null; originalInvoiceNo: number | null;
  issueDate: string; dueDate: string; status: string; totalNet: string; totalVat: string; totalGross: string; open: string | null; rejectedReason: string | null; overdueDays: number };
type List = { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number> };
type Aging = { totals: Record<string, string>; subledger: string; ledger: string | null; difference: string | null; reconciled: boolean };
type Seg = "ALL" | "DRAFT" | "PENDING" | "POSTED" | "OVERDUE";

export default function ReceivablesPage() {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const { can } = useCan();
  const sp = useSearchParams();
  const [seg, setSegRaw] = useState<Seg>(() => (sp.get("status") === "PENDING" ? "PENDING" : "ALL"));
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [page, setPage] = useState(1);
  const setSeg = (v: Seg) => { setSegRaw(v); setPage(1); };
  useEffect(() => { const t = setTimeout(() => { setQd(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (seg !== "ALL") params.set("status", seg);
  if (qd) params.set("q", qd);
  const { data, error, loading, reload } = useApi<List>(`/api/accounting/receivables/invoices?${params}`);
  const aging = useApi<Aging>("/api/accounting/reports/ar-aging");
  const c = data?.counts ?? {};
  const n = (k: string) => c[k] ?? 0;

  return (
    <Card>
      <div className="flex items-center gap-3 flex-wrap justify-between">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("بحث", "Search")}><input className={`${INPUT} min-w-[240px]`} placeholder={L("العميل أو رقم الفاتورة…", "Customer or invoice number…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Segmented<Seg> value={seg} onChange={setSeg} options={[
            { value: "ALL", label: L("الكل", "All") },
            { value: "DRAFT", label: L(`مسودات · ${n("DRAFT")}`, `Drafts · ${n("DRAFT")}`) },
            { value: "PENDING", label: L(`بانتظار الاعتماد · ${n("SUBMITTED") + n("APPROVED")}`, `Awaiting approval · ${n("SUBMITTED") + n("APPROVED")}`) },
            { value: "POSTED", label: L(`مرحّلة · ${n("POSTED")}`, `Posted · ${n("POSTED")}`) },
            { value: "OVERDUE", label: L(`متأخرة · ${n("OVERDUE")}`, `Overdue · ${n("OVERDUE")}`) },
          ]} />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/dashboard/accounting/receivables/receipts"><Button icon={Landmark}>{L("تحصيلات العملاء", "Customer receipts")}</Button></Link>
          <Link href="/dashboard/accounting/receivables/aging"><Button icon={BarChart3}>{L("الأعمار وكشف الحساب", "Aging & statements")}</Button></Link>
          {can("ar_invoice_create") && <Link href="/dashboard/accounting/receivables/new"><Button kind="primary" icon={Plus}>{L("فاتورة مبيعات", "Sales invoice")}</Button></Link>}
        </div>
      </div>
      {aging.data && (
        <div className="flex items-center gap-2 flex-wrap text-[13px]" aria-label={L("أعمار الذمم المدينة", "Receivables aging")}>
          <span className="font-extrabold text-charcoal">{L("المستحق من العملاء:", "Owed by customers:")} {amt(aging.data.subledger)} {L("ر.س", "SAR")}</span>
          <Badge tone="ok">{L("غير مستحقة", "Not due")} {amt(aging.data.totals.current)}</Badge>
          <Badge tone={Number(aging.data.totals.d1_30) > 0 ? "bad" : "info"}>{L("1–30 يوماً", "1–30 days")} {amt(aging.data.totals.d1_30)}</Badge>
          <Badge tone={Number(aging.data.totals.d31_60) > 0 ? "bad" : "info"}>{L("31–60 يوماً", "31–60 days")} {amt(aging.data.totals.d31_60)}</Badge>
          <Badge tone={Number(aging.data.totals.d61_90) + Number(aging.data.totals.d90p) > 0 ? "bad" : "info"}>{L("أكثر من 60 يوماً", "Over 60 days")} {amt(String(Number(aging.data.totals.d61_90) + Number(aging.data.totals.d90p)))}</Badge>
          {aging.data.reconciled
            ? <span className="text-green-700 font-bold text-xs">{L("يطابق رصيد حساب الذمم المدينة ✓", "Agrees to the receivables account ✓")}</span>
            : <span className="text-red-700 font-bold text-xs">{L(`فرق مع دفتر الأستاذ: ${amt(aging.data.difference)} — انظر الأعمار`, `Difference with the ledger: ${amt(aging.data.difference)} — see aging`)}</span>}
        </div>
      )}
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <LoadingState /> : data.rows.length === 0 ? (
        <EmptyState title={L("لا توجد مستندات بهذه الشروط", "No documents match")} body={L("غيّر التصفية أو أنشئ فاتورة مبيعات.", "Change the filters or create a sales invoice.")} />
      ) : (
        <div aria-busy={loading}>
          <MobileDocs rows={data.rows} onDone={reload} />
          <div className="hidden md:block">
          <Table>
            <thead><tr>
              <Th>{L("رقم", "No.")}</Th><Th>{L("العميل", "Customer")}</Th><Th>{L("الطلب / الأصل", "Order / original")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الاستحقاق", "Due")}</Th>
              <Th num>{L("الصافي", "Net")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th num>{L("المتبقي", "Open")}</Th><Th>{L("الحالة", "Status")}</Th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-cream/40">
                  <Td><a className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/receivables/${r.id}`}>{docNo(r)}</a></Td>
                  <Td>{r.customer}{!r.customerHasVat && <span className="ms-1 text-[11px] font-bold text-brown">{L("(مبسطة)", "(simplified)")}</span>}</Td>
                  <Td className="tabular-nums">{r.kind === "CREDIT_NOTE" ? `INV-${r.originalInvoiceNo}` : r.orderNumber ? L(`طلب ${r.orderNumber}`, `Order ${r.orderNumber}`) : "—"}</Td>
                  <Td className="whitespace-nowrap">{day(r.issueDate)}</Td>
                  <Td className={`whitespace-nowrap ${r.overdueDays > 0 ? "text-red-700 font-bold" : ""}`}>{r.kind === "CREDIT_NOTE" ? "—" : day(r.dueDate)}</Td>
                  <Td num>{amt(r.totalNet)}</Td><Td num>{amt(r.totalVat)}</Td><Td num>{amt(r.totalGross)}</Td>
                  <Td num className={r.overdueDays > 0 ? "text-red-700 font-bold" : ""}>{r.open === null ? "—" : amt(r.open)}</Td>
                  <Td><span title={r.rejectedReason ?? undefined}><BillStatus sales creditNote={r.kind === "CREDIT_NOTE"} status={r.status} rejected={!!r.rejectedReason} remaining={r.open} gross={r.totalGross} overdueDays={r.overdueDays} /></span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          </div>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <p className="text-xs text-brown">{L("التحصيل لا يُسجَّل هنا: يُسنَد سطر البنك إلى العميل فيُرحَّل مرة واحدة (مدين البنك / دائن الذمم المدينة، والزيادة دفعة مقدمة). العمولات تبقى من تحصيلات المبيعات المعتمدة ولا تتكرر.", "Collections are not entered here: the bank line is assigned to the customer and posts once (Dr bank / Cr receivables, any excess an advance). Commissions stay with approved sales collections and are not duplicated.")}</p>
    </Card>
  );
}

/** Figma ACC-36: below 768 px the list is cards; documents awaiting approval can be approved or
 *  rejected (with a reason) in place. The server still enforces four-eyes and permissions. */
function MobileDocs({ rows, onDone }: { rows: Row[]; onDone: () => void }) {
  const { L } = useL();
  const day = useDay();
  const amt = useAmount();
  const { can } = useCan();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (id: string, path: string, json: unknown = {}) => {
    setBusy(id + path); setMsg(null);
    try { await api(`/api/accounting/receivables/invoices/${id}/${path}`, { method: "POST", json }); setRejecting(null); setReason(""); onDone(); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
    setBusy("");
  };
  return (
    <div className="md:hidden flex flex-col gap-3">
      {msg && <Notice tone="bad">{msg}</Notice>}
      {rows.map((r) => (
        <article key={r.id} className="bg-white border border-border rounded-2xl p-4 flex flex-col gap-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <a className="font-bold text-orange tabular-nums" href={`/dashboard/accounting/receivables/${r.id}`}>{docNo(r)}</a>
            <BillStatus sales creditNote={r.kind === "CREDIT_NOTE"} status={r.status} rejected={!!r.rejectedReason} remaining={r.open} gross={r.totalGross} overdueDays={r.overdueDays} />
          </div>
          <p className="font-extrabold text-charcoal">{r.customer}{r.orderNumber ? ` · ${L("طلب", "order")} ${r.orderNumber}` : ""}{r.originalInvoiceNo ? ` · INV-${r.originalInvoiceNo}` : ""}</p>
          <p className="text-2xl font-extrabold text-charcoal tabular-nums">{amt(r.totalGross)} {L("ر.س", "SAR")}</p>
          <p className="text-xs text-brown">{day(r.issueDate)}{r.kind === "INVOICE" ? ` · ${L("تستحق", "due")} ${day(r.dueDate)}` : ""}</p>
          <div className="flex justify-between text-[13px] border-t border-border-light pt-2"><span>{L("الصافي", "Net")} {amt(r.totalNet)}</span><span>{L("الضريبة", "VAT")} {amt(r.totalVat)}</span></div>
          {r.status === "SUBMITTED" && can("ar_invoice_approve") && (rejecting === r.id ? (
            <div className="flex flex-col gap-2">
              <Field label={L("سبب الرفض", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")}><input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="flex gap-2"><Button kind="danger" className="min-h-11 flex-1" disabled={reason.trim().length < 5} busy={busy === r.id + "reject"} onClick={() => act(r.id, "reject", { reason })}>{L("تأكيد الرفض", "Confirm rejection")}</Button><Button className="min-h-11 flex-1" onClick={() => setRejecting(null)}>{L("إلغاء", "Cancel")}</Button></div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button kind="primary" className="min-h-11 flex-1" busy={busy === r.id + "approve"} onClick={() => act(r.id, "approve")}>{L("اعتماد", "Approve")}</Button>
              <Button kind="danger" className="min-h-11 flex-1" onClick={() => { setRejecting(r.id); setReason(""); }}>{L("رفض…", "Reject…")}</Button>
            </div>
          ))}
        </article>
      ))}
      <p className="text-[11px] text-brown">{L("الأزرار بحجم لمس 44 بكسل على الأقل. الرفض يطلب سبباً. من أعدّ المستند لا يستطيع اعتماده.", "Buttons are at least 44 px. Rejection asks for a reason. The preparer cannot approve.")}</p>
    </div>
  );
}
