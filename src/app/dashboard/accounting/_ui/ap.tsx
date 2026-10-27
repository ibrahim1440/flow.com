"use client";

// Accounting A3 — the AP list of «الذمم الدائنة» (accounting):
//   InvoiceList   — Figma ACC-50: the metric strip, status chips, the list (overdue in red).
// The invoice itself (entry, detail, approval) is the one-step «فاتورة مشتريات» of the purchases screen since
// unified inventory phase 2 (src/app/dashboard/purchases/_parts/invoice-form.tsx).
import Link from "next/link";
import { useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { money, todayRiyadh, useApi, useLang } from "./shell";

export type InvoiceRow = { id: string; number: string; supplierName: string; supplierRef: string; invoiceDate: string; dueDate: string; status: string; grossTotal: string; paidTotal: string; outstanding: string; overdueDays: number };
type List = { rows: InvoiceRow[]; summary: Record<string, { count: number; gross: string; outstanding: string }>; can: { draft: boolean; ap: boolean }; viewer: { id: string }; simpleMode: boolean };

export const INV_STATUS: Record<string, [string, string, string]> = {
  DRAFT: ["مسودة", "Draft", "neutral"], SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warning"], POSTED: ["مرحّلة", "Posted", "success"], CANCELLED: ["ملغاة", "Cancelled", "cancelled"],
};

export function InvoiceList({ base }: { base: string }) {
  const { L } = useLang();
  const [status, setStatus] = useState<string>("");
  const list = useApi<List>(`/api/accounting/ap/invoices${status ? `?status=${status}` : ""}`);
  const all = useApi<List>("/api/accounting/ap/invoices");
  const s = all.data?.summary ?? {};
  const today = todayRiyadh();
  const posted = all.data?.rows.filter((r) => r.status === "POSTED") ?? [];
  const due7 = posted.filter((r) => Number(r.outstanding) > 0 && r.dueDate <= new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)).reduce((a, r) => a + Number(r.outstanding), 0);
  const st = (v: string) => { const e = INV_STATUS[v]; return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : v}</span></span>; };
  if (list.error) return <p role="alert" className="hr-err">{list.error}</p>;
  return (
    <>
      <div className="acct-metrics" data-testid="ap-metrics">
        <div className="acct-metric"><span className="k">{L("بانتظار الاعتماد", "Awaiting approval")}</span><span className="v">{money(s.SUBMITTED?.gross ?? "0")}</span><span className="s">{L(`${s.SUBMITTED?.count ?? 0} فاتورة`, `${s.SUBMITTED?.count ?? 0} invoices`)}</span></div>
        <div className="acct-metric"><span className="k">{L("مرحّلة مفتوحة", "Posted, open")}</span><span className="v" data-testid="ap-open">{money(s.POSTED?.outstanding ?? "0")}</span><span className="s">{L(`${s.POSTED?.count ?? 0} فواتير`, `${s.POSTED?.count ?? 0} invoices`)}</span></div>
        <div className="acct-metric"><span className="k">{L("مستحقة خلال 7 أيام", "Due within 7 days")}</span><span className="v">{money(due7)}</span><span className="s"><Link href="/dashboard/accounting/ap?view=aging">{L("أعمار الدائنين", "AP aging")}</Link></span></div>
        <div className="acct-metric"><span className="k">{L("مسودات", "Drafts")}</span><span className="v">{s.DRAFT?.count ?? 0}</span><span className="s">{L("لم تُقدَّم بعد", "Not submitted yet")}</span></div>
      </div>
      <div className="acct-row">
        <div className="acct-chips" role="group" aria-label={L("الحالة", "Status")}>
          {[["", L("الكل", "All")], ["DRAFT", L("مسودة", "Draft")], ["SUBMITTED", L("بانتظار الاعتماد", "Awaiting approval")], ["POSTED", L("مرحّلة", "Posted")], ["CANCELLED", L("ملغاة", "Cancelled")]].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{label} <span className="hr-num acct-hint">{k ? s[k]?.count ?? 0 : all.data?.rows.length ?? 0}</span></button>
          ))}
        </div>
      </div>
      {!list.data ? <OpsLoading /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="ap-invoices">
            <thead><tr><th>{L("الفاتورة", "Invoice")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("فاتورة المورد", "Supplier ref")}</th><th className="acct-hide-m">{L("التاريخ", "Date")}</th><th className="acct-hide-m">{L("الاستحقاق", "Due")}</th><th className="num">{L("الإجمالي", "Gross")}</th><th className="num">{L("المتبقي", "Open")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {list.data.rows.map((r) => (
                <tr key={r.id} className={r.status === "SUBMITTED" ? "is-header" : undefined}>
                  <td><Link className="acct-code" href={`${base}/${r.id}`}>{r.number}</Link></td>
                  <td>{r.supplierName}</td><td className="acct-hide-m acct-code">{r.supplierRef}</td>
                  <td className="acct-hide-m hr-num">{r.invoiceDate}</td><td className="acct-hide-m hr-num">{r.dueDate}</td>
                  <td className="num hr-num">{money(r.grossTotal)}</td>
                  <td className="num hr-num">{r.status === "POSTED" ? money(r.outstanding) : "—"}</td>
                  <td>{r.overdueDays > 0 ? <span className="hr-dot tone-danger"><span>{L(`متأخرة ${r.overdueDays} يومًا`, `${r.overdueDays} days overdue`)}</span></span> : st(r.status)}</td>
                </tr>
              ))}
              {!list.data.rows.length ? <tr><td colSpan={8} className="acct-hint">{L("لا فواتير.", "No invoices.")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="acct-hint">{L("فاتورة المشتريات تُدخَل من «المشتريات»: «حفظ واستلام» يستلم البضاعة ويقدّمها للاعتماد؛ يعتمدها ويرحّلها محاسب آخر وفق إعداد فصل المهام. السداد يُسجَّل من «الذمم الدائنة › المدفوعات».", "Purchase invoices are entered under «Purchases»: «Save and receive» receives the goods and submits the bill; another accountant approves and posts it as the segregation-of-duties setting says. Payments are recorded under «Payables › Payments».")}</p>
    </>
  );
}
