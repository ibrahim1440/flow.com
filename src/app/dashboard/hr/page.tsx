"use client";
import { Select } from "@/components/ui/Select";
import { useCreateRequest } from "@/components/shell/page-context";
// HR-01 · Directory with split preview (Figma 1JbZgpMqmPkUVne8ms9Ozz · 449:767; 1024: 455:2286;
// 390: 455:3056; EN 1536:2272 / 1536:7264 / 1536:8485). The directory never shows pay, identity
// or bank data — the API's projection does not contain them.
import Link from "next/link";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ADVANCE_STATUS, Btn, Dialog, Empty, ErrorState, EMPLOYEE_STATUS, Field, Flag, KV, LoadingTable, NoPermission, Notice, PageHeader,
  StatusDot, Tabs, days, hrFetch, statusLabel, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta,
  FilterChip,
} from "@/components/hr/ui";
import { leaveTypeName, orgName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";

type Org = { nameAr: string | null; nameEn?: string | null };
type Row = {
  id: string; employeeNo: string; fullNameAr: string; jobTitle: string; status: string; hireDate: string; hasAccount: boolean;
  department: Org | null; branch: { code: string; nameAr: string | null; nameEn: string } | null; manager: { fullNameAr: string } | null;
  contractEnd: string | null; onLeaveToday: boolean;
};
type Dir = { total: number; page: number; pageSize: number; rows: Row[]; counts: { all: number; active: number; probation: number; expiring: number; separated: number; noAccount: number } };
type View = "all" | "active" | "probation" | "expiring" | "separated";

const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000);

