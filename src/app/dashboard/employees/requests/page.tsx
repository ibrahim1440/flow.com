"use client";

import { defaultLandingFor } from "@/lib/workspace/landing";
import { Select } from "@/components/ui/Select";
import { useState, useEffect } from "react";
import { Plus, Pencil, Eye, EyeOff, Lock, Navigation, Trash2, AlertTriangle } from "lucide-react";
import {
  ROLE_LABELS, ROLE_LABELS_AR, ALL_MODULES, MODULE_LABELS, MODULE_SUB_PRIVILEGES,
  buildDefaultPermissions, hasSubPrivilege, hasModuleAccess,
  type Permissions, type AccessLevel,
} from "@/lib/auth-shared";
import { conflictMessageAr, conflictMessageEn, effectivePermissions, payrollDutyConflicts, PAYROLL_DUTY_AR, PAYROLL_DUTY_EN, REVIEWED_GRANT_SUB_AR, REVIEWED_GRANT_SUB_EN, type PayrollSodDuty, type ReviewedGrantSub } from "@/lib/hr/sod";
import { hrText } from "@/lib/hr/messages-en";
import { formatDate } from "@/lib/utils";
import { useUser } from "../../user-context";
import { MfaPanel } from "../MfaPanel";
import { useI18n } from "@/lib/i18n/context";
import { PIN_LENGTH } from "@/lib/pin-policy";
import { Btn, Dot, Empty, Field, Flag, Notice, OpsRoot, PageHeader } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "../employees.css";

type Employee = {
  id: string; name: string; username: string | null; role: string;
  permissions: string | Permissions;
  defaultRoute: string;
  active: boolean; createdAt: string;
  phoneNumber?: string | null;
};

type IdentityRegister = {
  externalPersons: { id: string; fullName: string; organization: string | null; accountId: string | null; active: boolean; verified: boolean }[];
  employees: { id: string; employeeNo: string; name: string; accountId: string | null; verified: boolean }[];
  logins: { id: string; personType: "EMPLOYEE" | "EXTERNAL" | null; personId: string | null; personName: string | null; verified: boolean }[];
  requests: { id: string; status: string; subjectId: string | null; accountId: string | null }[];
};
type NotVerified = { id: string; name: string; inactive?: boolean; duties: PayrollSodDuty[]; status?: "NOT_LINKED" | "NOT_VERIFIED"; personName?: string | null; role?: string };

type PendingApproval = { grants?: string[]; subs?: string[]; confirms?: string[]; toAdmin?: boolean; credentialFields?: string[] };
/** The saved-with-a-pending-request toast, named after what actually waits (AR / EN). */
function pendingToast(p: PendingApproval, ar: boolean): string {
  const duties = (p.grants?.length ?? 0) > 0 || !!p.toAdmin;
  const confirms = p.confirms ?? [];
  const grantsInv = (p.subs ?? []).filter((k) => !confirms.includes(k)).length > 0;
  const creds = (p.credentialFields?.length ?? 0) > 0;
  const parts = ar
    ? [duties ? "منح المهام الحساسة" : null, grantsInv ? "منح صلاحية المخزون المميّزة (تعديل المخزون / التجاوز)" : null, confirms.length ? "تأكيد صلاحية المخزون المميّزة القائمة" : null, creds ? "تغيير بيانات الدخول" : null]
    : [duties ? "the grant of payroll-sensitive duties" : null, grantsInv ? "the inventory supervisor grant (stock adjustment / override)" : null, confirms.length ? "the confirmation of the inventory supervisor permissions already held" : null, creds ? "the credential change" : null];
  const what = parts.filter(Boolean).join(ar ? "، و" : "; ");
  return ar ? `حُفظ التغيير، و${what || "التغيير الحساس"} بانتظار اعتماد محرر حسابات آخر.` : `Saved; ${what || "the sensitive change"} waits for another account editor's approval.`;
}
type PermissionRequest = { credentialFields?: string[]; id: string; kind: "PERMISSION_CHANGE" | "PERMISSION_REVIEW"; revoked: PayrollSodDuty[]; fromAdmin: boolean; fingerprint: string; reason: string; accountId: string; accountName: string; role: string; grants: PayrollSodDuty[]; subs?: ReviewedGrantSub[]; confirms?: ReviewedGrantSub[]; toAdmin: boolean; requestedByName: string | null; requestedAt: string; mine: boolean; isSubject: boolean };

