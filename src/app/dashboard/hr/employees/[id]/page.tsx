"use client";
// HR-02 · Employee profile (Figma 1JbZgpMqmPkUVne8ms9Ozz · 449:20852). One page per person;
// each tab appears only for a caller holding its duty, and the API re-checks every duty —
// a hidden tab or button is never the control.
import { Select } from "@/components/ui/Select";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import {
  Btn, Dialog, EMPLOYEE_STATUS, Empty, ErrorState, Field, Flag, LoadingTable, NoPermission, Notice, PageHeader, StatusDot, Tabs,
  hrFetch, statusLabel, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta,
} from "@/components/hr/ui";
import ContractsTab, { RenewDialog } from "./_tabs/contracts";
import OverviewTab from "./_tabs/overview";
import LeaveTab from "./_tabs/leave";
import AttendanceTab from "./_tabs/attendance";
import AdvancesTab from "./_tabs/advances";
import AssetsTab from "./_tabs/assets";
import DocumentsTab from "./_tabs/documents";
import PerformanceTab from "./_tabs/performance";
import OffboardingTab from "./_tabs/offboarding";
import AuditTab from "./_tabs/audit";
import { orgName } from "@/lib/i18n/hr";
import { EMPLOYMENT_TYPE, daysUntil, mutate, type Person, type Profile, type TabProps } from "./_tabs/shared";

type TabKey = "overview" | "contracts" | "attendance" | "leave" | "advances" | "assets" | "documents" | "performance" | "offboarding" | "audit";
type Dlg = "edit" | "renew" | "more" | "status" | "account" | null;

