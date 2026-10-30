"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { useUser } from "../user-context";
import { canEdit, hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { Ico } from "@/components/shell/icons";
import { SectionPages, useCreateRequest, usePhone, useD21Phone } from "@/components/shell/page-context";
import { Dialog, Field, HrRoot } from "@/components/hr/ui";
import { CreditBadges } from "@/components/credit/credit-ui";
import { useAccountantView } from "../accounting/_ui/qoyod-pages";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { customersScopedToOwner } from "@/lib/services/sales/scope";
import { isSalesPersona } from "@/lib/workspace/landing";
import "./customers.css";

/**
 * Customers — Direction 2.1 (UI batch 2; UI batch 3: each name links to the account page
 * /dashboard/customers/[id] (179:1312) and the preview carries «فتح الصفحة»). Figma has the customer ACCOUNT (Phase 2 CRM page
 * 166:3352, «crm-account» 179:1312 / 390 178:1353) but no list frame, so the list is drawn like
 * the leads list (`crm-leads` 171:2: page header, search toolbar, ledger table, docked preview)
 * and the preview after the account frame — showing only what exists today: the contact
 * particulars, the WhatsApp opt-out, the order count and the roast profiles. Same requests
 * (/api/customers, /api/green-beans, /api/customers/:id[/preferences/:pid]), same payloads,
 * same validation; the account frame's sales, balance, deals, activity and quotation blocks
 * need data this screen does not have and are not drawn.
 */

type GreenBeanSlim = { id: string; beanType: string; serialNumber: string };

type UsageType = "ESPRESSO" | "FILTER" | "BOTH";

type RoastPreference = {
  id: string;
  greenBeanId: string;
  profileName: string;
  usageType: UsageType;
  notes: string | null;
  greenBean: GreenBeanSlim;
  targetColorWhole:      number | null;
  targetToleranceWhole:  number | null;
  targetColorGround:     number | null;
  targetToleranceGround: number | null;
  targetDeltaMin:        number | null;
  targetDeltaMax:        number | null;
};

type Customer = {
  id: string;
  name: string;
  nameAr: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  whatsappOptOut?: boolean;
  _count: { orders: number; roastPreferences: number };
  roastPreferences: RoastPreference[];
};

type GreenBeanFull = { id: string; beanType: string; serialNumber: string; quantityKg: number };


export default function CustomersPage() {
  const { t, lang } = useI18n();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const phone = usePhone();
  const user = useUser();
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "customers", "manage");
  useD21Phone({ title: ar ? "العملاء" : "Customers" });
  // «عملائي» (batch 24): a rep scoped to their book opens on the customers they are the account owner of — the same
  // definition Ctrl K searches — and can switch to everything they may serve (their deals' and orders' customers and
  // the ones nobody owns). The server decides visibility; `?owner=me` only narrows it.
  const scopedRep = user ? customersScopedToOwner(user) : false;
  // The last tab is remembered per person on this device (council fix round 1, P0-16) — a convenience, never data.
  const viewKey = user ? `hq.customersView.v1.${user.id}` : null;
  const [viewPick, setViewPickState] = useState<"mine" | "book" | null>(() => {
    if (!viewKey || typeof window === "undefined") return null;
    try { const v = window.localStorage.getItem(viewKey); return v === "mine" || v === "book" ? v : null; } catch { return null; }
  });
  const setViewPick = (v: "mine" | "book") => { setViewPickState(v); try { if (viewKey) window.localStorage.setItem(viewKey, v); } catch { /* private window */ } };
  const view = viewPick ?? (scopedRep ? "mine" : "book");
  // A sales person (council fix round 3, seat 5): no roast-profile column (a roastery's word, not a rep's), and a
  // «متأخرين» chip — the customers whose reorder status is LATE, the same status «يومي» and «متابعة إعادة الشراء» use.
  const salesView = !!user && isSalesPersona(user);
  const [lateIds, setLateIds] = useState<Set<string> | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  useEffect(() => {
    if (!salesView) return;
    let off = false;
    fetch("/api/sales/reorder").then((r) => (r.ok ? r.json() : null)).then((j: { rows: { customerId: string; state: string }[] } | null) => {
      if (!off && j) setLateIds(new Set(j.rows.filter((x) => x.state === "LATE").map((x) => x.customerId)));
    }).catch(() => undefined);
    return () => { off = true; };
  }, [salesView]);
  const listUrl = view === "mine" ? "/api/customers?owner=me" : "/api/customers";

  const [customers, setCustomers] = useState<Customer[]>([]);
  // feat/credit-hold: the red badges («متجاوز حد الائتمان», «متأخر السداد …», «البيع موقوف», «مهلة سماح حتى …»).
  type Badge = { overLimit: boolean; overdueDays: number; graceUntil: string | null; hold: { endsAt: string | null; untilPaid: boolean } | null };
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  const [beans, setBeans] = useState<GreenBeanFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Qoyod parity (accountant workspace only): «الرصيد» and «متأخرة» per customer from the AR aging (read-only; the
  // same figures as «أعمار الذمم»). Everyone else keeps the roast-profile and WhatsApp columns.
  const qoyod = useAccountantView() && !!user && canViewInvoices(user.permissions);
  const [arByCustomer, setArByCustomer] = useState<Record<string, { balance: string; overdue: string }> | null>(null);
  useEffect(() => {
    if (!qoyod) return;
    let off = false;
    fetch("/api/accounting/ar/aging").then((r) => (r.ok ? r.json() : null)).then((j: { rows: { customerId: string; balance: string; overdue: string }[] } | null) => {
      if (off || !j) return;
      setArByCustomer(Object.fromEntries(j.rows.map((x) => [x.customerId, { balance: x.balance, overdue: x.overdue }])));
    }).catch(() => undefined);
    return () => { off = true; };
  }, [qoyod]);
  const fmt2 = (v: string | undefined) => (v === undefined ? "0.00" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v)));

  // Selected customer (detail panel)
  const [selected, setSelected] = useState<Customer | null>(null);
  const [tab, setTab] = useState<"info" | "profiles">("info");

  // Customer add/edit form
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [customerForm, setCustomerForm] = useState({ name: "", nameAr: "", phone: "", email: "", address: "", whatsappOptOut: false });
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Profile form
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingPref, setEditingPref] = useState<RoastPreference | null>(null);
  const [profileForm, setProfileForm] = useState({
    greenBeanId: "", profileName: "", usageType: "BOTH" as UsageType, notes: "",
    targetColorWhole: "", targetToleranceWhole: "",
    targetColorGround: "", targetToleranceGround: "",
    targetDeltaMin: "", targetDeltaMax: "",
  });
  const [savingProfile, setSavingProfile] = useState(false);

  // Toast messages
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err" = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  useEffect(() => { loadData(); }, [listUrl]);

  // ?open=<id>[&tab=profiles]: the account page's «مسارات التحميص» opens this preview, where the
  // roast profiles are managed. Applied once, by the first load of the list.
  const search0 = useSearchParams();
  const deepLink = useRef<{ id: string; tab: "info" | "profiles" } | null>(
    search0.get("open") ? { id: search0.get("open")!, tab: search0.get("tab") === "profiles" ? "profiles" : "info" } : null,
  );

  async function loadData() {
    setLoading(true);
    const [custRes, beanRes] = await Promise.all([
      fetch(listUrl),
      fetch("/api/green-beans"),
    ]);
    if (custRes.ok) {
      const list = (await custRes.json()) as Customer[];
      setCustomers(list);
      const want = deepLink.current;
      deepLink.current = null;
      const found = want ? list.find((c) => c.id === want.id) : undefined;
      if (found && want) { setSelected(found); setTab(want.tab); }
    }
    if (beanRes.ok) setBeans(await beanRes.json());
    setLoading(false);
    fetch("/api/customers/credit-badges").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.badges) setBadges(d.badges); }).catch(() => undefined);
  }

  function refreshSelected(id: string, updated: Customer[]) {
    const found = updated.find((c) => c.id === id);
    if (found) setSelected(found);
  }

  // ── Customer CRUD ──────────────────────────────────────────────────────────
  function openAddCustomer() {
    setEditingCustomer(null);
    setCustomerForm({ name: "", nameAr: "", phone: "", email: "", address: "", whatsappOptOut: false });
    setShowCustomerForm(true);
  }

  // «+» beside «العملاء» in the accountant workspace (?new=customer): the same form as «عميل جديد», for the API's audience (customers › edit).
  useCreateRequest("customer", openAddCustomer, !!user && canEdit(user.permissions, "customers"));

  function openEditCustomer(c: Customer) {
    setEditingCustomer(c);
    setCustomerForm({ name: c.name, nameAr: c.nameAr ?? "", phone: c.phone ?? "", email: c.email ?? "", address: c.address ?? "", whatsappOptOut: c.whatsappOptOut ?? false });
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
    if (!res.ok) { const d = await res.json(); showToast(localizeApiError(d) || t("error"), "err"); return; }
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
    if (!res.ok) { const d = await res.json(); showToast(localizeApiError(d) || t("error"), "err"); return; }
    showToast(t("customerDeleted"));
    setSelected(null);
    loadData();
  }

  // ── Profile CRUD ───────────────────────────────────────────────────────────
  const BLANK_PROFILE_FORM = {
    greenBeanId: "", profileName: "", usageType: "BOTH" as UsageType, notes: "",
    targetColorWhole: "", targetToleranceWhole: "",
    targetColorGround: "", targetToleranceGround: "",
    targetDeltaMin: "", targetDeltaMax: "",
  };

  function openAddProfile() {
    setEditingPref(null);
    setProfileForm(BLANK_PROFILE_FORM);
    setShowProfileForm(true);
  }

  function openEditProfile(pref: RoastPreference) {
    setEditingPref(pref);
    setProfileForm({
      greenBeanId: pref.greenBeanId,
      profileName: pref.profileName,
      usageType: pref.usageType ?? "BOTH",
      notes: pref.notes ?? "",
      targetColorWhole:      pref.targetColorWhole      != null ? String(pref.targetColorWhole)      : "",
      targetToleranceWhole:  pref.targetToleranceWhole  != null ? String(pref.targetToleranceWhole)  : "",
      targetColorGround:     pref.targetColorGround     != null ? String(pref.targetColorGround)     : "",
      targetToleranceGround: pref.targetToleranceGround != null ? String(pref.targetToleranceGround) : "",
      targetDeltaMin:        pref.targetDeltaMin        != null ? String(pref.targetDeltaMin)        : "",
      targetDeltaMax:        pref.targetDeltaMax        != null ? String(pref.targetDeltaMax)        : "",
    });
    setShowProfileForm(true);
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSavingProfile(true);

    const toFloat = (v: string) => v.trim() !== "" ? parseFloat(v) : null;
    const targetPayload = {
      targetColorWhole:      toFloat(profileForm.targetColorWhole),
      targetToleranceWhole:  toFloat(profileForm.targetToleranceWhole),
      targetColorGround:     toFloat(profileForm.targetColorGround),
      targetToleranceGround: toFloat(profileForm.targetToleranceGround),
      targetDeltaMin:        toFloat(profileForm.targetDeltaMin),
      targetDeltaMax:        toFloat(profileForm.targetDeltaMax),
    };

    let res: Response;
    if (editingPref) {
      res = await fetch(`/api/customers/${selected.id}/preferences/${editingPref.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName: profileForm.profileName, usageType: profileForm.usageType, notes: profileForm.notes, ...targetPayload }),
      });
    } else {
      res = await fetch(`/api/customers/${selected.id}/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...profileForm, ...targetPayload }),
      });
    }

    setSavingProfile(false);
    if (!res.ok) { const d = await res.json(); showToast(localizeApiError(d) || t("error"), "err"); return; }
    showToast(t("roastPrefSaved"));
    setShowProfileForm(false);
    const updated = await fetch(listUrl).then((r) => r.json()) as Customer[];
    setCustomers(updated);
    refreshSelected(selected.id, updated);
  }

  async function handleDeleteProfile(pref: RoastPreference) {
    if (!selected) return;
    const res = await fetch(`/api/customers/${selected.id}/preferences/${pref.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); showToast(localizeApiError(d) || t("error"), "err"); return; }
    showToast(t("roastPrefDeleted"));
    const updated = await fetch(listUrl).then((r) => r.json()) as Customer[];
    setCustomers(updated);
    refreshSelected(selected.id, updated);
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredCustomers = useMemo(() => {
    const q = search.toLowerCase();
    const base = lateOnly && lateIds ? customers.filter((c) => lateIds.has(c.id)) : customers;
    if (!q) return base;
    return base.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.nameAr && c.nameAr.includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q))
    );
  }, [customers, search, lateOnly, lateIds]);

  // Beans not yet assigned a profile for this customer
  const availableBeans = useMemo(() => {
    if (!selected) return beans;
    const taken = new Set(selected.roastPreferences.map((p) => p.greenBeanId));
    if (editingPref) taken.delete(editingPref.greenBeanId); // allow editing current
    return beans.filter((b) => !taken.has(b.id));
  }, [beans, selected, editingPref]);

  if (loading) {
    return (
      <HrRoot>
        <div className="pg" role="status" aria-live="polite" data-testid="customers-loading">
          <div className="cu-skel" aria-hidden><i /><i /><i /><i /><i /></div>
          <span className="sr-only">{L("جارٍ التحميل…", "Loading…")}</span>
        </div>
      </HrRoot>
    );
  }

  const nameOf = (c: Customer) => (ar && c.nameAr ? c.nameAr : c.name);
  // The other spelling, when there is one that differs from the name shown.
  const otherName = (c: Customer) => {
    const o = ar ? (c.nameAr ? c.name : null) : c.nameAr;
    return o && o.trim() !== nameOf(c).trim() ? o : null;
  };
  const usage = (u: UsageType) => (u === "ESPRESSO" ? t("usageEspresso") : u === "FILTER" ? t("usageFilter") : t("usageBoth"));
  const withProfiles = customers.filter((c) => c._count.roastPreferences > 0).length;
  const optedOut = customers.filter((c) => c.whatsappOptOut).length;
  const open = (c: Customer) => { setSelected(c); setTab("info"); };

  const notice = toast ? (
    <p className={`notice ${toast.type === "ok" ? "ok" : "er"}`} role={toast.type === "ok" ? "status" : "alert"} data-testid="customers-toast" style={{ marginBottom: 16 }}>
      {toast.msg}<button type="button" onClick={() => setToast(null)} aria-label={L("إغلاق", "Dismiss")}>×</button>
    </p>
  ) : null;

  const addButton = canManage ? (
    <button type="button" onClick={openAddCustomer} className="btn p" data-testid="new-customer">
      <Ico name="plus" small /> {L("عميل", "Customer")}
    </button>
  ) : null;

  const searchBox = (
    // minWidth 0 on the phone: a flex item does not shrink below its content by default, so at 320 px
    // the search box kept the input's intrinsic width and pushed «+ عميل» off the screen (QA pass).
    <label className="search" style={phone ? { flex: 1, minWidth: 0, height: 40 } : { width: 280 }}>
      <Ico name="search" small />
      <input value={search} onChange={(e) => setSearch(e.target.value)} data-testid="customer-search"
        placeholder={phone ? L("الاسم أو الهاتف", "Name or phone") : L("الاسم أو الهاتف أو البريد", "Name, phone or email")}
        aria-label={t("searchCustomers")} />
    </label>
  );

  // «عملائي» / «كل المتاح لي» — only for a rep scoped to their own book (see `view` above).
  const viewTabs = scopedRep ? (
    <div className="seg cu-view" role="group" aria-label={L("أي عملاء؟", "Which customers?")} data-testid="customers-view">
      <button type="button" className={view === "mine" ? "on" : undefined} aria-pressed={view === "mine"} onClick={() => { setViewPick("mine"); setSelected(null); }} data-testid="customers-view-mine">
        {L("عملائي", "My customers")}
      </button>
      <button type="button" className={view === "book" ? "on" : undefined} aria-pressed={view === "book"} onClick={() => { setViewPick("book"); setSelected(null); }} data-testid="customers-view-book"
        title={L("عملاؤك، وعملاء صفقاتك وطلباتك، والعملاء اللي ما لهم مسؤول", "Your customers, your deals' and orders' customers, and the ones nobody owns")}>
        {L("كل المتاح لي", "All I can serve")}
      </button>
    </div>
  ) : null;

  const lateCount = lateIds ? customers.filter((c) => lateIds.has(c.id)).length : 0;
  const lateChip = salesView && lateIds ? (
    <button type="button" className={`btn sm${lateOnly ? " p" : ""}`} aria-pressed={lateOnly} onClick={() => setLateOnly((v) => !v)} data-testid="customers-filter-late"
      title={L("العملاء اللي تأخروا عن موعد طلبهم المعتاد", "Customers past their usual reorder time")}>
      {L("متأخرين", "Late")} <span className="n">({lateCount})</span>
    </button>
  ) : null;

  const empty = filteredCustomers.length === 0 ? (
    !search && !lateOnly && !loading && view === "mine" && scopedRep ? (
      <div data-testid="customers-empty-mine" style={{ padding: "48px 0", textAlign: "center" }}>
        <p style={{ fontWeight: 500 }}>{L("ما عندك عملاء معيّنين باسمك بعد.", "No customers are assigned to you yet.")}</p>
        <p className="lbl" style={{ fontWeight: 400 }}>{L("اطلب من المدير يعيّنك مسؤولًا عن عملائك، أو شوف «كل المتاح لي».", "Ask your manager to assign your customers to you, or open «All I can serve».")}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setViewPick("book")}>{L("كل المتاح لي", "All I can serve")}</button>
      </div>
    ) : search || lateOnly ? (
      <div data-testid="customers-no-results" style={{ padding: "48px 0", textAlign: "center" }}>
        <p>{search ? L("لا نتائج تطابق البحث.", "No customers match this search.") : L("ما عندك عملاء متأخرين 👌", "No late customers.")}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => { setSearch(""); setLateOnly(false); }}>{search ? L("مسح البحث", "Clear search") : L("عرض الكل", "Show all")}</button>
      </div>
    ) : (
      <div data-testid="customers-empty" style={{ padding: "48px 0", textAlign: "center" }}>
        <p style={{ fontWeight: 500 }}>{t("noCustomers")}</p>
        {canManage && <p className="lbl" style={{ fontWeight: 400 }}>{L("أضف أول عميل من زر «عميل».", "Add the first one with “Customer”.")}</p>}
      </div>
    )
  ) : null;

  const count = (
    <div className="pager">
      <span className="sm" data-testid="customers-count">
        <span className="n">{filteredCustomers.length}</span> {L("عميل", filteredCustomers.length === 1 ? "customer" : "customers")}
        {search ? <> {L("من", "of")} <span className="n">{customers.length}</span></> : null}
      </span>
    </div>
  );

  // The account preview (after crm-account 179:1312): name, the particulars it has, and its
  // roast profiles in place of the frame's «الأصناف المعتادة». Docked from 1280, over the list
  // from 768, a full-screen sheet on a phone.
  const pane = selected ? (
    <aside className="pane cu-pane" aria-label={L("بيانات العميل", "Customer")} data-testid="customer-pane">
      <div className="pane-h">
        <span className="lbl">{L("عميل", "Customer")}</span>
        <span className="sp" />
        <Link href={`/dashboard/customers/${selected.id}`} className="btn sm g" data-testid="open-account-page">
          {L("فتح الصفحة", "Open page")}<Ico name="back" small className="cu-fwd" />
        </Link>
        <button type="button" className="ib" onClick={() => setSelected(null)} aria-label={L("إغلاق", "Close")} data-testid="close-customer-pane">
          <Ico name="close" small />
        </button>
      </div>
      <div className="pane-b">
        <h2 className="pane-t" data-testid="customer-pane-name">{nameOf(selected)}</h2>
        <div className="meta" style={{ marginTop: 0, marginBottom: 20 }}>
          {otherName(selected) && <><bdi>{otherName(selected)}</bdi><i aria-hidden /></>}
          <span><span className="n">{selected._count.orders}</span> {L("طلب", selected._count.orders === 1 ? "order" : "orders")}</span>
          {selected.whatsappOptOut && <><i aria-hidden /><span className="flag wa">{L("لا يستلم واتساب", "No WhatsApp")}</span></>}
        </div>

        <div className="tabs" role="group" aria-label={L("أقسام العميل", "Customer sections")}>
          <button type="button" className={tab === "info" ? "on" : undefined} aria-pressed={tab === "info"} onClick={() => setTab("info")} data-testid="customer-tab-info">
            {L("نظرة عامة", "Overview")}
          </button>
          <button type="button" className={tab === "profiles" ? "on" : undefined} aria-pressed={tab === "profiles"} onClick={() => setTab("profiles")} data-testid="customer-tab-profiles">
            {t("roastProfiles")} <span className="c">{selected.roastPreferences.length}</span>
          </button>
        </div>

        {tab === "info" ? (
          <>
            <div className="lbl" style={{ margin: "8px 0 12px" }}>{L("التفاصيل", "Details")}</div>
            <dl className="props" style={{ marginBottom: 24 }}>
              <dt>{t("customerPhone")}</dt><dd>{selected.phone ? <bdi dir="ltr" className="n">{selected.phone}</bdi> : "—"}</dd>
              <dt>{t("customerEmail")}</dt><dd>{selected.email ? <bdi dir="ltr" style={{ overflowWrap: "anywhere" }}>{selected.email}</bdi> : "—"}</dd>
              <dt>{t("customerAddress")}</dt><dd style={{ whiteSpace: "pre-line" }}>{selected.address || "—"}</dd>
              <dt>{L("الطلبات", "Orders")}</dt><dd><span className="n">{selected._count.orders}</span></dd>
              <dt>{L("واتساب", "WhatsApp")}</dt>
              <dd data-testid="customer-whatsapp">
                {selected.whatsappOptOut
                  ? <span className="st wa">{L("لا يرغب برسائل النظام", "Opted out of system messages")}</span>
                  : <span className="st ok">{L("يستلم رسائل النظام", "Receives system messages")}</span>}
              </dd>
            </dl>
          </>
        ) : (
          <div data-testid="customer-profiles">
            {selected.roastPreferences.length === 0 ? (
              <p className="lbl" style={{ fontWeight: 400, margin: "8px 0 16px" }}>{t("noProfiles")}</p>
            ) : (
              <ul className="cu-prefs">
                {selected.roastPreferences.map((pref) => (
                  <li key={pref.id} data-testid={`roast-pref-${pref.id}`}>
                    <div className="cu-pref-main">
                      <div className="cu-pref-r1">
                        <b>{pref.profileName}</b>
                        <span className="st">{usage(pref.usageType)}</span>
                      </div>
                      <div className="cu-pref-sub"><bdi>{pref.greenBean.beanType}</bdi> · <span className="id">{pref.greenBean.serialNumber}</span></div>
                      {(pref.targetColorWhole != null || pref.targetColorGround != null || pref.targetDeltaMin != null || pref.targetDeltaMax != null) && (
                        <div className="cu-pref-targets">
                          {pref.targetColorWhole != null && (
                            <span>{L("كاملة", "Whole")} <bdi dir="ltr" className="n">{pref.targetColorWhole}{pref.targetToleranceWhole != null ? ` ±${pref.targetToleranceWhole}` : ""}</bdi></span>
                          )}
                          {pref.targetColorGround != null && (
                            <span>{L("مطحون", "Ground")} <bdi dir="ltr" className="n">{pref.targetColorGround}{pref.targetToleranceGround != null ? ` ±${pref.targetToleranceGround}` : ""}</bdi></span>
                          )}
                          {(pref.targetDeltaMin != null || pref.targetDeltaMax != null) && (
                            <span>Δ <bdi dir="ltr" className="n">{pref.targetDeltaMin ?? "?"} – {pref.targetDeltaMax ?? "?"}</bdi></span>
                          )}
                        </div>
                      )}
                      {pref.notes && <div className="cu-pref-sub">{pref.notes}</div>}
                    </div>
                    {canManage && (
                      <div className="cu-pref-act">
                        <button type="button" className="ib" onClick={() => openEditProfile(pref)} aria-label={`${t("editProfile")} · ${pref.profileName}`}>
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button type="button" className="ib cu-danger" onClick={() => handleDeleteProfile(pref)} aria-label={`${t("delete")} · ${pref.profileName}`}>
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && availableBeans.length > 0 && (
              <button type="button" className="btn" onClick={openAddProfile} data-testid="add-roast-profile" style={{ marginTop: 12 }}>
                <Ico name="plus" small /> {t("addProfile")}
              </button>
            )}
          </div>
        )}
      </div>
      {canManage && (
        <div className="pane-f">
          <button type="button" className="btn p" onClick={() => openEditCustomer(selected)} data-testid="edit-customer">
            <Pencil size={14} aria-hidden /> {t("editCustomer")}
          </button>
          <button type="button" className="btn cu-danger" onClick={() => handleDeleteCustomer(selected)} data-testid="delete-customer">
            <Trash2 size={14} aria-hidden /> {t("delete")}
          </button>
        </div>
      )}
    </aside>
  ) : null;

  const num = (n: number) => <span className="n">{n}</span>;

  return (
    <HrRoot>
      <div className={`split${pane ? " has-pane" : ""} cu-split`}>
        <div className="pg">
          {notice}
          {phone ? (
            <>
              <div style={{ marginBottom: 10 }}><SectionPages className="cu-ctx" /></div>
              {viewTabs || lateChip ? <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{viewTabs}{lateChip}</div> : null}
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{searchBox}{addButton}</div>
              {empty ?? (
                <div data-testid="customers-table">
                  {filteredCustomers.map((c) => (
                    <div key={c.id} className={`mrow rowlink${selected?.id === c.id ? " cu-sel" : ""}`} data-testid={`customer-${c.id}`}>
                      <div style={{ minWidth: 0 }}>
                        <Link href={`/dashboard/customers/${c.id}`} className="who open cu-open" data-testid={`open-customer-${c.id}`}>{nameOf(c)}</Link>
                      </div>
                      <span className="sm cu-orders">{num(c._count.orders)} {L("طلب", c._count.orders === 1 ? "order" : "orders")}</span>
                      <div className="r2">
                        <span style={{ flex: 1, minWidth: 0 }}>{c.phone ? <bdi dir="ltr" className="n">{c.phone}</bdi> : (otherName(c) ?? "—")}</span>
                        {!salesView && c._count.roastPreferences > 0 && <span>{num(c._count.roastPreferences)} {t("customerProfilesLabel")}</span>}
                        {c.whatsappOptOut && <span className="flag wa">{L("بلا واتساب", "No WhatsApp")}</span>}
                      </div>
                      {badges[c.id] && <div className="r2" data-testid={`customer-credit-${c.id}`}><CreditBadges ar={ar} s={badges[c.id]} compact /></div>}
                    </div>
                  ))}
                  {count}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ph" style={{ marginBottom: 20 }}>
                <div>
                  <h1>{t("customers")}</h1>
                  <div className="meta">
                    <span data-testid="customers-total">{num(customers.length)} {L("عميل", customers.length === 1 ? "customer" : "customers")}</span>
                    {!salesView && <><i /><span>{num(withProfiles)} {L("بمسارات تحميص", "with roast profiles")}</span></>}
                    {optedOut > 0 && <><i /><span>{num(optedOut)} {L("بلا رسائل واتساب", "opted out of WhatsApp")}</span></>}
                  </div>
                </div>
                <div className="act">
                  <SectionPages />
                  {addButton}
                </div>
              </div>
              <div className="tool" style={{ marginBottom: 8 }}>
                {viewTabs}
                {lateChip}
                {searchBox}
                <span className="sp" />
                <span className="sort-note">{L("بالاسم", "By name")}</span>
              </div>
              {empty ?? (
                <>
                  <table className="t leads cu-table" data-testid="customers-table">
                    <thead>
                      <tr>
                        <th scope="col">{L("العميل", "Customer")}</th>
                        <th scope="col">{t("customerPhone")}</th>
                        <th scope="col" className="xl">{t("customerEmail")}</th>
                        <th scope="col" className="num">{L("الطلبات", "Orders")}</th>
                        {qoyod ? <>
                          <th scope="col" className="num">{L("الرصيد", "Balance")}</th>
                          <th scope="col" className="num">{L("متأخرة", "Overdue")}</th>
                        </> : <>
                        {!salesView && <th scope="col">{t("roastProfiles")}</th>}
                        <th scope="col" className="xl">{L("واتساب", "WhatsApp")}</th>
                        </>}
                        <th scope="col"><span className="sr-only">{L("الإجراء", "Action")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCustomers.map((c) => (
                        <tr key={c.id} data-testid={`customer-${c.id}`} className={selected?.id === c.id ? "sel" : undefined}>
                          <td className="cu-name">
                            <Link href={`/dashboard/customers/${c.id}`} className="who cu-open" data-testid={`account-link-${c.id}`}>{nameOf(c)}</Link>
                            {(otherName(c) || c.address) && (
                              <span className="sm cu-namesub">{[otherName(c), c.address?.split("\n")[0]].filter(Boolean).join(" · ")}</span>
                            )}
                            {badges[c.id] && <span className="cu-badges-cell" data-testid={`customer-credit-${c.id}`}><CreditBadges ar={ar} s={badges[c.id]} compact /></span>}
                          </td>
                          <td>{c.phone ? <bdi dir="ltr" className="n">{c.phone}</bdi> : <span className="sm">—</span>}</td>
                          <td className="xl">{c.email ? <bdi dir="ltr" style={{ color: "var(--text-secondary)" }}>{c.email}</bdi> : <span className="sm">—</span>}</td>
                          <td className="num">{c._count.orders}</td>
                          {qoyod ? <>
                            <td className="num" data-testid={`customer-balance-${c.id}`}><Link href={`/dashboard/sales/receivables/${c.id}`}><bdi className="n">{arByCustomer ? fmt2(arByCustomer[c.id]?.balance) : "…"}</bdi></Link></td>
                            <td className="num">{arByCustomer && Number(arByCustomer[c.id]?.overdue ?? 0) > 0 ? <bdi className="n" style={{ color: "var(--action-danger)" }}>{fmt2(arByCustomer[c.id]?.overdue)}</bdi> : <span className="sm">{arByCustomer ? "0.00" : "…"}</span>}</td>
                          </> : <>
                          {!salesView && <td>{c._count.roastPreferences > 0 ? <span>{num(c._count.roastPreferences)} {t("customerProfilesLabel")}</span> : <span className="sm">—</span>}</td>}
                          <td className="xl">{c.whatsappOptOut ? <span className="st wa">{L("لا يرغب", "Opted out")}</span> : <span className="sm">{L("يستلم", "On")}</span>}</td>
                          </>}
                          <td style={{ textAlign: "end" }}>
                            <button type="button" className="btn sm" onClick={() => open(c)} aria-label={`${L("معاينة", "Preview")} · ${nameOf(c)}`} data-testid={`open-customer-${c.id}`}>{L("معاينة", "Preview")}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {count}
                </>
              )}
            </>
          )}
        </div>
        {pane}
      </div>

      {/* ── Customer form ── */}
      <Dialog open={showCustomerForm} title={editingCustomer ? t("editCustomer") : t("addCustomer")} onClose={() => setShowCustomerForm(false)} testId="customer-form"
        actions={<>
          <button type="submit" form="customer-form-el" className="hr-btn is-primary" disabled={savingCustomer}>{savingCustomer ? t("saving") : t("save")}</button>
          <button type="button" className="hr-btn" onClick={() => setShowCustomerForm(false)}>{t("cancel")}</button>
        </>}>
        <form id="customer-form-el" onSubmit={handleSaveCustomer} className="hr-form">
          <Field label={`${t("customerName")} *`} wide>
            <input required value={customerForm.name} onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })} className="hr-input" />
          </Field>
          <Field label={t("customerNameAr")} wide>
            <input value={customerForm.nameAr} onChange={(e) => setCustomerForm({ ...customerForm, nameAr: e.target.value })} className="hr-input" dir="rtl" />
          </Field>
          <Field label={t("customerPhone")}>
            <input value={customerForm.phone} onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })} className="hr-input" dir="ltr" style={{ textAlign: "start" }} />
          </Field>
          <Field label={t("customerEmail")}>
            <input type="email" value={customerForm.email} onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })} className="hr-input" dir="ltr" style={{ textAlign: "start" }} />
          </Field>
          <Field label={t("customerAddress")} wide>
            <textarea value={customerForm.address} onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })} rows={2} className="hr-textarea" />
          </Field>
          {/* Respected by every automated WhatsApp message: the message is recorded as not
              sent, with the reason, instead of being sent. */}
          <label className="cu-check is-wide">
            <input
              type="checkbox"
              checked={customerForm.whatsappOptOut}
              onChange={(e) => setCustomerForm({ ...customerForm, whatsappOptOut: e.target.checked })}
              data-testid="customer-whatsapp-optout"
            />
            {t("customerWhatsappOptOut")}
          </label>
        </form>
      </Dialog>

      {/* ── Roast profile form ── */}
      <Dialog open={showProfileForm && !!selected} title={editingPref ? t("editProfile") : t("addProfile")} sub={selected?.name} onClose={() => setShowProfileForm(false)} testId="roast-profile-form"
        actions={<>
          <button type="submit" form="roast-profile-form-el" className="hr-btn is-primary" disabled={savingProfile}>{savingProfile ? t("saving") : t("save")}</button>
          <button type="button" className="hr-btn" onClick={() => setShowProfileForm(false)}>{t("cancel")}</button>
        </>}>
        <form id="roast-profile-form-el" onSubmit={handleSaveProfile} className="hr-form">
          {!editingPref ? (
            <Field label={`${t("beanType")} *`} wide>
              <Select required value={profileForm.greenBeanId} onChange={(e) => setProfileForm({ ...profileForm, greenBeanId: e.target.value })} className="hr-select">
                <option value="">{t("selectBeanLabel")}</option>
                {availableBeans.map((b) => (
                  <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber})</option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="cu-bean is-wide">
              <b>{editingPref.greenBean.beanType}</b>
              <span className="hr-id">{editingPref.greenBean.serialNumber}</span>
            </div>
          )}
          <Field label={`${t("profileNameLabel")} *`}>
            <input required value={profileForm.profileName} onChange={(e) => setProfileForm({ ...profileForm, profileName: e.target.value })} placeholder="e.g. Dark-Gua-02" className="hr-input" />
          </Field>
          <Field label={`${t("usageTypeLabel")} *`}>
            <Select required value={profileForm.usageType} onChange={(e) => setProfileForm({ ...profileForm, usageType: e.target.value as UsageType })} className="hr-select">
              <option value="ESPRESSO">{t("usageEspresso")}</option>
              <option value="FILTER">{t("usageFilter")}</option>
              <option value="BOTH">{t("usageBoth")}</option>
            </Select>
          </Field>
          <Field label={t("profileNotesLabel")} wide>
            <textarea value={profileForm.notes} onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })} rows={2} className="hr-textarea" />
          </Field>

          {/* Roast standards */}
          <p className="cu-formsec is-wide">{t("roastStandards")}</p>
          <Field label={t("colorWholeLabel")}>
            <input type="number" step="0.1" min="0" max="100" value={profileForm.targetColorWhole} onChange={(e) => setProfileForm({ ...profileForm, targetColorWhole: e.target.value })} placeholder="e.g. 68" className="hr-input" dir="ltr" />
          </Field>
          <Field label={`${t("toleranceLabel")} (${L("كاملة", "Whole")})`}>
            <input type="number" step="0.1" min="0" value={profileForm.targetToleranceWhole} onChange={(e) => setProfileForm({ ...profileForm, targetToleranceWhole: e.target.value })} placeholder="e.g. 2" className="hr-input" dir="ltr" />
          </Field>
          <Field label={t("colorGroundLabel")}>
            <input type="number" step="0.1" min="0" max="100" value={profileForm.targetColorGround} onChange={(e) => setProfileForm({ ...profileForm, targetColorGround: e.target.value })} placeholder="e.g. 74" className="hr-input" dir="ltr" />
          </Field>
          <Field label={`${t("toleranceLabel")} (${L("مطحون", "Ground")})`}>
            <input type="number" step="0.1" min="0" value={profileForm.targetToleranceGround} onChange={(e) => setProfileForm({ ...profileForm, targetToleranceGround: e.target.value })} placeholder="e.g. 2" className="hr-input" dir="ltr" />
          </Field>
          <Field label={`${t("deltaRangeLabel")} · ${L("الأدنى", "Min")}`}>
            <input type="number" step="0.1" min="0" value={profileForm.targetDeltaMin} onChange={(e) => setProfileForm({ ...profileForm, targetDeltaMin: e.target.value })} placeholder="e.g. 4" className="hr-input" dir="ltr" />
          </Field>
          <Field label={`${t("deltaRangeLabel")} · ${L("الأعلى", "Max")}`}>
            <input type="number" step="0.1" min="0" value={profileForm.targetDeltaMax} onChange={(e) => setProfileForm({ ...profileForm, targetDeltaMax: e.target.value })} placeholder="e.g. 8" className="hr-input" dir="ltr" />
          </Field>
        </form>
      </Dialog>
    </HrRoot>
  );
}
