"use client";

// «أعمار الذمم وكشوف العملاء» (the fourth tab of ZT-10): every customer's open invoices by days past due — current,
// 1–30, 31–60, 61–90, over 90 — with unapplied credit and the net balance; CSV export; each row opens the customer's
// statement. accounting › ar sees every customer, an invoices viewer the customers in their scope.
import Link from "next/link";
import { useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { InvShell, money, useApi, useLang, todayRiyadh } from "../invoices/_ui/inv";

type Row = { customerId: string; customer: { name: string; nameAr: string | null; creditLimit: string | null } | null; current: string; d1_30: string; d31_60: string; d61_90: string; d90p: string; totalOpen: string; unappliedCredit: string; balance: string; overdue: string; oldestOverdueDays: number };
type Data = { asOf: string; buckets: { key: string; ar: string; en: string }[]; rows: Row[]; totals: Record<string, string> };

export default function ReceivablesPage() {
  const { L } = useLang();
  const [asOf, setAsOf] = useState(todayRiyadh());
  const r = useApi<Data>(`/api/accounting/ar/aging?asOf=${asOf}`);
  const d = r.data;
  const keys = ["current", "d1_30", "d31_60", "d61_90", "d90p"] as const;
  return (
    <InvShell testId="ar-aging"
      meta={<span className="acct-meta"><span>{L("أعمار الذمم المدينة", "Receivables aging")}</span><span aria-hidden="true">·</span><span>{L("كما في", "as of")} <bdi className="hr-num">{asOf}</bdi></span></span>}
      actions={<a className="hr-btn" href={`/api/accounting/ar/aging?asOf=${asOf}&format=csv`} data-testid="aging-csv">{L("تصدير CSV", "Export CSV")}</a>}>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("كما في تاريخ", "As of")}</span><input type="date" className="hr-input" value={asOf} onChange={(e) => setAsOf(e.target.value || todayRiyadh())} data-testid="aging-asof" /></label>
      </div>
      {r.error ? <p role="alert" className="hr-err">{r.error}</p> : null}
      {!d ? <OpsLoading /> : d.rows.length === 0 ? <p className="acct-hint" data-testid="aging-empty">{L("لا ذمم مفتوحة.", "No open receivables.")}</p> : (
        <>
          <div className="acct-cards">
            <div className="acct-card"><span className="acct-hint">{L("إجمالي المستحق", "Total open")}</span><b className="hr-num" data-testid="aging-total">{money(d.totals.totalOpen)}</b></div>
            <div className="acct-card"><span className="acct-hint">{L("متأخر السداد", "Overdue")}</span><b className="hr-num inv-late">{money(d.totals.overdue)}</b></div>
            <div className="acct-card"><span className="acct-hint">{L("أرصدة دائنة غير مخصصة", "Unapplied credit")}</span><b className="hr-num">{money(d.totals.unappliedCredit)}</b></div>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense is-mrow inv-aging" data-testid="aging-table">
              <thead><tr><th>{L("العميل", "Customer")}</th>{d.buckets.map((b) => <th key={b.key} className="num inv-hide-m">{L(b.ar, b.en)}</th>)}<th className="num inv-hide-m">{L("رصيد دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.customerId} data-testid={`aging-row-${x.customerId}`}>
                    <td className="m-title"><Link href={`/dashboard/sales/receivables/${x.customerId}`}><bdi>{x.customer?.nameAr || x.customer?.name || x.customerId}</bdi></Link>
                      {x.oldestOverdueDays > 0 ? <span className="inv-sub inv-late">{L(`أقدم تأخير ${x.oldestOverdueDays} يومًا`, `Oldest ${x.oldestOverdueDays} days overdue`)}</span> : null}
                      <span className="hr-msub">{L("المتأخر", "Overdue")} {money(x.overdue)}</span></td>
                    {keys.map((k) => <td key={k} className="num hr-num inv-hide-m">{money(x[k], true) || "—"}</td>)}
                    <td className="num hr-num inv-hide-m">{money(x.unappliedCredit, true) || "—"}</td>
                    <td className="num hr-num m-end"><b>{money(x.balance)}</b></td>
                  </tr>
                ))}
                <tr className="is-total"><td>{L("الإجمالي", "Total")}</td>{keys.map((k) => <td key={k} className="num hr-num inv-hide-m">{money(d.totals[k])}</td>)}<td className="num hr-num inv-hide-m">{money(d.totals.unappliedCredit)}</td><td className="num hr-num">{money(d.totals.balance)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </InvShell>
  );
}
