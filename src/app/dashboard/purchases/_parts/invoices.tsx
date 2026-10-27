"use client";
// «الفواتير» — the purchases screen's default tab (phase 2): every purchase invoice with its status (مسودة · بانتظار
// الاعتماد · معتمدة · ملغاة), net, VAT, total, paid and remaining; filters by status, supplier and period, a search
// and the CSV of the same view. GET /api/purchases/invoices (the AP read gate).
import Link from "next/link";
import { useMemo, useState } from "react";
import { FilterChip, Notice, OpsLoading } from "@/components/ops/ui";
import { DownloadIcon } from "../../inventory/_parts/shared";
import { money, todayRiyadh, useApi, useLang } from "../../accounting/_ui/shell";

export type PurchaseCan = { draft: boolean; ap: boolean; receive: boolean; inventory: boolean; read: boolean; suppliers: boolean; changeReceived?: boolean };
export type InvoiceListRow = {
  id: string; number: string; supplierId: string; supplierName: string; supplierRef: string; invoiceDate: string; dueDate: string; status: string; received: boolean;
  netTotal: string; vatTotal: string; grossTotal: string; paidTotal: string; outstanding: string; overdueDays: number;
};
type ListResponse = { rows: InvoiceListRow[]; summary: Record<string, { count: number; gross: string; outstanding: string }>; can: PurchaseCan; sodSelfAllowed: boolean; simpleMode: boolean; viewer: { id: string } };

/** The statuses as the accountant reads them. */
export const PI_STATUS: Record<string, [string, string, string]> = {
  DRAFT: ["مسودة", "Draft", "neutral"],
  SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warning"],
  POSTED: ["معتمدة", "Approved", "success"],
  CANCELLED: ["ملغاة", "Cancelled", "cancelled"],
};

const PERIODS = ["30", "90", "365"] as const;
const minusDays = (n: number) => new Date(Date.parse(todayRiyadh()) - n * 86_400_000).toISOString().slice(0, 10);

