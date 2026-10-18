"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Shield, Pencil, Eye, EyeOff, Lock, Navigation, Trash2, AlertTriangle } from "lucide-react";
import {
  ROLE_LABELS, ALL_MODULES, MODULE_LABELS, MODULE_SUB_PRIVILEGES,
  buildDefaultPermissions, hasSubPrivilege, hasModuleAccess,
  type Permissions, type AccessLevel,
} from "@/lib/auth-shared";
import { conflictMessageAr, conflictMessageEn, effectivePermissions, payrollDutyConflicts, PAYROLL_DUTY_AR, PAYROLL_DUTY_EN, REVIEWED_GRANT_SUB_AR, REVIEWED_GRANT_SUB_EN, type PayrollSodDuty, type ReviewedGrantSub } from "@/lib/hr/sod";
import { hrText } from "@/lib/hr/messages-en";
import { formatDate } from "@/lib/utils";
import { useUser } from "../user-context";
import { MfaPanel } from "./MfaPanel";
import { useI18n } from "@/lib/i18n/context";
import { PIN_LENGTH } from "@/lib/pin-policy";

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

const ACCESS_COLORS: Record<AccessLevel, string> = {
  edit: "bg-green-100 text-green-700 border-green-300",
  view: "bg-info-bg text-slate border-slate/30",
  none: "bg-gray-100 text-gray-400 border-gray-200",
};

const ACCESS_ICONS: Record<AccessLevel, typeof Pencil> = {
  edit: Pencil,
  view: Eye,
  none: EyeOff,
};