const TAB_VIEW: Record<TabKey, (p: TabProps) => React.ReactNode> = {
  overview: OverviewTab, contracts: ContractsTab, attendance: AttendanceTab, leave: LeaveTab, advances: AdvancesTab, assets: AssetsTab,
  documents: DocumentsTab, performance: PerformanceTab, offboarding: OffboardingTab, audit: AuditTab,
};

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const can = useCan();
  const { meta } = useHrMeta();
  const { data, error, loading, reload } = useHr<Profile>(id ? `/api/hr/employees/${id}` : null);
  // Deep links from the directory preview (A-10): ?tab=contracts&action=renew. Read once; the
  // tab falls back to the overview when the caller may not see it (`visible` below).
  const search = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => (search.get("tab") as TabKey | null) ?? "overview");
  const [dlg, setDlg] = useState<Dlg>(() => (search.get("action") === "renew" ? "renew" : null));
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); void reload(); }, [reload]);
  const reloadProfile = useCallback(() => { void reload(); }, [reload]);
  const { L, en, lang } = useHrI18n();

  const back = <Link className="hr-btn is-ghost is-sm" href="/dashboard/hr">{en ? "← People" : "→ الموظفون"}</Link>;

  if (meta && !meta.caps.directory) return <div className="hr-page"><NoPermission duty={L("دليل الموظفين", "Employee directory")} /></div>;
  if (error && !data) {
    return (
      <div className="hr-page">
        <div>{back}</div>
        {error.status === 404 ? <Empty title={L("الموظف غير موجود أو خارج نطاقك", "Employee not found or outside your scope")} body={L("تحقق من الرابط، أو اطلب صلاحية الفرع الذي يتبعه الموظف.", "Check the link, or ask for access to the employee’s branch.")} /> : <ErrorState error={error} onRetry={reload} />}
      </div>
    );
  }
  if (!data) return <div className="hr-page"><div>{back}</div>{loading ? <LoadingTable rows={8} label={L("جارٍ تحميل ملف الموظف…", "Loading the employee file…")} /> : null}</div>;

  const { person: p, permissions: perm, currentContract: cc } = data;
  const readOnly = p.status === "SEPARATED";
  const left = cc?.endDate ? daysUntil(cc.endDate) : null;
  const hasAdvances = perm.advances || can("advances_manage") || can("advances_approve") || can("advances_disburse");

  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: "overview", label: L("نظرة عامة", "Overview"), show: true },
    { key: "contracts", label: L("العقود والرواتب", "Contracts & payroll"), show: perm.contracts },
    { key: "attendance", label: L("الحضور", "Attendance"), show: can("attendance_manage") },
    { key: "leave", label: L("الإجازات", "Leave"), show: perm.leave },
    { key: "advances", label: L("السلف", "Advances"), show: hasAdvances },
    { key: "assets", label: L("العهد", "Assets"), show: !!data.assets },
    { key: "documents", label: L("المستندات", "Documents"), show: perm.documents },
    { key: "performance", label: L("الأداء", "Performance"), show: perm.performance },
    { key: "offboarding", label: L("إنهاء الخدمة", "End of service"), show: perm.offboard },
    { key: "audit", label: L("السجل", "Audit log"), show: perm.edit },
  ];
  const visible = tabs.filter((t) => t.show);
  const active = visible.some((t) => t.key === tab) ? tab : "overview";
  const View = TAB_VIEW[active];
  const props: TabProps = { id, profile: data, readOnly, reload: reloadProfile };

  return (
    <div className="hr-page">
      {/* C-02 R3: from 768 the breadcrumb leads back; the phone keeps the back link (M-02 R3). */}
      <div className="hr-mobile-only">{back}</div>
      <PageHeader
        stackMobile
        title={p.fullNameAr}
        actions={readOnly ? null : (
          <>
            {perm.contracts && cc ? <Btn variant="primary" onClick={() => setDlg("renew")}>{L("تجديد العقد", "Renew contract")}</Btn> : null}
            {perm.edit ? <Btn onClick={() => setDlg("edit")}>{L("تعديل البيانات", "Edit details")}</Btn> : null}
            {perm.edit ? <Btn variant="ghost" aria-label={L("إجراءات أخرى", "More actions")} onClick={() => setDlg("more")}>⋯</Btn> : null}
          </>
        )}
      >
        {/* C-02 R3 547:3334: number · job line, then the status and its flags. */}
        <span className="hr-id">{p.employeeNo}</span>
        <span className="hr-muted">{[p.jobTitle, p.department ? orgName(p.department, lang) : null, p.branch ? orgName(p.branch, lang) : null].filter(Boolean).join(" · ")}</span>
        <StatusDot map={EMPLOYEE_STATUS} value={p.status} />
        {!readOnly && left !== null && left >= 0 && left <= 60 ? <Flag>{L("العقد ينتهي بعد", "Contract ends in")} <span className="hr-num">{left}</span> {L("يومًا", "days")}</Flag> : null}
        {!readOnly && left !== null && left < 0 ? <Flag tone="danger">{L("انتهى تاريخ العقد", "Contract end date has passed")}</Flag> : null}
        {p.fullNameEn ? <span className="hr-caption hr-iso" dir="ltr">{p.fullNameEn}</span> : null}
      </PageHeader>

      {readOnly ? <Notice tone="warning">{L("انتهت خدمة هذا الموظف", "This employee’s service has ended")}{p.separationDate ? <> {L("في", "on")} <span className="hr-num">{p.separationDate}</span></> : null}. {L("الملف للقراءة فقط.", "The file is read-only.")}</Notice> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <Tabs label={L("أقسام ملف الموظف", "Employee file sections")} value={active} onChange={setTab} items={visible.map((t) => ({ key: t.key, label: t.label }))} />
      <div role="tabpanel" aria-label={visible.find((t) => t.key === active)?.label}>
        <View {...props} />
      </div>

      {dlg === "edit" ? <EditDialog person={p} onClose={close} onDone={done} /> : null}
      {dlg === "renew" && cc ? <RenewDialog id={id} current={cc} onClose={close} onDone={done} /> : null}
      {dlg === "more" ? (
        <Dialog open title={L("إجراءات أخرى", "More actions")} onClose={close}>
          <div className="hr-stack">
            <Btn onClick={() => setDlg("status")}>{L("تغيير الحالة", "Change status")}</Btn>
            <Btn onClick={() => setDlg("account")}>{p.hasAccount ? L("تغيير حساب الدخول أو فك ربطه", "Change or unlink the login account") : L("ربط حساب دخول", "Link a login account")}</Btn>
          </div>
          <p className="hr-caption" style={{ margin: 0 }}>{L("إنهاء الخدمة يتم من تبويب «إنهاء الخدمة» وليس بتغيير الحالة.", "Service is ended from the End of service tab, not by changing the status.")}</p>
        </Dialog>
      ) : null}
      {dlg === "status" ? <StatusDialog id={id} status={p.status} onClose={close} onDone={done} /> : null}
      {dlg === "account" ? <AccountDialog id={id} hasAccount={p.hasAccount} onClose={close} onDone={done} /> : null}
    </div>
  );
}

