"use client";
// Printable payslip of one payroll line. Payroll roles see any line in their scope; a person
// sees their own once the run is APPROVED or PAID (the API decides). Employer-side items are
// not on a payslip.
import { useParams, useRouter } from "next/navigation";
import {
  Btn, ErrorState, KV, LoadingTable, Notice, RUN_STATUS, StatusDot, days, money, useHr, useHrI18n,
} from "@/components/hr/ui";
import { dayRows, fullUnpaid, itemLabel, itemNote, type DayDetail, type PayItem } from "../../shared";
import { DayValue } from "../../day-value";
import { NOT_AUTHORIZED_AR, NOT_AUTHORIZED_EN, NOT_AUTHORIZED_NET_AR, NOT_AUTHORIZED_NET_EN } from "@/lib/hr/payroll-doc";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintCertified } from "@/components/print/Certification";

type Payslip = {
  id: string; runNo: number; kind: "REGULAR" | "CORRECTION"; periodMonth: string; status: string;
  employee: { employeeNo: string; fullNameAr: string; jobTitle: string };
  payableDays: string; dayDetail?: DayDetail | null; gross: string; deductions: string; net: string;
  items: PayItem[]; final: boolean; authorized?: boolean;
};

// Not an authorized payment (run not APPROVED / PAID): both languages at once, as a banner and a
// fixed diagonal watermark that repeats on every printed page. Fails closed: a response without
// `authorized: true` is marked.
const WATERMARK_CSS = `
.hr-payslip .hr-unauth-mark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 5; }
.hr-payslip .hr-unauth-mark span { transform: rotate(-30deg); font-size: 44px; font-weight: 800; line-height: 1.35; text-align: center; color: rgba(185, 28, 28, 0.16); border: 6px solid rgba(185, 28, 28, 0.16); padding: 12px 24px; white-space: pre-line; }
.hr-payslip .hr-unauth-banner { border: 3px solid #b91c1c; background: #fef2f2; color: #7f1d1d; padding: 12px 16px; border-radius: 10px; font-weight: 800; font-size: 18px; text-align: center; line-height: 1.6; }
@media print {
  .hr-payslip .hr-unauth-mark span { color: rgba(185, 28, 28, 0.22) !important; border-color: rgba(185, 28, 28, 0.22) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hr-payslip .hr-unauth-banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .hr-payslip, .hr-payslip * { visibility: visible !important; }
  .hr-payslip { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 0 !important; }
  .hr-noprint { display: none !important; }
  .hr-payslip .hr-table th { position: static; }
  @page { margin: 14mm; }
}`;

