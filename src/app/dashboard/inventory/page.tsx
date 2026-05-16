"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus, Package, Search, Pencil, Trash2, X, Languages,
  PowerOff, Power, Scale, History, Boxes, CheckCircle2,
  Clock, XCircle,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

// ─── Types ────────────────────────────────────────────────────────────────────

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

type FinishedGoodsLot = {
  id: string;
  batchNumber: string;
  quantityKg: number;
  availableQty: number;
  status: "AVAILABLE" | "RESERVED" | "SHIPPED";
  createdAt: string;
  product: { productNameEn: string; productNameAr: string | null };
};

type EnrichedMovement = {
  id: string;
  type: "IN" | "OUT" | "ADJUSTMENT" | "LOSS";
  category: "RAW_MATERIAL" | "FINISHED_GOODS";
  referenceEntityId: string | null;
  quantityChanged: number;
  previousQuantity: number;
  newQuantity: number;
  sourceDocType: string;
  timestamp: string;
  notes: string | null;
  entityLabel: string | null;
  entityLabelAr: string | null;
  userName: string | null;
};

type Tab = "raw" | "finished" | "ledger";

type FormState = {
  serialNumber: string; beanType: string; beanTypeAr: string;
  country: string; countryAr: string; region: string; regionAr: string;
  variety: string; process: string; processAr: string;
  altitude: string; location: string; quantityKg: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSerial() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `GB-${ymd}-${rand}`;
}

function emptyForm(): FormState {
  return {
    serialNumber: generateSerial(), beanType: "", beanTypeAr: "",
    country: "", countryAr: "", region: "", regionAr: "",
    variety: "", process: "", processAr: "", altitude: "", location: "", quantityKg: 0,
  };
}

async function callTranslate(text: string, target: "ar" | "en"): Promise<string | null> {
  if (!text.trim()) return null;
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.translated ?? null;
}

