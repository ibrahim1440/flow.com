"use client";

// «المحاسبة · نظرة عامة» (Figma ACC-01 family, Direction 2.1): the activation state and the setup checklist in
// the owner's order (chart → roles → fiscal year → go-live + activation → opening balances), the ledger's
// figures and the latest journals. A5: once accounting is active, the dashboard (KPIs, revenue trend, the close
// issues) leads the page.
import Link from "next/link";
import { OpsLoading } from "@/components/ops/ui";
import { AccountingDashboard } from "./_ui/dashboard";
import { AcctShell, StatusTag, STATUS_AR, TYPE_AR, money, useApi, useLang, type Setup } from "./_ui/shell";
import { ZatcaTile } from "./zatca/_ui/zatca";

type JournalList = { items: { id: string; ref: string | null; entryNo: number; entryDate: string; type: string; status: string; description: string | null; totalDebit: string; sourceModule: string }[]; total: number; byStatus: Record<string, number> };

export default function AccountingOverview() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const journals = useApi<JournalList>("/api/accounting/journals?take=8");
  const s = setup.data;
  const pending = (journals.data?.byStatus.SUBMITTED ?? 0) + (journals.data?.byStatus.APPROVED ?? 0);
  const steps = s ? [
    { ok: s.readiness.accounts > 0, ar: "تهيئة دليل الحسابات", en: "Set up the chart of accounts", href: "/dashboard/accounting/chart" },
    { ok: s.readiness.missingByPhase.A1.length === 0, ar: "ربط أدوار الترحيل بالحسابات", en: "Map the posting roles", href: "/dashboard/accounting/settings" },
    { ok: !!s.readiness.goLivePeriod || s.readiness.checks.find((c) => c.key === "period")?.ok === true, ar: "إنشاء السنة المالية", en: "Create the fiscal year", href: "/dashboard/accounting/periods" },
    { ok: s.readiness.active, ar: "تحديد تاريخ البدء وتفعيل المحاسبة", en: "Set the go-live date and activate", href: "/dashboard/accounting/settings" },
    { ok: s.readiness.openingPosted, ar: "ترحيل الأرصدة الافتتاحية", en: "Post the opening balances", href: "/dashboard/accounting/opening" },
  ] : [];
  return (
    <AcctShell setup={s} pendingCount={pending}>
      {setup.error ? <p role="alert" className="hr-err">{setup.error}</p> : null}
      {!s ? <OpsLoading /> : (
        <>
          {s.settings.accountingActive ? <AccountingDashboard /> : null}
          <div className="acct-cards">
            <section className="acct-card" data-testid="acct-setup-steps">
              <h2>{L("خطوات التهيئة", "Setup steps")}</h2>
              <ol className="acct-checks">
                {steps.map((x, i) => (
                  <li key={i}>
                    <span className={x.ok ? "ok" : "no"} aria-hidden="true">{x.ok ? "●" : "○"}</span>
                    <Link href={x.href}>{L(x.ar, x.en)}</Link>
                    <span className="hr-sr">{x.ok ? L("مكتمل", "done") : L("لم يكتمل", "pending")}</span>
                  </li>
                ))}
              </ol>
              <p className="acct-hint">
                {s.readiness.active
                  ? L("المحاسبة مفعّلة: العمليات المربوطة ترحّل قيودها تلقائيًا من تاريخ البدء.", "Accounting is active: connected operations post their entries automatically from the go-live date.")
                  : L("قبل التفعيل لا يُسجَّل أي قيد من العمليات اليومية؛ العمل يستمر كما هو.", "Until activation, daily operations post nothing; work carries on as it is.")}
              </p>
            </section>
            <section className="acct-card">
              <h2>{L("الدفتر", "The ledger")}</h2>
              <dl className="acct-kv-grid">
                <div><dt>{L("الحسابات", "Accounts")}</dt><dd className="hr-num">{s.readiness.accounts}</dd></div>
                <div><dt>{L("قابلة للترحيل", "Postable")}</dt><dd className="hr-num">{s.readiness.postable}</dd></div>
                <div><dt>{L("القيود", "Journals")}</dt><dd className="hr-num">{journals.data?.total ?? "—"}</dd></div>
                <div><dt>{L("بانتظار الاعتماد أو الترحيل", "Awaiting approval / posting")}</dt><dd className="hr-num">{pending}</dd></div>
                <div><dt>{L("تاريخ البدء", "Go-live date")}</dt><dd className="hr-num">{s.settings.goLiveDate ?? "—"}</dd></div>
                <div><dt>{L("القيود اليدوية", "Manual journals")}</dt><dd>{s.manualJournalsEnabled ? L("مسموحة", "Enabled") : L("معطّلة (المرحلة الأولى)", "Disabled (Phase 1)")}</dd></div>
              </dl>
            </section>
            <ZatcaTile />
          </div>
          <section className="acct-card">
            <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
              <h2>{L("أحدث القيود", "Latest journals")}</h2>
              <Link className="hr-btn is-sm" href="/dashboard/accounting/journals">{L("كل القيود", "All journals")}</Link>
            </div>
            {journals.data && journals.data.items.length === 0 ? <p className="acct-hint">{L("لا قيود بعد.", "No journals yet.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense">
                  <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("القيد", "Entry")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("النوع", "Type")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
                  <tbody>
                    {(journals.data?.items ?? []).map((j) => (
                      <tr key={j.id}>
                        <td className="hr-num">{j.entryDate}</td>
                        <td><Link href={`/dashboard/accounting/journals/${j.id}`} className="acct-code">{j.ref ?? `#${j.entryNo}`}</Link></td>
                        <td>{j.description ?? "—"}</td>
                        <td className="acct-hide-m">{L(TYPE_AR[j.type]?.[0] ?? j.type, TYPE_AR[j.type]?.[1] ?? j.type)}</td>
                        <td><StatusTag map={STATUS_AR} value={j.status} /></td>
                        <td className="num hr-num">{money(j.totalDebit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </AcctShell>
  );
}