export default function PayslipPage() {
  const { lineId } = useParams<{ lineId: string }>();
  const router = useRouter();
  const { data: p, error, loading, reload } = useHr<Payslip>(`/api/hr/payroll/payslips/${lineId}`);
  const { L, month, en, lang } = useHrI18n();
  // Owner decision D1: printing is out of Phase 1. The Print action works only once the server's
  // PRINT_CERTIFIED gate says so (unknown counts as off); the payslip itself stays viewable.
  const printing = usePrintCertified();

  return (
    <div className="hr-page hr-payslip" style={{ maxWidth: 880 }}>
      <style>{PRINT_CSS}</style>
      <div className="hr-noprint" style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <Btn variant="ghost" size="sm" onClick={() => router.back()}>{en ? "← Back" : "→ رجوع"}</Btn>
        {p ? <Btn variant="primary" data-testid="payslip-print" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID}
          onClick={() => { if (printing === true) window.print(); }}>{L("طباعة", "Print")}</Btn> : null}
      </div>
      {p && printing === false ? <PrintPhase1Notice className="hr-noprint" /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !p ? <LoadingTable rows={8} /> : null}
      {p ? (
        <>
          {p.authorized !== true ? (
            <>
              <style>{WATERMARK_CSS}</style>
              <div className="hr-unauth-mark" aria-hidden data-testid="payslip-unauthorized-watermark"><span>{`${NOT_AUTHORIZED_AR}\n${NOT_AUTHORIZED_EN}`}</span></div>
              <div className="hr-unauth-banner" role="alert" data-testid="payslip-unauthorized">
                <div lang="ar" dir="rtl">{NOT_AUTHORIZED_AR}</div>
                <div lang="en" dir="ltr">{NOT_AUTHORIZED_EN}</div>
              </div>
            </>
          ) : null}
          <div className="hr-pagehead">
            <div>
              <h1 className="hr-title">{L(`قسيمة راتب ${month(p.periodMonth)}`, `Payslip · ${month(p.periodMonth)}`)}</h1>
              <div className="hr-caption">
                {L("مسير", "Run")} <span className="hr-id">#{p.runNo}</span>{p.kind === "CORRECTION" ? L(" · تصحيح", " · correction") : ""} · <StatusDot map={RUN_STATUS} value={p.status} />
              </div>
            </div>
          </div>
          <KV rows={[
            [L("الموظف", "Employee"), p.employee.fullNameAr],
            [L("الرقم الوظيفي", "Employee no."), <span key="n" className="hr-id">{p.employee.employeeNo}</span>],
            [L("المسمى الوظيفي", "Job title"), p.employee.jobTitle],
            // P-2 rev3 item 6: one unit per row; a whole unpaid period shows 0 (blocked).
            ...(p.dayDetail ? dayRows(p.dayDetail, lang).map(([k, v, tone]) => [k, <DayValue key={k} v={v} />, tone] as [string, React.ReactNode, "warning" | undefined]) : [[L("الأيام المستحقة", "Payable days"), <span key="d" className="hr-num">{days(p.payableDays)}</span>] as [string, React.ReactNode]]),
          ]} />
          {p.final && p.authorized === true ? (
            <Notice tone="success">{L("قسيمة نهائية — لا تتغير بعد الاعتماد.", "Final payslip — it does not change after approval.")}</Notice>
          ) : (
            <Notice tone="warning">{L("مسودة — المسير لم يُعتمد بعد، وقد تتغير الأرقام عند إعادة الاحتساب.", "Draft — the run is not approved yet, and the figures may change when it is rebuilt.")}</Notice>
          )}
          <div className="hr-cols-2">
            <ItemsTable title={L("المستحقات", "Earnings")} items={p.items.filter((i) => i.kind === "EARNING")} total={p.gross} totalLabel={L("إجمالي المستحقات", "Total earnings")} />
            <ItemsTable title={L("الاستقطاعات", "Deductions")} items={p.items.filter((i) => i.kind === "DEDUCTION")} total={p.deductions} totalLabel={L("إجمالي الاستقطاعات", "Total deductions")} />
          </div>
          <KV rows={[
            [L("الإجمالي", "Gross"), <span key="g" className="hr-num">{money(p.gross)}</span>],
            [L("الاستقطاعات", "Deductions"), <span key="d" className="hr-num">{money(p.deductions)}</span>],
            // Net payable: the figure is Number/Metric S (IBM Plex Sans Regular 20/22) and its label a plain
            // row label (UI/Caption 13/22, 451:6039), as the net summaries in Figma HR-03 451:5844 / HR-07 454:1812 — no Bold (no HR frame uses 700).
            [<span key="nl" className="hr-caption">{p.authorized === true ? L("الصافي المستحق", "Net payable") : L(NOT_AUTHORIZED_NET_AR, NOT_AUTHORIZED_NET_EN)}</span>, fullUnpaid(p.dayDetail) ? <span key="n">{L("محجوب — الفترة كلها إجازة بدون راتب، لا مستحق", "Blocked — the whole period is unpaid leave; nothing is payable")}</span> : <span key="n" className="hr-metric">{money(p.net)}</span>],
          ]} />
          <p className="hr-caption" style={{ margin: 0 }}>{L("حصة صاحب العمل من الاشتراكات لا تظهر في القسيمة لأنها لا تُخصم من الموظف.", "The employer’s share of contributions is not on the payslip because it is not deducted from the employee.")}</p>
        </>
      ) : null}
    </div>
  );
}

function ItemsTable({ title, items, total, totalLabel }: { title: string; items: PayItem[]; total: string; totalLabel: string }) {
  const { L, lang } = useHrI18n();
  return (
    <section className="hr-stack" aria-label={title}>
      <h2 className="hr-section">{title}</h2>
      <table className="hr-table is-dense">
        <thead><tr><th>{L("البند", "Item")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
        <tbody>
          {items.length ? items.map((i, n) => (
            <tr key={`${i.code}-${n}`}>
              <td>
                {itemLabel(i.code, lang)}
                {itemNote(i, lang) ? <span className="sub">{itemNote(i, lang)}</span> : null}
              </td>
              <td className="num">{money(i.amount)}</td>
            </tr>
          )) : (
            <tr><td colSpan={2} className="hr-caption">{L("لا يوجد", "None")}</td></tr>
          )}
        </tbody>
        <tfoot><tr><td>{totalLabel}</td><td className="num">{money(total)}</td></tr></tfoot>
      </table>
    </section>
  );
}
