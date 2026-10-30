"use client";

// «طلبات الفواتير» (BATCH 22 WP-C) — the accountant's queue: every draft Sales requested, oldest first. Columns (design
// §WP-C): المرجع · العميل · من الطلب # · أنشأه · القيمة · عمر الطلب (Riyadh business days, Friday / Saturday off) ·
// آخر موعد نظامي (the 15th of the month after the supply, KSA VAT Implementing Regulations Art. 53). Amber over one
// business day; red over two, or within five days of the legal limit. The colour always comes with its words.
import Link from "next/link";
import { OpsLoading } from "@/components/ops/ui";
import { InvShell, KIND, Msg, money, useApi, useLang } from "./inv";
import { usePhone } from "@/components/shell/page-context";

type Row = {
  id: string; kind: string; family: string; customerName: string; orderId: string | null; orderNumber: number | null; createdByName: string | null; requestedByName: string | null;
  requestNote: string | null; grandTotal: string; supplyDate: string | null; requestedAt: string; requestedDay: string; ageBusinessDays: number; deadline: string; daysToDeadline: number; pastDeadline: boolean; tone: "ok" | "amber" | "red";
};

export function RequestQueue() {
  const { L } = useLang();
  const q = useApi<{ items: Row[]; count: number }>("/api/sales/invoices/requests");
  const rows = q.data?.items ?? [];
  // FOLLOWUPS sales UI bug 7: at 390 the seven columns squeezed into one-word lines — a phone reads one card per request.
  const phone = usePhone();
  return (
    <InvShell title={L("طلبات الفواتير", "Invoice requests")} testId="invoice-requests"
      meta={<span className="acct-meta"><span>{L(`${rows.length} طلب`, `${rows.length} request(s)`)}</span><span aria-hidden="true">·</span><span>{L("الأقدم أولًا", "Oldest first")}</span><span aria-hidden="true">·</span><span>{L("أيام العمل بتوقيت الرياض", "Riyadh business days")}</span></span>}>
      <Msg error={q.error} />
      {!q.data && !q.error ? <OpsLoading /> : rows.length === 0 && !q.error ? (
        <p className="acct-hint" data-testid="requests-empty">{L("لا توجد طلبات فواتير بانتظارك.", "No invoice requests are waiting for you.")}</p>
      ) : rows.length && phone ? (
        <ul className="inv-req-cards" data-testid="requests-cards">
          {rows.map((r) => (
            <li key={r.id} data-testid={`request-row-${r.id}`} data-tone={r.tone}>
              <Link href={`/dashboard/sales/invoices/${r.id}`} className="inv-req-card" data-testid="request-open">
                <span className="inv-req-top"><b><bdi>{r.customerName}</bdi></b><span className="hr-num inv-req-amt"><bdi>{money(r.grandTotal)}</bdi> {L("ر.س", "SAR")}</span></span>
                <span className="inv-sub">{L(KIND[r.kind]?.[r.family]?.[0] ?? r.kind, KIND[r.kind]?.[r.family]?.[1] ?? r.kind)}{r.orderNumber ? <> · {L("من الطلب", "from order")} <bdi dir="ltr" className="hr-num">#{r.orderNumber}</bdi></> : null}</span>
                {r.requestNote ? <span className="inv-sub"><bdi>{r.requestNote}</bdi></span> : null}
                <span className="inv-req-meta">
                  <span className={`inv-age is-${r.tone}`} data-testid="request-age">{L(`${r.ageBusinessDays} يوم عمل`, `${r.ageBusinessDays} business day(s)`)}{r.tone === "red" ? L(" · متأخر", " · late") : r.tone === "amber" ? L(" · انتبه", " · due soon") : ""}</span>
                  <span className={r.daysToDeadline <= 5 ? "inv-age is-red" : "inv-age"} data-testid="request-deadline">{r.pastDeadline ? L("تجاوز الموعد النظامي", "Past the legal limit") : L(`الموعد النظامي بعد ${r.daysToDeadline} يومًا`, `Legal limit in ${r.daysToDeadline} day(s)`)}</span>
                </span>
                <span className="inv-sub">{L("أنشأه", "Prepared by")} <bdi>{r.createdByName ?? "—"}</bdi></span>
              </Link>
            </li>
          ))}
        </ul>
      ) : rows.length ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="requests-table">
            <thead><tr>
              <th>{L("المرجع", "Reference")}</th><th>{L("العميل", "Customer")}</th><th>{L("من الطلب #", "From order #")}</th><th>{L("أنشأه", "Prepared by")}</th>
              <th className="num">{L("القيمة · ر.س", "Amount · SAR")}</th><th>{L("عمر الطلب", "Waiting")}</th><th>{L("آخر موعد نظامي", "Legal limit")}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid={`request-row-${r.id}`} data-tone={r.tone}>
                <td><Link href={`/dashboard/sales/invoices/${r.id}`} data-testid="request-open">{L(KIND[r.kind]?.[r.family]?.[0] ?? r.kind, KIND[r.kind]?.[r.family]?.[1] ?? r.kind)} · {L("يُعطى الرقم عند الإصدار", "numbered at issue")}</Link>
                  {r.requestNote ? <span className="inv-sub"><bdi>{r.requestNote}</bdi></span> : null}</td>
                <td><bdi>{r.customerName}</bdi></td>
                <td className="hr-num">{r.orderNumber ? <bdi dir="ltr">#{r.orderNumber}</bdi> : "—"}</td>
                <td><bdi>{r.createdByName ?? "—"}</bdi>{r.requestedByName && r.requestedByName !== r.createdByName ? <span className="inv-sub">{L("طلبها ", "requested by ")}<bdi>{r.requestedByName}</bdi></span> : null}</td>
                <td className="num hr-num">{money(r.grandTotal)}</td>
                <td><span className={`inv-age is-${r.tone}`} data-testid="request-age">{L(`${r.ageBusinessDays} يوم عمل`, `${r.ageBusinessDays} business day(s)`)}{r.tone === "red" ? L(" · متأخر", " · late") : r.tone === "amber" ? L(" · انتبه", " · due soon") : ""}</span>
                  <span className="inv-sub hr-num">{r.requestedDay}</span></td>
                <td><span className={r.daysToDeadline <= 5 ? "inv-age is-red" : "inv-age"} data-testid="request-deadline"><bdi className="hr-num" dir="ltr">{r.deadline}</bdi></span>
                  <span className="inv-sub">{r.pastDeadline ? L("تجاوز الموعد النظامي", "Past the legal limit") : L(`بعد ${r.daysToDeadline} يومًا`, `in ${r.daysToDeadline} day(s)`)}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      <p className="acct-hint">{L("الموعد النظامي: الخامس عشر من الشهر التالي لشهر التوريد (اللائحة التنفيذية لنظام ضريبة القيمة المضافة، المادة 53). الفاتورة المبسطة تُبلَّغ للهيئة خلال 24 ساعة من الإصدار.", "Legal limit: the 15th of the month after the month of supply (KSA VAT Implementing Regulations, Art. 53). A simplified invoice is reported to ZATCA within 24 hours of issue.")}</p>
    </InvShell>
  );
}
