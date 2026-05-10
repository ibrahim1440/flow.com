"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Package, Search, Pencil, Trash2, X, Languages, PowerOff, Power } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

type GreenBean = {
  id: string; serialNumber: string;
  beanType: string; beanTypeAr: string | null;
  country: string; countryAr: string | null;
  region: string | null; regionAr: string | null;
  variety: string | null;
  process: string | null; processAr: string | null;
  altitude: string | null; location: string | null;
  quantityKg: number; isActive: boolean;
  receivedDate: string; createdAt: string;
};

type FormState = {
  serialNumber: string; beanType: string; beanTypeAr: string;
  country: string; countryAr: string; region: string; regionAr: string;
  variety: string; process: string; processAr: string;
  altitude: string; location: string; quantityKg: number;
};

const EMPTY_FORM: FormState = {
  serialNumber: "", beanType: "", beanTypeAr: "", country: "", countryAr: "",
  region: "", regionAr: "", variety: "", process: "", processAr: "",
  altitude: "", location: "", quantityKg: 0,
};

// ─── Auto-translate helper ────────────────────────────────────────────────────

async function translateText(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target: "ar" }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.translated ?? null;
}

// ─── BeanForm (Add / Edit) ────────────────────────────────────────────────────

function BeanForm({
  title, initial, onSave, onClose, saving,
}: {
  title: string;
  initial: FormState;
  onSave: (f: FormState) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(initial);
  const [translating, setTranslating] = useState<Record<string, boolean>>({});

  const set = (key: keyof FormState, val: string | number) =>
    setForm((p) => ({ ...p, [key]: val }));

  async function handleTranslate(enKey: keyof FormState, arKey: keyof FormState) {
    const text = form[enKey] as string;
    if (!text.trim()) return;
    setTranslating((p) => ({ ...p, [arKey]: true }));
    const result = await translateText(text);
    setTranslating((p) => ({ ...p, [arKey]: false }));
    if (result) set(arKey, result);
  }

  const bilingualFields: { enKey: keyof FormState; arKey: keyof FormState; labelEn: string; labelAr: string; required?: boolean }[] = [
    { enKey: "beanType", arKey: "beanTypeAr", labelEn: `${t("beanType")} (EN)`, labelAr: `${t("beanType")} (AR)`, required: true },
    { enKey: "country",  arKey: "countryAr",  labelEn: `${t("country")} (EN)`,  labelAr: `${t("country")} (AR)`,  required: true },
    { enKey: "region",   arKey: "regionAr",   labelEn: `${t("region")} (EN)`,   labelAr: `${t("region")} (AR)` },
    { enKey: "process",  arKey: "processAr",  labelEn: `${t("process")} (EN)`,  labelAr: `${t("process")} (AR)` },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSave(form);
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-extrabold text-charcoal">{title}</h2>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Serial + Qty */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">{t("serialNumber")} *</label>
              <input value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} required
                className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm transition-colors" />
            </div>
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">{t("quantityKg")} *</label>
              <input type="number" step="0.01" value={form.quantityKg}
                onChange={(e) => set("quantityKg", parseFloat(e.target.value) || 0)} required
                className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm transition-colors" />
            </div>
          </div>

          {/* Bilingual fields */}
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="grid grid-cols-2 bg-cream text-xs font-extrabold text-brown/60 uppercase tracking-widest">
              <div className="px-4 py-2 border-r border-border">{t("enFields")}</div>
              <div className="px-4 py-2">{t("arFields")} (العربية)</div>
            </div>
            <div className="divide-y divide-border">
              {bilingualFields.map(({ enKey, arKey, labelEn, labelAr, required }) => (
                <div key={enKey} className="grid grid-cols-2">
                  <div className="px-4 py-3 border-r border-border">
                    <label className="block text-xs font-bold text-charcoal mb-1.5">{labelEn}{required ? " *" : ""}</label>
                    <div className="flex gap-1.5">
                      <input value={form[enKey] as string}
                        onChange={(e) => set(enKey, e.target.value)}
                        required={required}
                        className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border-2 border-border rounded-lg focus:border-orange focus:ring-1 focus:ring-orange/20 outline-none transition-colors"
                      />
                      <button type="button"
                        title={t("translateToAr")}
                        onClick={() => handleTranslate(enKey, arKey)}
                        disabled={translating[arKey] || !form[enKey]}
                        className="shrink-0 px-2 py-1.5 rounded-lg bg-orange/10 text-orange hover:bg-orange/20 disabled:opacity-30 transition-colors"
                      >
                        {translating[arKey]
                          ? <span className="text-[10px] font-bold">…</span>
                          : <Languages size={13} />}
                      </button>
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <label className="block text-xs font-bold text-charcoal mb-1.5 text-right" dir="rtl">{labelAr}</label>
                    <input value={form[arKey] as string}
                      onChange={(e) => set(arKey, e.target.value)}
                      dir="rtl" placeholder="اختياري"
                      className="w-full px-2.5 py-1.5 text-sm border-2 border-border rounded-lg focus:border-orange focus:ring-1 focus:ring-orange/20 outline-none transition-colors text-right"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Other optional fields */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { key: "variety", label: t("variety") },
              { key: "altitude", label: t("altitude") },
              { key: "location", label: t("storageLocation") },
            ].map(({ key, label }) => (
              <div key={key}>
                <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">{label}</label>
                <input value={(form as Record<string, string | number>)[key] as string}
                  onChange={(e) => set(key as keyof FormState, e.target.value)}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm transition-colors" />
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange/90 active:scale-[0.98] transition-all disabled:opacity-50">
              {saving ? `${t("saving")}` : t("save")}
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 border-2 border-border rounded-xl text-sm font-bold text-brown hover:bg-gray-50 transition-colors">
              {t("cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete confirmation ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  bean, onConfirm, onClose, deleting,
}: {
  bean: GreenBean; onConfirm: () => void; onClose: () => void; deleting: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <Trash2 size={18} className="text-red-500" />
          </div>
          <div>
            <p className="font-extrabold text-charcoal">{bean.beanType}</p>
            <p className="text-xs text-brown/50 font-mono">{bean.serialNumber}</p>
          </div>
        </div>
        <p className="text-sm text-brown/70">{t("confirmDeleteBean")}</p>
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={deleting}
            className="flex-1 py-2.5 bg-red-500 text-white rounded-xl font-bold text-sm hover:bg-red-600 disabled:opacity-50 transition-colors">
            {deleting ? "…" : t("delete")}
          </button>
          <button onClick={onClose}
            className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-sm text-brown hover:bg-gray-50 transition-colors">
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "receive");
  const canAdjust  = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");

  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // Modal state
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<GreenBean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GreenBean | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const loadBeans = useCallback(async () => {
    const res = await fetch("/api/green-beans?all=1");
    setBeans(await res.json());
  }, []);

  useEffect(() => { loadBeans(); }, [loadBeans]);

  // Language-aware display helper
  function display(en: string | null | undefined, ar: string | null | undefined) {
    if (lang === "ar" && ar) return ar;
    return en ?? "—";
  }

  async function handleAdd(f: FormState) {
    setSaving(true);
    setErrorMsg("");
    const res = await fetch("/api/green-beans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setSaving(false);
    if (!res.ok) { setErrorMsg("Failed to add bean"); return; }
    setAddOpen(false);
    loadBeans();
  }

  async function handleEdit(f: FormState) {
    if (!editTarget) return;
    setSaving(true);
    setErrorMsg("");
    const res = await fetch(`/api/green-beans/${editTarget.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setSaving(false);
    if (!res.ok) { setErrorMsg("Failed to update bean"); return; }
    setEditTarget(null);
    loadBeans();
  }

  async function handleToggleActive(bean: GreenBean) {
    await fetch(`/api/green-beans/${bean.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !bean.isActive }),
    });
    loadBeans();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setErrorMsg("");
    const res = await fetch(`/api/green-beans/${deleteTarget.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json();
      setErrorMsg(j.error || "Delete failed");
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    loadBeans();
  }

  const filtered = beans
    .filter((b) => showInactive || b.isActive)
    .filter((b) =>
      `${b.beanType} ${b.beanTypeAr ?? ""} ${b.country} ${b.countryAr ?? ""} ${b.serialNumber}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );

  const totalStock = beans.filter((b) => b.isActive).reduce((s, b) => s + b.quantityKg, 0);
  const activeCount = beans.filter((b) => b.isActive).length;

  return (
    <div className="space-y-6">
      {/* Error toast */}
      {errorMsg && (
        <div className="fixed top-4 ltr:right-4 rtl:left-4 z-50 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 font-medium shadow-lg flex items-center gap-3 max-w-sm">
          <span className="flex-1">{errorMsg}</span>
          <button onClick={() => setErrorMsg("")}><X size={14} /></button>
        </div>
      )}

      {/* Modals */}
      {addOpen && (
        <BeanForm
          title={t("registerNewStock")}
          initial={EMPTY_FORM}
          onSave={handleAdd}
          onClose={() => setAddOpen(false)}
          saving={saving}
        />
      )}
      {editTarget && (
        <BeanForm
          title={t("editBeanStock")}
          initial={{
            serialNumber: editTarget.serialNumber,
            beanType: editTarget.beanType,        beanTypeAr: editTarget.beanTypeAr ?? "",
            country:  editTarget.country,          countryAr:  editTarget.countryAr  ?? "",
            region:   editTarget.region   ?? "",   regionAr:   editTarget.regionAr   ?? "",
            variety:  editTarget.variety  ?? "",
            process:  editTarget.process  ?? "",   processAr:  editTarget.processAr  ?? "",
            altitude: editTarget.altitude ?? "",   location:   editTarget.location   ?? "",
            quantityKg: editTarget.quantityKg,
          }}
          onSave={handleEdit}
          onClose={() => setEditTarget(null)}
          saving={saving}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          bean={deleteTarget}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("greenBeanInventory")}</h1>
          <p className="text-brown text-sm font-medium">
            {t("totalStock")}: {totalStock.toFixed(1)} kg {t("from")} {activeCount} {t("varieties")}
          </p>
        </div>
        {canReceive && (
          <button onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all duration-200 font-bold">
            <Plus size={18} /> {t("addStock")}
          </button>
        )}
      </div>

      {/* Search + inactive toggle */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder={t("searchBeans")} value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
        </div>
        <button
          onClick={() => setShowInactive((p) => !p)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-bold transition-colors ${
            showInactive ? "bg-charcoal text-white border-charcoal" : "border-border text-brown hover:border-charcoal/30"
          }`}
        >
          <PowerOff size={14} />
          {t("showInactive")}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("serialNumberShort")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("beanType")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("origin")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("process")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("altitude")}</th>
                <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("stockKg")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("received")}</th>
                {(canAdjust) && (
                  <th className="text-center px-4 py-3 font-semibold text-charcoal">{t("actions")}</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((bean) => (
                <tr key={bean.id} className={`transition-colors ${bean.isActive ? "hover:bg-cream/50" : "bg-gray-50/80 opacity-60"}`}>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{bean.serialNumber}</span>
                    {!bean.isActive && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-200 text-gray-500">
                        {t("inactive")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium">{display(bean.beanType, bean.beanTypeAr)}</td>
                  <td className="px-4 py-3">
                    {display(bean.country, bean.countryAr)}
                    {(bean.region || bean.regionAr) && (
                      <span className="text-brown/50"> / {display(bean.region, bean.regionAr)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{display(bean.process, bean.processAr) || "—"}</td>
                  <td className="px-4 py-3 text-brown/70">{bean.altitude || "—"}</td>
                  <td className="px-4 py-3 text-end">
                    <span className={`font-bold ${bean.quantityKg < 20 ? "text-red-600" : "text-green-600"}`}>
                      {bean.quantityKg}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-brown">{formatDate(bean.receivedDate)}</td>
                  {canAdjust && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1.5">
                        <button title={t("edit")} onClick={() => setEditTarget(bean)}
                          className="p-1.5 rounded-lg text-brown/50 hover:text-orange hover:bg-orange/10 transition-colors">
                          <Pencil size={14} />
                        </button>
                        <button
                          title={bean.isActive ? t("deactivate") : t("activate")}
                          onClick={() => handleToggleActive(bean)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            bean.isActive
                              ? "text-brown/50 hover:text-amber-500 hover:bg-amber-50"
                              : "text-green-600 hover:bg-green-50"
                          }`}>
                          {bean.isActive ? <PowerOff size={14} /> : <Power size={14} />}
                        </button>
                        <button title={t("delete")} onClick={() => setDeleteTarget(bean)}
                          className="p-1.5 rounded-lg text-brown/50 hover:text-red-500 hover:bg-red-50 transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <Package size={40} className="mx-auto mb-2" />
            <p>{t("noBeansFound")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