function EditDialog({ person: p, onClose, onDone }: { person: Person; onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const { L, t, lang } = useHrI18n();
  const initial = {
    fullNameAr: p.fullNameAr, fullNameEn: p.fullNameEn ?? "", jobTitle: p.jobTitle, departmentId: p.departmentId ?? "", branchId: p.branchId ?? "",
    managerId: p.managerId ?? "", employmentType: p.employmentType, probationEndDate: p.probationEndDate ?? "", workPhone: p.workPhone ?? "", workEmail: p.workEmail ?? "",
  };
  const f = useForm(initial);
  const a = useAction();
  const managers = (meta?.people ?? []).filter((x) => x.id !== p.id);
  const submit = () => a.run("save", async () => {
    const changed = Object.fromEntries(
      (Object.keys(initial) as (keyof typeof initial)[]).filter((k) => f.v[k] !== initial[k]).map((k) => [k, f.v[k] === "" ? null : f.v[k]]),
    );
    if (Object.keys(changed).length === 0) return onClose();
    await mutate(`/api/hr/employees/${p.id}`, { method: "PATCH", json: { ...changed, version: p.version } });
    onDone();
  });
  return (
    <Dialog open title={L("تعديل بيانات الموظف", "Edit employee details")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.fullNameAr.trim() || !f.v.jobTitle.trim()}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الاسم بالعربية *", "Name in Arabic *")}><input className="hr-input" dir="rtl" {...f.bind("fullNameAr")} /></Field>
        <Field label={L("الاسم بالإنجليزية", "Name in English")}><input className="hr-input" dir="ltr" {...f.bind("fullNameEn")} /></Field>
        <Field label={L("المسمى الوظيفي *", "Job title *")}><input className="hr-input" {...f.bind("jobTitle")} /></Field>
        <Field label={L("نوع التوظيف", "Employment type")}><Select className="hr-select" {...f.bind("employmentType")}>{Object.entries(EMPLOYMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{lang === "en" ? v[1] : v[0]}</option>)}</Select></Field>
        <Field label={t("department")}><Select className="hr-select" {...f.bind("departmentId")}><option value="">—</option>{meta?.departments.map((d) => <option key={d.id} value={d.id}>{orgName(d, lang)}</option>)}</Select></Field>
        <Field label={t("branch")}>
          <Select className="hr-select" {...f.bind("branchId")}>
            <option value="">—</option>
            {p.branch && !meta?.branches.some((b) => b.id === p.branch?.id) ? <option value={p.branch.id}>{orgName(p.branch, lang)}</option> : null}
            {meta?.branches.map((b) => <option key={b.id} value={b.id}>{orgName(b, lang)}</option>)}
          </Select>
        </Field>
        <Field label={L("المدير المباشر", "Line manager")}>
          <Select className="hr-select" {...f.bind("managerId")}>
            <option value="">—</option>
            {p.manager && !managers.some((m) => m.id === p.manager?.id) ? <option value={p.manager.id}>{p.manager.fullNameAr}</option> : null}
            {managers.map((m) => <option key={m.id} value={m.id}>{m.fullNameAr} · {m.employeeNo}</option>)}
          </Select>
        </Field>
        <Field label={L("نهاية فترة التجربة", "Probation ends")}><input className="hr-input" type="date" {...f.bind("probationEndDate")} /></Field>
        <Field label={L("هاتف العمل", "Work phone")}><input className="hr-input" dir="ltr" {...f.bind("workPhone")} /></Field>
        <Field label={L("بريد الشركة", "Company e-mail")} help={L("إليه تُرسل تنبيهات النظام. البريد الشخصي في «البيانات الخاصة».", "System notifications go here. The personal e-mail is under private data.")}><input className="hr-input" type="email" dir="ltr" {...f.bind("workEmail")} data-testid="hr-work-email" /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("تاريخ المباشرة لا يُعدَّل هنا. إن عدّل شخص آخر الملف بعد فتحه فسيُرفض الحفظ وتحتاج إلى إعادة التحميل.", "The start date is not edited here. If someone else changes the file after you open it, saving is refused and you need to reload.")}</p>
    </Dialog>
  );
}

