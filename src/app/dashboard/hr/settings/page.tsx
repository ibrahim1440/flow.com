"use client";
import { Combobox, Select } from "@/components/ui/Select";
import { useCreateRequest } from "@/components/shell/page-context";
// HR-09 · HR settings (Figma 1JbZgpMqmPkUVne8ms9Ozz · 454:21861). Nothing here ships with an
// approved value: a policy is drafted by one person and activated by another (four-eyes),
// contribution rules carry a mandatory source note, and none is seeded.
import { useMemo, useState, type ReactNode } from "react";
import {
  Btn, Dialog, Dot, Empty, ErrorState, Field, Flag, KV, LoadingTable, NoPermission, Notice, PageHeader, ProposalTag,
  StatusDot, Tabs, hrFetch, money, statusLabel, todayIso, useAction, useForm, useHr, useHrI18n, useHrMeta, type StatusEntry, dateTimeIn
} from "@/components/hr/ui";
import { WEEKDAYS, leaveTypeName } from "@/lib/i18n/hr";
import type { Lang } from "@/lib/i18n/translations";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "../../user-context";
import { ExternalPersons } from "./external-persons";
import { useI18n } from "@/lib/i18n/context";

type Rule = { id: string; code: string; nameAr: string; employeeRatePercent: string; employerRatePercent: string; baseComponents: string[]; appliesToGroup: string; monthlyBaseCap: string | null; sourceNote: string };
type Policy = {
  id: string; fingerprint: string; version: number; effectiveFrom: string; status: "DRAFT" | "ACTIVE" | "RETIRED"; dayBasis: "CALENDAR_DAYS" | "FIXED_30";
  standardDailyHours: string; overtimeMultiplier: string; maxDeductionPercent: string; unpaidLeaveComponents: string[]; overtimeComponents: string[];
  timezone: string; weekendDays: number[]; isProposal: boolean; notes: string | null; createdBy: string; activatedBy: string | null; activatedAt: string | null; contributionRules: Rule[];
  createdByName?: string | null; activatedByName?: string | null;
  // P-2 findings 2/3: accountant decisions; null / empty = not decided (payroll refuses to run).
  capBaseIncludesVariable: boolean; capBaseAfterUnearned: boolean | null; deductionCapUnearnedPercent: string | null; deductionCapLoanPercent: string | null; deductionCapStatutoryPercent: string | null; deductionCapOtherPercent: string | null;
  deductionOverallCovers: string[]; deductionPriority: string[]; deductionCapAction: string | null; advanceDeferralEscalateAfter: number | null; deductionGaps: string[];
};

// P-2 findings 2/3: the four deduction categories.
const DED_CATS: [string, string, string][] = [
  ["UNEARNED_PAY", "الأجر غير المستحق (إجازة بدون راتب)", "Unearned pay (unpaid leave)"],
  ["LOAN_RECOVERY", "استرداد السلف والقروض", "Loan / advance recovery"],
  ["STATUTORY", "الاشتراكات النظامية", "Statutory contributions"],
  ["OTHER", "استقطاعات أخرى", "Other deductions"],
];
const DED_CAP_FIELD: Record<string, "dCapUnearned" | "dCapLoan" | "dCapStatutory" | "dCapOther"> = { UNEARNED_PAY: "dCapUnearned", LOAN_RECOVERY: "dCapLoan", STATUTORY: "dCapStatutory", OTHER: "dCapOther" };
type Account = { id: string; code: string; nameAr: string | null; nameEn: string | null; type?: string };
type Overview = { policies: Policy[]; accountMap: { keys: { key: string; account: Account | null }[]; postable: Account[] }; settings: { accountingEnabled: boolean; updatedAt?: string } };
type LeaveType = { id: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; accrualDaysPerYear: string | null; allowNegative: boolean; active: boolean; isProposal: boolean };
type View = "policy" | "accounts" | "leave" | "rules" | "accounting" | "external";

const POLICY_STATUS: Record<string, StatusEntry> = { DRAFT: ["مسودة", "neutral", "Draft"], ACTIVE: ["سارية", "success", "Active"], RETIRED: ["متقاعدة", "cancelled", "Retired"] };
const COMPONENTS_BI: [string, string, string][] = [["BASIC", "الأساسي", "Basic"], ["HOUSING", "السكن", "Housing"], ["TRANSPORT", "النقل", "Transport"], ["OTHER", "بدلات أخرى", "Other allowances"]];
const components = (lang: Lang): [string, string][] => COMPONENTS_BI.map(([k, ar, en]) => [k, lang === "en" ? en : ar]);
const compLabel = (cs: string[], lang: Lang) => cs.map((c) => components(lang).find(([k]) => k === c)?.[1] ?? c).join(lang === "en" ? ", " : "، ") || "—";
const DAY_BASIS: Record<string, [string, string]> = { CALENDAR_DAYS: ["أيام الشهر الفعلية", "Actual days in the month"], FIXED_30: ["30 يومًا ثابتة", "Fixed 30 days"] };
const dayBasis = (k: string, lang: Lang) => (DAY_BASIS[k] ? DAY_BASIS[k][lang === "en" ? 1 : 0] : k);
const ACCOUNT_LABEL: Record<string, [string, string]> = {
  SALARY_EXPENSE: ["مصروف الرواتب الأساسية", "Basic salary expense"], ALLOWANCE_EXPENSE: ["مصروف البدلات", "Allowance expense"], OVERTIME_EXPENSE: ["مصروف العمل الإضافي", "Overtime expense"], COMMISSION_EXPENSE: ["مصروف العمولات", "Commission expense"],
  EMPLOYER_CONTRIB_EXPENSE: ["مصروف اشتراكات صاحب العمل", "Employer contribution expense"], SALARIES_PAYABLE: ["رواتب مستحقة الدفع", "Salaries payable"], CONTRIB_PAYABLE: ["اشتراكات مستحقة", "Contributions payable"], OTHER_DEDUCTIONS_PAYABLE: ["استقطاعات أخرى مستحقة", "Other deductions payable"],
  ADVANCES_RECEIVABLE: ["سلف الموظفين", "Employee advances"], PAYROLL_CASH: ["حساب صرف الرواتب", "Payroll payment account"],
};
const accountLabel = (k: string, lang: Lang) => (ACCOUNT_LABEL[k] ? ACCOUNT_LABEL[k][lang === "en" ? 1 : 0] : k);
const accName = (a: Account, lang: Lang = "ar") => `${a.code} · ${(lang === "en" ? a.nameEn || a.nameAr : a.nameAr ?? a.nameEn) ?? ""}`;