export default function DirectoryPage() {
  const can = useCan();
  const { meta } = useHrMeta();
  const { L, t, lang } = useHrI18n();
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [branchId, setBranchId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «موظف جديد».
  useCreateRequest("person", () => setCreating(true), can("people_manage"));
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const url = useMemo(() => {
    const p = new URLSearchParams({ view, page: String(page), pageSize: "25" });
    if (debounced) p.set("q", debounced);
    if (branchId) p.set("branchId", branchId);
    if (departmentId) p.set("departmentId", departmentId);
    return `/api/hr/directory?${p}`;
  }, [view, page, debounced, branchId, departmentId]);
  const { data, error, loading, reload } = useHr<Dir>(meta && !meta.caps.directory ? null : url);

  if (meta && !meta.caps.directory) return <div className="hr-page"><NoPermission duty={L("دليل الموظفين", "Employee directory")} /></div>;
  const c = data?.counts;
  const filtered = !!(debounced || branchId || departmentId);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className={`hr-split${selected ? " has-preview" : ""}`}>
      <div className="hr-page">
        <PageHeader
          title={L("الموظفون", "People")}
          actions={can("people_manage") ? <Btn variant="primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> {L("موظف جديد", "New employee")}</Btn> : null}
        />
        <Tabs
          label={L("عروض الموظفين", "Directory views")}
          value={view}
          onChange={(v) => { setView(v); setPage(1); }}
          items={[
            { key: "all", label: t("all"), count: c?.all },
            { key: "active", label: L("على رأس العمل", "Active"), count: c?.active },
            { key: "probation", label: L("فترة التجربة", "Probation"), count: c?.probation },
            { key: "expiring", label: L("عقود تنتهي خلال 60 يومًا", "Contracts ending within 60 days"), count: c?.expiring, danger: !!c?.expiring },
            { key: "separated", label: L("انتهت خدمتهم", "Ended service"), count: c?.separated },
          ]}
        />
        <div className="hr-filterbar">
          <input className="hr-input hr-search" type="search" placeholder={L("اسم الموظف أو رقمه الوظيفي", "Employee name or number")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("search")} />
          {meta && meta.branches.length > 1 ? (
            <FilterChip label={t("branch")} value={branchId} onChange={(v) => { setBranchId(v); setPage(1); }} options={meta.branches.map((b) => ({ value: b.id, label: orgName(b, lang) }))} />
          ) : null}
          {meta && meta.departments.length ? (
            <FilterChip label={t("department")} value={departmentId} onChange={(v) => { setDepartmentId(v); setPage(1); }} options={meta.departments.map((d) => ({ value: d.id, label: orgName(d, lang) }))} />
          ) : null}
          {branchId || departmentId ? <Btn variant="ghost" size="sm" onClick={() => { setBranchId(""); setDepartmentId(""); setPage(1); }}>{t("clearFilters")}</Btn> : null}
        </div>

        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        {loading && !data ? <LoadingTable /> : null}
        {data && data.rows.length === 0 ? (
          filtered ? (
            <Empty title={L("لا موظف يطابق", "No matching employee")} body={L("جرّب كلمة أخرى أو امسح المرشحات.", "Try another word or clear the filters.")} action={<Btn size="sm" onClick={() => { setQ(""); setBranchId(""); setDepartmentId(""); }}>{t("clearFilters")}</Btn>} />
          ) : (
            <Empty title={L("لا يوجد موظفون بعد", "No employees yet")} body={L("أضف أول موظف، أو حوّل متقدمًا مقبولًا من «التوظيف». الموظف لا يحتاج حساب دخول.", "Add the first employee, or convert an accepted applicant from Recruitment. An employee does not need a login account.")} action={can("people_manage") ? <Btn variant="primary" onClick={() => setCreating(true)}>{L("موظف جديد", "New employee")}</Btn> : undefined} />
          )
        ) : null}
        {data && data.rows.length > 0 ? (
          <>
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("دليل الموظفين", "Employee directory")}>
                <thead>
                  <tr>
                    <th>{L("الرقم", "No.")}</th><th>{t("employee")}</th><th>{L("المسمى · الإدارة", "Title · Department")}</th><th className="hr-hide-compact">{t("branch")}</th><th className="hr-hide-compact hr-hide-preview">{L("المدير", "Manager")}</th><th className="num">{L("المباشرة", "Start")}</th><th>{t("status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const left = r.contractEnd ? daysUntil(r.contractEnd) : null;
                    return (
                      <tr key={r.id} className="is-clickable" aria-selected={selected === r.id} tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(r.id))}>
                        <td data-label={L("الرقم", "No.")}><span className="hr-id">{r.employeeNo}</span></td>
                        <td data-label={t("employee")} className="strong m-title">{r.fullNameAr}<span className="hr-msub"><span className="hr-id">{r.employeeNo}</span> · {r.jobTitle}{r.department ? ` · ${orgName(r.department, lang)}` : ""}</span></td>
                        <td data-label={L("المسمى", "Title")}>{r.jobTitle}{r.department ? <span className="sub">{orgName(r.department, lang)}</span> : null}</td>
                        <td data-label={t("branch")} className="hr-hide-compact hr-muted">{r.branch ? orgName(r.branch, lang) : "—"}</td>
                        <td data-label={L("المدير", "Manager")} className="hr-hide-compact hr-hide-preview hr-muted">{r.manager?.fullNameAr ?? "—"}</td>
                        <td data-label={L("المباشرة", "Start")} className="num">{r.hireDate}</td>
                        <td data-label={t("status")} className="m-end">
                          {left !== null && left >= 0 && left <= 60 && r.status !== "SEPARATED" ? <Flag>{L(`العقد: ${left} يومًا`, `Contract: ${left} days`)}</Flag> : r.onLeaveToday ? <StatusDot map={{ L: ["في إجازة", "neutral", "On leave"] }} value="L" /> : <StatusDot map={EMPLOYEE_STATUS} value={r.status} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="hr-tablefoot">
              <span>{L(`${data.total} موظفًا`, `${data.total} employees`)}{c ? L(` · ${c.noAccount} بلا حساب دخول`, ` · ${c.noAccount} without a login account`) : ""}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="hr-num">{(data.page - 1) * data.pageSize + 1}–{Math.min(data.total, data.page * data.pageSize)}</span> {L("من", "of")} <span className="hr-num">{data.total}</span>
                <Btn size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("previous")}</Btn>
                <Btn size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t("next")}</Btn>
              </span>
            </div>
          </>
        ) : null}
      </div>
      {selected ? <><div className="hr-scrim" onClick={() => setSelected(null)} /><Preview id={selected} onClose={() => setSelected(null)} /></> : null}
      {creating ? <CreatePerson onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void reload(); setSelected(id); }} /> : null}
    </div>
  );
}

type Profile = {
  person: Row & { workPhone: string | null; probationEndDate: string | null };
  currentContract: { contractNo: string; type: string; startDate: string; endDate: string | null } | null;
  reminders: { kind: string; date: string; message: string }[];
  /** The caller's duties on this person (the API decides; the pane only shows what applies). */
  permissions: { contracts: boolean };
  /** Absent key: not the caller's to see; null: none. */
  snapshot: {
    shift: { name: string; startTime: string; endTime: string } | null;
    leave?: { code: string; nameAr: string; available: string } | null;
    advance?: { advanceNo: string; status: string } | null;
  };
};