function StatusDialog({ id, status, onClose, onDone }: { id: string; status: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ status: status === "SEPARATED" ? "ACTIVE" : status, reason: "" });
  const { L, t, lang } = useHrI18n();
  const a = useAction();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/status`, { json: f.v });
    onDone();
  });
  return (
    <Dialog open title={L("تغيير الحالة", "Change status")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={f.v.status === status || f.v.reason.trim().length < 3}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الحالة الجديدة *", "New status *")}>
          <Select className="hr-select" {...f.bind("status")}>
            {(["PROBATION", "ACTIVE", "NOTICE", "SUSPENDED"] as const).map((s) => <option key={s} value={s}>{statusLabel(EMPLOYEE_STATUS, s, lang)}</option>)}
          </Select>
        </Field>
        <Field label={L("السبب *", "Reason *")} wide><input className="hr-input" {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}

function AccountDialog({ id, hasAccount, onClose, onDone }: { id: string; hasAccount: boolean; onClose: () => void; onDone: () => void }) {
  const list = useHr<{ id: string; name: string; role: string; simpleModeException?: boolean }[]>("/api/hr/accounts/linkable");
  const [accountId, setAccountId] = useState("");
  const { L, t } = useHrI18n();
  const a = useAction();
  const link = (value: string | null) => a.run(value ? "link" : "unlink", async () => {
    await hrFetch(`/api/hr/employees/${id}/account`, { json: { accountId: value } });
    onDone();
  });
  return (
    <Dialog open title={L("حساب الدخول", "Login account")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "link"} disabled={!accountId} onClick={() => link(accountId)}>{L("ربط", "Link")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("الربط لا يُنشئ حسابًا جديدًا. تظهر هنا الحسابات النشطة غير المرتبطة بأي موظف فقط.", "Linking does not create an account. Only active accounts not linked to any employee are listed.")}</p>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <LoadingTable rows={2} /> : null}
      {list.data ? (
        list.data.length === 0 ? <Notice tone="warning">{L("لا توجد حسابات دخول متاحة للربط.", "No login accounts are available to link.")}</Notice> : (
          <Field label={hasAccount ? L("استبدال الحساب المرتبط بـ", "Replace the linked account with") : L("الحساب", "Account")}>
            <Select className="hr-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{L("— اختر —", "— Select —")}</option>
              {list.data.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.role}</option>)}
            </Select>
          </Field>
        )
      ) : null}
      {/* SIMPLE MODE: a privileged login is linked as a recorded control exception (the server decides and audits it). */}
      {list.data?.find((x) => x.id === accountId)?.simpleModeException ? <Notice tone="warning">{L("وضع التشغيل المبسّط: سيُسجَّل هذا الربط كاستثناء رقابي", "Simple operating mode: this link will be recorded as a control exception")}</Notice> : null}
      {hasAccount ? (
        <div className="hr-stack" style={{ gap: 6 }}>
          <hr className="hr-divider" />
          <Btn variant="danger" busy={a.busy === "unlink"} onClick={() => link(null)}>{L("فك ربط الحساب الحالي", "Unlink the current account")}</Btn>
          <span className="hr-caption">{L("فك الربط لا يعطّل الحساب، لكنه يوقف وصول صاحبه إلى خدماته الذاتية في الموارد البشرية.", "Unlinking does not disable the account, but its owner loses access to My HR.")}</span>
        </div>
      ) : null}
    </Dialog>
  );
}
