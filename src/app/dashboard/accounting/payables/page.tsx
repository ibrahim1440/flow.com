"use client";

// Figma: ACC-20. Supplier bills: status segments with counts, search, aging chips tied to the
// payables control account, paid / part-paid / overdue shown on each posted bill.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, BarChart3 } from "lucide-react";
import { api, ApiError, Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { BillStatus, Pager, useAmount, useCan, useDay } from "../_components/kit";

type Row = { id: string; billNo: number; supplier: string; supplierHasVat: boolean; supplierInvoiceNo: string; billDate: string; dueDate: string; status: string; totalNet: string; totalVat: string; totalGross: string; remaining: string | null; rejectedReason: string | null; overdueDays: number };
type List = { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number> };
type Aging = { totals: Record<string, string>; subledger: string; ledger: string | null; difference: string | null; reconciled: boolean };
type Seg = "ALL" | "DRAFT" | "PENDING" | "POSTED" | "OVERDUE";

export default function PayablesPage() {
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
  const { data, error, loading, reload } = useApi<List>(`/api/accounting/bills?${params}`);
  const aging = useApi<Aging>("/api/accounting/reports/ap-aging");
  const c = data?.counts ?? {};
  const n = (k: string) => c[k] ?? 0;

  return (
    <Card>
      <div className="flex items-center gap-3 flex-wrap justify-between">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("بحث", "Search")}><input className={`${INPUT} min-w-[240px]`} placeholder={L("المورد أو رقم الفاتورة…", "Supplier or invoice number…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Segmented<Seg> value={seg} onChange={setSeg} options={[
            { value: "ALL", label: L("الكل", "All") },
            { value: "DRAFT", label: L(`مسودات · ${n("DRAFT")}`, `Drafts · ${n("DRAFT")}`) },
            { value: "PENDING", label: L(`بانتظار الاعتماد · ${n("SUBMITTED") + n("APPROVED")}`, `Awaiting approval · ${n("SUBMITTED") + n("APPROVED")}`) },
            { value: "POSTED", label: L(`مرحّلة · ${n("POSTED")}`, `Posted · ${n("POSTED")}`) },
            { value: "OVERDUE", label: L(`متأخرة · ${n("OVERDUE")}`, `Overdue · ${n("OVERDUE")}`) },
          ]} />
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/accounting/payables/aging"><Button icon={BarChart3}>{L("أعمار الذمم وكشف الحساب", "Aging & statements")}</Button></Link>
          {can("ap_bill_create") && <Link href="/dashboard/accounting/payables/new"><Button kind="primary" icon={Plus}>{L("فاتورة مورد", "Supplier bill")}</Button></Link>}
        </div>
      </div>
      {aging.data && (
        <div className="flex items-center gap-2 flex-wrap text-[13px]" aria-label={L("أعمار الذمم الدائنة", "Payables aging")}>
          <span className="font-extrabold text-charcoal">{L("الرصيد المستحق للموردين:", "Owed to suppliers:")} {amt(aging.data.subledger)} {L("ر.س", "SAR")}</span>
          <Badge tone="ok">{L("غير مستحقة", "Not due")} {amt(aging.data.totals.current)}</Badge>
          <Badge tone={Number(aging.data.totals.d1_30) > 0 ? "bad" : "info"}>{L("1–30 يوماً", "1–30 days")} {amt(aging.data.totals.d1_30)}</Badge>
          <Badge tone={Number(aging.data.totals.d31_60) > 0 ? "bad" : "info"}>{L("31–60 يوماً", "31–60 days")} {amt(aging.data.totals.d31_60)}</Badge>
          <Badge tone={Number(aging.data.totals.d61_90) + Number(aging.data.totals.d90p) > 0 ? "bad" : "info"}>{L("أكثر من 60 يوماً", "Over 60 days")} {amt(String(Number(aging.data.totals.d61_90) + Number(aging.data.totals.d90p)))}</Badge>
          {aging.data.reconciled
            ? <span className="text-green-700 font-bold text-xs">{L("يطابق رصيد حساب الذمم الدائنة ✓", "Agrees to the payables account ✓")}</span>
            : <span className="text-red-700 font-bold text-xs">{L(`فرق مع دفتر الأستاذ: ${amt(aging.data.difference)} — انظر التفاصيل`, `Difference with the ledger: ${amt(aging.data.difference)} — see details`)}</span>}
        </div>
      )}
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <LoadingState /> : data.rows.length === 0 ? (
        <EmptyState title={L("لا توجد فواتير بهذه الشروط", "No bills match")} body={L("غيّر التصفية أو أضف فاتورة مورد.", "Change the filters or add a supplier bill.")} />
      ) : (
        <div aria-busy={loading}>
          <MobileBills rows={data.rows} onDone={reload} />
          <div className="hidden md:block">
          <Table>
            <thead><tr>
              <Th>{L("رقم", "No.")}</Th><Th>{L("المورد", "Supplier")}</Th><Th>{L("فاتورة المورد", "Supplier invoice")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الاستحقاق", "Due")}</Th>
              <Th num>{L("الصافي", "Net")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th num>{L("المتبقي", "Remaining")}</Th><Th>{L("الحالة", "Status")}</Th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-cream/40">
                  <Td><a className="font-bold text-orange hover:underline" href={`/dashboard/accounting/payables/${r.id}`}>ف-{r.billNo}</a></Td>
                  <Td>{r.supplier}{!r.supplierHasVat && <span className="ms-1 text-[11px] font-bold text-amber-700">{L("(بلا رقم ضريبي)", "(no VAT no.)")}</span>}</Td>
                  <Td className="tabular-nums">{r.supplierInvoiceNo}</Td>
                  <Td className="whitespace-nowrap">{day(r.billDate)}</Td>
                  <Td className={`whitespace-nowrap ${r.overdueDays > 0 ? "text-red-700 font-bold" : ""}`}>{day(r.dueDate)}</Td>
                  <Td num>{amt(r.totalNet)}</Td><Td num>{amt(r.totalVat)}</Td><Td num>{amt(r.totalGross)}</Td>
                  <Td num className={r.overdueDays > 0 ? "text-red-700 font-bold" : ""}>{r.remaining === null ? "—" : amt(r.remaining)}</Td>
                  <Td><span title={r.rejectedReason ?? undefined}><BillStatus status={r.status} rejected={!!r.rejectedReason} remaining={r.remaining} gross={r.totalGross} overdueDays={r.overdueDays} /></span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          </div>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <p className="text-xs text-brown">{L("الدفع لا يُسجَّل هنا: يُطابَق سطر البنك بالتزام الفاتورة في وحدة المالية فيُرحَّل مرة واحدة (مدين ذمم دائنة / دائن البنك).", "Payments are not entered here: the bank line is matched to the bill's obligation in Finance and posts once (Dr payables / Cr bank).")}</p>
    </Card>
  );
}

/** Figma ACC-26: below 768 px the list is cards; bills awaiting approval can be approved or
 *  rejected (with a reason) in place. The server still enforces four-eyes and permissions. */
function MobileBills({ rows, onDone }: { rows: Row[]; onDone: () => void }) {
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
    try { await api(`/api/accounting/bills/${id}/${path}`, { method: "POST", json }); setRejecting(null); setReason(""); onDone(); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
    setBusy("");
  };
  return (
    <div className="md:hidden flex flex-col gap-3">
      {msg && <Notice tone="bad">{msg}</Notice>}
      {rows.map((r) => (
        <article key={r.id} className="bg-white border border-border rounded-2xl p-4 flex flex-col gap-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <a className="font-bold text-orange" href={`/dashboard/accounting/payables/${r.id}`}>ف-{r.billNo}</a>
            <BillStatus status={r.status} rejected={!!r.rejectedReason} remaining={r.remaining} gross={r.totalGross} overdueDays={r.overdueDays} />
          </div>
          <p className="font-extrabold text-charcoal">{r.supplier} · <span className="tabular-nums">{r.supplierInvoiceNo}</span></p>
          <p className="text-2xl font-extrabold text-charcoal tabular-nums">{amt(r.totalGross)} {L("ر.س", "SAR")}</p>
          <p className="text-xs text-brown">{day(r.billDate)} · {L("تستحق", "due")} {day(r.dueDate)}</p>
          <div className="flex justify-between text-[13px] border-t border-border-light pt-2"><span>{L("الصافي", "Net")} {amt(r.totalNet)}</span><span>{L("الضريبة", "VAT")} {amt(r.totalVat)}</span></div>
          {!r.supplierHasVat && Number(r.totalVat) > 0 && <p className="text-xs font-bold text-amber-800">{L("المورد بلا رقم ضريبي", "Supplier has no VAT number")}</p>}
          {r.status === "SUBMITTED" && can("ap_bill_approve") && (rejecting === r.id ? (
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
      <p className="text-[11px] text-brown">{L("الأزرار بحجم لمس 44 بكسل على الأقل. الرفض يطلب سبباً. من أعدّ الفاتورة لا يستطيع اعتمادها.", "Buttons are at least 44 px. Rejection asks for a reason. The preparer cannot approve.")}</p>
    </div>
  );
}