export function InvoicesTab({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  const { L, lang } = useLang();
  const [status, setStatus] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [period, setPeriod] = useState<string>("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ ...(status ? { status } : {}), ...(supplierId ? { supplierId } : {}), ...(period ? { from: minusDays(Number(period)) } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const list = useApi<ListResponse>(`/api/purchases/invoices${params ? `?${params}` : ""}`);
  const all = useApi<ListResponse>("/api/purchases/invoices");
  const s = all.data?.summary ?? {};
  const today = todayRiyadh();
  const due7 = useMemo(() => (all.data?.rows ?? []).filter((r) => r.status === "POSTED" && Number(r.outstanding) > 0 && r.dueDate <= minusDays(-7)).reduce((a, r) => a + Number(r.outstanding), 0), [all.data]);
  const overdue = (all.data?.rows ?? []).filter((r) => r.status === "POSTED" && Number(r.outstanding) > 0 && r.dueDate < today).length;
  const rows = list.data?.rows ?? [];
  const tot = rows.filter((r) => r.status !== "CANCELLED").reduce((a, r) => ({ net: a.net + Number(r.netTotal), vat: a.vat + Number(r.vatTotal), gross: a.gross + Number(r.grossTotal), paid: a.paid + Number(r.paidTotal), open: a.open + (r.status === "POSTED" ? Number(r.outstanding) : 0) }), { net: 0, vat: 0, gross: 0, paid: 0, open: 0 });
  const st = (r: InvoiceListRow) => {
    if (r.overdueDays > 0) return <span className="hr-dot tone-danger"><span>{L(`متأخرة ${r.overdueDays} يومًا`, `${r.overdueDays} days overdue`)}</span></span>;
    const e = PI_STATUS[r.status];
    return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : r.status}</span></span>;
  };
  const periodLabel = (p: string) => (p === "365" ? L("آخر سنة", "Last year") : lang === "ar" ? `آخر ${p} يومًا` : `Last ${p} days`);
  if (list.error && !list.data) return <Notice tone="danger">{list.error}</Notice>;
  return (
    <div className="hr-stack pur-tab" data-testid="invoices-tab">
      <div className="acct-metrics" data-testid="pi-metrics">
        <div className="acct-metric"><span className="k">{L("بانتظار الاعتماد", "Awaiting approval")}</span><span className="v">{money(s.SUBMITTED?.gross ?? "0")}</span><span className="s">{L(`${s.SUBMITTED?.count ?? 0} فاتورة`, `${s.SUBMITTED?.count ?? 0} invoices`)}</span></div>
        <div className="acct-metric"><span className="k">{L("المتبقي للموردين", "Owed to suppliers")}</span><span className="v" data-testid="pi-open">{money(s.POSTED?.outstanding ?? "0")}</span><span className="s">{overdue ? <span className="acct-bad">{L(`${overdue} متأخرة`, `${overdue} overdue`)}</span> : L("لا متأخرات", "Nothing overdue")}</span></div>
        <div className="acct-metric"><span className="k">{L("مستحق خلال 7 أيام", "Due within 7 days")}</span><span className="v">{money(due7)}</span><span className="s">{L("ريال سعودي · شامل الضريبة", "SAR · VAT inclusive")}</span></div>
        <div className="acct-metric"><span className="k">{L("مسودات", "Drafts")}</span><span className="v">{s.DRAFT?.count ?? 0}</span><span className="s">{L("لم تُستلم ولم تُقدَّم", "Not received or submitted")}</span></div>
      </div>
      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" placeholder={L("رقم الفاتورة أو المورد أو رقم فاتورة المورد", "Invoice no., supplier or supplier ref")} aria-label={L("بحث في الفواتير", "Search invoices")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="pi-search" />
        <FilterChip label={L("الحالة", "Status")} value={status} onChange={setStatus} allLabel={L("كل الحالات", "All statuses")}
          options={Object.entries(PI_STATUS).map(([k, v]) => ({ value: k, label: `${L(v[0], v[1])} · ${s[k]?.count ?? 0}` }))} />
        <FilterChip label={L("المورد", "Supplier")} value={supplierId} onChange={setSupplierId} allLabel={L("كل الموردين", "All suppliers")} options={suppliers.map((x) => ({ value: x.id, label: x.name }))} />
        <FilterChip label={L("الفترة", "Period")} value={period} onChange={setPeriod} allLabel={L("كل الفترات", "All time")} options={PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))} />
        <span className="stk-end"><a className="hr-btn is-ghost" href={`/api/purchases/invoices/export${params ? `?${params}` : ""}`} download data-testid="pi-export"><DownloadIcon />{L("تصدير CSV", "Export CSV")}</a></span>
      </div>
      {!list.data ? <OpsLoading /> : rows.length === 0 ? (
        <div className="hr-state"><h3>{status || supplierId || period || q ? L("لا نتائج لهذا البحث.", "No results for this search.") : L("لا فواتير مشتريات بعد.", "No purchase invoices yet.")}</h3>
          {!(status || supplierId || period || q) ? <p className="hr-caption">{L("ابدأ بـ «+ فاتورة مشتريات»: تستلم البضاعة وتسجّل الفاتورة في خطوة واحدة.", "Start with «+ Purchase invoice»: it receives the goods and records the bill in one step.")}</p> : null}
        </div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow pur-invoices" data-testid="pi-table" aria-label={L("فواتير المشتريات", "Purchase invoices")}>
            <thead><tr>
              <th>{L("الفاتورة", "Invoice")}</th><th>{L("المورد", "Supplier")}</th><th className="hr-hide-compact">{L("فاتورة المورد", "Supplier ref")}</th>
              <th className="hr-hide-compact">{L("التاريخ", "Date")}</th><th className="hr-hide-compact">{L("الاستحقاق", "Due")}</th><th>{L("الحالة", "Status")}</th>
              <th className="num hr-hide-compact">{L("الصافي", "Net")}</th><th className="num hr-hide-compact">{L("الضريبة", "VAT")}</th><th className="num">{L("الإجمالي", "Total")}</th>
              <th className="num hr-hide-compact">{L("المدفوع", "Paid")}</th><th className="num hr-hide-compact">{L("المتبقي", "Remaining")}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.status === "CANCELLED" ? "is-muted" : undefined} data-testid={`pi-row-${r.number}`}>
                  <td><Link className="acct-code" href={`/dashboard/purchases/invoices/${r.id}`}>{r.number}</Link>{r.received ? <span className="pur-tag" title={L("استلمت البضاعة بنفسها", "Received its goods itself")}>{L("مستلمة", "Received")}</span> : null}</td>
                  <td className="m-title"><span className="strong">{r.supplierName}</span><span className="hr-msub"><bdi className="acct-code">{r.supplierRef}</bdi> · <span className="hr-num">{r.invoiceDate}</span></span></td>
                  <td className="hr-hide-compact"><bdi className="acct-code">{r.supplierRef}</bdi></td>
                  <td className="hr-hide-compact hr-num">{r.invoiceDate}</td>
                  <td className="hr-hide-compact hr-num">{r.dueDate}</td>
                  <td>{st(r)}</td>
                  <td className="num hr-hide-compact hr-num">{money(r.netTotal)}</td>
                  <td className="num hr-hide-compact hr-num">{money(r.vatTotal)}</td>
                  <td className="num hr-num m-end" style={{ fontWeight: 600 }}>{money(r.grossTotal)}</td>
                  <td className="num hr-hide-compact hr-num">{r.status === "POSTED" ? money(r.paidTotal) : "—"}</td>
                  <td className="num hr-hide-compact hr-num">{r.status === "POSTED" ? money(r.outstanding) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{L(`${rows.length} فاتورة · بلا الملغاة`, `${rows.length} invoices · cancelled excluded`)}</td>
                <td className="hr-hide-compact" colSpan={4} />
                <td className="num hr-hide-compact stk-tot hr-num">{money(tot.net)}</td>
                <td className="num hr-hide-compact stk-tot hr-num">{money(tot.vat)}</td>
                <td className="num stk-tot hr-num">{money(tot.gross)}</td>
                <td className="num hr-hide-compact stk-tot hr-num">{money(tot.paid)}</td>
                <td className="num hr-hide-compact stk-tot hr-num">{money(tot.open)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="acct-hint">{L("«حفظ واستلام» يُدخل البضاعة المخزون ويقدّم الفاتورة للاعتماد في خطوة واحدة؛ يعتمدها محاسب آخر وفق إعداد فصل المهام. السداد من «المحاسبة › الذمم الدائنة › المدفوعات».", "«Save and receive» puts the goods into stock and submits the bill in one step; another accountant approves it as the segregation-of-duties setting says. Payments: «Accounting › Payables › Payments».")}</p>
    </div>
  );
}