// ─── BeanForm (Add / Edit) ───────────────────────────────────────────────────

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
  const [formError, setFormError] = useState("");

  const set = (key: keyof FormState, val: string | number) =>
    setForm((p) => ({ ...p, [key]: val }));

  async function translate(
    sourceKey: keyof FormState,
    targetKey: keyof FormState,
    targetLang: "ar" | "en",
  ) {
    const text = form[sourceKey] as string;
    if (!text.trim()) return;
    setTranslating((p) => ({ ...p, [targetKey]: true }));
    const result = await callTranslate(text, targetLang);
    setTranslating((p) => ({ ...p, [targetKey]: false }));
    if (result) set(targetKey, result);
  }

  const bilingualFields: {
    enKey: keyof FormState; arKey: keyof FormState;
    labelEn: string; labelAr: string; required?: boolean;
  }[] = [
    { enKey: "beanType", arKey: "beanTypeAr", labelEn: `${t("beanType")} (EN)`, labelAr: `${t("beanType")} (AR)`, required: true },
    { enKey: "country",  arKey: "countryAr",  labelEn: `${t("country")} (EN)`,  labelAr: `${t("country")} (AR)`,  required: true },
    { enKey: "region",   arKey: "regionAr",   labelEn: `${t("region")} (EN)`,   labelAr: `${t("region")} (AR)` },
    { enKey: "process",  arKey: "processAr",  labelEn: `${t("process")} (EN)`,  labelAr: `${t("process")} (AR)` },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    await onSave(form);
  }

  function TranslateBtn({
    sourceKey, targetKey, targetLang, disabled: extraDisabled,
  }: {
    sourceKey: keyof FormState; targetKey: keyof FormState;
    targetLang: "ar" | "en"; disabled?: boolean;
  }) {
    const busy = translating[targetKey];
    const hasSource = !!(form[sourceKey] as string)?.trim();
    return (
      <button
        type="button"
        title={targetLang === "ar" ? t("translateToAr") : "Translate to English"}
        onClick={() => translate(sourceKey, targetKey, targetLang)}
        disabled={busy || !hasSource || extraDisabled}
        className="shrink-0 px-2 py-1.5 rounded-lg bg-orange/10 text-orange hover:bg-orange/20 disabled:opacity-25 transition-colors"
      >
        {busy ? <span className="text-[10px] font-bold px-0.5">…</span> : <Languages size={13} />}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-extrabold text-charcoal">{title}</h2>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors"><X size={20} /></button>
        </div>

        {formError && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
            {formError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">
                {t("serialNumber")}
                <span className="ml-1 normal-case text-brown/40 font-normal">(auto-generated)</span>
              </label>
              <input
                value={form.serialNumber}
                onChange={(e) => set("serialNumber", e.target.value)}
                placeholder="GB-20260511-142"
                className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm font-mono transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">{t("quantityKg")} *</label>
              <input
                type="number" step="0.01" min="0" value={form.quantityKg} required
                onChange={(e) => set("quantityKg", parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm transition-colors"
              />
            </div>
          </div>

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
                      <input
                        value={form[enKey] as string}
                        onChange={(e) => set(enKey, e.target.value)}
                        required={required}
                        className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border-2 border-border rounded-lg focus:border-orange focus:ring-1 focus:ring-orange/20 outline-none transition-colors"
                      />
                      <TranslateBtn sourceKey={arKey} targetKey={enKey} targetLang="en" />
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <label className="block text-xs font-bold text-charcoal mb-1.5 text-right" dir="rtl">{labelAr}</label>
                    <div className="flex gap-1.5">
                      <TranslateBtn sourceKey={enKey} targetKey={arKey} targetLang="ar" />
                      <input
                        value={form[arKey] as string}
                        onChange={(e) => set(arKey, e.target.value)}
                        dir="rtl" placeholder="اختياري"
                        className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border-2 border-border rounded-lg focus:border-orange focus:ring-1 focus:ring-orange/20 outline-none transition-colors text-right"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { key: "variety", label: t("variety") },
              { key: "altitude", label: t("altitude") },
              { key: "location", label: t("storageLocation") },
            ].map(({ key, label }) => (
              <div key={key}>
                <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">{label}</label>
                <input
                  value={(form as Record<string, string | number>)[key] as string}
                  onChange={(e) => set(key as keyof FormState, e.target.value)}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm transition-colors"
                />
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange/90 active:scale-[0.98] transition-all disabled:opacity-50">
              {saving ? t("saving") : t("save")}
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

// ─── Delete Confirmation ──────────────────────────────────────────────────────

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

// ─── Adjustment Modal ─────────────────────────────────────────────────────────

function AdjustmentModal({
  bean, onClose, onSuccess,
}: {
  bean: GreenBean;
  onClose: () => void;
  onSuccess: (noChange: boolean) => void;
}) {
  const { t } = useI18n();
  const [actualQty, setActualQty] = useState(String(bean.quantityKg));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const delta = parseFloat(actualQty) - bean.quantityKg;
  const deltaValid = !isNaN(parseFloat(actualQty));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await fetch("/api/inventory/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: bean.id,
        newActualQuantity: parseFloat(actualQty),
        notes: notes.trim() || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || t("adjustFailed"));
      return;
    }
    onSuccess(res.status === 200);
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange/10 flex items-center justify-center">
              <Scale size={18} className="text-orange" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-charcoal">{t("adjustTitle")}</h2>
              <p className="text-xs text-brown/60 font-mono">{bean.serialNumber}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-brown/40 hover:text-charcoal transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Bean identity */}
        <div className="mb-5 px-4 py-3 bg-cream rounded-xl">
          <p className="font-bold text-charcoal">{bean.beanType}</p>
          {bean.beanTypeAr && <p className="text-sm text-brown/70 mt-0.5" dir="rtl">{bean.beanTypeAr}</p>}
          <p className="text-xs text-brown/50 mt-1">{bean.country}{bean.region ? ` / ${bean.region}` : ""}</p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* System qty (read-only) */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">
              {t("systemQtyLabel")}
            </label>
            <div className="px-3 py-2.5 bg-gray-50 border-2 border-border rounded-xl text-sm font-bold text-charcoal font-mono">
              {bean.quantityKg.toFixed(3)} kg
            </div>
          </div>

          {/* Actual qty input */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">
              {t("actualQtyLabel")} *
            </label>
            <input
              type="number" step="0.001" min="0"
              value={actualQty}
              onChange={(e) => setActualQty(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm font-mono transition-colors"
            />
          </div>

          {/* Live delta preview */}
          {deltaValid && (
            <div className={`flex items-center justify-between px-4 py-3 rounded-xl text-sm font-bold border-2 ${
              Math.abs(delta) < 0.001
                ? "bg-gray-50 border-border text-brown/60"
                : delta > 0
                  ? "bg-green-50 border-green-200 text-green-700"
                  : "bg-red-50 border-red-200 text-red-600"
            }`}>
              <span>الفارق</span>
              <span className="font-mono">
                {Math.abs(delta) < 0.001 ? "لا تغيير" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)} kg`}
              </span>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-bold text-brown uppercase tracking-wide mb-1">
              {t("adjustNotes")}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="سبب التسوية (اختياري)"
              dir="rtl"
              className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm resize-none transition-colors text-right"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange/90 active:scale-[0.98] transition-all disabled:opacity-50">
              {saving ? "…" : t("performCount")}
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

// ─── Movement type / source helpers ──────────────────────────────────────────

const TYPE_STYLES: Record<string, string> = {
  IN:         "bg-green-100 text-green-700",
  OUT:        "bg-red-100 text-red-600",
  ADJUSTMENT: "bg-blue-100 text-blue-700",
  LOSS:       "bg-orange/15 text-orange",
};

const SRC_LABELS_AR: Record<string, string> = {
  PURCHASE:          "شراء",
  ROASTING_BATCH:    "دفعة تحميص",
  DELIVERY:          "توصيل",
  PACKING:           "تعبئة",
  MANUAL_ADJUSTMENT: "جرد يدوي",
  BLEND:             "خلط",
};

const TYPE_LABELS_AR: Record<string, string> = {
  IN:         "وارد",
  OUT:        "صادر",
  ADJUSTMENT: "تسوية",
  LOSS:       "فاقد",
};

const LOT_STATUS_STYLES: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  AVAILABLE: { label: "متاح",   cls: "bg-green-100 text-green-700",  icon: CheckCircle2 },
  RESERVED:  { label: "محجوز",  cls: "bg-amber-100 text-amber-700",  icon: Clock },
  SHIPPED:   { label: "مشحون",  cls: "bg-gray-100 text-gray-500",    icon: XCircle },
};

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "receive");
  const canAdjust  = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");

  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>("raw");
  const [loadedTabs, setLoadedTabs] = useState<Set<Tab>>(new Set<Tab>());

  // Data
  const [beans, setBeans]         = useState<GreenBean[]>([]);
  const [lots, setLots]           = useState<FinishedGoodsLot[]>([]);
  const [movements, setMovements] = useState<EnrichedMovement[]>([]);

  // UI
  const [search, setSearch]           = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [lotsSearch, setLotsSearch]     = useState("");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  // Modals
  const [addOpen, setAddOpen]         = useState(false);
  const [editTarget, setEditTarget]   = useState<GreenBean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GreenBean | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<GreenBean | null>(null);
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  function showToast(msg: string, type: "ok" | "err") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Data loaders ─────────────────────────────────────────────────────────

  const loadBeans = useCallback(async () => {
    const res = await fetch("/api/green-beans?all=1");
    setBeans(await res.json());
    setLoadedTabs((p) => new Set([...p, "raw" as Tab]));
  }, []);

  const loadLots = useCallback(async () => {
    const res = await fetch("/api/finished-goods-lots");
    if (res.ok) setLots(await res.json());
    setLoadedTabs((p) => new Set([...p, "finished" as Tab]));
  }, []);

  const loadMovements = useCallback(async () => {
    const res = await fetch("/api/inventory-movements");
    if (res.ok) setMovements(await res.json());
    setLoadedTabs((p) => new Set([...p, "ledger" as Tab]));
  }, []);

  useEffect(() => { loadBeans(); }, [loadBeans]);

  useEffect(() => {
    if (activeTab === "finished" && !loadedTabs.has("finished")) loadLots();
    if (activeTab === "ledger"   && !loadedTabs.has("ledger"))   loadMovements();
  }, [activeTab, loadedTabs, loadLots, loadMovements]);

  // ── Lang-aware display ────────────────────────────────────────────────────

  function disp(en: string | null | undefined, ar: string | null | undefined) {
    if (lang === "ar" && ar) return ar;
    return en ?? "—";
  }

  function fmtDateTime(ts: string) {
    return new Date(ts).toLocaleString(lang === "ar" ? "ar-SA" : "en-US", {
      dateStyle: "short", timeStyle: "short",
    });
  }

  // ── CRUD handlers (unchanged logic) ──────────────────────────────────────

  async function handleAdd(f: FormState) {
    setSaving(true);
    const res = await fetch("/api/green-beans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(j.error || "Failed to add bean", "err");
      return;
    }
    setAddOpen(false);
    loadBeans();
  }

  async function handleEdit(f: FormState) {
    if (!editTarget) return;
    setSaving(true);
    const res = await fetch(`/api/green-beans/${editTarget.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(j.error || "Failed to update bean", "err");
      return;
    }
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
    const res = await fetch(`/api/green-beans/${deleteTarget.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(j.error || "Delete failed", "err");
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    loadBeans();
  }

  // ── Filtered lists ────────────────────────────────────────────────────────

  const filteredBeans = beans
    .filter((b) => showInactive || b.isActive)
    .filter((b) =>
      `${b.beanType} ${b.beanTypeAr ?? ""} ${b.country} ${b.countryAr ?? ""} ${b.serialNumber}`
        .toLowerCase().includes(search.toLowerCase())
    );

  const filteredLots = lots.filter((l) =>
    `${l.batchNumber} ${l.product.productNameEn} ${l.product.productNameAr ?? ""}`
      .toLowerCase().includes(lotsSearch.toLowerCase())
  );

  const filteredMovements = movements.filter((m) =>
    `${m.entityLabel ?? ""} ${m.entityLabelAr ?? ""} ${m.sourceDocType} ${m.userName ?? ""}`
      .toLowerCase().includes(ledgerSearch.toLowerCase())
  );

  const totalStock  = beans.filter((b) => b.isActive).reduce((s, b) => s + b.quantityKg, 0);
  const activeCount = beans.filter((b) => b.isActive).length;
  const totalAvailableFG = lots.filter((l) => l.status === "AVAILABLE").reduce((s, l) => s + l.availableQty, 0);

  return (
    <div className="space-y-6">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-4 ltr:right-4 rtl:left-4 z-50 rounded-xl px-4 py-3 text-sm font-medium shadow-lg flex items-center gap-3 max-w-sm ${
          toast.type === "ok"
            ? "bg-green-50 border border-green-200 text-green-700"
            : "bg-red-50 border border-red-200 text-red-700"
        }`}>
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      {/* ── Modals ── */}
      {addOpen && (
        <BeanForm
          title={t("registerNewStock")}
          initial={emptyForm()}
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
      {adjustTarget && (
        <AdjustmentModal
          bean={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onSuccess={(noChange) => {
            showToast(noChange ? t("adjustNoChange") : t("adjustSuccess"), "ok");
            setAdjustTarget(null);
            loadBeans();
            if (loadedTabs.has("ledger")) loadMovements();
          }}
        />
      )}

      {/* ── Page header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("inventory")}</h1>
          {activeTab === "raw" && (
            <p className="text-brown text-sm font-medium">
              {t("totalStock")}: {totalStock.toFixed(1)} kg — {activeCount} {t("varieties")}
            </p>
          )}
          {activeTab === "finished" && (
            <p className="text-brown text-sm font-medium">
              متاح للشحن: {totalAvailableFG.toFixed(1)} kg
            </p>
          )}
          {activeTab === "ledger" && (
            <p className="text-brown text-sm font-medium">
              {filteredMovements.length} حركة مسجلة
            </p>
          )}
        </div>
        {activeTab === "raw" && canReceive && (
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange/90 shadow-md shadow-orange/20 active:scale-[0.98] transition-all duration-200 font-bold text-sm"
          >
            <Plus size={18} /> {t("addStock")}
          </button>
        )}
      </div>

      {/* ── Tab switcher ── */}
      <div className="flex gap-1 bg-cream border border-border rounded-xl p-1">
        {([
          { id: "raw"      as Tab, label: t("rawMaterials"),   icon: Package },
          { id: "finished" as Tab, label: t("finishedGoods"),  icon: Boxes   },
          { id: "ledger"   as Tab, label: t("movementLedger"), icon: History },
        ] as { id: Tab; label: string; icon: React.ElementType }[]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 ${
              activeTab === id
                ? "bg-orange text-white shadow-sm shadow-orange/30"
                : "text-brown hover:text-charcoal hover:bg-white/60"
            }`}
          >
            <Icon size={15} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════
          TAB 1 — Raw Materials
          ════════════════════════════════════════════════════════════ */}
      {activeTab === "raw" && (
        <div className="space-y-4">
          {/* Search + inactive toggle */}
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" placeholder={t("searchBeans")} value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
              />
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

          {/* Beans table */}
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
                    <th className="text-center px-4 py-3 font-semibold text-charcoal">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBeans.map((bean) => (
                    <tr key={bean.id} className={`transition-colors ${bean.isActive ? "hover:bg-cream/50" : "bg-gray-50/80 opacity-60"}`}>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs">{bean.serialNumber}</span>
                        {!bean.isActive && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-200 text-gray-500">
                            {t("inactive")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium">{disp(bean.beanType, bean.beanTypeAr)}</td>
                      <td className="px-4 py-3">
                        {disp(bean.country, bean.countryAr)}
                        {(bean.region || bean.regionAr) && (
                          <span className="text-brown/50"> / {disp(bean.region, bean.regionAr)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{disp(bean.process, bean.processAr) || "—"}</td>
                      <td className="px-4 py-3 text-brown/70">{bean.altitude || "—"}</td>
                      <td className="px-4 py-3 text-end">
                        <span className={`font-bold tabular-nums ${bean.quantityKg < 20 ? "text-red-600" : "text-green-600"}`}>
                          {bean.quantityKg.toFixed(1)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-brown">{formatDate(bean.receivedDate)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          {canAdjust && (
                            <button
                              title={t("performCount")}
                              onClick={() => setAdjustTarget(bean)}
                              className="p-1.5 rounded-lg text-brown/50 hover:text-orange hover:bg-orange/10 transition-colors"
                            >
                              <Scale size={14} />
                            </button>
                          )}
                          {canAdjust && (
                            <button
                              title={t("edit")}
                              onClick={() => setEditTarget(bean)}
                              className="p-1.5 rounded-lg text-brown/50 hover:text-orange hover:bg-orange/10 transition-colors"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {canAdjust && (
                            <button
                              title={bean.isActive ? t("deactivate") : t("activate")}
                              onClick={() => handleToggleActive(bean)}
                              className={`p-1.5 rounded-lg transition-colors ${
                                bean.isActive
                                  ? "text-brown/50 hover:text-amber-500 hover:bg-amber-50"
                                  : "text-green-600 hover:bg-green-50"
                              }`}
                            >
                              {bean.isActive ? <PowerOff size={14} /> : <Power size={14} />}
                            </button>
                          )}
                          {canAdjust && (
                            <button
                              title={t("delete")}
                              onClick={() => setDeleteTarget(bean)}
                              className="p-1.5 rounded-lg text-brown/50 hover:text-red-500 hover:bg-red-50 transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredBeans.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <Package size={40} className="mx-auto mb-2" />
                <p>{t("noBeansFound")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          TAB 2 — Finished Goods
          ════════════════════════════════════════════════════════════ */}
      {activeTab === "finished" && (
        <div className="space-y-4">
          <div className="relative">
            <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="بحث في اللوتات…" value={lotsSearch}
              onChange={(e) => setLotsSearch(e.target.value)}
              className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
            />
          </div>

          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream">
                  <tr>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("lotNumber")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("productName")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("totalQtyKg")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("availableQtyKg")}</th>
                    <th className="text-center px-4 py-3 font-semibold text-charcoal">{t("lotStatusLabel")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("date")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredLots.map((lot) => {
                    const st = LOT_STATUS_STYLES[lot.status] ?? LOT_STATUS_STYLES.AVAILABLE;
                    const StatusIcon = st.icon;
                    const availRatio = lot.quantityKg > 0 ? lot.availableQty / lot.quantityKg : 0;
                    return (
                      <tr key={lot.id} className="hover:bg-cream/50 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs font-bold text-charcoal">{lot.batchNumber}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium">{disp(lot.product.productNameEn, lot.product.productNameAr)}</p>
                        </td>
                        <td className="px-4 py-3 text-end font-mono text-brown">{lot.quantityKg.toFixed(1)}</td>
                        <td className="px-4 py-3 text-end">
                          <span className={`font-bold tabular-nums font-mono ${
                            availRatio > 0.5 ? "text-green-600" : availRatio > 0 ? "text-amber-600" : "text-red-500"
                          }`}>
                            {lot.availableQty.toFixed(1)}
                          </span>
                          <span className="text-brown/40 text-xs ml-1">({(availRatio * 100).toFixed(0)}%)</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${st.cls}`}>
                            <StatusIcon size={11} />
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-brown text-xs">{formatDate(lot.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredLots.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <Boxes size={40} className="mx-auto mb-2" />
                <p>{t("noFinishedGoods")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          TAB 3 — Movement Ledger
          ════════════════════════════════════════════════════════════ */}
      {activeTab === "ledger" && (
        <div className="space-y-4">
          <div className="relative">
            <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="بحث في الحركات…" value={ledgerSearch}
              onChange={(e) => setLedgerSearch(e.target.value)}
              className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
            />
          </div>

          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream">
                  <tr>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal whitespace-nowrap">{t("movementDate")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("movementType")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("itemDetails")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-charcoal whitespace-nowrap">{t("prevQty")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-charcoal whitespace-nowrap">{t("newQtyKg")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("difference")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("sourceDoc")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredMovements.map((m) => {
                    const isGain = m.quantityChanged > 0;
                    const isLoss = m.quantityChanged < 0;
                    const isZero = Math.abs(m.quantityChanged) < 0.001;
                    return (
                      <tr key={m.id} className="hover:bg-cream/40 transition-colors">
                        <td className="px-4 py-3 text-xs text-brown whitespace-nowrap font-mono">
                          {fmtDateTime(m.timestamp)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${TYPE_STYLES[m.type] ?? "bg-gray-100 text-gray-600"}`}>
                            {TYPE_LABELS_AR[m.type] ?? m.type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-charcoal">
                            {disp(m.entityLabel, m.entityLabelAr) || "—"}
                          </p>
                          <p className="text-[11px] text-brown/50 mt-0.5">
                            {m.category === "RAW_MATERIAL" ? t("catRawMaterial") : t("catFinishedGoods")}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-end font-mono text-brown/70 tabular-nums">
                          {m.previousQuantity.toFixed(3)}
                        </td>
                        <td className="px-4 py-3 text-end font-mono text-charcoal font-semibold tabular-nums">
                          {m.newQuantity.toFixed(3)}
                        </td>
                        <td className="px-4 py-3 text-end">
                          <span className={`font-bold tabular-nums font-mono ${
                            isZero ? "text-brown/40" : isGain ? "text-green-600" : isLoss ? "text-red-500" : ""
                          }`}>
                            {isZero ? "—" : `${isGain ? "+" : ""}${m.quantityChanged.toFixed(3)}`}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-brown">{SRC_LABELS_AR[m.sourceDocType] ?? m.sourceDocType}</p>
                          {m.userName && (
                            <p className="text-[11px] text-brown/50 mt-0.5">{m.userName}</p>
                          )}
                          {m.notes && (
                            <p className="text-[11px] text-brown/60 mt-0.5 italic">{m.notes}</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredMovements.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <History size={40} className="mx-auto mb-2" />
                <p>{t("noLedgerMovements")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