export default function EmployeesPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const ar = lang === "ar";
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
    setForm({ name: "", username: "", pin: "", password: "", role: "custom", defaultRoute: "/dashboard", active: true, phoneNumber: "" });
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
    <div className="space-y-6">
      {permRequests.length > 0 ? (
        <div role="status" data-testid="hr-permission-requests" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-slate-900" dir={ar ? "rtl" : "ltr"}>
          <p className="font-bold">{ar ? "منح وتغييرات حساسة بانتظار اعتماد محرر حسابات آخر — لم يُطبَّق بعد:" : "Sensitive grants and changes awaiting another account editor — not applied yet:"}</p>
          <ul className="mt-2 space-y-2">
            {permRequests.map((r) => (
              r.kind === "PERMISSION_REVIEW" ? (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{r.accountName}</span>: {ar ? "سُحب فورًا — " : "revoked at once — "}{[...r.revoked.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.fromAdmin ? [ar ? "دور مدير النظام" : "the admin role"] : [])].join(ar ? "، " : ", ")}
                  <span className="block text-xs text-brown/60">{ar ? "مراجعة لاحقة من شخص آخر · سحبه" : "Post-hoc review by another person · revoked by"} {r.requestedByName ?? "—"}</span>
                </span>
                {!r.mine && !r.isSubject ? (
                  <button type="button" onClick={() => void decidePermissionRequest(r, "ACKNOWLEDGE")} className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-bold">{ar ? "إقرار المراجعة" : "Acknowledge"}</button>
                ) : <span className="text-xs text-brown/60">{ar ? "يراجعه شخص آخر" : "Another person reviews it"}</span>}
              </li>
              ) : (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{r.accountName}</span>: {[...r.grants.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.subs ?? []).map((k) => `${(ar ? REVIEWED_GRANT_SUB_AR[k] : REVIEWED_GRANT_SUB_EN[k]) ?? k}${(r.confirms ?? []).includes(k) ? (ar ? " (تأكيد صلاحية قائمة)" : " (confirm, already held)") : ""}`), ...(r.toAdmin ? [ar ? "دور مدير النظام" : "the admin role"] : []), ...(r.credentialFields ?? []).map((f) => (ar ? ({ username: "تغيير اسم المستخدم", pin: "تغيير الرمز السري", password: "تغيير كلمة المرور", active: "إعادة التفعيل" } as Record<string, string>)[f] ?? f : ({ username: "username change", pin: "PIN change", password: "password change", active: "reactivation" } as Record<string, string>)[f] ?? f))].join(ar ? "، " : ", ")}
                  <span className="block text-xs text-brown/60">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {hrText(r.reason, ar ? "ar" : "en")}</span>
                </span>
                <span className="flex gap-2">
                  {r.mine ? (
                    <button type="button" onClick={() => void decidePermissionRequest(r, "WITHDRAW")} className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-bold">{ar ? "سحب الطلب" : "Withdraw"}</button>
                  ) : r.isSubject ? (
                    <span className="text-xs text-brown/60">{ar ? "طلب على حسابك؛ يقرره غيرك" : "A request on your account; someone else decides"}</span>
                  ) : (
                    <>
                      <button type="button" onClick={() => void decidePermissionRequest(r, "APPROVE")} className="px-3 py-1.5 rounded-lg bg-orange text-white text-xs font-bold">{ar ? "اعتماد وتطبيق" : "Approve and apply"}</button>
                      <button type="button" onClick={() => void decidePermissionRequest(r, "REJECT")} className="px-3 py-1.5 rounded-lg border border-red-300 bg-white text-red-700 text-xs font-bold">{ar ? "رفض" : "Reject"}</button>
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
        <div role="status" data-testid="hr-identity-not-verified" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" dir={ar ? "rtl" : "ltr"}>
          <p className="font-bold">{ar ? "هوية غير موثّقة — محظور من إجراءات الرواتب حتى التوثيق:" : "Identity not verified — blocked from payroll actions until verified:"}</p>
          <p className="text-xs mt-0.5">{ar ? "تبقى المهام مسندة، لكن الخادم يرفض كل إجراء رواتب أو إدارة رواتب من هذه الحسابات حتى يرتبط الحساب بشخص (موظف أو شخص خارجي) وتُوثَّق هويته بموافقة شخص ثانٍ." : "The duties stay assigned, but the server refuses every payroll or payroll-administration action from these logins until each is linked to a person (employee or external person) whose identity a second person verifies."}</p>
          <ul className="mt-1 list-disc ps-5">{identityNotVerified.map((r) => (
            <li key={r.id}>
              <span className="font-semibold">{r.name}</span>{r.inactive ? <span className="text-xs"> ({ar ? "غير نشط" : "inactive"})</span> : null}
              {" "}<span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 border border-amber-300">{r.status === "NOT_VERIFIED" ? (ar ? `مرتبط بـ«${r.personName ?? "—"}» · هوية غير موثّقة` : `linked to “${r.personName ?? "—"}” · identity not verified`) : (ar ? "غير مرتبط بأي شخص" : "not linked to any person")}</span>
              {" "}<span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-50 text-red-700 border border-red-200">{ar ? "محظور من إجراءات الرواتب حتى التوثيق" : "Blocked from payroll actions until verified"}</span>
              : {[...r.duties.map((g) => (ar ? PAYROLL_DUTY_AR[g] : PAYROLL_DUTY_EN[g])), ...(r.role === "admin" ? [ar ? "دور مدير النظام" : "the admin role"] : [])].join(ar ? "، " : ", ")}
            </li>
          ))}</ul>
        </div>
      ) : null}
      {canEditPerms && identity && identity.requests.some((q) => q.status === "PENDING") ? (
        <div role="status" data-testid="hr-identity-pending" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-slate-900 flex flex-wrap items-center justify-between gap-2" dir={ar ? "rtl" : "ltr"}>
          <span>{ar ? `${identity.requests.filter((q) => q.status === "PENDING").length} طلب هوية (توثيق أو شخص خارجي) بانتظار قرار شخص آخر.` : `${identity.requests.filter((q) => q.status === "PENDING").length} identity request(s) (verification or external person) awaiting another person.`}</span>
          <a href="/dashboard/hr/settings?view=external" className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-bold">{ar ? "مراجعة الطلبات" : "Review requests"}</a>
        </div>
      ) : null}
      {canEditPerms && user ? <MfaPanel ar={ar} meId={user.id} onToast={showToast} /> : null}
      {dutyConflicts.length > 0 ? (
        <div role="status" data-testid="hr-duty-conflicts-report" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" dir={ar ? "rtl" : "ltr"}>
          <p className="font-bold">{ar ? "حسابات تجمع مهام رواتب متعارضة — للمراجعة، لم يُسحب شيء تلقائيًا:" : "Accounts holding conflicting payroll duties — for review; nothing was revoked automatically:"}</p>
          <ul className="mt-1 list-disc ps-5">
            {dutyConflicts.map((c) => (
              <li key={c.id}><span className="font-semibold">{c.name}</span>{c.inactive ? <span className="text-xs"> ({ar ? "غير نشط" : "inactive"})</span> : null}: {c.conflicts.map(([a, b]) => ar ? `${PAYROLL_DUTY_AR[a]} + ${PAYROLL_DUTY_AR[b]}` : `${PAYROLL_DUTY_EN[a]} + ${PAYROLL_DUTY_EN[b]}`).join(ar ? "، " : ", ")}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 ltr:right-6 rtl:left-6 z-[100] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl text-sm font-bold text-white transition-all ${toast.ok ? "bg-green-600" : "bg-red-600"}`}>
          {toast.ok ? "✓" : "✕"} {toast.text}
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("employees")}</h1>
          <p className="text-brown text-sm font-medium">{employees.length} {t("employees")}</p>
        </div>
        {canCreate && (
          <button onClick={openNew}
            className="flex items-center gap-2 px-5 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange-dark transition-all duration-200 shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98]">
            <Plus size={18} strokeWidth={2.5} /> {t("newEmployee")}
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {employees.map((emp) => {
          // QA P3: an account on role defaults (empty permissions) shows the duties it ACTUALLY has.
          // (Roster readers get no permissions at all: nothing to count.)
          const perms = emp.permissions === undefined ? parsePerms({}) : (effectivePermissions(emp.permissions, emp.role) as ReturnType<typeof parsePerms>);
          const { edit, view } = countAccess(perms);
          return (
            <div key={emp.id} className={`bg-white rounded-2xl border p-5 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group ${emp.active ? "border-border hover:border-border-light" : "border-red-200 bg-red-50/30 opacity-70"}`}>
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${emp.active ? "bg-slate/10 group-hover:bg-slate/15" : "bg-red-100"}`}>
                  <Shield size={20} className={emp.active ? "text-slate" : "text-red-400"} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-charcoal">{emp.name}</p>
                  {emp.username && (
                    <p className="text-[11px] text-brown/50 font-mono font-medium">@{emp.username}</p>
                  )}
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cream text-brown">
                      {ROLE_LABELS[emp.role] || emp.role}
                    </span>
                    {!emp.active && (
                      <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-600 border border-red-200">
                        غير نشط · Inactive
                      </span>
                    )}
                    {identity ? <IdentityBadge s={identity.logins.find((l) => l.id === emp.id)} ar={ar} /> : null}
                  </div>
                </div>
                {canEditPerms && identity && (
                  <button onClick={() => setIdentityFor(emp)} data-testid="hr-identity-open" aria-label={ar ? "الهوية والتوثيق" : "Identity and verification"}
                    className="px-2.5 py-1.5 text-[11px] font-bold text-brown/70 border border-border rounded-lg hover:text-orange hover:border-orange/40 transition-all duration-200">
                    {ar ? "الهوية" : "Identity"}
                  </button>
                )}
                {canEditPerms && (
                  <button onClick={() => openEdit(emp)}
                    className="p-2.5 text-brown/40 hover:text-orange hover:bg-orange/10 rounded-xl transition-all duration-200 opacity-0 group-hover:opacity-100">
                    <Pencil size={16} />
                  </button>
                )}
              </div>
              <div className="flex gap-2 mb-3">
                <span className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-green-50 text-green-700 border border-green-200">
                  {edit} {t("edit")}
                </span>
                <span className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-info-bg text-slate border border-slate/20">
                  {view} {t("view")}
                </span>
                <span className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gray-50 text-gray-400 border border-gray-200">
                  {ALL_MODULES.length - edit - view} {ar ? "مخفية" : "hidden"}
                </span>
              </div>
              <div className="text-xs text-brown/50 font-medium space-y-0.5">
                <p className="flex items-center gap-1.5">
                  <Navigation size={11} className="text-[#6B7280]" />
                  {t("defaultPage")}: <span className="text-charcoal font-bold">{routeLabel(emp.defaultRoute || "/dashboard")}</span>
                </p>
                <p>{formatDate(emp.createdAt)}</p>
                <p>{t("active")}: {emp.active ? <span className="text-green-600 font-bold">{t("active")}</span> : <span className="text-danger font-bold">{t("inactive")}</span>}</p>
              </div>
            </div>
          );
        })}
        {employees.length === 0 && (
          <div className="col-span-full text-center py-16 text-brown/40">
            <Users size={48} className="mx-auto mb-3 opacity-50" /><p className="font-semibold">{t("noEmployeesFound")}</p>
          </div>
        )}
      </div>

      {identityFor && identity ? <IdentityDialog emp={identityFor} reg={identity} ar={ar} onClose={() => setIdentityFor(null)} onDone={(msg) => { setIdentityFor(null); showToast(true, msg); loadIdentity(); }} onError={(msg) => showToast(false, msg)} /> : null}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-7 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-extrabold text-charcoal mb-5">
              {editingId ? t("edit") + " " + t("employees") : t("newEmployee")}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Row 1: Display Name + Username */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1.5">{t("displayName")}</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1.5">{t("usernameLabel")} <span className="text-brown/50 font-normal">(login ID)</span></label>
                  <div className="relative">
                    <span className="absolute ltr:left-3.5 rtl:right-3.5 top-1/2 -translate-y-1/2 text-brown/40 font-bold text-sm select-none">@</span>
                    <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64) })}
                      className="w-full ltr:pl-8 rtl:pr-8 pr-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors font-mono"
                      placeholder="e.g. ahmed" required />
                  </div>
                </div>
              </div>

              {/* The number automated WhatsApp messages reach this employee on. */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5">{t("phoneNumber")} <span className="text-brown/50 font-normal">(WhatsApp)</span></label>
                <input type="tel" dir="ltr" value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
                  className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                  placeholder="05XXXXXXXX" data-testid="employee-phone" />
              </div>

              {/* Row 2: PIN + Password */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1.5">
                    {editingId ? t("newPin") : t("pinLabel")}
                  </label>
                  <input type="text" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                    className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors font-mono tracking-widest"
                    {...(!editingId ? { required: true, minLength: PIN_LENGTH } : {})}
                    inputMode="numeric" maxLength={PIN_LENGTH} placeholder={`${PIN_LENGTH} digits`} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1.5">
                    {editingId ? t("passwordLabel") : t("passwordLabel")}
                  </label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                    placeholder="For username+password login" autoComplete="new-password" />
                </div>
              </div>

              {/* Account Status (edit only) */}
              {editingId && (
                <div className="flex items-center justify-between px-4 py-3 rounded-xl border-2 border-border bg-cream/50">
                  <div>
                    <p className="text-sm font-bold text-charcoal">حالة الحساب · Account Status</p>
                    <p className="text-xs text-brown/50 mt-0.5">{form.active ? "Active — employee can log in" : "Inactive — login blocked"}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
                    className={`relative w-12 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${form.active ? "bg-green-500" : "bg-red-400"}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${form.active ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
              )}

              {editingId && editingHeldInv && ["adjust", "override"].some((k) => hasModuleAccess(permissions, "inventory") && hasSubPrivilege(permissions, "inventory", k)) ? (
                <label data-testid="confirm-inventory-subs" className="flex items-start gap-2 px-4 py-3 rounded-xl border-2 border-amber-200 bg-amber-50 text-sm text-amber-900">
                  <input type="checkbox" checked={confirmInv} onChange={(e) => setConfirmInv(e.target.checked)} className="mt-1" />
                  <span>
                    <span className="font-bold block">{ar ? "طلب تأكيد صلاحية المخزون المميّزة من محرر حسابات آخر" : "Ask another account editor to confirm the inventory supervisor permissions"}</span>
                    <span className="text-xs">{ar ? "تعديل المخزون / التجاوز ممنوحان لهذا الحساب مسبقًا. يُنشأ طلب يعتمده شخص ثانٍ ولا يتغيّر شيء عند الاعتماد؛ يُسجَّل الاعتماد دليلًا للمنح." : "Stock adjustment / override are already on this account. A request is created for a second person; nothing changes on approval, and the approval is recorded as the grant's evidence."}</span>
                  </span>
                </label>
              ) : null}

              {/* Default Landing Page */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5 flex items-center gap-1.5">
                  <Navigation size={14} className="text-[#6B7280]" /> {t("defaultPage")}
                </label>
                <select
                  value={form.defaultRoute}
                  onChange={(e) => setForm({ ...form, defaultRoute: e.target.value })}
                  className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors bg-white text-charcoal text-sm"
                >
                  {ROUTE_OPTIONS.map((opt) => {
                    const accessible = !opt.module || opt.module === "dashboard" || hasModuleAccess(permissions, opt.module);
                    return (
                      <option key={opt.value} value={opt.value} disabled={!accessible}>
                        {opt.label}{!accessible ? ` (${t("noAccess")})` : ""}
                      </option>
                    );
                  })}
                </select>
                {form.defaultRoute !== "/dashboard" && !accessibleRoutes.find((r) => r.value === form.defaultRoute) && (
                  <p className="text-xs text-amber-700 font-bold mt-1.5 flex items-center gap-1">
                    ⚠ This page requires access permissions for that module. Grant access above or change the landing page.
                  </p>
                )}
                <p className="text-xs text-brown/50 mt-1.5 font-medium">
                  Only pages the employee can access are selectable. Greyed-out options require the relevant module permission.
                </p>
              </div>

              <div>
                <label className="block text-sm font-bold text-charcoal mb-2">{t("role")}</label>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(ROLE_LABELS).map(([key, label]) => (
                    <button key={key} type="button" onClick={() => applyPreset(key)}
                      className={`px-3.5 py-2 rounded-xl text-xs font-bold border-2 transition-all duration-200 ${
                        form.role === key
                          ? "bg-charcoal text-white border-charcoal shadow-md"
                          : "bg-white text-brown border-border hover:border-slate hover:text-charcoal"
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Lock size={16} className="text-orange" />
                  <label className="text-sm font-extrabold text-charcoal">{t("permissionsLabel")}</label>
                </div>

                <div className="space-y-2">
                  {ALL_MODULES.map((mod) => {
                    const perm = permissions[mod] || { access: "none" as AccessLevel };
                    const subs = MODULE_SUB_PRIVILEGES[mod];
                    return (
                      <div key={mod} className="border-2 border-border rounded-xl overflow-hidden hover:border-slate/30 transition-colors">
                        <div className="flex items-center gap-3 px-4 py-3 bg-cream/50">
                          <span className="text-sm font-bold text-charcoal flex-1">
                            {MODULE_LABELS[mod]}
                          </span>
                          <div className="flex gap-1.5">
                            {(["edit", "view", "none"] as AccessLevel[]).map((level) => {
                              const Icon = ACCESS_ICONS[level];
                              const active = perm.access === level;
                              return (
                                <button key={level} type="button"
                                  onClick={() => setModuleAccess(mod, level)}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border-2 transition-all duration-200 ${
                                    active ? ACCESS_COLORS[level] : "bg-white text-gray-400 border-gray-200 hover:border-gray-300"
                                  }`}>
                                  <Icon size={12} />
                                  {level === "edit" ? t("edit") : level === "view" ? t("view") : t("noAccess")}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {mod === "hr" && perm.access !== "none" && formConflicts.length > 0 ? (
                          <div role="alert" data-testid="hr-duty-conflict" className="px-4 py-2.5 border-t border-amber-200 bg-amber-50 text-xs font-semibold text-amber-900" dir={ar ? "rtl" : "ltr"}>
                            {ar
                              ? <>{conflictMessageAr(formConflicts)} لن يُحفظ هذا الجمع. فصل المهام: الإعداد، والاعتماد، وتسجيل الصرف، وإلغاء المسير المعتمد لأشخاص مختلفين.</>
                              : <>{conflictMessageEn(formConflicts)} This combination will not be saved. Segregation of duties: preparation, approval, payment recording and cancelling an approved run belong to different people.</>}
                          </div>
                        ) : null}
                        {subs && perm.access !== "none" && (
                          <div className="px-4 py-2.5 border-t border-border bg-white">
                            <div className="flex flex-wrap gap-x-5 gap-y-2">
                              {subs.map((sub) => {
                                const enabled = perm.sub?.[sub.key] === true;
                                return (
                                  <label key={sub.key} className="flex items-center gap-2 cursor-pointer group/sub">
                                    <input type="checkbox" checked={enabled}
                                      onChange={() => toggleSub(mod, sub.key)}
                                      className="w-4 h-4 rounded border-2 border-gray-300 text-orange focus:ring-orange/30 accent-orange" />
                                    <span className={`text-xs font-medium transition-colors ${enabled ? "text-charcoal" : "text-gray-400"}`}>
                                      {sub.label}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Delete confirmation inline */}
              {editingId && deleteConfirm && (
                <div className="flex items-center gap-3 p-4 rounded-xl border-2 border-red-200 bg-red-50">
                  <AlertTriangle size={18} className="text-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-700 font-medium flex-1">Are you sure you want to permanently delete this employee?</p>
                  <button type="button" onClick={handleDelete} disabled={deleting}
                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors disabled:opacity-50">
                    {deleting ? "Deleting…" : "Yes, Delete"}
                  </button>
                  <button type="button" onClick={() => setDeleteConfirm(false)}
                    className="px-3 py-1.5 rounded-lg border border-border text-xs font-bold text-brown hover:bg-cream transition-colors">
                    Cancel
                  </button>
                </div>
              )}

              <div className="flex gap-3 pt-3">
                {editingId && user?.role === "admin" && !deleteConfirm && (
                  <button type="button" onClick={() => setDeleteConfirm(true)}
                    className="flex items-center gap-2 px-4 py-3 rounded-xl border-2 border-red-200 text-red-500 text-sm font-bold hover:bg-red-50 hover:border-red-400 transition-colors">
                    <Trash2 size={16} /> حذف
                  </button>
                )}
                <button type="submit"
                  className="flex-1 py-3 bg-orange text-white rounded-xl font-bold hover:bg-orange-dark transition-all duration-200 shadow-md shadow-orange/20 active:scale-[0.98]">
                  {editingId ? t("saveChanges") : t("createEmployee")}
                </button>
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function IdentityBadge({ s, ar }: { s?: IdentityRegister["logins"][number]; ar: boolean }) {
  if (!s) return null;
  const [cls, text] = s.verified
    ? ["bg-green-50 text-green-700 border-green-200", ar ? "هوية موثّقة" : "Identity verified"]
    : s.personType
      ? ["bg-amber-50 text-amber-800 border-amber-300", ar ? "هوية غير موثّقة" : "Identity not verified"]
      : ["bg-gray-50 text-gray-500 border-gray-200", ar ? "غير مرتبط بشخص" : "No person linked"];
  return <span data-testid="hr-identity-badge" className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold border ${cls}`}>{text}</span>;
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
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={ar ? "الهوية والتوثيق" : "Identity and verification"} data-testid="hr-identity-dialog" dir={ar ? "rtl" : "ltr"} className="bg-white rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-extrabold text-charcoal">{ar ? "الهوية والتوثيق" : "Identity and verification"} · {emp.name}</h2>
        <p className="text-sm">
          {s?.verified ? (ar ? `مرتبط بـ«${s.personName}» — هوية موثّقة.` : `Linked to “${s.personName}” — identity verified.`)
            : s?.personType ? (ar ? `مرتبط بـ«${s.personName}» (${s.personType === "EMPLOYEE" ? "موظف" : "شخص خارجي"}) — هوية غير موثّقة.` : `Linked to “${s.personName}” (${s.personType === "EMPLOYEE" ? "employee" : "external person"}) — identity not verified.`)
            : (ar ? "غير مرتبط بأي شخص. مهام الرواتب والإدارة لا تُمنح ولا تُنفَّذ إلا لحساب شخص موثّق." : "Not linked to any person. Payroll and administration duties are granted to, and performed by, logins of verified persons only.")}
        </p>
        {pending ? <p className="text-sm text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">{ar ? "يوجد طلب هوية لهذا الحساب بانتظار القرار." : "An identity request for this login is awaiting a decision."}</p> : null}
        {!s?.personType ? (
          <label className="block text-sm font-bold text-charcoal">
            {ar ? "اربطه بـ" : "Link it to"}
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1.5 w-full px-3 py-2.5 border-2 border-border rounded-xl font-normal">
              <option value="">—</option>
              {freeEmployees.length ? <optgroup label={ar ? "موظف (يُوثَّق مع الربط)" : "Employee (verified with the link)"}>{freeEmployees.map((e) => <option key={e.id} value={`E:${e.id}`}>{e.employeeNo} · {e.name}</option>)}</optgroup> : null}
              {freeExternals.length ? <optgroup label={ar ? "شخص خارجي" : "External person"}>{freeExternals.map((x) => <option key={x.id} value={`X:${x.id}`}>{x.fullName}{x.organization ? ` · ${x.organization}` : ""}</option>)}</optgroup> : null}
            </select>
            <span className="block text-xs font-normal text-brown/60 mt-1">{ar ? "لشخص خارجي غير مسجّل: أضفه أولًا من" : "For an external person not yet recorded: add them first in"} <a className="underline" href="/dashboard/hr/settings?view=external">{ar ? "الأشخاص الخارجيون" : "External persons"}</a>.</span>
          </label>
        ) : null}
        {!s?.verified ? (
          <label className="block text-sm font-bold text-charcoal">
            {ar ? "السبب وما تحققت منه *" : "Reason and what you checked *"}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1.5 w-full px-3 py-2 border-2 border-border rounded-xl font-normal" />
          </label>
        ) : null}
        <div className="flex flex-wrap gap-2 justify-end">
          {!s?.verified ? <button type="button" disabled={!canSend || busy} onClick={() => void send()} className="px-4 py-2 rounded-xl bg-orange text-white text-sm font-bold disabled:opacity-50">{s?.personType ? (ar ? "طلب توثيق الهوية" : "Request verification") : (ar ? "طلب الربط والتوثيق" : "Request link")}</button> : null}
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-border text-sm font-bold">{ar ? "إغلاق" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
