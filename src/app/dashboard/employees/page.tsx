"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Shield, Pencil, Eye, EyeOff, Lock, Navigation } from "lucide-react";
import {
  ROLE_LABELS, ALL_MODULES, MODULE_LABELS, MODULE_SUB_PRIVILEGES,
  buildDefaultPermissions, hasSubPrivilege, hasModuleAccess,
  type Permissions, type AccessLevel,
} from "@/lib/auth";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { useI18n } from "@/lib/i18n/context";

type Employee = {
  id: string; name: string; username: string | null; role: string;
  permissions: string | Permissions;
  defaultRoute: string;
  active: boolean; createdAt: string;
};

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
  const { t } = useI18n();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "employees", "create");
  const canEditPerms = hasSubPrivilege(user?.permissions ?? {}, "employees", "edit");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", username: "", pin: "", password: "", role: "custom", defaultRoute: "/dashboard" });
  const [permissions, setPermissions] = useState<Permissions>(buildDefaultPermissions("custom"));

  useEffect(() => { loadEmployees(); }, []);

  async function loadEmployees() {
    const res = await fetch("/api/employees");
    setEmployees(await res.json());
  }

  function openNew() {
    setEditingId(null);
    setForm({ name: "", username: "", pin: "", password: "", role: "custom", defaultRoute: "/dashboard" });
    setPermissions(buildDefaultPermissions("custom"));
    setShowForm(true);
  }

  function openEdit(emp: Employee) {
    setEditingId(emp.id);
    setForm({ name: emp.name, username: emp.username || "", pin: "", password: "", role: emp.role, defaultRoute: emp.defaultRoute || "/dashboard" });
    setPermissions(parsePerms(emp.permissions));
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
    const body: Record<string, unknown> = {
      name: form.name, username: form.username.trim().toLowerCase(),
      role: form.role, permissions, defaultRoute: form.defaultRoute,
    };
    if (!editingId) {
      body.pin = form.pin;
      if (form.password) body.password = form.password;
      await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      if (form.pin) body.pin = form.pin;
      if (form.password) body.password = form.password;
      await fetch(`/api/employees/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    setShowForm(false);
    loadEmployees();
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
          const perms = parsePerms(emp.permissions);
          const { edit, view } = countAccess(perms);
          return (
            <div key={emp.id} className="bg-white rounded-2xl border border-border p-5 hover:shadow-lg hover:shadow-charcoal/5 hover:border-border-light transition-all duration-300 group">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 bg-slate/10 rounded-xl flex items-center justify-center group-hover:bg-slate/15 transition-colors">
                  <Shield size={20} className="text-slate" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-charcoal">{emp.name}</p>
                  {emp.username && (
                    <p className="text-[11px] text-brown/50 font-mono font-medium">@{emp.username}</p>
                  )}
                  <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cream text-brown mt-0.5">
                    {ROLE_LABELS[emp.role] || emp.role}
                  </span>
                </div>
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
                  {ALL_MODULES.length - edit - view} hidden
                </span>
              </div>
              <div className="text-xs text-brown/50 font-medium space-y-0.5">
                <p className="flex items-center gap-1.5">
                  <Navigation size={11} className="text-[#738995]" />
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
                    <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                      className="w-full ltr:pl-8 rtl:pr-8 pr-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors font-mono"
                      placeholder="e.g. ahmed" required />
                  </div>
                </div>
              </div>

              {/* Row 2: PIN + Password */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1.5">
                    {editingId ? t("newPin") : t("pinLabel")}
                  </label>
                  <input type="text" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                    className="w-full px-4 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors font-mono tracking-widest"
                    {...(!editingId ? { required: true, minLength: 4 } : {})}
                    inputMode="numeric" maxLength={8} placeholder="4–8 digits" />
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

              {/* Default Landing Page */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5 flex items-center gap-1.5">
                  <Navigation size={14} className="text-[#738995]" /> {t("defaultPage")}
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

                        {subs && perm.access !== "none" && (
                          <div className="px-4 py-2.5 border-t border-border bg-white">
                            <div className="flex flex-wrap gap-x-5 gap-y-2">
                              {subs.map((sub) => {
                                const enabled = perm.sub?.[sub.key] ?? (perm.access === "edit");
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

              <div className="flex gap-3 pt-3">
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
