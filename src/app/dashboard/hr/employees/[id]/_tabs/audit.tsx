"use client";
// HR-02 · Audit trail for this person (latest 200 rows; people_manage). Private-data rows
// carry field names only; document rows carry no bytes.
import { Empty, ErrorState, LoadingTable, useHr, useHrI18n } from "@/components/hr/ui";
import { AUDIT_ACTION, SectionHead, fmtDateTime, lbl, type TabProps } from "./shared";

type Row = { id: string; action: string; entityType: string; reason: string | null; actor: string | null; at: string; after: unknown };

const fieldsOf = (after: unknown) => {
  const f = (after as { fields?: unknown } | null)?.fields;
  return Array.isArray(f) ? f.map(String) : null;
};

export default function AuditTab({ id }: TabProps) {
  const { data, error, loading, reload } = useHr<Row[]>(`/api/hr/employees/${id}/audit`);
  const { L, lang } = useHrI18n();
  return (
    <section className="hr-stack">
      <SectionHead title={L("السجل", "Audit log")} />
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable /> : null}
      {data && data.length === 0 ? <Empty title={L("لا توجد حركات مسجلة", "No recorded activity")} /> : null}
      {data && data.length > 0 ? (
        <>
          <div className="hr-tablewrap">
            <table className="hr-table is-stack is-dense" aria-label={L("سجل الموظف", "Employee audit log")}>
              <thead><tr><th className="num">{L("الوقت", "Time")}</th><th>{L("الإجراء", "Action")}</th><th>{L("بواسطة", "By")}</th><th>{L("السبب / التفاصيل", "Reason / details")}</th></tr></thead>
              <tbody>
                {data.map((r) => {
                  const fields = fieldsOf(r.after);
                  return (
                    <tr key={r.id}>
                      <td data-label={L("الوقت", "Time")} className="num">{fmtDateTime(r.at)}</td>
                      <td data-label={L("الإجراء", "Action")} className="strong">{AUDIT_ACTION[r.action] ? lbl(AUDIT_ACTION, r.action, lang) : <span className="hr-id">{r.action}</span>}</td>
                      <td data-label={L("بواسطة", "By")}>{r.actor ?? L("النظام", "System")}</td>
                      <td data-label={L("السبب", "Reason")} className="hr-muted">
                        {r.reason ?? null}
                        {fields ? <span className="hr-iso" dir="ltr">{fields.join(", ")}</span> : null}
                        {!r.reason && !fields ? "—" : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hr-tablefoot"><span>{L("آخر", "Last")} <span className="hr-num">{data.length}</span> {L("حركة", "entries")}{data.length >= 200 ? L(" (يُعرض أحدث 200 فقط)", " (only the latest 200 are shown)") : ""}</span></div>
        </>
      ) : null}
    </section>
  );
}