// Initials skip the definite article («الزهراني» → «ز»), the same rule as the CRM branch.
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.replace(/^ال(?=.)/, "")[0]).join("");

function Preview({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading, reload } = useHr<Profile>(`/api/hr/employees/${id}`);
  const can = useCan();
  const { L, t, lang, en } = useHrI18n();
  const p = data?.person;
  const s = data?.snapshot;
  // A-10 (HR-01 449:979): the pane's quick actions are the profile's own actions, deep-linked —
  // the profile and the leave page open the dialog the link names. Shown only to a caller who
  // holds the duty; the API re-checks it.
  const canRenew = !!data?.permissions.contracts && !!data?.currentContract && p?.status !== "SEPARATED";
  const canLeave = can("leave_manage") && p?.status !== "SEPARATED";
  return (
    <aside className="hr-preview" aria-label={L("معاينة الموظف", "Employee preview")}>
      <div className="hr-preview-head">
        <span className="hr-id">{p?.employeeNo ?? ""}</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link className="hr-btn is-ghost is-sm" href={`/dashboard/hr/employees/${id}`}>{en ? "→ Open file" : "فتح الملف ←"}</Link>
          <Btn variant="ghost" className="hr-iconbtn" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={onClose}>✕</Btn>
        </span>
      </div>
      <div className="hr-preview-body">
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        {loading && !data ? <LoadingTable rows={5} /> : null}
        {p ? (
          <>
            <div className="hr-preview-identity">
              <span className="hr-avatar" aria-hidden="true">{initials(p.fullNameAr)}</span>
              <div>
                <h2 className="hr-mobile-title">{p.fullNameAr}</h2>
                <div className="hr-caption">{[p.jobTitle, p.department ? orgName(p.department, lang) : null, p.branch ? orgName(p.branch, lang) : null].filter(Boolean).join(" · ")}</div>
              </div>
            </div>
            <div className="hr-meta">
              <StatusDot map={EMPLOYEE_STATUS} value={p.status} />
              {data?.currentContract?.endDate && daysUntil(data.currentContract.endDate) <= 60 ? <Flag>{L(`العقد ينتهي بعد ${daysUntil(data.currentContract.endDate)} يومًا`, `Contract ends in ${daysUntil(data.currentContract.endDate)} days`)}</Flag> : null}
            </div>
            <KV rows={[
              [L("رقم الموظف", "Employee no."), <span key="n" className="hr-id">{p.employeeNo}</span>],
              [L("المدير المباشر", "Line manager"), p.manager?.fullNameAr ?? "—"],
              [L("تاريخ المباشرة", "Start date"), <span key="h" className="hr-num">{p.hireDate}</span>],
              [L("العقد الحالي", "Current contract"), data?.currentContract ? (data.currentContract.endDate ? L(`محدد المدة حتى ${data.currentContract.endDate}`, `Fixed term until ${data.currentContract.endDate}`) : L("غير محدد المدة", "Open-ended")) : L("لا يوجد عقد ساري", "No active contract"), data?.currentContract ? undefined : "warning"],
              [L("الوردية", "Shift"), s?.shift ? <span key="s">{s.shift.name} <span className="hr-num">{s.shift.startTime}–{s.shift.endTime}</span></span> : L("لا توجد وردية اليوم", "No shift today"), s?.shift ? undefined : "muted"],
              ...(s && "leave" in s ? [[s.leave?.code === "ANNUAL" ? L("رصيد الإجازة السنوية", "Annual leave balance") : L(`رصيد ${s.leave?.nameAr ?? "الإجازة"}`, `${s.leave ? leaveTypeName(s.leave, lang) : "Leave"} balance`), s.leave ? <span key="l"><span className="hr-num">{days(s.leave.available)}</span> {L("يوم", "days")}</span> : "—"] as [string, ReactNode]] : []),
              ...(s && "advance" in s ? [[L("سلفة قائمة", "Open advance"), s.advance ? <span key="a"><span className="hr-id">{s.advance.advanceNo}</span> · {statusLabel(ADVANCE_STATUS, s.advance.status, lang)}</span> : t("none"), s.advance ? "warning" : "muted"] as [string, ReactNode, string]] : []),
              [L("حساب الدخول", "Login account"), p.hasAccount ? L("مرتبط", "Linked") : t("none"), "muted"],
            ]} />
            {data?.reminders.length ? (
              <>
                <span className="hr-label">{L("تذكيرات", "Reminders")}</span>
                <KV rows={data.reminders.slice(0, 5).map((r) => [hrText(r.message, lang), <span key={r.kind + r.date} className="hr-num">{r.date}</span>, r.kind === "NOTICE_DEADLINE" ? "warning" : "text-2"])} />
              </>
            ) : null}
            <p className="hr-caption" style={{ margin: 0 }}>{L("الراتب والبيانات الشخصية لا تظهر في الدليل، بل في ملف الموظف لمن يملك صلاحية «العقود والرواتب» أو «البيانات الخاصة».", "Pay and personal data are not shown in the directory; they appear in the employee file to users with the “Contracts & payroll” or “Private data” permission.")}</p>
          </>
        ) : null}
      </div>
      <div className="hr-preview-foot">
        {canRenew ? <Link className="hr-btn is-primary" href={`/dashboard/hr/employees/${id}?tab=contracts&action=renew`}>{L("تجديد العقد", "Renew contract")}</Link> : null}
        {canLeave ? <Link className="hr-btn" href={`/dashboard/hr/leave?request=${id}`}>{L("تسجيل إجازة", "Record leave")}</Link> : null}
        <Link className={`hr-btn ${canRenew ? "is-ghost hr-iconbtn" : "is-primary"}`} href={`/dashboard/hr/employees/${id}`} aria-label={canRenew ? L("إجراءات أخرى — فتح الملف", "More actions — open file") : undefined} title={canRenew ? t("openFile") : undefined}>{canRenew ? "⋯" : t("openFile")}</Link>
      </div>
    </aside>
  );
}

