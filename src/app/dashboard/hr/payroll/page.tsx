"use client";
import { useCreateRequest } from "@/components/shell/page-context";
// Payroll runs — list + «إعداد مسير». A run is prepared from current inputs for one month
// and one scope (whole company or one branch); the API refuses a second REGULAR run for the
// same month/scope (409 RUN_EXISTS) and a month with no ACTIVE policy (409 NO_POLICY).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Btn, Dialog, Empty, ErrorState, Field, LoadingTable, NoPermission, Notice, PageHeader, RUN_STATUS,
  StatusDot, hrFetch, money, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta,
} from "@/components/hr/ui";
import { orgName } from "@/lib/i18n/hr";
import { KIND_LABEL, label, thisMonth, type RunDetail, type RunRow } from "./shared";

export default function PayrollRunsPage() {
  const can = useCan();
  const { meta } = useHrMeta();
  const reader = can("payroll_prepare") || can("payroll_approve") || can("payroll_pay");
  const { data, error, loading, reload } = useHr<RunRow[]>(meta && !reader ? null : "/api/hr/payroll/runs");
  const [preparing, setPreparing] = useState(false);
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «إعداد مسير».
  useCreateRequest("run", () => setPreparing(true), can("payroll_prepare"));
  const router = useRouter();
  const { L, t, lang, month } = useHrI18n();

  const scopeName = useMemo(() => {
    const m = new Map((meta?.branches ?? []).map((b) => [b.id, orgName(b, lang)]));
    return (key: string) => (key === "COMPANY" ? t("wholeCompany") : m.get(key) ?? key);
  }, [meta, lang, t]);

  if (meta && !reader) return <div className="hr-page"><NoPermission duty={L("الرواتب", "Payroll")} /></div>;

  return (
    <div className="hr-page">
      <PageHeader title={L("مسيرات الرواتب", "Payroll runs")} actions={can("payroll_prepare") ? <Btn variant="primary" onClick={() => setPreparing(true)}>{L("إعداد مسير +", "+ Prepare run")}</Btn> : null} />
      <p className="hr-caption" style={{ margin: 0 }}>
        {L("يُعدّ المسير من بيانات الشهر الحالية، ثم يُرسل للاعتماد. يعتمد كل بند شخصٌ غير من أعدّ المسير وغير صاحب البند، ويُسجَّل الصرف بعد الاعتماد — تسجيل فقط، لا تحويل بنكي.", "A run is prepared from the month’s current data, then submitted for approval. Each line is approved by someone who neither prepared the run nor is paid by the line, and the payment is recorded after approval — record only, no bank transfer.")}
      </p>
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable /> : null}
      {data && data.length === 0 ? (
        <Empty
          title={L("لا توجد مسيرات بعد", "No payroll runs yet")}
          body={L("أعدّ أول مسير لشهر. يلزم أن تكون سياسة الرواتب مفعّلة، وأن تكون للموظفين رواتب مسجلة.", "Prepare the first run for a month. The payroll policy must be active and employees must have pay recorded.")}
          action={can("payroll_prepare") ? <Btn variant="primary" onClick={() => setPreparing(true)}>{L("إعداد مسير", "Prepare run")}</Btn> : undefined}
        />
      ) : null}
      {data && data.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("مسيرات الرواتب", "Payroll runs")}>
            <thead>
              <tr>
                <th>{L("المسير", "Run")}</th><th>{L("النوع", "Type")}</th><th>{L("النطاق", "Scope")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("الموظفون", "Employees")}</th><th className="num hr-hide-compact">{L("الإجمالي", "Gross")}</th><th className="num">{L("الصافي", "Net")}</th><th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="is-clickable" tabIndex={0} onClick={() => router.push(`/dashboard/hr/payroll/${r.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/dashboard/hr/payroll/${r.id}`)}>
                  <td data-label={L("المسير", "Run")} className="strong">
                    {month(r.periodMonth)} <span className="sub hr-id">#{r.runNo}</span>
                  </td>
                  <td data-label={L("النوع", "Type")}>{r.kind === "CORRECTION" ? <span className="hr-flag tone-info">{label(KIND_LABEL, "CORRECTION", lang)}</span> : label(KIND_LABEL, "REGULAR", lang)}</td>
                  <td data-label={L("النطاق", "Scope")} className="hr-muted">{scopeName(r.branchKey)}</td>
                  <td data-label={L("الحالة", "Status")}><StatusDot map={RUN_STATUS} value={r.status} /></td>
                  <td data-label={L("الموظفون", "Employees")} className="num">{r.lines}</td>
                  <td data-label={L("الإجمالي", "Gross")} className="num hr-hide-compact">{money(r.totalGross)}</td>
                  <td data-label={L("الصافي", "Net")} className="num">{money(r.totalNet)}</td>
                  <td>
                    <Link className="hr-btn is-ghost is-sm" href={`/dashboard/hr/payroll/${r.id}`} onClick={(e) => e.stopPropagation()}>{L("فتح ←", "Open →")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {preparing ? <PrepareDialog runs={data ?? []} onClose={() => setPreparing(false)} onDone={(id) => router.push(`/dashboard/hr/payroll/${id}`)} /> : null}
    </div>
  );
}

