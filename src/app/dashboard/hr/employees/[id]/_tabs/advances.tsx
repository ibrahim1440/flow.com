"use client";
// HR-02 · Advances for this person (read-only here; requests, decisions and disbursement
// are handled on the advances workspace, where separation of duties is enforced).
import { ADVANCE_STATUS, Empty, ErrorState, LoadingTable, StatusDot, money, useHr, useHrI18n } from "@/components/hr/ui";
import { SectionHead, type AdvanceRow, type TabProps } from "./shared";

export default function AdvancesTab({ id }: TabProps) {
  // The list endpoint has no per-person filter; it is scoped and capped server-side, so
  // filter to this person here.
  const { data, error, loading, reload } = useHr<AdvanceRow[]>("/api/hr/advances");
  const rows = data?.filter((a) => a.employee.id === id) ?? [];
  const open = rows.filter((a) => a.status === "DISBURSED");
  const outstanding = open.reduce((s, a) => s + Number(a.outstanding), 0);
  const { L, t, month } = useHrI18n();
  return (
    <section className="hr-stack">
      <SectionHead title={L("السلف", "Advances")} />
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable rows={4} /> : null}
      {data && rows.length === 0 ? <Empty title={L("لا توجد سلف", "No advances")} body={L("لم تُطلب أي سلفة لهذا الموظف.", "No advance has been requested for this employee.")} /> : null}
      {rows.length > 0 ? (
        <>
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("سلف الموظف", "Employee advances")}>
              <thead><tr><th>{L("الرقم", "No.")}</th><th className="num">{t("amount")}</th><th className="num">{L("الأقساط", "Instalments")}</th><th>{L("أول قسط", "First instalment")}</th><th className="num">{L("المتبقي", "Remaining")}</th><th>{t("status")}</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td data-label={L("الرقم", "No.")}><span className="hr-id">{a.advanceNo}</span>{a.reason ? <span className="sub">{a.reason}</span> : null}</td>
                    <td data-label={t("amount")} className="num">{money(a.amount)}</td>
                    <td data-label={L("الأقساط", "Instalments")} className="num">{a.installmentCount}</td>
                    <td data-label={L("أول قسط", "First instalment")}>{a.firstInstallmentMonth ? month(a.firstInstallmentMonth) : "—"}</td>
                    <td data-label={L("المتبقي", "Remaining")} className="num strong">{a.status === "DISBURSED" ? money(a.outstanding) : "—"}</td>
                    <td data-label={t("status")}><StatusDot map={ADVANCE_STATUS} value={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hr-tablefoot">
            <span><span className="hr-num">{rows.length}</span> {L("سلفة", "advances")} · <span className="hr-num">{open.length}</span> {L("قائمة", "open")}</span>
            <span>{L("إجمالي المتبقي:", "Total remaining:")} <span className="hr-num">{money(outstanding)}</span></span>
          </div>
        </>
      ) : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("تُخصم الأقساط عبر مسير الرواتب. الطلب والاعتماد والصرف تتم من صفحة «السلف».", "Instalments are deducted through payroll. Requests, approval and payment are handled on the Advances page.")}</p>
    </section>
  );
}
