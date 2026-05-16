"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ShoppingBag, Plus, Search, X, ChevronDown, Package, CalendarDays, Banknote,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

// ─── Types ────────────────────────────────────────────────────────────────────

type Supplier = { id: string; name: string; contact: string | null };
type GreenBean = { id: string; beanType: string; beanTypeAr: string | null; serialNumber: string };
type PurchaseRecord = {
  id: string;
  supplier: Supplier;
  itemId: string | null;
  type: string;
  quantity: number;
  costPerUnit: number;
  totalCost: number;
  purchaseDate: string;
  notes: string | null;
  createdAt: string;
};

type FormState = {
  supplierId: string;
  isNewSupplier: boolean;
  newSupplierName: string;
  newSupplierContact: string;
  itemId: string;
  quantity: string;
  costPerUnit: string;
  purchaseDate: string;
  notes: string;
};

const INPUT_CLS =
  "w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors bg-white";

function emptyForm(): FormState {
  return {
    supplierId: "",
    isNewSupplier: false,
    newSupplierName: "",
    newSupplierContact: "",
    itemId: "",
    quantity: "",
    costPerUnit: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
    notes: "",
  };
}

// ─── Stats Card ───────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-4 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon size={20} strokeWidth={1.8} className="text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-bold text-brown/60 uppercase tracking-wide truncate">{label}</p>
        <p className="text-xl font-extrabold text-charcoal leading-tight">{value}</p>
        {sub && <p className="text-xs text-brown/50 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Add Purchase Modal ───────────────────────────────────────────────────────

function AddPurchaseModal({
  suppliers,
  beans,
  onClose,
  onSuccess,
}: {
  suppliers: Supplier[];
  beans: GreenBean[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: val }));

  const qty = parseFloat(form.quantity) || 0;
  const cpu = parseFloat(form.costPerUnit) || 0;
  const previewTotal = qty * cpu;

  function handleSupplierSelect(val: string) {
    if (val === "__new__") {
      set("isNewSupplier", true);
      set("supplierId", "");
    } else {
      set("isNewSupplier", false);
      set("supplierId", val);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!form.itemId) { setFormError("اختر صنف البن الأخضر"); return; }
    if (!form.quantity || qty <= 0) { setFormError("أدخل كمية صحيحة"); return; }
    if (!form.costPerUnit || cpu <= 0) { setFormError("أدخل سعر الكيلو"); return; }
    if (!form.purchaseDate) { setFormError("اختر تاريخ الشراء"); return; }
    if (!form.isNewSupplier && !form.supplierId) { setFormError("اختر المورد"); return; }
    if (form.isNewSupplier && !form.newSupplierName.trim()) {
      setFormError("أدخل اسم المورد الجديد");
      return;
    }

    setSaving(true);
    try {
      let supplierId = form.supplierId;

      // Create supplier first if needed
      if (form.isNewSupplier) {
        const sRes = await fetch("/api/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.newSupplierName.trim(),
            contact: form.newSupplierContact.trim() || null,
          }),
        });
        if (!sRes.ok) {
          const j = await sRes.json().catch(() => ({}));
          setFormError(j.error || t("error"));
          setSaving(false);
          return;
        }
        const newSupplier: Supplier = await sRes.json();
        supplierId = newSupplier.id;
      }

      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          itemId: form.itemId,
          quantity: qty,
          costPerUnit: cpu,
          purchaseDate: form.purchaseDate,
          notes: form.notes.trim() || null,
        }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFormError(j.error || t("purchaseFailed"));
        setSaving(false);
        return;
      }

      onSuccess(t("purchaseAdded"));
    } catch {
      setFormError(t("error"));
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-extrabold text-charcoal">{t("addPurchase")}</h2>
            <p className="text-xs text-brown/60 mt-0.5">{t("greenBeanPurchase")}</p>
          </div>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors">
            <X size={20} />
          </button>
        </div>

        {formError && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
            {formError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Supplier */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
              {t("supplier")} *
            </label>
            <div className="relative">
              <select
                value={form.isNewSupplier ? "__new__" : form.supplierId}
                onChange={(e) => handleSupplierSelect(e.target.value)}
                className={INPUT_CLS + " appearance-none ltr:pr-8 rtl:pl-8 cursor-pointer"}
              >
                <option value="">{t("selectSupplier")}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                <option value="__new__">＋ {t("addNewSupplier")}</option>
              </select>
              <ChevronDown size={14} className="absolute ltr:right-3 rtl:left-3 top-1/2 -translate-y-1/2 text-brown/40 pointer-events-none" />
            </div>
          </div>

          {/* New Supplier inline fields */}
          {form.isNewSupplier && (
            <div className="rounded-xl border-2 border-orange/30 bg-orange/5 p-4 space-y-3">
              <p className="text-xs font-extrabold text-orange uppercase tracking-wide">
                {t("newSupplierSection")}
              </p>
              <div>
                <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
                  {t("supplierName")} *
                </label>
                <input
                  value={form.newSupplierName}
                  onChange={(e) => set("newSupplierName", e.target.value)}
                  placeholder="مثال: شركة المحمصة للتوريد"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
                  {t("supplierContact")}
                </label>
                <input
                  value={form.newSupplierContact}
                  onChange={(e) => set("newSupplierContact", e.target.value)}
                  placeholder="+966 5x xxx xxxx"
                  className={INPUT_CLS}
                />
              </div>
            </div>
          )}

          {/* Green Bean item */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
              {t("greenBeans")} *
            </label>
            <div className="relative">
              <select
                value={form.itemId}
                onChange={(e) => set("itemId", e.target.value)}
                className={INPUT_CLS + " appearance-none ltr:pr-8 rtl:pl-8 cursor-pointer"}
              >
                <option value="">{t("selectItem")}</option>
                {beans.map((b) => (
                  <option key={b.id} value={b.id}>
                    {lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType} ({b.serialNumber})
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute ltr:right-3 rtl:left-3 top-1/2 -translate-y-1/2 text-brown/40 pointer-events-none" />
            </div>
          </div>

          {/* Quantity + Cost per unit */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
                {t("quantityKg")} *
              </label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.quantity}
                onChange={(e) => set("quantity", e.target.value)}
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
                {t("costPerUnit")} *
              </label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.costPerUnit}
                onChange={(e) => set("costPerUnit", e.target.value)}
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </div>
          </div>

          {/* Live total preview */}
          {previewTotal > 0 && (
            <div className="flex items-center justify-between px-4 py-3 bg-cream rounded-xl border border-border">
              <span className="text-xs font-bold text-brown/60 uppercase tracking-wide">
                {t("totalCost")}
              </span>
              <span className="text-lg font-extrabold text-charcoal">
                {previewTotal.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ريال
              </span>
            </div>
          )}

          {/* Purchase date */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
              {t("purchaseDate")} *
            </label>
            <input
              type="date"
              value={form.purchaseDate}
              onChange={(e) => set("purchaseDate", e.target.value)}
              className={INPUT_CLS}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1.5">
              {t("notes")}
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              placeholder="ملاحظات اختيارية عن الشحنة…"
              className={INPUT_CLS + " resize-none"}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t("saving") : t("addPurchase")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border-2 border-border rounded-xl text-sm font-bold text-brown hover:bg-gray-50 transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const { t, lang } = useI18n();
  const user = useUser();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "inventory", "adjust");

  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err" = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    const [pRes, sRes, bRes] = await Promise.all([
      fetch("/api/purchases"),
      fetch("/api/suppliers"),
      fetch("/api/green-beans"),
    ]);
    if (pRes.ok) setPurchases(await pRes.json());
    if (sRes.ok) setSuppliers(await sRes.json());
    if (bRes.ok) setBeans(await bRes.json());
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Build a bean lookup map for table display
  const beanMap = useMemo(
    () => new Map(beans.map((b) => [b.id, b])),
    [beans]
  );

  function beanLabel(itemId: string | null): string {
    if (!itemId) return "—";
    const b = beanMap.get(itemId);
    if (!b) return "—";
    return lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchases;
    return purchases.filter((p) => {
      const bean = p.itemId ? beanMap.get(p.itemId) : null;
      const beanName = (bean ? `${bean.beanType} ${bean.beanTypeAr ?? ""}` : "").toLowerCase();
      return (
        p.supplier.name.toLowerCase().includes(q) ||
        beanName.includes(q) ||
        (p.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [purchases, search, beanMap]);

  // Summary stats
  const totalSpendSAR = purchases.reduce((s, p) => s + p.totalCost, 0);
  const totalKg = purchases.reduce((s, p) => s + p.quantity, 0);
  const uniqueSuppliers = new Set(purchases.map((p) => p.supplier.id)).size;

  function handleSuccess(msg: string) {
    setShowForm(false);
    showToast(msg, "ok");
    loadData();
  }

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 ltr:right-4 rtl:left-4 z-[100] px-4 py-3 rounded-xl text-sm font-bold shadow-lg flex items-center gap-3 max-w-sm ${
            toast.type === "ok"
              ? "bg-green-600 text-white"
              : "bg-red-600 text-white"
          }`}
        >
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      {/* Modal */}
      {showForm && (
        <AddPurchaseModal
          suppliers={suppliers}
          beans={beans}
          onClose={() => setShowForm(false)}
          onSuccess={handleSuccess}
        />
      )}

      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("purchasesTitle")}</h1>
          <p className="text-brown text-sm font-medium">{t("purchasesSubtitle")}</p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange/90 shadow-md shadow-orange/20 active:scale-[0.98] transition-all duration-200 font-bold text-sm"
          >
            <Plus size={18} />
            {t("addPurchase")}
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={Banknote}
          label={t("totalSpend")}
          value={`${totalSpendSAR.toLocaleString("ar-SA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ر.س`}
          sub={`${purchases.length} ${lang === "ar" ? "عملية شراء" : "transactions"}`}
          color="bg-orange"
        />
        <StatCard
          icon={Package}
          label={t("totalReceived")}
          value={`${totalKg.toFixed(1)} كغ`}
          sub={lang === "ar" ? "بن أخضر مستلم" : "green bean received"}
          color="bg-emerald-500"
        />
        <StatCard
          icon={ShoppingBag}
          label={t("suppliersCount")}
          value={String(uniqueSuppliers)}
          sub={lang === "ar" ? "مورد نشط" : "active suppliers"}
          color="bg-blue-500"
        />
      </div>

      {/* Search */}
      <div className="relative">
        <Search
          size={18}
          className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          type="text"
          placeholder={t("searchPurchases")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-brown/50">
            <div className="w-7 h-7 border-3 border-orange border-t-transparent rounded-full animate-spin mr-3" />
            {t("loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <ShoppingBag size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">{search ? t("noData") : t("noPurchases")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-cream">
                <tr>
                  <th className="text-start px-4 py-3 font-semibold text-charcoal whitespace-nowrap">
                    <div className="flex items-center gap-1.5"><CalendarDays size={14} />{t("date")}</div>
                  </th>
                  <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("supplier")}</th>
                  <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("greenBeans")}</th>
                  <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("quantityKg")}</th>
                  <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("costPerUnit")}</th>
                  <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("totalCost")}</th>
                  <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("notes")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-cream/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-brown font-mono text-xs">
                      {formatDate(p.purchaseDate)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-charcoal">{p.supplier.name}</p>
                      {p.supplier.contact && (
                        <p className="text-xs text-brown/50">{p.supplier.contact}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium">{beanLabel(p.itemId)}</td>
                    <td className="px-4 py-3 text-end">
                      <span className="font-bold text-charcoal">{p.quantity}</span>
                      <span className="text-brown/50 text-xs"> كغ</span>
                    </td>
                    <td className="px-4 py-3 text-end text-brown">
                      {p.costPerUnit.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <span className="font-bold text-charcoal">
                        {p.totalCost.toLocaleString("ar-SA", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      <span className="text-brown/50 text-xs"> ر.س</span>
                    </td>
                    <td className="px-4 py-3 text-brown/70 max-w-[180px] truncate">
                      {p.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