function PrepareDialog({ runs, onClose, onDone }: { runs: RunRow[]; onClose: () => void; onDone: (id: string) => void }) {
  const { meta } = useHrMeta();
  const can = useCan();
  const companyWide = !!meta?.allBranches || can("all_branches");
  const f = useForm({ month: thisMonth(), kind: "REGULAR", branchKey: companyWide ? "COMPANY" : meta?.branches[0]?.id ?? "", correctsRunId: "" });
  const a = useAction();
  const { L, t, lang, month } = useHrI18n();
  const correctable = runs.filter((r) => r.periodMonth === f.v.month && r.kind === "REGULAR" && (r.status === "APPROVED" || r.status === "PAID"));
  const submit = () =>
    a.run("prepare", async () => {
      const body: Record<string, string> = { month: f.v.month, kind: f.v.kind, branchKey: f.v.branchKey || "COMPANY" };
      if (f.v.kind === "CORRECTION") body.correctsRunId = f.v.correctsRunId;
      const run = await hrFetch<RunDetail>("/api/hr/payroll/runs", { json: body });
      onDone(run.id);
    });
  const invalid = !/^\d{4}-\d{2}$/.test(f.v.month) || (f.v.kind === "CORRECTION" && !f.v.correctsRunId);
  return (
    <Dialog
      open
      title={L("إعداد مسير", "Prepare run")}
      onClose={onClose}
      actions={<><Btn variant="primary" busy={a.busy === "prepare"} disabled={invalid} onClick={submit}>{L("إعداد", "Prepare")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}
    >
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الشهر *", "Month *")}><input className="hr-input" type="month" {...f.bind("month")} /></Field>
        <Field label={L("النطاق", "Scope")}>
          <select className="hr-select" {...f.bind("branchKey")}>
            {companyWide ? <option value="COMPANY">{t("wholeCompany")}</option> : null}
            {meta?.branches.map((b) => <option key={b.id} value={b.id}>{orgName(b, lang)}</option>)}
          </select>
        </Field>
        <Field label={L("النوع", "Type")} help={f.v.kind === "CORRECTION" ? L("يحمل التسويات فقط، لموظفين في مسير معتمد أو مصروف لنفس الشهر.", "Carries adjustments only, for employees in an approved or paid run for the same month.") : undefined}>
          <select className="hr-select" {...f.bind("kind")}>
            <option value="REGULAR">{label(KIND_LABEL, "REGULAR", lang)}</option>
            <option value="CORRECTION">{label(KIND_LABEL, "CORRECTION", lang)}</option>
          </select>
        </Field>
        {f.v.kind === "CORRECTION" ? (
          <Field label={L("يصحّح المسير *", "Corrects run *")} error={correctable.length ? null : L("لا يوجد مسير معتمد أو مصروف لهذا الشهر.", "No approved or paid run exists for this month.")}>
            <select className="hr-select" {...f.bind("correctsRunId")}>
              <option value="">—</option>
              {correctable.map((r) => <option key={r.id} value={r.id}>#{r.runNo} · {month(r.periodMonth)}</option>)}
            </select>
          </Field>
        ) : null}
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>
        {L("يُحتسب المسير من الرواتب السارية والإجازات بدون راتب والإضافي المعتمد والعمولات وأقساط السلف المستحقة، ويحجزها حتى يُعاد احتسابه أو يُلغى. لا يُعدّ مسيران عاديان لنفس الشهر والنطاق.", "The run is calculated from active pay, unpaid leave, approved overtime, commissions and due advance instalments, and reserves them until it is rebuilt or cancelled. Two regular runs for the same month and scope are not allowed.")}
      </p>
    </Dialog>
  );
}
