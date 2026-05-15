"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Users2, Plus, Search, Pencil, Trash2, Star, X, ChevronRight,
  Phone, Mail, MapPin, Package,
} from "lucide-react";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

type GreenBeanSlim = { id: string; beanType: string; serialNumber: string };

type RoastPreference = {
  id: string;
  greenBeanId: string;
  profileName: string;
  notes: string | null;
  greenBean: GreenBeanSlim;
};

type Customer = {
  id: string;
  name: string;
  nameAr: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  _count: { orders: number; roastPreferences: number };
  roastPreferences: RoastPreference[];
};

type GreenBeanFull = { id: string; beanType: string; serialNumber: string; quantityKg: number };

const INPUT_CLS = "w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors";

export default function CustomersPage() {
  const { t } = useI18n();
  const user = useUser();
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "customers", "manage");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [beans, setBeans] = useState<GreenBeanFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Selected customer (detail panel)
  const [selected, setSelected] = useState<Customer | null>(null);
  const [tab, setTab] = useState<"info" | "profiles">("info");

  // Customer add/edit form
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [customerForm, setCustomerForm] = useState({ name: "", nameAr: "", phone: "", email: "", address: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Profile form
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingPref, setEditingPref] = useState<RoastPreference | null>(null);
  const [profileForm, setProfileForm] = useState({ greenBeanId: "", profileName: "", notes: "" });
  const [savingProfile, setSavingProfile] = useState(false);

  // Toast messages
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err" = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [custRes, beanRes] = await Promise.all([
      fetch("/api/customers"),
      fetch("/api/green-beans"),
    ]);
    if (custRes.ok) setCustomers(await custRes.json());
    if (beanRes.ok) setBeans(await beanRes.json());
    setLoading(false);
  }

  function refreshSelected(id: string, updated: Customer[]) {
    const found = updated.find((c) => c.id === id);
    if (found) setSelected(found);
  }

  // ── Customer CRUD ──────────────────────────────────────────────────────────
  function openAddCustomer() {
    setEditingCustomer(null);
    setCustomerForm({ name: "", nameAr: "", phone: "", email: "", address: "" });
    setShowCustomerForm(true);
  }

  function openEditCustomer(c: Customer) {
    setEditingCustomer(c);
    setCustomerForm({ name: c.name, nameAr: c.nameAr ?? "", phone: c.phone ?? "", email: c.email ?? "", address: c.address ?? "" });
    setShowCustomerForm(true);
  }

  async function handleSaveCustomer(e: React.FormEvent) {
    e.preventDefault();
    setSavingCustomer(true);
    const url = editingCustomer ? `/api/customers/${editingCustomer.id}` : "/api/customers";
    const method = editingCustomer ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customerForm),
    });
    setSavingCustomer(false);
    if (!res.ok) { const d = await res.json(); showToast(d.error || t("error"), "err"); return; }
    showToast(t("customerSaved"));
    setShowCustomerForm(false);
    await loadData().then(() => {
      setCustomers((prev) => {
        if (editingCustomer) {
          const next = prev.map((c) => c.id === editingCustomer.id ? { ...c, ...customerForm } : c);
          refreshSelected(editingCustomer.id, next);
          return next;
        }
        return prev;
      });
    });
  }

  async function handleDeleteCustomer(c: Customer) {
    if (!confirm(t("deleteCustomerConfirm"))) return;
    const res = await fetch(`/api/customers/${c.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); showToast(d.error || t("error"), "err"); return; }
    showToast(t("customerDeleted"));
    setSelected(null);
    loadData();
  }

  // ── Profile CRUD ───────────────────────────────────────────────────────────
  function openAddProfile() {
    setEditingPref(null);
    setProfileForm({ greenBeanId: "", profileName: "", notes: "" });
    setShowProfileForm(true);
  }

  function openEditProfile(pref: RoastPreference) {
    setEditingPref(pref);
    setProfileForm({ greenBeanId: pref.greenBeanId, profileName: pref.profileName, notes: pref.notes ?? "" });
    setShowProfileForm(true);
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSavingProfile(true);

    let res: Response;
    if (editingPref) {
      res = await fetch(`/api/customers/${selected.id}/preferences/${editingPref.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName: profileForm.profileName, notes: profileForm.notes }),
      });
    } else {
      res = await fetch(`/api/customers/${selected.id}/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileForm),
      });
    }

    setSavingProfile(false);
    if (!res.ok) { const d = await res.json(); showToast(d.error || t("error"), "err"); return; }
    showToast(t("roastPrefSaved"));
    setShowProfileForm(false);
    const updated = await fetch("/api/customers").then((r) => r.json()) as Customer[];
    setCustomers(updated);
    refreshSelected(selected.id, updated);
  }

  async function handleDeleteProfile(pref: RoastPreference) {
    if (!selected) return;
    const res = await fetch(`/api/customers/${selected.id}/preferences/${pref.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); showToast(d.error || t("error"), "err"); return; }
    showToast(t("roastPrefDeleted"));
    const updated = await fetch("/api/customers").then((r) => r.json()) as Customer[];
    setCustomers(updated);
    refreshSelected(selected.id, updated);
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredCustomers = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.nameAr && c.nameAr.includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q))
    );
  }, [customers, search]);

  // Beans not yet assigned a profile for this customer
  const availableBeans = useMemo(() => {
    if (!selected) return beans;
    const taken = new Set(selected.roastPreferences.map((p) => p.greenBeanId));
    if (editingPref) taken.delete(editingPref.greenBeanId); // allow editing current
    return beans.filter((b) => !taken.has(b.id));
  }, [beans, selected, editingPref]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("customersTitle")}</h1>
          <p className="text-brown text-sm font-medium">{customers.length} {t("customers")}</p>
        </div>
        {canManage && (
          <button
            onClick={openAddCustomer}
            className="flex items-center gap-2 px-4 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all duration-200"
          >
            <Plus size={16} /> {t("addCustomer")}
          </button>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 ltr:right-5 rtl:left-5 z-[100] px-4 py-3 rounded-xl text-sm font-bold shadow-lg ${toast.type === "ok" ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
          {toast.msg}
        </div>
      )}

      <div className="flex gap-5 items-start">
        {/* Customer list */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Search */}
          <div className="relative">
            <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder={t("searchCustomers")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
            />
          </div>

          {filteredCustomers.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-border text-brown/40">
              <Users2 size={36} className="mx-auto mb-3 opacity-40" />
              <p className="font-semibold">{t("noCustomers")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCustomers.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setSelected(c); setTab("info"); }}
                  className={`w-full text-start bg-white rounded-2xl border p-4 hover:shadow-md transition-all duration-200 ${selected?.id === c.id ? "border-orange shadow-md shadow-orange/15" : "border-border hover:border-orange/30"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-charcoal truncate">{c.name}</p>
                      {c.nameAr && <p className="text-sm text-brown/60 truncate">{c.nameAr}</p>}
                      <div className="flex items-center gap-3 mt-1 text-xs text-brown/60">
                        {c.phone && <span className="flex items-center gap-1"><Phone size={11} />{c.phone}</span>}
                        <span>{c._count.orders} {t("customerOrdersLabel")}</span>
                        {c._count.roastPreferences > 0 && (
                          <span className="flex items-center gap-1 text-amber-700 font-semibold">
                            <Star size={11} fill="currentColor" />
                            {c._count.roastPreferences} {t("customerProfilesLabel")}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-brown/30 flex-shrink-0 ltr:ml-2 rtl:mr-2 rtl:rotate-180" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="w-[380px] flex-shrink-0 bg-white rounded-2xl border border-border overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-cream/50">
              <div>
                <p className="font-extrabold text-charcoal">{selected.name}</p>
                {selected.nameAr && <p className="text-xs text-brown/60">{selected.nameAr}</p>}
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg text-brown/40 hover:text-charcoal hover:bg-cream transition-colors">
                <X size={18} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border">
              {(["info", "profiles"] as const).map((t_) => (
                <button
                  key={t_}
                  onClick={() => setTab(t_)}
                  className={`flex-1 py-2.5 text-sm font-bold transition-colors ${tab === t_ ? "text-orange border-b-2 border-orange" : "text-brown hover:text-charcoal"}`}
                >
                  {t_ === "info" ? t("customerInfo") : t("roastProfiles")}
                </button>
              ))}
            </div>

            <div className="p-5">
              {tab === "info" && (
                <div className="space-y-4">
                  {[
                    { icon: Phone, label: t("customerPhone"), val: selected.phone },
                    { icon: Mail, label: t("customerEmail"), val: selected.email },
                    { icon: MapPin, label: t("customerAddress"), val: selected.address },
                    { icon: Package, label: t("customerOrdersLabel"), val: String(selected._count.orders) },
                  ].map(({ icon: Icon, label, val }) => (
                    <div key={label} className="flex items-start gap-3">
                      <Icon size={16} className="text-brown/40 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-xs text-brown/50 font-medium">{label}</p>
                        <p className="text-sm text-charcoal font-semibold">{val || "—"}</p>
                      </div>
                    </div>
                  ))}

                  {canManage && (
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => openEditCustomer(selected)}
                        className="flex-1 flex items-center justify-center gap-2 py-2 bg-charcoal text-white rounded-xl text-sm font-bold hover:bg-charcoal/80 transition-all active:scale-[0.98]"
                      >
                        <Pencil size={14} /> {t("editCustomer")}
                      </button>
                      <button
                        onClick={() => handleDeleteCustomer(selected)}
                        className="p-2 rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                        title={t("delete")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {tab === "profiles" && (
                <div className="space-y-3">
                  {selected.roastPreferences.length === 0 ? (
                    <div className="text-center py-6 text-brown/40">
                      <Star size={28} className="mx-auto mb-2 opacity-30" />
                      <p className="text-sm font-semibold">{t("noProfiles")}</p>
                    </div>
                  ) : (
                    selected.roastPreferences.map((pref) => (
                      <div key={pref.id} className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <Star size={12} className="text-amber-600 flex-shrink-0" fill="currentColor" />
                              <p className="text-xs text-amber-700 font-bold truncate">{pref.greenBean.beanType}</p>
                              <span className="text-xs text-amber-500 font-mono">({pref.greenBean.serialNumber})</span>
                            </div>
                            <p className="text-sm font-bold text-charcoal">{pref.profileName}</p>
                            {pref.notes && <p className="text-xs text-brown/60 mt-0.5">{pref.notes}</p>}
                          </div>
                          {canManage && (
                            <div className="flex gap-1 flex-shrink-0">
                              <button onClick={() => openEditProfile(pref)} className="p-1.5 rounded-lg text-amber-600 hover:bg-amber-100 transition-colors">
                                <Pencil size={13} />
                              </button>
                              <button onClick={() => handleDeleteProfile(pref)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 transition-colors">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}

                  {canManage && availableBeans.length > 0 && (
                    <button
                      onClick={openAddProfile}
                      className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-orange/40 rounded-xl text-orange text-sm font-bold hover:border-orange hover:bg-orange/5 transition-all"
                    >
                      <Plus size={15} /> {t("addProfile")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Customer form modal ─────────────────────────────────────────────── */}
      {showCustomerForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowCustomerForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-4">
              {editingCustomer ? t("editCustomer") : t("addCustomer")}
            </h2>
            <form onSubmit={handleSaveCustomer} className="space-y-3">
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("customerName")} *</label>
                <input required value={customerForm.name} onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })} className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("customerNameAr")}</label>
                <input value={customerForm.nameAr} onChange={(e) => setCustomerForm({ ...customerForm, nameAr: e.target.value })} className={INPUT_CLS} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("customerPhone")}</label>
                  <input value={customerForm.phone} onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })} className={INPUT_CLS} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("customerEmail")}</label>
                  <input type="email" value={customerForm.email} onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })} className={INPUT_CLS} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("customerAddress")}</label>
                <textarea value={customerForm.address} onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })} rows={2} className={INPUT_CLS} />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="submit" disabled={savingCustomer}
                  className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all disabled:opacity-60">
                  {savingCustomer ? t("saving") : t("save")}
                </button>
                <button type="button" onClick={() => setShowCustomerForm(false)}
                  className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Profile form modal ──────────────────────────────────────────────── */}
      {showProfileForm && selected && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowProfileForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">
              {editingPref ? t("editProfile") : t("addProfile")}
            </h2>
            <p className="text-sm text-brown font-medium mb-4">{selected.name}</p>
            <form onSubmit={handleSaveProfile} className="space-y-3">
              {!editingPref && (
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("beanType")} *</label>
                  <select required value={profileForm.greenBeanId}
                    onChange={(e) => setProfileForm({ ...profileForm, greenBeanId: e.target.value })}
                    className={INPUT_CLS}>
                    <option value="">{t("selectBeanLabel")}</option>
                    {availableBeans.map((b) => (
                      <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber})</option>
                    ))}
                  </select>
                </div>
              )}
              {editingPref && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  <p className="text-xs text-amber-700 font-bold">{editingPref.greenBean.beanType}</p>
                  <p className="text-xs text-amber-500 font-mono">{editingPref.greenBean.serialNumber}</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("profileNameLabel")} *</label>
                <input required value={profileForm.profileName}
                  onChange={(e) => setProfileForm({ ...profileForm, profileName: e.target.value })}
                  placeholder="e.g. Dark-Gua-02"
                  className={INPUT_CLS} />
              </div>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("profileNotesLabel")}</label>
                <textarea value={profileForm.notes}
                  onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })}
                  rows={2} className={INPUT_CLS} />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="submit" disabled={savingProfile}
                  className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all disabled:opacity-60">
                  {savingProfile ? t("saving") : t("save")}
                </button>
                <button type="button" onClick={() => setShowProfileForm(false)}
                  className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
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