export default function HrSettingsPage() {
  const { meta } = useHrMeta();
  const user = useUser();
  const { lang } = useI18n();
  const perms = user?.permissions ?? {};
  // Policy tabs: the policy_manage duty. «الأشخاص الخارجيون» (Option A): account editors.
  const allowed = hasModuleAccess(perms, "hr") && hasSubPrivilege(perms, "hr", "policy_manage");
  const editor = hasModuleAccess(perms, "employees") && hasSubPrivilege(perms, "employees", "edit");
  const ov = useHr<Overview>(allowed ? "/api/hr/policy" : null);
  const [view, setView] = useState<View>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "external") ? "external" : "policy");
  const [newPolicy, setNewPolicy] = useState(false);
  const { L } = useHrI18n();
  // «جديد» from the shell (A-3): `?new=policy` opens the same draft form as the header button
  // (it renders once the policy overview has loaded, exactly like the button's).
  useCreateRequest("policy", () => { setView("policy"); setNewPolicy(true); }, !!meta?.caps.policy_manage);

  if (!user) return <div className="hr-page"><LoadingTable /></div>;
  if (!allowed && !editor) return <div className="hr-page"><NoPermission duty={L("السياسات والإعدادات", "Policies & settings")} /></div>;
  if (!allowed) return <div className="hr-page"><PageHeader title={L("إعدادات الموارد البشرية", "HR settings")} /><ExternalPersons /></div>;
  const unmapped = ov.data?.accountMap.keys.filter((k) => !k.account).length ?? 0;
  const drafts = ov.data?.policies.filter((p) => p.status === "DRAFT").length ?? 0;

  return (
    <div className="hr-page">
      <PageHeader title={L("إعدادات الموارد البشرية", "HR settings")} actions={view === "policy" ? <Btn onClick={() => setNewPolicy(true)} disabled={!ov.data}>{ov.data?.policies.some((p) => p.status === "ACTIVE") ? <><span className="hr-hide-mobile">{L("مسودة جديدة من النسخة السارية", "New draft from the active version")}</span><span className="hr-mobile-only">{L("مسودة جديدة", "New draft")}</span></> : L("مسودة جديدة", "New draft")}</Btn> : null} />
      <Tabs
        underline
        label={L("أقسام الإعدادات", "Settings sections")}
        value={view}
        onChange={setView}
        items={[
          { key: "policy", label: L("سياسة الرواتب", "Payroll policy"), count: drafts ? L(`${drafts} مسودة`, `${drafts} draft`) : undefined },
          { key: "accounts", label: L("ربط الحسابات", "Account mapping"), count: unmapped || undefined, danger: unmapped > 0 },
          { key: "leave", label: L("أنواع الإجازات", "Leave types") },
          { key: "rules", label: L("قواعد الاشتراكات", "Contribution rules") },
          { key: "accounting", label: L("المحاسبة", "Accounting") },
          ...(editor ? [{ key: "external" as const, label: L("الأشخاص الخارجيون", "External persons") }] : []),
        ]}
      />
      {view === "external" ? null : <Notice tone="warning">{L("كل القيم مقترحات للتجربة ولم تعتمدها الإدارة أو المحاسب. لا تتضمن الحزمة نسب تأمينات أو صيغة نهاية خدمة أو صيغة ملف حماية الأجور؛ تُدخل من مصدر رسمي ويُراجعها المحاسب.", "All values are trial proposals not approved by management or the accountant. No social-insurance rates, end-of-service formula or wage-protection file format is included; they are entered from an official source and reviewed by the accountant.")}</Notice>}
      {view === "external" ? <ExternalPersons /> : view === "leave" ? <LeaveTypes /> : (
        <>
          {ov.error ? <ErrorState error={ov.error} onRetry={ov.reload} /> : null}
          {ov.loading && !ov.data ? <LoadingTable /> : null}
          {ov.data && view === "policy" ? <PolicyTab policies={ov.data.policies} me={meta?.actorId ?? null} onNew={() => setNewPolicy(true)} reload={ov.reload} /> : null}
          {ov.data && view === "accounts" ? <AccountsTab map={ov.data.accountMap} reload={ov.reload} /> : null}
          {ov.data && view === "rules" ? <RulesTab policies={ov.data.policies} me={meta?.actorId ?? null} reload={ov.reload} /> : null}
          {ov.data && view === "accounting" ? <AccountingTab enabled={ov.data.settings.accountingEnabled} updatedAt={ov.data.settings.updatedAt} reload={ov.reload} /> : null}
        </>
      )}
      {newPolicy && ov.data ? <NewPolicy base={ov.data.policies.find((p) => p.status === "ACTIVE") ?? ov.data.policies[0] ?? null} onClose={() => setNewPolicy(false)} onDone={() => { setNewPolicy(false); void ov.reload(); }} /> : null}
    </div>
  );
}

// ── Policy versions ────────────────────────────────────────────────────────────────

