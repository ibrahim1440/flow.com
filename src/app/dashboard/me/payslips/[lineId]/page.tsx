"use client";
// Self-service payslip. Only lines of APPROVED/PAID runs that belong to the caller's own
// linked record are served (/api/hr/me/payslips/[lineId]); employer contributions are not
// part of the slip.
import Link from "next/link";
import { useParams } from "next/navigation";
import { Btn, ErrorState, KV, LoadingTable, Metrics, PageHeader, RUN_STATUS, StatusDot, days, money, useHr, useHrI18n } from "@/components/hr/ui";
import { hrText } from "@/lib/hr/messages-en";
import { dayRows, type DayDetail } from "../../../hr/payroll/shared";
import { DayValue } from "../../../hr/payroll/day-value";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintCertified } from "@/components/print/Certification";
import "../../me.css";
import { NOT_AUTHORIZED_AR, NOT_AUTHORIZED_EN } from "@/lib/hr/payroll-doc";

type Item = { code: string; kind: "EARNING" | "DEDUCTION"; amount: string; quantity: string | null; description: string };
type Slip = {
  id: string; runNo: number; kind: string; periodMonth: string; status: string;
  employee: { employeeNo: string; fullNameAr: string; jobTitle: string };
  payableDays: string; dayDetail?: DayDetail | null; gross: string; deductions: string; net: string; items: Item[]; final: boolean; authorized?: boolean;
};

function ItemsTable({ title, items, total }: { title: string; items: Item[]; total: string }) {
  const { L, lang } = useHrI18n();
  return (
    <section className="hr-stack" aria-label={title}>
      <h2 className="hr-section">{title}</h2>
      <div className="hr-tablewrap">
        <table className="hr-table is-dense" aria-label={title}>
          <thead><tr><th>{L("البند", "Item")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
          <tbody>
            {items.length === 0 ? <tr><td className="hr-muted" colSpan={2}>{L("لا يوجد", "None")}</td></tr> : items.map((i, n) => (
              <tr key={`${i.code}-${n}`}>
                <td>{hrText(i.description, lang)}</td>
                <td className="num">{money(i.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>{L("الإجمالي", "Total")}</td><td className="num">{money(total)}</td></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

export default function MyPayslipPage() {
  const { lineId } = useParams<{ lineId: string }>();
  const { data, error, loading, reload } = useHr<Slip>(lineId ? `/api/hr/me/payslips/${encodeURIComponent(lineId)}` : null);
  const { L, month, en, lang } = useHrI18n();
  // Owner decision D1: printing is out of Phase 1. The Print action works only once the server's
  // PRINT_CERTIFIED gate says so (unknown counts as off); the payslip itself stays viewable.
  const printing = usePrintCertified();
  const back = <Link className="hr-btn is-ghost me-noprint" href="/dashboard/me">{en ? "← My HR" : "→ خدماتي"}</Link>;

  if (error) return <div className="hr-page"><PageHeader title={L("قسيمة الراتب", "Payslip")} actions={back} /><ErrorState error={error} onRetry={reload} /></div>;
  if (loading || !data) return <div className="hr-page"><PageHeader title={L("قسيمة الراتب", "Payslip")} actions={back} /><LoadingTable rows={8} /></div>;
  const earnings = data.items.filter((i) => i.kind === "EARNING");
  const deductions = data.items.filter((i) => i.kind === "DEDUCTION");

  return (
    <div className="hr-page me-print">
      <PageHeader title={L(`قسيمة راتب ${month(data.periodMonth)}`, `Payslip · ${month(data.periodMonth)}`)} actions={<>{back}<Btn variant="primary" className="me-noprint" data-testid="payslip-print" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID} onClick={() => { if (printing === true) window.print(); }}>{L("طباعة", "Print")}</Btn></>}>
        <span className="hr-caption">{data.employee.fullNameAr} · <span className="hr-num">{data.employee.employeeNo}</span> · {data.employee.jobTitle}</span>
        <StatusDot map={RUN_STATUS} value={data.status} />
      </PageHeader>
      {/* The API serves only APPROVED / PAID lines here; should one ever arrive unauthorized it is
          marked, never printed as a payment (owner, RC3.1). */}
      {data.authorized !== true ? (
        <div role="alert" data-testid="payslip-unauthorized" style={{ border: "3px solid #b91c1c", background: "#fef2f2", color: "#7f1d1d", padding: "12px 16px", borderRadius: 10, fontWeight: 800, fontSize: 18, textAlign: "center", printColorAdjust: "exact" }}>
          <div lang="ar" dir="rtl">{NOT_AUTHORIZED_AR}</div>
          <div lang="en" dir="ltr">{NOT_AUTHORIZED_EN}</div>
        </div>
      ) : null}
      {printing === false ? <PrintPhase1Notice className="me-noprint" /> : null}
      <KV rows={[
        [L("المسير", "Run"), <span key="r"><span className="hr-num">#{data.runNo}</span>{data.kind !== "REGULAR" ? L(" · مسير تصحيحي", " · correction run") : ""}</span>],
        [L("الفترة", "Period"), <span key="p" className="hr-num">{data.periodMonth}</span>],
        // P-2 rev3 item 6: one unit per row (calendar days, or pay units of the month basis).
        ...(data.dayDetail ? dayRows(data.dayDetail, lang).map(([k, v, tone]) => [k, <DayValue key={k} v={v} />, tone] as [string, React.ReactNode, "warning" | undefined]) : [[L("أيام الاستحقاق", "Payable days"), <span key="d" className="hr-num">{days(data.payableDays)}</span>] as [string, React.ReactNode]]),
      ]} />
      <div className="hr-cols-2">
        <ItemsTable title={L("الاستحقاقات", "Earnings")} items={earnings} total={data.gross} />
        <ItemsTable title={L("الاستقطاعات", "Deductions")} items={deductions} total={data.deductions} />
      </div>
      <Metrics items={[[L("الإجمالي", "Gross"), money(data.gross)], [L("الاستقطاعات", "Deductions"), money(data.deductions)], [L("الصافي", "Net"), money(data.net)]]} />
      <p className="hr-caption" style={{ margin: 0 }}>{L("تظهر القسيمة بعد اعتماد المسير فقط، ولا تتغير بعد ذلك. أي تصحيح يظهر قسيمةً مستقلة مرتبطة بالأصل.", "A payslip appears only after the run is approved, and does not change afterwards. A correction appears as a separate payslip linked to the original.")}</p>
    </div>
  );
}