function CreatePerson({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { meta } = useHrMeta();
  const { L, t, lang } = useHrI18n();
  const f = useForm({ fullNameAr: "", fullNameEn: "", jobTitle: "", hireDate: new Date().toISOString().slice(0, 10), probationEndDate: "", branchId: "", departmentId: "", managerId: "", employmentType: "FULL_TIME", status: "PROBATION" });
  const a = useAction();
  const submit = () => a.run("create", async () => {
    const body = Object.fromEntries(Object.entries(f.v).filter(([, v]) => v !== ""));
    const p = await hrFetch<{ id: string }>("/api/hr/employees", { json: body });
    onCreated(p.id);
  });
  return (
    <Dialog open title={L("موظف جديد", "New employee")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "create"} onClick={submit} disabled={!f.v.fullNameAr || !f.v.jobTitle || !f.v.hireDate}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الاسم بالعربية *", "Name in Arabic *")}><input className="hr-input" dir="rtl" {...f.bind("fullNameAr")} /></Field>
        <Field label={L("الاسم بالإنجليزية", "Name in English")}><input className="hr-input" dir="ltr" {...f.bind("fullNameEn")} /></Field>
        <Field label={L("المسمى الوظيفي *", "Job title *")}><input className="hr-input" {...f.bind("jobTitle")} /></Field>
        <Field label={L("تاريخ المباشرة *", "Start date *")}><input className="hr-input" type="date" {...f.bind("hireDate")} /></Field>
        <Field label={t("branch")}><Select className="hr-select" {...f.bind("branchId")}><option value="">—</option>{meta?.branches.map((b) => <option key={b.id} value={b.id}>{orgName(b, lang)}</option>)}</Select></Field>
        <Field label={t("department")}><Select className="hr-select" {...f.bind("departmentId")}><option value="">—</option>{meta?.departments.map((d) => <option key={d.id} value={d.id}>{orgName(d, lang)}</option>)}</Select></Field>
        <Field label={L("المدير المباشر", "Line manager")}><Select className="hr-select" {...f.bind("managerId")}><option value="">—</option>{meta?.people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}</Select></Field>
        <Field label={L("نهاية فترة التجربة", "Probation ends")}><input className="hr-input" type="date" {...f.bind("probationEndDate")} /></Field>
        <Field label={t("status")}><Select className="hr-select" {...f.bind("status")}><option value="PROBATION">{L("فترة تجربة", "Probation")}</option><option value="ACTIVE">{L("على رأس العمل", "Active")}</option></Select></Field>
        <Field label={L("نوع التوظيف", "Employment type")}><Select className="hr-select" {...f.bind("employmentType")}><option value="FULL_TIME">{L("دوام كامل", "Full time")}</option><option value="PART_TIME">{L("دوام جزئي", "Part time")}</option><option value="TEMPORARY">{L("مؤقت", "Temporary")}</option></Select></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("لا يُنشأ حساب دخول. الراتب والعقد يُسجَّلان من ملف الموظف بصلاحية «العقود والرواتب».", "No login account is created. Pay and the contract are recorded from the employee file with the “Contracts & payroll” permission.")}</p>
    </Dialog>
  );
}