function PolicyTab({ policies, me, onNew, reload }: { policies: Policy[]; me: string | null; onNew: () => void; reload: () => void }) {
  const act = useAction();
  const { L } = useHrI18n();
  const [sel, setSel] = useState<string | null>(policies.find((x) => x.status === "DRAFT")?.id ?? policies[0]?.id ?? null);
  const p = policies.find((x) => x.id === sel) ?? policies[0] ?? null;
  // The approval names the exact content on screen; an edit made since is refused (409).
  const activate = (x: Policy) => act.run(x.id, async () => {
    await hrFetch(`/api/hr/policy/${x.id}/activate`, { json: { expected: x.fingerprint } });
    reload();
  });
  if (!policies.length) {
    return <Empty title={L("لا توجد سياسة رواتب", "No payroll policy")} body={L("لا يمكن احتساب مسير قبل اعتماد سياسة. أنشئ نسخة مسودة، ثم يعتمدها مسؤول آخر يملك الصلاحية نفسها.", "No run can be calculated before a policy is approved. Create a draft version; another administrator with the same permission approves it.")} action={<Btn variant="primary" onClick={onNew}>{L("مسودة جديدة", "New draft")}</Btn>} />;
  }
  const isDraft = p?.status === "DRAFT";
  const mine = !!p && p.createdBy === me;
  const base = p ? policies.find((x) => x.status === "ACTIVE" && x.id !== p.id) ?? null : null;
  return (
    <div className="hr-cols-2 hr-policy-cols">
      {p ? (
        <div className="hr-stack hr-policy-detail">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 className="hr-section">{isDraft ? <>{L("مسودة · نسخة", "Draft · version")} <span className="hr-num">{p.version}</span>{base ? <> ({L("من النسخة", "from version")} <span className="hr-num">{base.version}</span>)</> : null}</> : <>{L("سياسة الرواتب · نسخة", "Payroll policy · version")} <span className="hr-num">{p.version}</span></>}</h2>
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><StatusDot map={POLICY_STATUS} value={p.status} />{p.isProposal ? <ProposalTag /> : null}</span>
          </div>
          {isDraft && mine ? (
            <DraftEditor key={p.id} p={p} base={base} onSaved={reload} />
          ) : (
            <>
              <PolicyFacts p={p} base={isDraft ? base : null} />
              {isDraft ? (
                <>
                  <Notice tone="info">{L("أنشأ هذه المسودة", "This draft was created by")} {p.createdByName ?? L("مسؤول آخر", "another administrator")}. {L("تعدّلها منشئتها فقط؛ يمكنك اعتمادها أو تركها لمراجعة أخرى.", "Only its creator edits it; you can approve it or leave it for another review.")}</Notice>
                  {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
                  {p.isProposal ? (
                    <div data-testid="hr-policy-proposal-block"><Notice tone="warning">{L("هذه المسودة ما زالت «مقترحة»، فلا تُعتمد ولا تسري. تُزيل منشئتها علامة «مقترح» بعد تأكيد المحاسب للقيم، ثم يعتمدها مسؤول آخر.", "This draft is still proposed, so it cannot be approved or take effect. Its creator removes the proposed mark once the accountant confirms the values; another manager then approves it.")}</Notice></div>
                  ) : (
                    <div className="hr-actions" style={{ display: "flex", gap: 8 }}>
                      <Btn variant="primary" busy={act.busy === p.id} onClick={() => void activate(p)}>{L("اعتماد النسخة", "Approve version")} <span className="hr-num">{p.version}</span></Btn>
                    </div>
                  )}
                  <p className="hr-caption" style={{ margin: 0 }}>{L("الاعتماد يجعل المسودة سارية من تاريخها، ولا يغيّر أي مسير محسوب. لا يعتمد المسودة من أنشأها (قيد في قاعدة البيانات أيضًا).", "Approval makes the draft active from its date and changes no calculated run. Whoever created the draft cannot approve it (also enforced in the database).")}</p>
                </>
              ) : (
                <p className="hr-caption" style={{ margin: 0 }}>{p.status === "ACTIVE" ? L("نسخة سارية", "Active version") : L("نسخة متقاعدة", "Retired version")}{L(": للقراءة فقط ولا تُعدَّل، في الواجهة والخادم وقاعدة البيانات. لتغييرها أنشئ مسودة نسخة جديدة بتاريخ سريان.", ": read-only and never edited — in the interface, the server and the database. To change it, create a new draft version with an effective date.")}</p>
              )}
            </>
          )}
          {p.notes && !(isDraft && mine) ? <p className="hr-caption" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{p.notes}</p> : null}
        </div>
      ) : null}
      <div className="hr-stack">
        <h2 className="hr-section">{L("النسخ", "Versions")}</h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("نسخ سياسة الرواتب", "Payroll policy versions")}>
            <thead><tr><th>{L("النسخة", "Version")}</th><th className="num">{L("سارية من", "Effective from")}</th><th>{L("الحالة", "Status")}</th><th>{L("أنشأها · اعتمدها", "Created by · approved by")}</th></tr></thead>
            <tbody>
              {policies.map((x) => (
                <tr key={x.id} className="is-clickable" aria-selected={p?.id === x.id} tabIndex={0} onClick={() => setSel(x.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(x.id); } }}>
                  <td data-label={L("النسخة", "Version")} className="strong m-title">{L("نسخة", "Version")} <span className="hr-num">{x.version}</span><span className="hr-msub">{L("من", "from")} <span className="hr-num">{x.effectiveFrom}</span> · {x.createdByName ?? "—"}</span></td>
                  <td data-label={L("سارية من", "Effective from")} className="num">{x.effectiveFrom}</td>
                  <td data-label={L("الحالة", "Status")} className="m-end"><span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><StatusDot map={POLICY_STATUS} value={x.status} /><span className="hr-hide-mobile">{x.isProposal ? <ProposalTag /> : null}</span></span></td>
                  <td data-label={L("أنشأها · اعتمدها", "Created by · approved by")}>{x.createdByName ?? "—"}{x.activatedByName ? <> · {x.activatedByName}</> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hr-caption" style={{ margin: 0 }}>{L("النسخة السارية والمتقاعدة للقراءة فقط. التغيير يكون بمسودة نسخة جديدة بتاريخ سريان؛ المسيرات السابقة تحتفظ بالنسخة التي حُسبت بها. من أنشأ المسودة لا يعتمدها.", "Active and retired versions are read-only. Changes are made through a new draft version with an effective date; past runs keep the version they were calculated with. Whoever created a draft cannot approve it.")}</p>
      </div>
    </div>
  );
}

const fmtPct = (v: string) => `${v}%`;
/** Read-only facts of a version; for a draft, each value that differs from the active version is marked. */
function PolicyFacts({ p, base }: { p: Policy; base: Policy | null }) {
  const { L, lang } = useHrI18n();
  const changed = (now: string, was: string | undefined): [ReactNode, string?] => (base && was !== undefined && now !== was ? [<span key="c" className="hr-caption" style={{ color: "var(--hr-warning)" }}>{L("تغيّر · كان", "Changed · was")} <span className="hr-iso">{was}</span></span>, "warning"] : [null]);
  const row = (label: string, value: ReactNode, now: string, was?: string): [ReactNode, ReactNode] => {
    const [mark] = changed(now, was);
    return [mark ? <span key="l" style={{ display: "inline-flex", flexDirection: "column" }}>{label}{mark}</span> : label, value];
  };
  return (
    <KV rows={[
      row(L("سارية من", "Effective from"), <span key="e" className="hr-num">{p.effectiveFrom}</span>, p.effectiveFrom, base?.effectiveFrom),
      row(L("أساس احتساب اليوم", "Day calculation basis"), dayBasis(p.dayBasis, lang), p.dayBasis, base?.dayBasis),
      row(L("ساعات اليوم القياسية", "Standard hours per day"), <span key="h"><span className="hr-num">{p.standardDailyHours}</span> {L("ساعة", "hours")}</span>, p.standardDailyHours, base?.standardDailyHours),
      row(L("معامل العمل الإضافي", "Overtime multiplier"), <span key="o" className="hr-num">× {p.overtimeMultiplier}</span>, p.overtimeMultiplier, base?.overtimeMultiplier),
      row(L("حد الاستقطاعات من الإجمالي", "Deduction cap of gross"), <span key="m" className="hr-num">{fmtPct(p.maxDeductionPercent)}</span>, fmtPct(p.maxDeductionPercent), base ? fmtPct(base.maxDeductionPercent) : undefined),
      row(L("البدلات الداخلة في خصم الغياب", "Allowances included in absence deduction"), compLabel(p.unpaidLeaveComponents, lang), compLabel(p.unpaidLeaveComponents, lang), base ? compLabel(base.unpaidLeaveComponents, lang) : undefined),
      row(L("مكونات أجر العمل الإضافي", "Overtime pay components"), compLabel(p.overtimeComponents, lang), compLabel(p.overtimeComponents, lang), base ? compLabel(base.overtimeComponents, lang) : undefined),
      row(L("عطلة نهاية الأسبوع", "Weekend"), p.weekendDays.map((d) => WEEKDAYS[lang][d]).join(L("، ", ", ")) || "—", p.weekendDays.join(","), base?.weekendDays.join(",")),
      row(L("المنطقة الزمنية", "Time zone"), <span key="t" className="hr-num">{p.timezone}</span>, p.timezone, base?.timezone),
      [L("قواعد الاشتراكات", "Contribution rules"), p.contributionRules.length ? L(`${p.contributionRules.length} قاعدة`, `${p.contributionRules.length} rules`) : L("لا توجد", "None")],
      ...DED_CATS.map(([k, ar, en]): [ReactNode, ReactNode] => {
        const v = p[({ UNEARNED_PAY: "deductionCapUnearnedPercent", LOAN_RECOVERY: "deductionCapLoanPercent", STATUTORY: "deductionCapStatutoryPercent", OTHER: "deductionCapOtherPercent" } as const)[k as "OTHER"]];
        return [L(`حد ${ar}`, `Cap · ${en}`), v === null ? <Flag key={k} tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag> : <span key={k} className="hr-num">{fmtPct(v)}</span>];
      }),
      [L("يشمله الحد العام", "Covered by the overall cap"), p.deductionOverallCovers.length ? p.deductionOverallCovers.map((c) => DED_CATS.find((x) => x[0] === c)?.[lang === "en" ? 2 : 1] ?? c).join(L("، ", ", ")) : <Flag key="c" tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag>],
      [L("ترتيب التطبيق", "Order of application"), p.deductionPriority.length ? p.deductionPriority.map((c, i) => `${i + 1}. ${DED_CATS.find((x) => x[0] === c)?.[lang === "en" ? 2 : 1] ?? c}`).join(L("، ", ", ")) : <Flag key="o" tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag>],
      [L("عند تجاوز الحد", "When a cap is exceeded"), p.deductionCapAction ? (p.deductionCapAction === "BLOCK" ? L("يمنع الاعتماد", "Blocks the run") : L("تنبيه", "Warning")) : <Flag key="a" tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag>],
      [L("أساس الحد", "Cap base"), p.capBaseIncludesVariable ? L("الإجمالي بما فيه المتغير", "Gross including variable pay") : L("الأجر المضمون فقط (بلا عمولة ولا إضافي)", "Guaranteed pay only (no commission or overtime)")],
      [L("أساس الحد والأجر غير المستحق", "Cap base and unearned pay"), p.capBaseAfterUnearned === null || p.capBaseAfterUnearned === undefined ? <Flag key="u" tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag> : p.capBaseAfterUnearned ? L("بعد خصم الأجر غير المستحق", "After unearned pay") : L("قبل خصم الأجر غير المستحق", "Before unearned pay")],
      [L("تصعيد السلفة بعد تأجيلات", "Escalate an advance after deferrals"), p.advanceDeferralEscalateAfter ?? <Flag key="e" tone="warning">{L("لم يُحدَّد", "Not decided")}</Flag>],
    ]} />
  );
}

type PolicyValues = {
  effectiveFrom: string; dayBasis: string; standardDailyHours: string; overtimeMultiplier: string; maxDeductionPercent: string; timezone: string; notes: string; unpaid: string[]; ot: string[]; weekend: string[]; isProposal: boolean;
  dCapUnearned: string; dCapLoan: string; dCapStatutory: string; dCapOther: string; dCovers: string[]; dPriority: string[]; dAction: string; dEscalate: string; dVariable: boolean;
  /** P-2 review P2-B7: "" = not decided, "true" / "false". */
  dAfterUnearned: string;
};
const valuesOf = (p: Policy | null, effectiveFrom: string): PolicyValues => ({
  effectiveFrom, dayBasis: p?.dayBasis ?? "FIXED_30", standardDailyHours: p?.standardDailyHours ?? "8", overtimeMultiplier: p?.overtimeMultiplier ?? "1.5",
  maxDeductionPercent: p?.maxDeductionPercent ?? "50", timezone: p?.timezone ?? "Asia/Riyadh", notes: p?.notes ?? "",
  unpaid: p?.unpaidLeaveComponents ?? ["BASIC", "HOUSING", "TRANSPORT"], ot: p?.overtimeComponents ?? ["BASIC"], weekend: (p?.weekendDays ?? [5, 6]).map(String), isProposal: p?.isProposal ?? true,
  // P-2: never defaulted — a new draft carries what the version it starts from decided, or nothing.
  dCapUnearned: p?.deductionCapUnearnedPercent ?? "", dCapLoan: p?.deductionCapLoanPercent ?? "", dCapStatutory: p?.deductionCapStatutoryPercent ?? "", dCapOther: p?.deductionCapOtherPercent ?? "",
  dCovers: p?.deductionOverallCovers ?? [], dPriority: p?.deductionPriority ?? [], dAction: p?.deductionCapAction ?? "", dEscalate: p?.advanceDeferralEscalateAfter ? String(p.advanceDeferralEscalateAfter) : "", dVariable: p?.capBaseIncludesVariable ?? false,
  dAfterUnearned: p?.capBaseAfterUnearned === true ? "true" : p?.capBaseAfterUnearned === false ? "false" : "",
});
const bodyOf = (v: PolicyValues) => ({
  effectiveFrom: v.effectiveFrom, dayBasis: v.dayBasis, standardDailyHours: v.standardDailyHours, overtimeMultiplier: v.overtimeMultiplier, maxDeductionPercent: v.maxDeductionPercent,
  timezone: v.timezone, notes: v.notes || undefined, unpaidLeaveComponents: v.unpaid, overtimeComponents: v.ot, weekendDays: v.weekend.map(Number), isProposal: v.isProposal,
  capBaseIncludesVariable: v.dVariable, capBaseAfterUnearned: v.dAfterUnearned === "" ? null : v.dAfterUnearned === "true", deductionCapUnearnedPercent: v.dCapUnearned || null, deductionCapLoanPercent: v.dCapLoan || null, deductionCapStatutoryPercent: v.dCapStatutory || null, deductionCapOtherPercent: v.dCapOther || null,
  deductionOverallCovers: v.dCovers, deductionPriority: v.dPriority.length === 4 && new Set(v.dPriority).size === 4 ? v.dPriority : [], deductionCapAction: v.dAction || null, advanceDeferralEscalateAfter: v.dEscalate || null,
});

/** The editable fields of a version (new draft or draft edit); `base` marks what differs from the active version. */
function PolicyForm({ v, set, base, actions }: { v: PolicyValues; set: (p: Partial<PolicyValues>) => void; base: Policy | null; actions?: ReactNode }) {
  const { L, lang } = useHrI18n();
  const COMPONENTS = components(lang);
  const b = (k: keyof PolicyValues) => ({ value: v[k] as string, onChange: (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<PolicyValues>) });
  // The previous value is isolated: a bare date or zone inside Arabic text reorders (01-01-2026).
  const was = (now: string, before: string | undefined) => (base && before !== undefined && now !== before ? <span style={{ color: "var(--hr-warning)" }}>{L("تغيّر · كان", "Changed · was")} <span className="hr-iso">{before}</span></span> : undefined);
  // HR-09 R3: one fact per row. The weekend is not a field of this form any more (owner, 15 Oct):
  // the draft keeps the value of the version it was drafted from.
  // C-09 549:3646 / M-09 548:3762: the seven fields the frame draws come first — at 1024 they
  // fill the first column, then the second (effective date · day basis · hours · overtime factor,
  // then deduction cap · allowances · time zone) — with the draft's actions right under them;
  // the rows the frame does not draw (overtime components, proposal flag, notes) follow.
  return (
    <>
    <div className="hr-form is-rows is-policy-main">
      <Field label={L("سارية من *", "Effective from *")} help={was(v.effectiveFrom, base?.effectiveFrom)}><input className="hr-input" type="date" {...b("effectiveFrom")} /></Field>
      <Field label={L("أساس احتساب اليوم", "Day calculation basis")} help={was(dayBasis(v.dayBasis, lang), base ? dayBasis(base.dayBasis, lang) : undefined)}><Select className="hr-select" {...b("dayBasis")}><option value="FIXED_30">{dayBasis("FIXED_30", lang)}</option><option value="CALENDAR_DAYS">{dayBasis("CALENDAR_DAYS", lang)}</option></Select></Field>
      <Field label={L("ساعات اليوم القياسية", "Standard hours per day")} help={was(v.standardDailyHours, base?.standardDailyHours)}><input className="hr-input hr-num" inputMode="decimal" {...b("standardDailyHours")} /></Field>
      <Field label={L("معامل العمل الإضافي (×)", "Overtime multiplier (×)")} help={was(v.overtimeMultiplier, base?.overtimeMultiplier)}><input className="hr-input hr-num" inputMode="decimal" {...b("overtimeMultiplier")} /></Field>
      <Field label={L("حد الاستقطاعات من الإجمالي (%)", "Deduction cap of gross (%)")} help={was(`${v.maxDeductionPercent}%`, base ? `${base.maxDeductionPercent}%` : undefined)}><input className="hr-input hr-num" inputMode="decimal" {...b("maxDeductionPercent")} /></Field>
      <div className="hr-field is-checks"><span className="hr-label">{L("البدلات الداخلة في خصم الغياب *", "Allowances included in absence deduction *")}</span><Checks label="" options={COMPONENTS} value={v.unpaid} onChange={(unpaid) => set({ unpaid })} /></div>
      <Field label={L("المنطقة الزمنية", "Time zone")} help={was(v.timezone, base?.timezone) ?? <>{L("اسم", "An")} <span className="hr-iso">IANA</span> {L("، مثل", "name, e.g.")} <span className="hr-iso">Asia/Riyadh</span></>}><input className="hr-input" dir="ltr" {...b("timezone")} /></Field>
    </div>
    {actions}
    <div className="hr-form is-rows is-policy-extra">
      <div className="hr-field is-tall"><span className="hr-label">{L("مكونات أجر العمل الإضافي *", "Overtime pay components *")}</span><Checks label="" options={COMPONENTS} value={v.ot} onChange={(ot) => set({ ot })} /></div>
      <label className="hr-field is-tall" style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={v.isProposal} onChange={(e) => set({ isProposal: e.target.checked })} />
        <span>{L("مقترح غير معتمد من الإدارة أو المحاسب (لا تُعتمد النسخة ولا تسري ما دامت مقترحة)", "Proposed, not approved by management or the accountant (the version cannot be approved or take effect while proposed)")}</span>
      </label>
      <Field label={L("ملاحظات · المصدر", "Notes · source")} wide><textarea className="hr-textarea is-compact" rows={2} maxLength={1000} {...b("notes")} /></Field>
    </div>
    <DeductionFields v={v} set={set} />
    </>
  );
}

/**
 * P-2 findings 2/3: the deduction categories. Every value is the accountant's decision and none
 * is prefilled; while any is empty the version can be saved, but payroll refuses to run under it.
 */
function DeductionFields({ v, set }: { v: PolicyValues; set: (p: Partial<PolicyValues>) => void }) {
  const { L, lang } = useHrI18n();
  const name = (k: string) => DED_CATS.find((x) => x[0] === k)?.[lang === "en" ? 2 : 1] ?? k;
  const setPriority = (i: number, k: string) => { const next = [...(v.dPriority.length === 4 ? v.dPriority : ["", "", "", ""])]; next[i] = k; set({ dPriority: next }); };
  return (
    <fieldset className="hr-form is-rows" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="hr-label" style={{ marginBottom: 8 }}>{L("حدود الاستقطاع حسب الفئة (قرار المحاسب — لا يعمل المسير قبل تحديدها كلها)", "Deduction caps by category (accountant decisions — payroll does not run until all are set)")}</legend>
      {DED_CATS.map(([k]) => (
        <Field key={k} label={`${name(k)} (%)`}><input className="hr-input hr-num" inputMode="decimal" value={v[DED_CAP_FIELD[k]]} onChange={(e) => set({ [DED_CAP_FIELD[k]]: e.target.value } as Partial<PolicyValues>)} /></Field>
      ))}
      <div className="hr-field is-checks"><span className="hr-label">{L("يشملها الحد العام للاستقطاع", "Covered by the overall deduction cap")}</span><Checks label="" options={DED_CATS.map(([k]) => [k, name(k)] as [string, string])} value={v.dCovers} onChange={(dCovers) => set({ dCovers })} /></div>
      {[0, 1, 2, 3].map((i) => (
        <Field key={i} label={L(`ترتيب التطبيق ${i + 1}`, `Applied ${i + 1}${["st", "nd", "rd", "th"][i]}`)}>
          <Select className="hr-select" value={v.dPriority[i] ?? ""} onChange={(e) => setPriority(i, e.target.value)}>
            <option value="">{L("— لم يُحدَّد —", "— not decided —")}</option>
            {DED_CATS.map(([k]) => <option key={k} value={k}>{name(k)}</option>)}
          </Select>
        </Field>
      ))}
      <Field label={L("عند تجاوز الحد", "When a cap is exceeded")}>
        <Select className="hr-select" value={v.dAction} onChange={(e) => set({ dAction: e.target.value })}>
          <option value="">{L("— لم يُحدَّد —", "— not decided —")}</option>
          <option value="WARN">{L("تنبيه فقط", "Warn only")}</option>
          <option value="BLOCK">{L("يمنع إرسال المسير", "Block the run")}</option>
        </Select>
      </Field>
      <Field label={L("أساس الحد والأجر غير المستحق", "Cap base and unearned pay")}>
        <Select className="hr-select" value={v.dAfterUnearned} onChange={(e) => set({ dAfterUnearned: e.target.value })}>
          <option value="">{L("— لم يُحدَّد —", "— not decided —")}</option>
          <option value="true">{L("بعد خصم الأجر غير المستحق", "After unearned pay")}</option>
          <option value="false">{L("قبل خصم الأجر غير المستحق", "Before unearned pay")}</option>
        </Select>
      </Field>
      <Field label={L("تصعيد السلفة بعد عدد تأجيلات متتالية", "Escalate an advance after N consecutive deferrals")}><input className="hr-input hr-num" inputMode="numeric" value={v.dEscalate} onChange={(e) => set({ dEscalate: e.target.value })} /></Field>
      <label className="hr-field is-tall" style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={v.dVariable} onChange={(e) => set({ dVariable: e.target.checked })} />
        <span>{L("يشمل أساس الحد الأجر المتغير (العمولة والإضافي). الافتراضي: الأجر المضمون فقط.", "The cap base includes variable pay (commission, overtime). Default: guaranteed pay only.")}</span>
      </label>
    </fieldset>
  );
}

/** HR-09 R3: the drafter edits their DRAFT in place; saving writes the same draft (never a released version). */
function DraftEditor({ p, base, onSaved }: { p: Policy; base: Policy | null; onSaved: () => void }) {
  const initial = useMemo(() => valuesOf(p, p.effectiveFrom), [p]);
  const [v, setV] = useState<PolicyValues>(initial);
  const act = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const { L } = useHrI18n();
  const save = () => act.run("save", async () => {
    await hrFetch(`/api/hr/policy/${p.id}`, { method: "PUT", json: bodyOf(v) });
    onSaved();
  });
  // The form's rows, its actions and the caption are direct children of this stack, so on the
  // phone the actions can be moved last (CSS order) and the sticky bar holds to the end of the
  // form; 768+ keeps them under the frame fields, where C-09 draws them.
  return (
    <div className="hr-stack hr-draft-editor">
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <PolicyForm v={v} set={(x) => setV((s) => ({ ...s, ...x }))} base={base} actions={
        <div className="hr-actions hr-policy-actions">
          <Btn variant="primary" busy={act.busy === "save"} disabled={!dirty || !v.effectiveFrom || !v.unpaid.length || !v.ot.length} onClick={save}>{L("حفظ المسودة", "Save draft")}</Btn>
          <Btn disabled={!dirty} onClick={() => setV(initial)}><span className="hr-hide-mobile">{L("تراجع عن التغييرات", "Discard changes")}</span><span className="hr-mobile-only">{L("تراجع", "Discard")}</span></Btn>
        </div>
      } />
      <p className="hr-caption" style={{ margin: 0 }}>{L("«حفظ المسودة» يحفظ القيم على هذه المسودة نفسها ولا يمس النسخة السارية. يعتمدها مسؤول سياسات آخر، فلا يظهر لك زر «اعتماد» هنا. يرفض الخادم أي تعديل على نسخة غير مسودة أو من غير منشئها.", "Save draft saves the values on this draft itself and does not touch the active version. Another policy administrator approves it, so no Approve button is shown to you here. The server refuses any edit to a non-draft version or by anyone but its creator.")}</p>
    </div>
  );
}

function Checks({ options, value, onChange, label }: { options: [string, string][]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {label ? <legend className="hr-label" style={{ marginBottom: 6 }}>{label}</legend> : null}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {options.map(([k, l]) => (
          <label key={k} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
            {l}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NewPolicy({ base, onClose, onDone }: { base: Policy | null; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<PolicyValues>(() => ({ ...valuesOf(base, todayIso()), notes: "", isProposal: true }));
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("p", async () => {
    await hrFetch("/api/hr/policy", { json: bodyOf(v) });
    onDone();
  });
  return (
    <Dialog open title={base ? L(`مسودة جديدة (من النسخة ${base.version})`, `New draft (from version ${base.version})`) : L("مسودة سياسة جديدة", "New policy draft")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "p"} disabled={!v.effectiveFrom || !v.unpaid.length || !v.ot.length} onClick={submit}>{L("حفظ كمسودة", "Save as draft")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <PolicyForm v={v} set={(x) => setV((s) => ({ ...s, ...x }))} base={base} />
      <p className="hr-caption" style={{ margin: 0 }}>{L("تُحفظ النسخة مسودة يمكنك تعديلها حتى الاعتماد. يعتمدها مسؤول آخر غيرك؛ المسيرات السابقة تحتفظ بالنسخة التي حُسبت بها.", "The version is saved as a draft you can edit until approval. Another administrator approves it; past runs keep the version they were calculated with.")}</p>
    </Dialog>
  );
}

// ── Account map ────────────────────────────────────────────────────────────────────

function AccountsTab({ map, reload }: { map: Overview["accountMap"]; reload: () => void }) {
  const act = useAction();
  const pending = usePendingChanges();
  const [pick, setPick] = useState<Record<string, string>>({});
  const { L, lang } = useHrI18n();
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const waiting = new Set((pending.data ?? []).filter((c) => c.kind === "ACCOUNT_MAP_SET").map((c) => (c.payload as { key: string }).key));
  // F2: a change is REQUESTED here; it takes effect only when another policy manager approves it.
  const save = (key: string) => act.run(key, async () => {
    await hrFetch("/api/hr/policy/accounts", { json: { key, accountId: pick[key], reason: reason.trim() } });
    setPick((s) => ({ ...s, [key]: "" }));
    setSent(key);
    void pending.reload();
    reload();
  });
  return (
    <div className="hr-stack">
      <h2 className="hr-section">{L("ربط الحسابات (دليل الحسابات الحالي)", "Account mapping (current chart of accounts)")}</h2>
      <PendingChanges q={pending} kinds={["ACCOUNT_MAP_SET"]} onDecided={reload} />
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {sent ? <Notice tone="success">{L(`أُرسل طلب ربط ${accountLabel(sent, lang)} للاعتماد. يبقى الربط الحالي ساريًا حتى يعتمده مسؤول سياسات آخر.`, `The request to map ${accountLabel(sent, lang)} was sent for approval. The current mapping stays in effect until another policy manager approves it.`)}</Notice> : null}
      {map.postable.length === 0 ? <Notice tone="warning">{L("لا توجد حسابات ترحيل (فرعية نشطة تقبل الترحيل) في دليل الحسابات.", "The chart of accounts has no postable accounts (active sub-accounts that accept postings).")}</Notice> : null}
      <Field label={L("سبب طلب التغيير *", "Reason for the change request *")} help={L("خمسة أحرف على الأقل؛ يُحفظ مع الطلب وفي سجل التدقيق.", "At least five characters; kept with the request and in the audit log.")}><input className="hr-input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="hr-tablewrap">
        <table className="hr-table is-stack" aria-label={L("ربط الحسابات", "Account mapping")}>
          <thead><tr><th>{L("البند", "Item")}</th><th>{L("الحساب", "Account")}</th><th>{L("الحالة", "Status")}</th><th>{L("طلب تغيير", "Change request")}</th></tr></thead>
          <tbody>
            {map.keys.map(({ key, account }) => (
              <tr key={key}>
                <td data-label={L("البند", "Item")} className="strong hr-wrap-en"><span className="hr-nowrap">{accountLabel(key, lang)}</span><span className="sub hr-id">{key}</span></td>
                <td data-label={L("الحساب", "Account")}>{account ? <span className="hr-iso">{accName(account, lang)}</span> : "—"}</td>
                <td data-label={L("الحالة", "Status")}><span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>{account ? <Dot tone="success">{L("مربوط", "Mapped")}</Dot> : <Flag>{L("غير مربوط", "Not mapped")}</Flag>}{waiting.has(key) ? <Flag tone="info">{L("تغيير بانتظار الاعتماد", "Change awaiting approval")}</Flag> : null}</span></td>
                <td data-label={L("طلب تغيير", "Change request")}>
                  <span style={{ display: "flex", gap: 6 }}>
                    <Select className="hr-select" style={{ height: "var(--hr-control-sm)", minWidth: 180 }} aria-label={L(`حساب ${accountLabel(key, lang)}`, `${accountLabel(key, lang)} account`)} disabled={waiting.has(key)} value={pick[key] ?? ""} onChange={(e) => setPick((s) => ({ ...s, [key]: e.target.value }))}>
                      <option value="">{account ? L("اختر لتغييره…", "Choose to change…") : L("اختر حسابًا…", "Choose an account…")}</option>
                      {map.postable.map((a) => <option key={a.id} value={a.id}>{accName(a, lang)}</option>)}
                    </Select>
                    <Btn size="sm" variant={pick[key] ? "primary" : "secondary"} disabled={!pick[key] || pick[key] === account?.id || reason.trim().length < 5 || waiting.has(key)} busy={act.busy === key} onClick={() => save(key)}>{L("طلب الربط", "Request mapping")}</Btn>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("كل تغيير في الربط طلبٌ يعتمده مسؤول سياسات آخر غير مقدّمه، ويُطبَّق عند اعتماده فقط. لا يُعتمد مسير ولا تُصرف سلفة قبل ربط كل حساب يحتاجه القيد. كل طلب وقرار يُسجَّل في سجل التدقيق.", "Every mapping change is a request that a policy manager other than its requester approves, and it applies only once approved. No run is approved and no advance paid until every account the entry needs is mapped. Every request and decision is recorded in the audit log.")}</p>
    </div>
  );
}

// ── Configuration change requests (F2: independent approval) ────────────────────────

type ConfigChange = {
  id: string; kind: "ACCOUNT_MAP_SET" | "ACCOUNTING_TOGGLE" | "LEAVE_TYPE_CREATE"; targetKey: string; payload: Record<string, unknown>; before: unknown;
  fingerprint: string; reason: string; status: string; requestedByName: string | null; requestedAt: string; mine: boolean;
};
function usePendingChanges() {
  return useHr<ConfigChange[]>("/api/hr/config-changes?status=pending");
}
function describeChange(c: ConfigChange, lang: Lang): string {
  const en = lang === "en";
  if (c.kind === "ACCOUNT_MAP_SET") { const k = (c.payload as { key: string }).key; return en ? `Map ${accountLabel(k, lang)} to another account` : `ربط ${accountLabel(k, lang)} بحساب آخر`; }
  if (c.kind === "ACCOUNTING_TOGGLE") {
    const on = (c.payload as { accountingEnabled: boolean }).accountingEnabled;
    return on ? (en ? "Turn HR accounting on" : "تفعيل محاسبة الموارد البشرية") : (en ? "Turn HR accounting off (no journal entries)" : "إيقاف محاسبة الموارد البشرية (بلا قيود)");
  }
  const p = c.payload as { code: string; nameAr: string };
  return en ? `New leave type: ${p.nameAr} (${p.code})` : `نوع إجازة جديد: ${p.nameAr} (${p.code})`;
}

function PendingChanges({ q, kinds, onDecided }: { q: ReturnType<typeof usePendingChanges>; kinds: ConfigChange["kind"][]; onDecided: () => void }) {
  const { L, lang } = useHrI18n();
  const act = useAction();
  const [rejecting, setRejecting] = useState<ConfigChange | null>(null);
  const [note, setNote] = useState("");
  const rows = (q.data ?? []).filter((c) => kinds.includes(c.kind));
  const done = () => { void q.reload(); onDecided(); };
  const approve = (c: ConfigChange) => act.run(`a${c.id}`, async () => { await hrFetch(`/api/hr/config-changes/${c.id}/decide`, { json: { decision: "APPROVE", expected: c.fingerprint } }); done(); });
  const withdraw = (c: ConfigChange) => act.run(`w${c.id}`, async () => { await hrFetch(`/api/hr/config-changes/${c.id}/withdraw`, { json: {} }); done(); });
  const reject = () => rejecting && act.run(`r${rejecting.id}`, async () => { await hrFetch(`/api/hr/config-changes/${rejecting.id}/decide`, { json: { decision: "REJECT", note: note.trim() } }); setRejecting(null); setNote(""); done(); });
  if (!rows.length) return null;
  return (
    <section className="hr-stack" data-testid="hr-config-pending" style={{ gap: 8 }}>
      <span className="hr-label">{L("طلبات بانتظار الاعتماد", "Requests awaiting approval")}</span>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {rows.map((c) => (
        <div key={c.id} className="hr-notice tone-info" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span>
            <strong>{describeChange(c, lang)}</strong>
            <span className="hr-caption" style={{ display: "block" }}>{L("طلبه", "Requested by")} {c.requestedByName ?? "—"} · <span className="hr-num">{dateTimeIn(c.requestedAt)}</span> · {c.reason}</span>
            <span className="hr-caption" style={{ display: "block" }}>{L("الإعداد الحالي يبقى ساريًا حتى الاعتماد.", "The current setting stays in effect until approval.")}</span>
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            {c.mine ? (
              <Btn size="sm" variant="ghost" busy={act.busy === `w${c.id}`} onClick={() => void withdraw(c)} title={L("طلبته؛ يعتمده مسؤول آخر", "You requested it; another manager approves it")}>{L("سحب الطلب", "Withdraw")}</Btn>
            ) : (
              <>
                <Btn size="sm" variant="primary" busy={act.busy === `a${c.id}`} onClick={() => void approve(c)}>{L("اعتماد وتطبيق", "Approve and apply")}</Btn>
                <Btn size="sm" variant="danger" onClick={() => setRejecting(c)}>{L("رفض", "Reject")}</Btn>
              </>
            )}
          </span>
        </div>
      ))}
      {rejecting ? (
        <Dialog open title={L("رفض طلب التغيير", "Reject the change request")} onClose={() => setRejecting(null)} actions={<><Btn variant="danger" disabled={note.trim().length < 3} busy={act.busy === `r${rejecting.id}`} onClick={() => void reject()}>{L("رفض", "Reject")}</Btn><Btn onClick={() => setRejecting(null)}>{L("تراجع", "Back")}</Btn></>}>
          <p className="hr-body-s" style={{ margin: 0 }}>{describeChange(rejecting, lang)}</p>
          <Field label={L("سبب الرفض *", "Reason for rejecting *")}><textarea className="hr-textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </Dialog>
      ) : null}
    </section>
  );
}

// ── Leave types ────────────────────────────────────────────────────────────────────

function LeaveTypes() {
  const { reload: reloadMeta } = useHrMeta();
  const q = useHr<LeaveType[]>("/api/hr/leave/types");
  const pending = usePendingChanges();
  const [adding, setAdding] = useState(false);
  const { L, lang } = useHrI18n();
  const [sent, setSent] = useState(false);
  return (
    <div className="hr-stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="hr-section">{L("أنواع الإجازات", "Leave types")}</h2>
        <Btn onClick={() => setAdding(true)}>{L("+ طلب نوع إجازة", "+ Leave type request")}</Btn>
      </div>
      <PendingChanges q={pending} kinds={["LEAVE_TYPE_CREATE"]} onDecided={() => { void q.reload(); reloadMeta(); }} />
      {sent ? <Notice tone="success">{L("أُرسل طلب نوع الإجازة للاعتماد؛ يُضاف عند اعتماده من مسؤول سياسات آخر.", "The leave type request was sent for approval; it is added once another policy manager approves it.")}</Notice> : null}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <LoadingTable rows={4} /> : null}
      {q.data && q.data.length === 0 ? <Empty title={L("لا أنواع إجازات", "No leave types")} body={L("أضف أنواع الإجازات المعتمدة لديكم. الاستحقاق السنوي يُدخل من سياسة الشركة أو نظام العمل.", "Add the leave types you use. The annual accrual comes from company policy or the labour law.")} action={<Btn variant="primary" onClick={() => setAdding(true)}>{L("نوع إجازة", "Leave type")}</Btn>} /> : null}
      {q.data && q.data.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("أنواع الإجازات", "Leave types")}>
            <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th><th>{L("مدفوعة", "Paid")}</th><th>{L("تخصم من رصيد", "Deducted from a balance")}</th><th className="num">{L("الاستحقاق السنوي", "Annual accrual")}</th><th>{L("رصيد سالب", "Negative balance")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {q.data.map((lt) => (
                <tr key={lt.id}>
                  <td data-label={L("الرمز", "Code")}><span className="hr-id">{lt.code}</span></td>
                  <td data-label={L("الاسم", "Name")} className="strong">{leaveTypeName(lt, lang)}</td>
                  <td data-label={L("مدفوعة", "Paid")}>{lt.paid ? L("نعم", "Yes") : L("لا", "No")}</td>
                  <td data-label={L("تخصم من رصيد", "Deducted from a balance")}>{lt.tracksBalance ? L("نعم", "Yes") : L("لا", "No")}</td>
                  <td data-label={L("الاستحقاق السنوي", "Annual accrual")} className="num">{lt.accrualDaysPerYear ? L(`${Number(lt.accrualDaysPerYear)} يومًا`, `${Number(lt.accrualDaysPerYear)} days`) : "—"}</td>
                  <td data-label={L("رصيد سالب", "Negative balance")}>{lt.allowNegative ? L("مسموح", "Allowed") : L("غير مسموح", "Not allowed")}</td>
                  <td data-label={L("الحالة", "Status")}><span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>{lt.active ? <Dot tone="success">{L("نشط", "Active")}</Dot> : <Dot tone="cancelled">{L("موقوف", "Inactive")}</Dot>}{lt.isProposal ? <ProposalTag /> : null}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {adding ? <NewLeaveType onClose={() => setAdding(false)} onDone={() => { setAdding(false); setSent(true); void pending.reload(); }} /> : null}
    </div>
  );
}

function NewLeaveType({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const f = useForm({ code: "", nameAr: "", accrualDaysPerYear: "", reason: "" });
  const [flags, setFlags] = useState({ paid: true, tracksBalance: true, allowNegative: false, isProposal: true });
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("t", async () => {
    await hrFetch("/api/hr/leave/types", { json: { ...f.v, reason: f.v.reason.trim(), accrualDaysPerYear: f.v.accrualDaysPerYear || null, ...flags } });
    onDone();
  });
  const box = (k: keyof typeof flags, l: string) => (
    <label key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags((s) => ({ ...s, [k]: e.target.checked }))} />{l}
    </label>
  );
  return (
    <Dialog open title={L("طلب نوع إجازة جديد", "New leave type request")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "t"} disabled={!f.v.code || !f.v.nameAr || f.v.reason.trim().length < 5} onClick={submit}>{L("إرسال للاعتماد", "Send for approval")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الرمز *", "Code *")}><input className="hr-input" dir="ltr" maxLength={20} {...f.bind("code")} /></Field>
        <Field label={L("الاسم *", "Name *")}><input className="hr-input" maxLength={80} {...f.bind("nameAr")} /></Field>
        <Field label={L("الاستحقاق السنوي (يوم)", "Annual accrual (days)")} help={L("يُضاف شهريًا بمهمة الاستحقاق. اتركه فارغًا إن لم يُستحق.", "Added monthly by the accrual job. Leave empty if it does not accrue.")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("accrualDaysPerYear")} /></Field>
        <div className="hr-stack" style={{ gap: 6 }}>
          {box("paid", L("مدفوعة الأجر", "Paid"))}
          {box("tracksBalance", L("تخصم من رصيد", "Deducted from a balance"))}
          {box("allowNegative", L("تسمح برصيد سالب", "Allows a negative balance"))}
          {box("isProposal", L("مقترح غير معتمد", "Proposed, not approved"))}
        </div>
        <Field label={L("سبب الطلب *", "Reason for the request *")} help={L("يُضاف النوع عند اعتماده من مسؤول سياسات آخر.", "The type is added once another policy manager approves it.")} wide><textarea className="hr-textarea" maxLength={300} {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}

// ── Contribution rules ─────────────────────────────────────────────────────────────

function RulesTab({ policies, me, reload }: { policies: Policy[]; me: string | null; reload: () => void }) {
  const drafts = policies.filter((p) => p.status === "DRAFT");
  const [pid, setPid] = useState<string>(drafts[0]?.id ?? policies[0]?.id ?? "");
  const p = policies.find((x) => x.id === pid) ?? null;
  const [adding, setAdding] = useState(false);
  const { L, lang } = useHrI18n();
  if (!policies.length) return <Empty title={L("لا توجد سياسة", "No policy")} body={L("تُضاف قواعد الاشتراكات إلى نسخة سياسة مسودة. أنشئ نسخة أولًا من «سياسة الرواتب».", "Contribution rules are added to a draft policy version. Create a version first under Payroll policy.")} />;
  return (
    <div className="hr-stack">
      <div className="hr-filterbar">
        <label className="hr-chip">{L("النسخة:", "Version:")}
          <Select value={pid} onChange={(e) => setPid(e.target.value)} aria-label={L("نسخة السياسة", "Policy version")}>
            {policies.map((x) => <option key={x.id} value={x.id}>{L("نسخة", "Version")} {x.version} · {statusLabel(POLICY_STATUS, x.status, lang)}</option>)}
          </Select>
        </label>
        {p?.status === "DRAFT" && p.createdBy === me ? <Btn variant="primary" onClick={() => setAdding(true)}>{L("+ قاعدة اشتراك", "+ Contribution rule")}</Btn> : null}
      </div>
      {p?.status === "DRAFT" && p.createdBy !== me ? <Notice tone="info">{L("يضيف قواعد هذه المسودة منشئها فقط", "Only this draft’s creator adds its rules")} ({p.createdByName ?? L("مسؤول آخر", "another administrator")}){L("؛ يمكنك مراجعتها واعتمادها من «سياسة الرواتب».", "; you can review and approve it under Payroll policy.")}</Notice> : null}
      {p && p.status !== "DRAFT" ? <Notice tone="info">{L("هذه النسخة", "This version is")} {statusLabel(POLICY_STATUS, p.status, lang)}{L("؛ لا تتغير قواعدها. تُضاف القواعد إلى نسخة مسودة ثم تُعتمد.", "; its rules do not change. Rules are added to a draft version, then approved.")}</Notice> : null}
      {!drafts.length ? <p className="hr-caption" style={{ margin: 0 }}>{L("لا توجد نسخة مسودة. أنشئ «نسخة جديدة» من تبويب سياسة الرواتب لإضافة قواعد.", "No draft version exists. Create a new version on the Payroll policy tab to add rules.")}</p> : null}
      {p && p.contributionRules.length === 0 ? (
        <Empty title={L("لا قواعد اشتراكات", "No contribution rules")} body={L("لا تُزرع أي نسبة تأمينات افتراضيًا. أدخل كل قاعدة من مصدر رسمي مع ذكره، ويراجعها المحاسب قبل الاعتماد.", "No insurance rate is seeded by default. Enter each rule from an official source and cite it; the accountant reviews it before approval.")} />
      ) : null}
      {p && p.contributionRules.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("قواعد الاشتراكات", "Contribution rules")}>
            <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th><th>{L("الفئة", "Group")}</th><th className="num">{L("الموظف %", "Employee %")}</th><th className="num">{L("صاحب العمل %", "Employer %")}</th><th>{L("الوعاء", "Base")}</th><th className="num">{L("سقف الوعاء", "Base cap")}</th><th>{L("المصدر", "Source")}</th></tr></thead>
            <tbody>
              {p.contributionRules.map((r) => (
                <tr key={r.id}>
                  <td data-label={L("الرمز", "Code")}><span className="hr-id">{r.code}</span></td>
                  <td data-label={L("الاسم", "Name")} className="strong">{r.nameAr}</td>
                  <td data-label={L("الفئة", "Group")}><span className="hr-id">{r.appliesToGroup}</span></td>
                  <td data-label={L("الموظف %", "Employee %")} className="num">{r.employeeRatePercent}</td>
                  <td data-label={L("صاحب العمل %", "Employer %")} className="num">{r.employerRatePercent}</td>
                  <td data-label={L("الوعاء", "Base")}>{compLabel(r.baseComponents, lang)}</td>
                  <td data-label={L("سقف الوعاء", "Base cap")} className="num">{r.monthlyBaseCap ? money(r.monthlyBaseCap) : "—"}</td>
                  <td data-label={L("المصدر", "Source")} className="hr-caption">{r.sourceNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {adding && p ? <NewRule policy={p} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} /> : null}
    </div>
  );
}

function NewRule({ policy, onClose, onDone }: { policy: Policy; onClose: () => void; onDone: () => void }) {
  const f = useForm({ code: "", nameAr: "", employeeRatePercent: "", employerRatePercent: "", appliesToGroup: "", monthlyBaseCap: "", sourceNote: "" });
  const [base, setBase] = useState<string[]>(["BASIC", "HOUSING"]);
  const act = useAction();
  const { L, lang } = useHrI18n();
  const noteOk = f.v.sourceNote.trim().length >= 10;
  const valid = useMemo(() => !!(f.v.code && f.v.nameAr && f.v.employeeRatePercent !== "" && f.v.employerRatePercent !== "" && f.v.appliesToGroup && base.length && noteOk), [f.v, base, noteOk]);
  const submit = () => act.run("r", async () => {
    await hrFetch(`/api/hr/policy/${policy.id}/rules`, { json: { ...f.v, monthlyBaseCap: f.v.monthlyBaseCap || null, baseComponents: base } });
    onDone();
  });
  return (
    <Dialog open title={L(`قاعدة اشتراك · نسخة ${policy.version}`, `Contribution rule · version ${policy.version}`)} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "r"} disabled={!valid} onClick={submit}>{L("إضافة", "Add")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <Notice tone="warning">{L("لا تُدخل نسبة من الذاكرة. انقل النسبة والسقف من المصدر الرسمي واذكره، ويراجعها المحاسب.", "Don’t enter a rate from memory. Copy the rate and cap from the official source and cite it; the accountant reviews it.")}</Notice>
      <div className="hr-form">
        <Field label={L("الرمز *", "Code *")}><input className="hr-input" dir="ltr" maxLength={20} {...f.bind("code")} /></Field>
        <Field label={L("الاسم *", "Name *")}><input className="hr-input" maxLength={80} {...f.bind("nameAr")} /></Field>
        <Field label={L("نسبة الموظف % *", "Employee rate % *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("employeeRatePercent")} /></Field>
        <Field label={L("نسبة صاحب العمل % *", "Employer rate % *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("employerRatePercent")} /></Field>
        <Field label={L("فئة الموظفين *", "Employee group *")} help={L("تطابق «فئة الاشتراك» في البيانات الخاصة للموظف.", "Matches the contribution group in the employee’s private data.")}><Combobox className="hr-input" dir="ltr" maxLength={40} {...f.bind("appliesToGroup")} options={[{ value: "SAUDI" }, { value: "NON_SAUDI" }]} /></Field>
        <Field label={L("سقف الوعاء الشهري", "Monthly base cap")} help={L("اختياري.", "Optional.")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("monthlyBaseCap")} /></Field>
        <div className="is-wide"><Checks label={L("مكونات الوعاء *", "Base components *")} options={components(lang)} value={base} onChange={setBase} /></div>
        <Field label={L("المصدر الرسمي *", "Official source *")} wide error={f.v.sourceNote && !noteOk ? L("اذكر المصدر بعشرة أحرف على الأقل.", "Cite the source in at least ten characters.") : null} help={L("مثل: اسم النظام أو التعميم ورقم المادة وتاريخه.", "e.g. the regulation or circular name, article number and date.")}>
          <textarea className="hr-textarea" maxLength={500} {...f.bind("sourceNote")} />
        </Field>
      </div>
    </Dialog>
  );
}

// ── Accounting switch ──────────────────────────────────────────────────────────────

function AccountingTab({ enabled, updatedAt, reload }: { enabled: boolean; updatedAt?: string; reload: () => void }) {
  const [next, setNext] = useState(enabled);
  const [reason, setReason] = useState("");
  const act = useAction();
  const pending = usePendingChanges();
  const [sent, setSent] = useState(false);
  const waiting = (pending.data ?? []).some((c) => c.kind === "ACCOUNTING_TOGGLE");
  const changed = next !== enabled;
  const { L } = useHrI18n();
  // F2: switching is REQUESTED; it applies only when another policy manager approves it.
  const save = () => act.run("s", async () => {
    await hrFetch("/api/hr/policy/settings", { method: "PUT", json: { accountingEnabled: next, reason: reason.trim() } });
    setReason("");
    setSent(true);
    void pending.reload();
  });
  return (
    <div className="hr-stack" style={{ maxWidth: 640 }}>
      <h2 className="hr-section">{L("ربط الموارد البشرية بالمحاسبة", "HR to accounting link")}</h2>
      <PendingChanges q={pending} kinds={["ACCOUNTING_TOGGLE"]} onDecided={() => { setSent(false); reload(); }} />
      {sent ? <Notice tone="success">{L("أُرسل طلب التغيير للاعتماد. تبقى الحالة الحالية سارية حتى يعتمده مسؤول سياسات آخر.", "The change request was sent for approval. The current state stays in effect until another policy manager approves it.")}</Notice> : null}
      <KV rows={[
        [L("الحالة الحالية", "Current state"), enabled ? <Dot key="s" tone="success">{L("مفعّل · تُنشأ القيود", "On · entries are created")}</Dot> : <Dot key="s" tone="warning">{L("موقوف · بلا قيود", "Off · no entries")}</Dot>],
        [L("آخر تغيير", "Last change"), updatedAt ? <span key="u" className="hr-num">{dateTimeIn(updatedAt)}</span> : "—"],
      ]} />
      <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input type="checkbox" role="switch" aria-checked={next} checked={next} onChange={(e) => setNext(e.target.checked)} />
        <span>{L("إنشاء قيود محاسبية لأحداث الموارد البشرية المالية (اعتماد المسير، صرفه، صرف السلف وسدادها)", "Create accounting entries for HR financial events (run approval and payment, advance payment and repayment)")}</span>
      </label>
      <p className="hr-caption" style={{ margin: 0 }}>{L("عند الإيقاف تُسجِّل الموارد البشرية الأحداث المالية (المسير، الصرف، السلف) دون إنشاء قيود، وتُعلَّم كل حركة بأنها «بلا قيد محاسبي» ليُعالجها المحاسب يدويًا. إعادة التفعيل لا تُنشئ قيودًا بأثر رجعي للأحداث السابقة. عند التفعيل يُشترط اكتمال إعداد المحاسبة وربط الحسابات.", "When off, HR records financial events (runs, payments, advances) without creating entries, and marks each as having no accounting entry for the accountant to handle by hand. Turning it back on creates no entries for past events. Turning it on requires accounting setup and account mapping to be complete.")}</p>
      {changed ? (
        <Field label={L("سبب التغيير *", "Reason for the change *")} help={L("يُحفظ في سجل التدقيق.", "Kept in the audit log.")}><textarea className="hr-textarea" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      ) : null}
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div><Btn variant="primary" disabled={!changed || reason.trim().length < 5 || waiting} busy={act.busy === "s"} onClick={save}>{L("طلب التغيير", "Request the change")}</Btn></div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("التشغيل والإيقاف طلبٌ يعتمده مسؤول سياسات آخر غير مقدّمه، ويُطبَّق عند اعتماده فقط.", "Switching on or off is a request that a policy manager other than its requester approves; it applies only once approved.")}</p>
      <IntegrityPanel />
    </div>
  );
}

type Integrity = {
  asOfMonth: string; ok: boolean;
  runsWithoutJournal: { runId: string; runNo: number; periodMonth: string; status: string; net: string; reason: string }[];
  paymentsWithoutJournal: { runNo: number; paymentId: string; amount: string }[];
  advancesWithoutJournal: { advanceNo: string; employeeNo: string; amount: string }[];
  reconciliation: { runNo: number; periodMonth: string; mismatches: { check: string; expected: string; actual: string }[] }[];
  deferredInstallments: { advanceNo: string; employeeNo: string; overdueInstallments: number; oldestDueMonth: string; overdueAmount: string }[];
};

/** F2 (E-3, E-4, E-5): read-only list of money records the accountant must look at. */
function IntegrityPanel() {
  const { L } = useHrI18n();
  const q = useHr<Integrity>("/api/hr/payroll/integrity");
  const r = q.data;
  const rows: [ReactNode, ReactNode, string?][] = r ? [
    [L("مسيّرات معتمدة بلا قيد استحقاق", "Approved runs without an accrual entry"), r.runsWithoutJournal.length ? r.runsWithoutJournal.map((x) => <div key={x.runNo}>#<span className="hr-num">{x.runNo}</span> · <span className="hr-num">{x.periodMonth}</span> · {x.reason === "ACCOUNTING_OFF" ? L("المحاسبة موقوفة", "Accounting off") : L("القيد مفقود", "Entry missing")} · <span className="hr-num">{money(x.net)}</span></div>) : L("لا يوجد", "None"), r.runsWithoutJournal.length ? "warning" : undefined],
    [L("دفعات رواتب بلا قيد صرف", "Payroll payments without a payment entry"), r.paymentsWithoutJournal.length ? r.paymentsWithoutJournal.map((x) => <div key={x.paymentId}>#<span className="hr-num">{x.runNo}</span> · <span className="hr-num">{money(x.amount)}</span></div>) : L("لا يوجد", "None"), r.paymentsWithoutJournal.length ? "warning" : undefined],
    [L("سلف مصروفة بلا قيد", "Paid advances without an entry"), r.advancesWithoutJournal.length ? r.advancesWithoutJournal.map((x) => <div key={x.advanceNo}><span className="hr-id">{x.advanceNo}</span> · <span className="hr-id">{x.employeeNo}</span> · <span className="hr-num">{money(x.amount)}</span></div>) : L("لا يوجد", "None"), r.advancesWithoutJournal.length ? "warning" : undefined],
    [L("مسيّرات غير متطابقة بالهللة", "Runs that do not reconcile to the halala"), r.reconciliation.length ? r.reconciliation.map((x) => <div key={x.runNo}>#<span className="hr-num">{x.runNo}</span> · <span dir="ltr" className="hr-num">{x.mismatches[0]?.check}</span></div>) : L("لا يوجد", "None"), r.reconciliation.length ? "warning" : undefined],
    [L("أقساط سلف مؤجلة بعد موعدها", "Advance instalments deferred past their due month"), r.deferredInstallments.length ? r.deferredInstallments.map((x) => <div key={x.advanceNo}><span className="hr-id">{x.advanceNo}</span> · <span className="hr-id">{x.employeeNo}</span> · <span className="hr-num">{x.overdueInstallments}</span> {L("قسط منذ", "instalments since")} <span className="hr-num">{x.oldestDueMonth}</span> · <span className="hr-num">{money(x.overdueAmount)}</span></div>) : L("لا يوجد", "None"), r.deferredInstallments.length ? "warning" : undefined],
  ] : [];
  return (
    <section className="hr-stack" data-testid="hr-integrity" style={{ gap: 8 }}>
      <h2 className="hr-section">{L("سلامة القيود والمطابقة", "Journal integrity and reconciliation")}</h2>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !r ? <LoadingTable rows={3} /> : null}
      {r ? <KV rows={rows} /> : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("للقراءة فقط: لا يُعدِّل التقرير أي مبلغ أو قيد. يُراجعه المحاسب ويقرر المعالجة.", "Read only: the report changes no amount or entry. The accountant reviews it and decides the treatment.")}</p>
    </section>
  );
}