function parsePerms(raw: string | Permissions): Permissions {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

const ROUTE_OPTIONS: { value: string; label: string; module: string | null }[] = [
  { value: "/dashboard/workspace",   label: "My Workspace",    module: null },
  { value: "/dashboard",             label: "Dashboard",       module: "dashboard" },
  { value: "/dashboard/inventory",   label: "Inventory",       module: "inventory" },
  { value: "/dashboard/orders",      label: "Orders",          module: "orders" },
  { value: "/dashboard/production",  label: "Production",      module: "production" },
  { value: "/dashboard/qc",          label: "Quality Control", module: "qc" },
  { value: "/dashboard/packaging",   label: "Packaging",       module: "packaging" },
  { value: "/dashboard/dispatch",    label: "Dispatch",        module: "dispatch" },
  { value: "/dashboard/history",     label: "History",         module: "history" },
  { value: "/dashboard/analytics",   label: "Analytics",       module: "analytics" },
  { value: "/dashboard/labels",      label: "Labels",          module: "labels" },
  { value: "/dashboard/employees",   label: "Employees",       module: "employees" },
];

const ACCESS_ICONS: Record<AccessLevel, typeof Pencil> = {
  edit: Pencil,
  view: Eye,
  none: EyeOff,
};

// Direction 2.1 (UI batch 1, visual port only): the content scope of the shared shell. The
// behaviour, fields, requests and payloads below are the legacy page's, unchanged.
export default function EmployeesPage() {
  return <OpsRoot><EmployeesInner /></OpsRoot>;
}

function EmployeesInner() {
  const user = useUser();
  const { t, lang } = useI18n();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "employees", "create");
  const canEditPerms = hasSubPrivilege(user?.permissions ?? {}, "employees", "edit");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", username: "", pin: "", password: "", role: "custom", defaultRoute: "/dashboard", active: true, phoneNumber: "" });
  const [permissions, setPermissions] = useState<Permissions>(buildDefaultPermissions("custom"));
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Inventory Option A (RUNBOOK §10.7 item 8): ask a second account editor to confirm an inventory
  // adjust / override the account ALREADY holds (a legacy one-editor grant).
  const [editingHeldInv, setEditingHeldInv] = useState(false);
  const [confirmInv, setConfirmInv] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // P-3 / Q-3: accounts that already hold conflicting payroll duties — listed for review, never
  // revoked automatically.
  const [dutyConflicts, setDutyConflicts] = useState<{ id: string; name: string; inactive?: boolean; conflicts: [PayrollSodDuty, PayrollSodDuty][] }[]>([]);
  const formConflicts = payrollDutyConflicts(permissions);
  // Owner decision 1b: grants of segregated duties awaiting a second account editor.
  const [permRequests, setPermRequests] = useState<PermissionRequest[]>([]);
  const [identityNotVerified, setIdentityNotVerified] = useState<NotVerified[]>([]);
  // Option A: each login's person and verification, for account editors.
  const [identity, setIdentity] = useState<IdentityRegister | null>(null);
  const [identityFor, setIdentityFor] = useState<Employee | null>(null);
  const loadIdentity = () => { if (canEditPerms) fetch("/api/employees/identity").then((r) => (r.ok ? r.json() : null)).then(setIdentity).catch(() => setIdentity(null)); };
  useEffect(loadIdentity, [canEditPerms, employees]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadPermissionRequests(); }, [canEditPerms]); // eslint-disable-line react-hooks/exhaustive-deps

  function showToast(ok: boolean, text: string) {
    setToast({ ok, text });
    setTimeout(() => setToast(null), 4000);
  }

  useEffect(() => { loadEmployees(); }, []);
  useEffect(() => {
    if (!canEditPerms) return;
    fetch("/api/hr/duty-conflicts").then((r) => (r.ok ? r.json() : { conflicts: [] })).then((d) => { setDutyConflicts(d.conflicts ?? []); setIdentityNotVerified(d.identityNotVerified ?? []); }).catch(() => setDutyConflicts([]));
  }, [canEditPerms, employees]);

  async function loadEmployees() {
    const res = await fetch("/api/employees");
    setEmployees(await res.json());
  }

  function openNew() {
    setEditingId(null);
    setForm({ name: "", username: "", pin: "", password: "", role: "custom", defaultRoute: defaultLandingFor("custom"), active: true, phoneNumber: "" });
    setPermissions(buildDefaultPermissions("custom"));
    setDeleteConfirm(false);
    setEditingHeldInv(false);
    setConfirmInv(false);
    setShowForm(true);
  }

  function openEdit(emp: Employee) {
    setEditingId(emp.id);
    setForm({ name: emp.name, username: emp.username || "", pin: "", password: "", role: emp.role, defaultRoute: emp.defaultRoute || "/dashboard", active: emp.active, phoneNumber: emp.phoneNumber ?? "" });
    setPermissions(parsePerms(emp.permissions));
    setDeleteConfirm(false);
    const held = effectivePermissions(typeof emp.permissions === "string" ? emp.permissions : JSON.stringify(emp.permissions ?? {}), emp.role);
    setEditingHeldInv(["adjust", "override"].some((k) => hasModuleAccess(held, "inventory") && hasSubPrivilege(held, "inventory", k)));
    setConfirmInv(false);
    setShowForm(true);
  }

  function applyPreset(role: string) {
    const newPerms = buildDefaultPermissions(role);
    setForm((f) => {
      // If the current defaultRoute is now inaccessible with the new permissions, reset it
      const routeOpt = ROUTE_OPTIONS.find((r) => r.value === f.defaultRoute);
      const stillAccessible =
        !routeOpt?.module ||
        routeOpt.module === "dashboard" ||
        hasModuleAccess(newPerms, routeOpt.module);
      // A NEW account follows the landing rule of its role (lib/workspace/landing.ts); an existing
      // account keeps its choice while it stays reachable.
      if (!editingId) return { ...f, role, defaultRoute: defaultLandingFor(role) };
      return { ...f, role, defaultRoute: stillAccessible ? f.defaultRoute : "/dashboard" };
    });
    setPermissions(newPerms);
  }

  function setModuleAccess(mod: string, access: AccessLevel) {
    setPermissions((prev) => {
      const subs = MODULE_SUB_PRIVILEGES[mod];
      const sub: Record<string, boolean> = {};
      if (subs) {
        for (const s of subs) sub[s.key] = access === "edit";
      }
      const next = { ...prev, [mod]: { access, ...(subs ? { sub } : {}) } };
      // If removing access makes the current defaultRoute inaccessible, reset it
      if (access === "none") {
        const routeOpt = ROUTE_OPTIONS.find((r) => r.module === mod);
        if (routeOpt && form.defaultRoute === routeOpt.value) {
          setForm((f) => ({ ...f, defaultRoute: "/dashboard" }));
        }
      }
      return next;
    });
  }

  function toggleSub(mod: string, subKey: string) {
    setPermissions((prev) => {
      const current = prev[mod] || { access: "none" };
      const sub = { ...current.sub };
      sub[subKey] = !sub[subKey];
      return { ...prev, [mod]: { ...current, sub } };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let pendingNote: unknown = null;
    const body: Record<string, unknown> = {
      name: form.name, username: form.username.trim().toLowerCase(),
      role: form.role, permissions, defaultRoute: form.defaultRoute, active: form.active,
      phoneNumber: form.phoneNumber.trim(),
    };
    if (editingId && confirmInv) body.confirmReviewedSubs = true;
    if (!editingId) {
      body.pin = form.pin;
      if (form.password) body.password = form.password;
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); showToast(false, (ar ? d.error : d.errorEn ?? d.error) ?? "Failed to create employee"); return; }
      const created = await res.json();
      pendingNote = created.pendingApproval ?? null;
      // Option A: a new login is nobody's yet, so payroll / administration duties are not granted.
      if (created.identityRequired) {
        setShowForm(false);
        showToast(true, ar ? `أُنشئ الحساب دون المهام الحساسة: ${created.identityRequired.message} ثم اطلب المنح.` : `Account created without the sensitive duties: ${created.identityRequired.messageEn} Then request the grant.`);
        loadEmployees();
        return;
      }
    } else {
      if (form.pin) body.pin = form.pin;
      if (form.password) body.password = form.password;
      const res = await fetch(`/api/employees/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); showToast(false, (ar ? d.error : d.errorEn ?? d.error) ?? "Failed to update employee"); return; }
      pendingNote = (await res.json()).pendingApproval ?? null;
    }
    setShowForm(false);
    // Owner decision 1b: a grant of a segregated duty (or the admin role) waits for a second editor;
    // so do inventory adjust / override (Option A) and a credential change of a sensitive account.
    if (pendingNote) showToast(true, pendingToast(pendingNote as PendingApproval, ar));
    else showToast(true, editingId ? "Employee updated successfully." : "Employee created successfully.");
    loadEmployees();
    void loadPermissionRequests();
  }

  async function loadPermissionRequests() {
    if (!canEditPerms) return;
    const r = await fetch("/api/employees/permission-requests?status=pending").catch(() => null);
    setPermRequests(r && r.ok ? await r.json() : []);
  }

  async function decidePermissionRequest(req: PermissionRequest, decision: "APPROVE" | "REJECT" | "WITHDRAW" | "ACKNOWLEDGE") {
    let note = "";
    if (decision === "REJECT") {
      note = window.prompt(ar ? "سبب الرفض" : "Reason for rejecting") ?? "";
      if (note.trim().length < 3) return;
    }
    // The approver attests who holds the account (owner decision 1 identity control).
    if (decision === "APPROVE" && !window.confirm(ar ? `أؤكد أن هذا الحساب يخص شخصًا مختلفًا («${req.accountName}»).` : `I confirm this account belongs to a distinct person (“${req.accountName}”).`)) return;
    const url = decision === "WITHDRAW" ? `/api/employees/permission-requests/${req.id}/withdraw` : decision === "ACKNOWLEDGE" ? `/api/employees/permission-requests/${req.id}/acknowledge` : `/api/employees/permission-requests/${req.id}/decide`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decision === "WITHDRAW" || decision === "ACKNOWLEDGE" ? {} : { decision, expected: req.fingerprint, note, attested: decision === "APPROVE" }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(false, (ar ? d.error : d.errorEn ?? d.error) ?? "Failed"); return; }
    showToast(true, decision === "ACKNOWLEDGE" ? (ar ? "سُجّلت مراجعة السحب." : "Revocation reviewed.") : decision === "APPROVE" ? (ar ? "اعتُمد المنح وطُبّق." : "Grant approved and applied.") : decision === "REJECT" ? (ar ? "رُفض الطلب." : "Request rejected.") : (ar ? "سُحب الطلب." : "Request withdrawn."));
    loadEmployees();
    void loadPermissionRequests();
  }

  async function handleDelete() {
    if (!editingId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/employees/${editingId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        showToast(false, d.error ?? "Failed to delete employee.");
        setDeleteConfirm(false);
        return;
      }
      setShowForm(false);
      showToast(true, "Employee deleted successfully.");
      loadEmployees();
    } finally {
      setDeleting(false);
    }
  }

  function countAccess(perms: Permissions) {
    const parsed = typeof perms === "string" ? parsePerms(perms) : perms;
    let edit = 0, view = 0;
    for (const mod of ALL_MODULES) {
      const p = parsed[mod];
      if (p?.access === "edit") edit++;
      else if (p?.access === "view") view++;
    }
    return { edit, view };
  }

  // Compute which routes are accessible given current permissions
  const accessibleRoutes = ROUTE_OPTIONS.filter((opt) => {
    if (!opt.module || opt.module === "dashboard") return true;
    return hasModuleAccess(permissions, opt.module);
  });

  // Compute label for current employee default route for cards
  function routeLabel(route: string) {
    return ROUTE_OPTIONS.find((r) => r.value === route)?.label ?? "Dashboard";
  }

  return (
    <div className="hr-page" data-emp-root="">
      <PageHeader
        title={L("المستخدمون والصلاحيات", "Users & permissions")}
        actions={canCreate ? (
          <Btn variant="primary" onClick={openNew} data-testid="employees-new">
            <Plus size={16} strokeWidth={2} aria-hidden="true" /> {t("newEmployee")}
          </Btn>
        ) : null}
      >
        <span><span className="hr-num">{employees.length}</span> {t("employees")}</span>
        <span>{L("حسابات الدخول وصلاحياتها", "Sign-in accounts and their access")}</span>
      </PageHeader>

      {permRequests.length > 0 ? (
        <div role="status" data-testid="hr-permission-requests" className="hr-notice tone-info emp-notice">
          <p className="emp-notice-title">{ar ? "منح وتغييرات حساسة بانتظار اعتماد محرر حسابات آخر — لم يُطبَّق بعد:" : "Sensitive grants and changes awaiting another account editor — not applied yet:"}</p>
          <ul className="emp-reqs">
            {permRequests.map((r) => (
              r.kind === "PERMISSION_REVIEW" ? (
              <li key={r.id}>
                <span>
                  <span className="emp-strong">{r.accountName}</span>: {ar ? "سُحب فورًا — " : "revoked at once — "}{[...r.revoked.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.fromAdmin ? [ar ? "دور مدير النظام" : "the admin role"] : [])].join(ar ? "، " : ", ")}
                  <span className="hr-caption emp-block">{ar ? "مراجعة لاحقة من شخص آخر · سحبه" : "Post-hoc review by another person · revoked by"} {r.requestedByName ?? "—"}</span>
                </span>
                {!r.mine && !r.isSubject ? (
                  <Btn size="sm" onClick={() => void decidePermissionRequest(r, "ACKNOWLEDGE")}>{ar ? "إقرار المراجعة" : "Acknowledge"}</Btn>
                ) : <span className="hr-caption">{ar ? "يراجعه شخص آخر" : "Another person reviews it"}</span>}
              </li>
              ) : (
              <li key={r.id}>
                <span>
                  <span className="emp-strong">{r.accountName}</span>: {[...r.grants.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.subs ?? []).map((k) => `${(ar ? REVIEWED_GRANT_SUB_AR[k] : REVIEWED_GRANT_SUB_EN[k]) ?? k}${(r.confirms ?? []).includes(k) ? (ar ? " (تأكيد صلاحية قائمة)" : " (confirm, already held)") : ""}`), ...(r.toAdmin ? [ar ? "دور مدير النظام" : "the admin role"] : []), ...(r.credentialFields ?? []).map((f) => (ar ? ({ username: "تغيير اسم المستخدم", pin: "تغيير الرمز السري", password: "تغيير كلمة المرور", active: "إعادة التفعيل" } as Record<string, string>)[f] ?? f : ({ username: "username change", pin: "PIN change", password: "password change", active: "reactivation" } as Record<string, string>)[f] ?? f))].join(ar ? "، " : ", ")}
                  <span className="hr-caption emp-block">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {hrText(r.reason, ar ? "ar" : "en")}</span>
                </span>
                <span className="emp-btns">
                  {r.mine ? (
                    <Btn size="sm" onClick={() => void decidePermissionRequest(r, "WITHDRAW")}>{ar ? "سحب الطلب" : "Withdraw"}</Btn>
                  ) : r.isSubject ? (
                    <span className="hr-caption">{ar ? "طلب على حسابك؛ يقرره غيرك" : "A request on your account; someone else decides"}</span>
                  ) : (
                    <>
                      <Btn size="sm" variant="primary" onClick={() => void decidePermissionRequest(r, "APPROVE")}>{ar ? "اعتماد وتطبيق" : "Approve and apply"}</Btn>
                      <Btn size="sm" variant="danger" onClick={() => void decidePermissionRequest(r, "REJECT")}>{ar ? "رفض" : "Reject"}</Btn>
                    </>
                  )}
                </span>
              </li>
              )
            ))}
          </ul>
        </div>
      ) : null}
      {identityNotVerified.length > 0 ? (
        <div role="status" data-testid="hr-identity-not-verified" className="hr-notice tone-warning emp-notice">
          <p className="emp-notice-title">{ar ? "هوية غير موثّقة — محظور من إجراءات الرواتب حتى التوثيق:" : "Identity not verified — blocked from payroll actions until verified:"}</p>
          <p className="hr-caption">{ar ? "تبقى المهام مسندة، لكن الخادم يرفض كل إجراء رواتب أو إدارة رواتب من هذه الحسابات حتى يرتبط الحساب بشخص (موظف أو شخص خارجي) وتُوثَّق هويته بموافقة شخص ثانٍ." : "The duties stay assigned, but the server refuses every payroll or payroll-administration action from these logins until each is linked to a person (employee or external person) whose identity a second person verifies."}</p>
          <ul className="emp-bullets">{identityNotVerified.map((r) => (
            <li key={r.id}>
              <span className="emp-strong">{r.name}</span>{r.inactive ? <span className="hr-caption"> ({ar ? "غير نشط" : "inactive"})</span> : null}
              {" "}<Flag tone="warning">{r.status === "NOT_VERIFIED" ? (ar ? `مرتبط بـ«${r.personName ?? "—"}» · هوية غير موثّقة` : `linked to “${r.personName ?? "—"}” · identity not verified`) : (ar ? "غير مرتبط بأي شخص" : "not linked to any person")}</Flag>
              {" "}<Flag tone="danger">{ar ? "محظور من إجراءات الرواتب حتى التوثيق" : "Blocked from payroll actions until verified"}</Flag>
              : {[...r.duties.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.role === "admin" ? [ar ? "دور مدير النظام" : "the admin role"] : [])].join(ar ? "، " : ", ")}
            </li>
          ))}</ul>
        </div>
      ) : null}
      {canEditPerms && identity && identity.requests.some((q) => q.status === "PENDING") ? (
        <div role="status" data-testid="hr-identity-pending" className="hr-notice tone-info emp-notice emp-row">
          <span>{ar ? `${identity.requests.filter((q) => q.status === "PENDING").length} طلب هوية (توثيق أو شخص خارجي) بانتظار قرار شخص آخر.` : `${identity.requests.filter((q) => q.status === "PENDING").length} identity request(s) (verification or external person) awaiting another person.`}</span>
          <a href="/dashboard/hr/settings?view=external" className="hr-btn is-sm">{ar ? "مراجعة الطلبات" : "Review requests"}</a>
        </div>
      ) : null}
      {canEditPerms && user ? <MfaPanel ar={ar} meId={user.id} onToast={showToast} /> : null}
      {dutyConflicts.length > 0 ? (
        <div role="status" data-testid="hr-duty-conflicts-report" className="hr-notice tone-warning emp-notice">
          <p className="emp-notice-title">{ar ? "حسابات تجمع مهام رواتب متعارضة — للمراجعة، لم يُسحب شيء تلقائيًا:" : "Accounts holding conflicting payroll duties — for review; nothing was revoked automatically:"}</p>
          <ul className="emp-bullets">
            {dutyConflicts.map((c) => (
              <li key={c.id}><span className="emp-strong">{c.name}</span>{c.inactive ? <span className="hr-caption"> ({ar ? "غير نشط" : "inactive"})</span> : null}: {c.conflicts.map(([a, b]) => ar ? `${PAYROLL_DUTY_AR[a]} + ${PAYROLL_DUTY_AR[b]}` : `${PAYROLL_DUTY_EN[a]} + ${PAYROLL_DUTY_EN[b]}`).join(ar ? "، " : ", ")}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Toast */}
      {toast && (
        <div className="emp-toast" role="status" data-testid="employees-toast">
          <Notice tone={toast.ok ? "success" : "danger"}>{toast.ok ? "✓" : "✕"} {toast.text}</Notice>
        </div>
      )}

      {employees.length === 0 ? (
        <Empty title={t("noEmployeesFound")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow emp-table" aria-label={L("المستخدمون", "Users")}>
            <thead>
              <tr>
                <th>{L("المستخدم", "User")}</th>
                <th>{L("الدور", "Role")}</th>
                <th className="hr-hide-compact">{t("permissionsLabel")}</th>
                <th className="hr-hide-compact">{t("defaultPage")}</th>
                <th className="hr-hide-compact">{L("أُنشئ", "Created")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th aria-label={L("إجراءات", "Actions")} />
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                // QA P3: an account on role defaults (empty permissions) shows the duties it ACTUALLY has.
                // (Roster readers get no permissions at all: nothing to count.)
                const perms = emp.permissions === undefined ? parsePerms({}) : (effectivePermissions(emp.permissions, emp.role) as ReturnType<typeof parsePerms>);
                const { edit, view } = countAccess(perms);
                const role = (ar ? ROLE_LABELS_AR[emp.role] : ROLE_LABELS[emp.role]) || emp.role;
                const status = emp.active ? <Dot tone="success">{t("active")}</Dot> : <Dot tone="danger">{t("inactive")}</Dot>;
                return (
                  <tr key={emp.id} data-testid="employee-row" className={emp.active ? undefined : "is-inactive"}>
                    <td className="m-title">
                      <span className="emp-who">
                        <span className="hr-avatar emp-avatar" aria-hidden="true">{initials(emp.name)}</span>
                        <span className="emp-whotext">
                          <span className="emp-name">{emp.name}</span>
                          {emp.username ? <bdi dir="ltr" className="emp-user">@{emp.username}</bdi> : null}
                          <span className="hr-msub">{role} · {status}</span>
                        </span>
                      </span>
                    </td>
                    <td>{role}</td>
                    <td className="hr-hide-compact">
                      <span className="emp-counts">
                        <span><span className="hr-num">{edit}</span> {t("edit")}</span>
                        <span><span className="hr-num">{view}</span> {t("view")}</span>
                        <span className="hr-muted"><span className="hr-num">{ALL_MODULES.length - edit - view}</span> {ar ? "مخفية" : "hidden"}</span>
                      </span>
                    </td>
                    <td className="hr-hide-compact">
                      <span className="emp-route"><Navigation size={12} aria-hidden="true" /> {routeLabel(emp.defaultRoute || "/dashboard")}</span>
                    </td>
                    <td className="hr-hide-compact hr-num hr-muted">{formatDate(emp.createdAt)}</td>
                    <td>
                      <span className="emp-status">
                        {status}
                        {identity ? <IdentityBadge s={identity.logins.find((l) => l.id === emp.id)} ar={ar} /> : null}
                      </span>
                    </td>
                    <td className="m-end">
                      <span className="emp-btns">
                        {canEditPerms && identity && (
                          <Btn size="sm" onClick={() => setIdentityFor(emp)} data-testid="hr-identity-open" aria-label={ar ? "الهوية والتوثيق" : "Identity and verification"}>
                            {ar ? "الهوية" : "Identity"}
                          </Btn>
                        )}
                        {canEditPerms && (
                          <Btn size="sm" variant="ghost" className="hr-iconbtn" onClick={() => openEdit(emp)} data-testid="employee-edit" aria-label={`${t("edit")} · ${emp.name}`}>
                            <Pencil size={15} aria-hidden="true" />
                          </Btn>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {identityFor && identity ? <IdentityDialog emp={identityFor} reg={identity} ar={ar} onClose={() => setIdentityFor(null)} onDone={(msg) => { setIdentityFor(null); showToast(true, msg); loadIdentity(); }} onError={(msg) => showToast(false, msg)} /> : null}
      <Dialog
        open={showForm}
        title={editingId ? L("تعديل المستخدم", "Edit user") : t("newEmployee")}
        sub={editingId ? form.name : L("اسم الدخول والرمز وكلمة المرور، ثم الصلاحيات.", "Sign-in name, PIN and password, then the permissions.")}
        onClose={() => setShowForm(false)}
        className="emp-dialog"
        testId="employee-form"
        actions={<>
          <Btn type="submit" form="employee-form-el" variant="primary">{editingId ? t("saveChanges") : t("createEmployee")}</Btn>
          <Btn onClick={() => setShowForm(false)}>{t("cancel")}</Btn>
          {editingId && user?.role === "admin" && !deleteConfirm && (
            <Btn variant="danger" className="emp-delete" onClick={() => setDeleteConfirm(true)}>
              <Trash2 size={15} aria-hidden="true" /> {L("حذف", "Delete")}
            </Btn>
          )}
        </>}
      >
        <form id="employee-form-el" onSubmit={handleSubmit} className="emp-form">
          <div className="hr-form">
            <Field label={t("displayName")}>
              <input type="text" className="hr-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label={`${t("usernameLabel")} · ${L("اسم الدخول", "login ID")}`}>
              <span className="emp-prefixed">
                <span className="emp-prefix" aria-hidden="true">@</span>
                <input type="text" dir="ltr" className="hr-input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64) })}
                  placeholder="e.g. ahmed" required />
              </span>
            </Field>
            {/* The number automated WhatsApp messages reach this employee on. */}
            <Field label={`${t("phoneNumber")} · WhatsApp`} wide>
              <input type="tel" dir="ltr" className="hr-input" value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
                placeholder="05XXXXXXXX" data-testid="employee-phone" />
            </Field>
            <Field label={editingId ? t("newPin") : t("pinLabel")}>
              <input type="text" dir="ltr" className="hr-input emp-pin" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                {...(!editingId ? { required: true, minLength: PIN_LENGTH } : {})}
                inputMode="numeric" maxLength={PIN_LENGTH} placeholder={L(`${PIN_LENGTH} أرقام`, `${PIN_LENGTH} digits`)} />
            </Field>
            <Field label={t("passwordLabel")}>
              <input type="password" dir="ltr" className="hr-input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={L("للدخول باسم المستخدم وكلمة المرور", "For username+password login")} autoComplete="new-password" />
            </Field>
          </div>

          {/* Account Status (edit only) */}
          {editingId && (
            <div className="emp-switchrow">
              <span>
                <span className="emp-strong emp-block">{L("حالة الحساب", "Account status")}</span>
                <span className="hr-caption">{form.active ? L("نشط — يستطيع الدخول", "Active — employee can log in") : L("غير نشط — الدخول محظور", "Inactive — login blocked")}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={form.active}
                aria-label={L("حالة الحساب", "Account status")}
                onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
                className="emp-switch"
              >
                <span />
              </button>
            </div>
          )}

          {editingId && editingHeldInv && ["adjust", "override"].some((k) => hasModuleAccess(permissions, "inventory") && hasSubPrivilege(permissions, "inventory", k)) ? (
            <label data-testid="confirm-inventory-subs" className="hr-notice tone-warning emp-check">
              <input type="checkbox" checked={confirmInv} onChange={(e) => setConfirmInv(e.target.checked)} />
              <span>
                <span className="emp-strong emp-block">{ar ? "طلب تأكيد صلاحية المخزون المميّزة من محرر حسابات آخر" : "Ask another account editor to confirm the inventory supervisor permissions"}</span>
                <span className="hr-caption">{ar ? "تعديل المخزون / التجاوز ممنوحان لهذا الحساب مسبقًا. يُنشأ طلب يعتمده شخص ثانٍ ولا يتغيّر شيء عند الاعتماد؛ يُسجَّل الاعتماد دليلًا للمنح." : "Stock adjustment / override are already on this account. A request is created for a second person; nothing changes on approval, and the approval is recorded as the grant's evidence."}</span>
              </span>
            </label>
          ) : null}

          {/* Default Landing Page */}
          <Field
            label={t("defaultPage")}
            help={L("لا تُختار إلا الصفحات التي يصل إليها الموظف؛ الخيارات المعطّلة تحتاج صلاحية الوحدة.", "Only pages the employee can access are selectable. Greyed-out options require the relevant module permission.")}
          >
            <Select
              className="hr-select"
              value={form.defaultRoute}
              onChange={(e) => setForm({ ...form, defaultRoute: e.target.value })}
            >
              {ROUTE_OPTIONS.map((opt) => {
                const accessible = !opt.module || opt.module === "dashboard" || hasModuleAccess(permissions, opt.module);
                return (
                  <option key={opt.value} value={opt.value} disabled={!accessible}>
                    {opt.label}{!accessible ? ` (${t("noAccess")})` : ""}
                  </option>
                );
              })}
            </Select>
          </Field>
          {form.defaultRoute !== "/dashboard" && !accessibleRoutes.find((r) => r.value === form.defaultRoute) && (
            <Notice tone="warning">
              {L("هذه الصفحة تحتاج صلاحية الوحدة. امنح الوصول أدناه أو غيّر الصفحة الافتراضية.", "This page requires access permissions for that module. Grant access above or change the landing page.")}
            </Notice>
          )}

          <div className="emp-group">
            <span className="hr-label">{L("الدور", "Role")}</span>
            <div className="emp-roles" role="group" aria-label={L("الدور", "Role")}>
              {Object.entries(ROLE_LABELS).map(([key, label]) => (
                <Btn key={key} size="sm" variant={form.role === key ? "primary" : "secondary"} aria-pressed={form.role === key} onClick={() => applyPreset(key)}>
                  {ar ? ROLE_LABELS_AR[key] ?? label : label}
                </Btn>
              ))}
            </div>
          </div>

          <div className="emp-group">
            <span className="emp-permhead"><Lock size={15} aria-hidden="true" /> <span className="hr-section">{t("permissionsLabel")}</span></span>
            <div className="emp-perms">
              {ALL_MODULES.map((mod) => {
                const perm = permissions[mod] || { access: "none" as AccessLevel };
                const subs = MODULE_SUB_PRIVILEGES[mod];
                return (
                  <div key={mod} className="emp-perm">
                    <div className="emp-permrow">
                      <span className="emp-strong">{MODULE_LABELS[mod]}</span>
                      <span className="ops-seg" role="group" aria-label={MODULE_LABELS[mod]}>
                        {(["edit", "view", "none"] as AccessLevel[]).map((level) => {
                          const Icon = ACCESS_ICONS[level];
                          const active = perm.access === level;
                          return (
                            <button key={level} type="button" aria-pressed={active} className={level === "none" ? "is-negative" : undefined}
                              onClick={() => setModuleAccess(mod, level)}>
                              <Icon size={12} aria-hidden="true" />
                              {level === "edit" ? t("edit") : level === "view" ? t("view") : t("noAccess")}
                            </button>
                          );
                        })}
                      </span>
                    </div>

                    {mod === "hr" && perm.access !== "none" && formConflicts.length > 0 ? (
                      <div role="alert" data-testid="hr-duty-conflict" className="hr-notice tone-warning">
                        {ar
                          ? <>{conflictMessageAr(formConflicts)} لن يُحفظ هذا الجمع. فصل المهام: الإعداد، والاعتماد، وتسجيل الصرف، وإلغاء المسير المعتمد لأشخاص مختلفين.</>
                          : <>{conflictMessageEn(formConflicts)} This combination will not be saved. Segregation of duties: preparation, approval, payment recording and cancelling an approved run belong to different people.</>}
                      </div>
                    ) : null}
                    {subs && perm.access !== "none" && (
                      <div className="emp-subs">
                        {subs.map((sub) => {
                          const enabled = perm.sub?.[sub.key] === true;
                          return (
                            <label key={sub.key} className={enabled ? "is-on" : undefined}>
                              <input type="checkbox" checked={enabled} onChange={() => toggleSub(mod, sub.key)} />
                              <span>{sub.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Delete confirmation inline */}
          {editingId && deleteConfirm && (
            <div className="hr-notice tone-danger emp-row" role="alert">
              <span className="emp-row-text"><AlertTriangle size={16} aria-hidden="true" /> {L("هل تريد حذف هذا الموظف نهائيًا؟", "Are you sure you want to permanently delete this employee?")}</span>
              <span className="emp-btns">
                <Btn size="sm" variant="danger" onClick={handleDelete} disabled={deleting}>
                  {deleting ? L("جارٍ الحذف…", "Deleting…") : L("نعم، احذف", "Yes, Delete")}
                </Btn>
                <Btn size="sm" onClick={() => setDeleteConfirm(false)}>{t("cancel")}</Btn>
              </span>
            </div>
          )}
        </form>
      </Dialog>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]).join("") || "—";
}

function IdentityBadge({ s, ar }: { s?: IdentityRegister["logins"][number]; ar: boolean }) {
  if (!s) return null;
  const [tone, text] = s.verified
    ? ["success", ar ? "هوية موثّقة" : "Identity verified"] as const
    : s.personType
      ? ["warning", ar ? "هوية غير موثّقة" : "Identity not verified"] as const
      : ["neutral", ar ? "غير مرتبط بشخص" : "No person linked"] as const;
  return <span data-testid="hr-identity-badge" className={`emp-badge tone-${tone}`}>{text}</span>;
}

/**
 * Option A: link a login to a person and request the identity verification. Nothing applies here:
 * each step is a request another account editor approves (HR settings › External persons).
 */
function IdentityDialog({ emp, reg, ar, onClose, onDone, onError }: { emp: Employee; reg: IdentityRegister; ar: boolean; onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const s = reg.logins.find((l) => l.id === emp.id);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = reg.requests.some((q) => q.status === "PENDING" && (q.accountId === emp.id || (s?.personId && q.subjectId === s.personId)));
  const freeEmployees = reg.employees.filter((e) => !e.accountId);
  const freeExternals = reg.externalPersons.filter((x) => x.active && !x.accountId);
  async function send() {
    setBusy(true);
    try {
      let res: Response;
      if (s?.personType) {
        res = await fetch("/api/employees/identity/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectType: s.personType, subjectId: s.personId, reason }) });
      } else if (target.startsWith("E:")) {
        res = await fetch("/api/employees/identity/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectType: "EMPLOYEE", subjectId: target.slice(2), linkAccountId: emp.id, reason }) });
      } else {
        res = await fetch("/api/employees/identity/external", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "LINK", externalId: target.slice(2), accountId: emp.id, reason }) });
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onError((ar ? d.error : d.errorEn ?? d.error) ?? "Failed"); return; }
      onDone(ar ? "أُرسل الطلب؛ يُطبَّق عند اعتماد محرر حسابات آخر." : "Request sent; it applies when another account editor approves it.");
    } finally {
      setBusy(false);
    }
  }
  const canSend = reason.trim().length >= 5 && (s?.personType ? !s.verified : !!target) && !pending;
  const title = ar ? "الهوية والتوثيق" : "Identity and verification";
  return (
    <Dialog
      open
      title={`${title} · ${emp.name}`}
      onClose={onClose}
      testId="hr-identity-dialog"
      actions={<>
        {!s?.verified ? <Btn variant="primary" disabled={!canSend} busy={busy} onClick={() => void send()}>{s?.personType ? (ar ? "طلب توثيق الهوية" : "Request verification") : (ar ? "طلب الربط والتوثيق" : "Request link")}</Btn> : null}
        <Btn onClick={onClose}>{ar ? "إغلاق" : "Close"}</Btn>
      </>}
    >
      <p className="emp-p">
        {s?.verified ? (ar ? `مرتبط بـ«${s.personName}» — هوية موثّقة.` : `Linked to “${s.personName}” — identity verified.`)
          : s?.personType ? (ar ? `مرتبط بـ«${s.personName}» (${s.personType === "EMPLOYEE" ? "موظف" : "شخص خارجي"}) — هوية غير موثّقة.` : `Linked to “${s.personName}” (${s.personType === "EMPLOYEE" ? "employee" : "external person"}) — identity not verified.`)
          : (ar ? "غير مرتبط بأي شخص. مهام الرواتب والإدارة لا تُمنح ولا تُنفَّذ إلا لحساب شخص موثّق." : "Not linked to any person. Payroll and administration duties are granted to, and performed by, logins of verified persons only.")}
      </p>
      {pending ? <Notice tone="info">{ar ? "يوجد طلب هوية لهذا الحساب بانتظار القرار." : "An identity request for this login is awaiting a decision."}</Notice> : null}
      {!s?.personType ? (
        <Field
          label={ar ? "اربطه بـ" : "Link it to"}
          help={<>{ar ? "لشخص خارجي غير مسجّل: أضفه أولًا من" : "For an external person not yet recorded: add them first in"} <a className="emp-link" href="/dashboard/hr/settings?view=external">{ar ? "الأشخاص الخارجيون" : "External persons"}</a>.</>}
        >
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="hr-select">
            <option value="">—</option>
            {freeEmployees.length ? <optgroup label={ar ? "موظف (يُوثَّق مع الربط)" : "Employee (verified with the link)"}>{freeEmployees.map((e) => <option key={e.id} value={`E:${e.id}`}>{e.employeeNo} · {e.name}</option>)}</optgroup> : null}
            {freeExternals.length ? <optgroup label={ar ? "شخص خارجي" : "External person"}>{freeExternals.map((x) => <option key={x.id} value={`X:${x.id}`}>{x.fullName}{x.organization ? ` · ${x.organization}` : ""}</option>)}</optgroup> : null}
          </Select>
        </Field>
      ) : null}
      {!s?.verified ? (
        <Field label={ar ? "السبب وما تحققت منه *" : "Reason and what you checked *"}>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} className="hr-textarea" />
        </Field>
      ) : null}
    </Dialog>
  );
}
