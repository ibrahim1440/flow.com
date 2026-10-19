"use client";
// Inventory — Direction 2.1 (migration phase 2; Figma page 216:2, frames 251:2482 green coffee,
// 253:2987 packaging materials, 266:5230 finished stock, 268:5577 movement ledger, 278:4772
// count dialog; phones 270:5944 / 270:6058 / 270:6164 / 270:6268 / 270:6388).
//
// Visual port only: the same requests (GET /api/green-beans?all=1, /api/finished-goods-lots,
// /api/inventory-movements, /api/materials; POST/PUT/DELETE /api/green-beans, POST
// /api/inventory/adjust, the materials receive / count routes), the same permission gates and the
// same validation as the legacy screen. What the frames draw that the ERP does not store (14-day
// roast rate and coverage, count sessions, export, pagination) is not built.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Languages, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import {
  Btn, Field, Notice, OpsBanner, OpsLoading, OpsRoot, PageHeader, StatusDot, Tabs, kg, opsDate, useL,
} from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { CheckIcon, MaterialForm, MaterialsPanel, PlusIcon, type Material } from "../_components/stock-materials";

/** A stored quantity for display: "—" when it is not a finite number (Infinity arrives as JSON null), so one bad row cannot crash the screen. */
const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

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
  reservedQty: number;
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

type Tab = "raw" | "pack" | "finished" | "ledger";

type FormState = {
  serialNumber: string; beanType: string; beanTypeAr: string;
  country: string; countryAr: string; region: string; regionAr: string;
  variety: string; process: string; processAr: string;
  altitude: string; location: string; quantityKg: number;
};

/** The legacy screen's low-stock rule for a green-coffee row (kept as is: below 20 kg). */
const LOW_KG = 20;

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

function FilterIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" /></svg>;
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
  const L = useL();
  const [form, setForm] = useState<FormState>(initial);
  const [translating, setTranslating] = useState<Record<string, boolean>>({});

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
    await onSave(form);
  }

  function TranslateBtn({ sourceKey, targetKey, targetLang }: { sourceKey: keyof FormState; targetKey: keyof FormState; targetLang: "ar" | "en" }) {
    const busy = translating[targetKey];
    const hasSource = !!(form[sourceKey] as string)?.trim();
    const label = targetLang === "ar" ? t("translateToAr") : "Translate to English";
    return (
      <Btn size="sm" variant="ghost" className="hr-iconbtn" title={label} aria-label={label}
        onClick={() => translate(sourceKey, targetKey, targetLang)} disabled={busy || !hasSource}>
        {busy ? "…" : <Languages size={16} />}
      </Btn>
    );
  }

  return (
    <Dialog
      open
      title={title}
      className="stk-wide"
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" type="submit" form="bean-form" disabled={saving}>{saving ? t("saving") : t("save")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      <form id="bean-form" onSubmit={handleSubmit} className="hr-form">
        <Field label={t("serialNumber")} help={L("يُولَّد تلقائيًا", "Auto-generated")}>
          <input className="hr-input hr-id" dir="ltr" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} placeholder="GB-20260511-142" />
        </Field>
        <Field label={`${t("quantityKg")} *`}>
          <input className="hr-input" type="number" step="0.01" min="0" value={form.quantityKg} required
            onChange={(e) => set("quantityKg", parseFloat(e.target.value) || 0)} />
        </Field>
        {bilingualFields.map(({ enKey, arKey, labelEn, labelAr, required }) => (
          <div key={enKey} style={{ display: "contents" }}>
            <Field label={`${labelEn}${required ? " *" : ""}`}>
              <span className="stk-pair">
                <input className="hr-input" dir="ltr" value={form[enKey] as string} onChange={(e) => set(enKey, e.target.value)} required={required} />
                <TranslateBtn sourceKey={arKey} targetKey={enKey} targetLang="en" />
              </span>
            </Field>
            <Field label={labelAr}>
              <span className="stk-pair">
                <input className="hr-input" dir="rtl" placeholder="اختياري" value={form[arKey] as string} onChange={(e) => set(arKey, e.target.value)} />
                <TranslateBtn sourceKey={enKey} targetKey={arKey} targetLang="ar" />
              </span>
            </Field>
          </div>
        ))}
        {([
          { key: "variety", label: t("variety") },
          { key: "altitude", label: t("altitude") },
          { key: "location", label: t("storageLocation") },
        ] as const).map(({ key, label }) => (
          <Field key={key} label={label}>
            <input className="hr-input" value={form[key] as string} onChange={(e) => set(key, e.target.value)} />
          </Field>
        ))}
      </form>
    </Dialog>
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
    <Dialog
      open
      title={bean.beanType}
      sub={<span className="hr-id">{bean.serialNumber}</span>}
      onClose={onClose}
      actions={
        <>
          <Btn variant="danger" onClick={onConfirm} disabled={deleting}>{deleting ? "…" : t("delete")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t("confirmDeleteBean")}</p>
    </Dialog>
  );
}

// ─── Adjustment (count) dialog — Figma 278:4772 ──────────────────────────────

function AdjustmentModal({
  bean, onClose, onSuccess,
}: {
  bean: GreenBean;
  onClose: () => void;
  onSuccess: (noChange: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const L = useL();
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

  const name = lang === "ar" && bean.beanTypeAr ? bean.beanTypeAr : bean.beanType;
  const zero = Math.abs(delta) < 0.001;
  return (
    <Dialog
      open
      title={t("adjustTitle")}
      sub={<>{name} · <span className="hr-id">{bean.serialNumber}</span>{bean.location ? ` · ${bean.location}` : ""}</>}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" type="submit" form="adjust-form" disabled={saving}>{saving ? "…" : t("performCount")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <form id="adjust-form" onSubmit={handleSubmit} className="hr-stack" style={{ gap: 14 }}>
        <div className="hr-form">
          <Field label={t("systemQtyLabel")}>
            <input className="hr-input hr-num" value={fmtQty(bean.quantityKg, 3)} disabled readOnly />
          </Field>
          <Field label={`${t("actualQtyLabel")} *`}>
            <input className="hr-input" type="number" step="0.001" min="0" value={actualQty}
              onChange={(e) => setActualQty(e.target.value)} required autoFocus />
          </Field>
        </div>
        {deltaValid ? (
          <div className={`stk-diff${zero ? "" : delta > 0 ? " tone-success" : " tone-danger"}`}>
            <span>{L("الفارق", "Difference")} <strong>{zero ? L("لا تغيير", "No change") : `${delta > 0 ? "+" : ""}${delta.toFixed(3)} ${lang === "ar" ? "كغ" : "kg"}`}</strong></span>
            {zero ? null : <span>{L("يُسجَّل كتسوية", "Recorded as an adjustment")}</span>}
          </div>
        ) : null}
        <Field label={t("adjustNotes")}>
          <textarea className="hr-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder={L("سبب التسوية (اختياري)", "Reason for the adjustment (optional)")} />
        </Field>
      </form>
    </Dialog>
  );
}

// ─── Movement type / source helpers ──────────────────────────────────────────

const TYPE_MAP: Record<string, [string, "success" | "neutral" | "warning" | "danger", string]> = {
  IN:         ["وارد", "success", "In"],
  OUT:        ["صادر", "neutral", "Out"],
  ADJUSTMENT: ["تسوية", "warning", "Adjustment"],
  LOSS:       ["فاقد", "danger", "Loss"],
};

const SRC_LABELS: Record<string, [string, string]> = {
  PURCHASE:          ["شراء", "Purchase"],
  ROASTING_BATCH:    ["دفعة تحميص", "Roasting batch"],
  DELIVERY:          ["توصيل", "Delivery"],
  PACKING:           ["تعبئة", "Packing"],
  MANUAL_ADJUSTMENT: ["جرد يدوي", "Manual count"],
  BLEND:             ["خلط", "Blend"],
  OPENING_BALANCE:   ["رصيد افتتاحي (استلام)", "Opening balance (receipt)"],
  RECEIVING:         ["استلام توريد", "Receiving"],
};

const LOT_STATUS: Record<string, [string, "success" | "warning" | "neutral", string]> = {
  AVAILABLE: ["متاح", "success", "Available"],
  RESERVED:  ["محجوز", "warning", "Reserved"],
  SHIPPED:   ["مشحون", "neutral", "Shipped"],
};

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const L = useL();
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "receive");
  const canAdjust  = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");
  // Bean record edit / (de)activate / delete is catalogue maintenance: the receiving duty or adjust
  // (owner decision, inventory Option A). The count (a stock adjustment) stays adjust-only.
  const canMaintain = canReceive || canAdjust;

  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>("raw");
  const [loadedTabs, setLoadedTabs] = useState<Set<Tab>>(new Set<Tab>());

  // Data
  const [beans, setBeans]         = useState<GreenBean[]>([]);
  const [lots, setLots]           = useState<FinishedGoodsLot[]>([]);
  const [movements, setMovements] = useState<EnrichedMovement[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);

  // UI
  const [search, setSearch]           = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [lotsSearch, setLotsSearch]     = useState("");
  const [matSearch, setMatSearch]       = useState("");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  // Modals
  const [addOpen, setAddOpen]         = useState(false);
  const [editTarget, setEditTarget]   = useState<GreenBean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GreenBean | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<GreenBean | null>(null);
  const [materialFormOpen, setMaterialFormOpen] = useState(false);
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

  // The packaging materials list (Figma 253:2987): the products screen's request.
  const loadMaterials = useCallback(async () => {
    const res = await fetch("/api/materials?activeOnly=false");
    if (res.ok) setMaterials(await res.json());
    setLoadedTabs((p) => new Set([...p, "pack" as Tab]));
  }, []);

  // The first load: the same request as loadBeans, with every state update after the await.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/green-beans?all=1");
      const j = await res.json();
      if (cancelled) return;
      setBeans(j);
      setLoadedTabs((p) => new Set([...p, "raw" as Tab]));
    })();
    return () => { cancelled = true; };
  }, []);

  // Each other tab loads the first time it is opened (as before, now from the tab change itself).
  function openTab(tab: Tab) {
    setActiveTab(tab);
    if (tab === "finished" && !loadedTabs.has("finished")) loadLots();
    if (tab === "ledger"   && !loadedTabs.has("ledger"))   loadMovements();
    if (tab === "pack"     && !loadedTabs.has("pack"))     loadMaterials();
  }

  // ── Lang-aware display ────────────────────────────────────────────────────

  function disp(en: string | null | undefined, ar: string | null | undefined) {
    if (lang === "ar" && ar) return ar;
    return en ?? "—";
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

  const filteredMaterials = useMemo(() => {
    const q = matSearch.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter((m) => m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [materials, matSearch]);

  const activeBeans = beans.filter((b) => b.isActive);
  const totalStock  = activeBeans.reduce((s, b) => s + b.quantityKg, 0);
  const activeCount = activeBeans.length;
  const lowBeans    = activeBeans.filter((b) => b.quantityKg < LOW_KG);
  const lastReceipt = activeBeans.reduce<GreenBean | null>((a, b) => (!a || b.receivedDate > a.receivedDate ? b : a), null);
  const availableLots = lots.filter((l) => l.status === "AVAILABLE");
  const totalAvailableFG = availableLots.reduce((s, l) => s + l.availableQty, 0);
  // Split the shelf into what is already promised to an order and what is still sellable.
  const totalReservedFG = availableLots.reduce((s, l) => s + (l.reservedQty ?? 0), 0);
  const totalFreeFG = Math.max(0, totalAvailableFG - totalReservedFG);
  const lowMaterials = materials.filter((m) => m.belowReorderPoint);
  const filteredStock = filteredBeans.reduce((s, b) => s + (Number.isFinite(b.quantityKg) ? b.quantityKg : 0), 0);

  // Ledger rows grouped by operational day (268:5577 «اليوم 6», «أمس 4»), newest first as served.
  const ledgerGroups = useMemo(() => {
    const out: { day: string; rows: EnrichedMovement[] }[] = [];
    for (const m of filteredMovements) {
      const day = opsDate(m.timestamp, lang);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(m);
      else out.push({ day, rows: [m] });
    }
    return out;
  }, [filteredMovements, lang]);

  const kgU = lang === "ar" ? "كغ" : "kg";
  const loading = !loadedTabs.has(activeTab);
  const timeOf = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Riyadh" });
  };

  const headerAction = activeTab === "raw" && canReceive ? (
    <Btn variant="primary" onClick={() => setAddOpen(true)}><PlusIcon />{t("addStock")}</Btn>
  ) : activeTab === "pack" ? (
    <Btn variant="primary" onClick={() => setMaterialFormOpen(true)}><PlusIcon />{t("newMaterialBtn")}</Btn>
  ) : null;

  return (
    <OpsRoot className="stk-inventory">
    <div className="hr-page">

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
      {materialFormOpen && (
        <MaterialForm
          onClose={() => setMaterialFormOpen(false)}
          onSaved={() => { setMaterialFormOpen(false); loadMaterials(); }}
          onError={(m) => showToast(m, "err")}
        />
      )}

      {/* ── Page header ── */}
      <PageHeader title={t("inventory")} actions={headerAction}>
        {activeTab === "raw" && (
          <span className="hr-caption">
            {t("totalStock")}: <span className="hr-num">{totalStock.toFixed(1)}</span> {kgU} — {activeCount} {t("varieties")}
          </span>
        )}
        {activeTab === "finished" && (
          <span className="hr-caption">
            {L("متاح للشحن", "Available to ship")}: <span className="hr-num">{totalAvailableFG.toFixed(1)}</span> {kgU}
            {" — "}{t("totalReservedFG")}: <span className="hr-num">{totalReservedFG.toFixed(1)}</span> {kgU}
            {" — "}{t("totalFreeFG")}: <span className="hr-num">{totalFreeFG.toFixed(1)}</span> {kgU}
          </span>
        )}
        {activeTab === "ledger" && (
          <span className="hr-caption">{lang === "ar" ? `${filteredMovements.length} حركة مسجلة` : `${filteredMovements.length} movements recorded`}</span>
        )}
        {activeTab === "pack" && (
          <span className="hr-caption">{lang === "ar" ? `${materials.length} مواد · ${lowMaterials.length} تحت حد إعادة الطلب` : `${materials.length} materials · ${lowMaterials.length} below reorder point`}</span>
        )}
      </PageHeader>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

      {/* ── Tabs (251:2482: البن الأخضر · مواد التعبئة · المخزون التام · سجل الحركات) ── */}
      <Tabs
        label={t("inventory")}
        value={activeTab}
        onChange={openTab}
        items={[
          { key: "raw", label: L("البن الأخضر", "Green coffee"), count: loadedTabs.has("raw") ? activeCount : undefined },
          { key: "pack", label: t("tabMaterials"), count: loadedTabs.has("pack") ? materials.length : undefined },
          { key: "finished", label: t("finishedGoods"), count: loadedTabs.has("finished") ? lots.length : undefined },
          { key: "ledger", label: t("movementLedger") },
        ]}
      />

      {loading ? <OpsLoading /> : null}

      {/* ════════════ Green coffee (251:2482) ════════════ */}
      {activeTab === "raw" && !loading && (
        <section className="hr-stack" aria-label={L("البن الأخضر", "Green coffee")}>
          <div className="stk-metrics">
            <div>
              <span className="stk-lbl">{L("البن الأخضر في المخزون", "Green coffee in stock")}</span>
              <span className="stk-mid">{kg(totalStock)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{lang === "ar" ? `${activeCount} لوتات نشطة` : `${activeCount} active lots`}</span>
            </div>
            <div>
              <span className="stk-lbl">{L(`أصناف أقل من ${LOW_KG} كغ`, `Lots below ${LOW_KG} kg`)}</span>
              <span className={`stk-mid${lowBeans.length ? " tone-danger" : ""}`}>{lowBeans.length}</span>
              <span className="stk-d">{lowBeans.map((b) => disp(b.beanType, b.beanTypeAr)).join(lang === "ar" ? "، " : ", ") || "—"}</span>
            </div>
            <div>
              <span className="stk-lbl">{L("آخر استلام", "Last receipt")}</span>
              <span className="stk-mid">{lastReceipt ? kg(lastReceipt.quantityKg) : "—"}{lastReceipt ? <span className="stk-unit">{kgU}</span> : null}</span>
              <span className="stk-d">{lastReceipt ? `${opsDate(lastReceipt.receivedDate, lang)} · ${disp(lastReceipt.beanType, lastReceipt.beanTypeAr)}` : "—"}</span>
            </div>
          </div>

          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={t("searchBeans")} aria-label={t("searchBeans")}
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <Btn size="sm" className="stk-toggle" aria-pressed={showInactive} onClick={() => setShowInactive((p) => !p)}>
              <FilterIcon />{t("showInactive")}
            </Btn>
          </div>

          {filteredBeans.length === 0 ? (
            <div className="hr-state"><h3>{t("noBeansFound")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("البن الأخضر", "Green coffee")}>
                <thead>
                  <tr>
                    <th>{L("البن الأخضر", "Green coffee")}</th>
                    <th>{L("اللوت", "Lot")}</th>
                    <th className="hr-hide-compact">{t("origin")}</th>
                    <th className="hr-hide-compact">{t("altitude")}</th>
                    <th className="num">{lang === "ar" ? "الرصيد · كغ" : "Balance · kg"}</th>
                    <th>{t("received")}</th>
                    <th className="hr-mobile-cell" aria-hidden="true" />
                    <th aria-label={t("actions")} />
                  </tr>
                </thead>
                <tbody>
                  {filteredBeans.map((bean) => {
                    const low = bean.quantityKg < LOW_KG;
                    const proc = disp(bean.process, bean.processAr);
                    return (
                      <tr key={bean.id} className={bean.isActive ? undefined : "is-inactive"}>
                        <td className="m-title">
                          <span className="strong">{disp(bean.beanType, bean.beanTypeAr)}</span>
                          {bean.process || bean.processAr ? <span className="hr-caption"> · {proc}</span> : null}
                          {low && bean.isActive ? <> <span className="stk-flag hr-desktop-only">{L(`أقل من ${LOW_KG} كغ`, `Below ${LOW_KG} kg`)}</span></> : null}
                          {!bean.isActive ? <> <span className="stk-flag tone-warning">{t("inactive")}</span></> : null}
                          <span className="hr-msub">
                            <span className="hr-id">{bean.serialNumber}</span> · {disp(bean.country, bean.countryAr)}{bean.location ? ` · ${bean.location}` : ""}
                          </span>
                        </td>
                        <td><span className="hr-id">{bean.serialNumber}</span>{bean.location ? <span className="stk-sub">{bean.location}</span> : null}</td>
                        <td className="hr-hide-compact">
                          {disp(bean.country, bean.countryAr)}
                          {(bean.region || bean.regionAr) && <span className="hr-caption"> / {disp(bean.region, bean.regionAr)}</span>}
                        </td>
                        <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{bean.altitude || "—"}</td>
                        <td className={`num${low ? " is-low" : ""}`} style={{ fontWeight: 600 }}><span className="hr-num">{fmtQty(bean.quantityKg, 2)}</span></td>
                        <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{opsDate(bean.receivedDate, lang)}</td>
                        <td className="m-end hr-mobile-cell" style={{ fontWeight: 600 }}>
                          <span className="hr-num" style={low ? { color: "var(--status-danger)" } : undefined}>{fmtQty(bean.quantityKg, 2)}</span>&nbsp;{kgU}
                        </td>
                        <td className="stk-acts stk-macts">
                          {canAdjust && (
                            <Btn size="sm" variant="ghost" title={t("performCount")} onClick={() => setAdjustTarget(bean)}>
                              <CheckIcon />{L("جرد", "Count")}
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn" title={t("edit")} aria-label={t("edit")} onClick={() => setEditTarget(bean)}>
                              <Pencil size={16} />
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn"
                              title={bean.isActive ? t("deactivate") : t("activate")} aria-label={bean.isActive ? t("deactivate") : t("activate")}
                              onClick={() => handleToggleActive(bean)}>
                              {bean.isActive ? <PowerOff size={16} /> : <Power size={16} />}
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn" title={t("delete")} aria-label={t("delete")} onClick={() => setDeleteTarget(bean)}>
                              <Trash2 size={16} />
                            </Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{lang === "ar" ? `${filteredBeans.length} لوتات` : `${filteredBeans.length} lots`}</td>
                    <td className="num stk-tot"><span className="hr-num">{kg(filteredStock)}</span></td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ════════════ Packaging materials (253:2987) ════════════ */}
      {activeTab === "pack" && !loading && (
        <section className="hr-stack" aria-label={t("tabMaterials")}>
          <div className="stk-metrics">
            <div>
              <span className="stk-lbl">{L("مواد نشطة", "Active materials")}</span>
              <span className="stk-mid">{materials.filter((m) => m.isActive).length}</span>
              <span className="stk-d">{L("تعبئة · ملصقات · مستهلكات", "Packaging · labels · consumables")}</span>
            </div>
            <div>
              <span className="stk-lbl">{L("تحت حد إعادة الطلب", "Below reorder point")}</span>
              <span className={`stk-mid${lowMaterials.length ? " tone-warning" : ""}`}>{lowMaterials.length}</span>
              <span className="stk-d">{lowMaterials.map((m) => m.name).join(lang === "ar" ? "، " : ", ") || "—"}</span>
            </div>
          </div>
          <MaterialsPanel
            materials={filteredMaterials}
            onChanged={loadMaterials}
            onError={(m) => showToast(m, "err")}
            search={
              <div className="stk-tool">
                <input type="search" className="hr-input hr-search" placeholder={L("رمز المادة أو اسمها", "Material code or name")}
                  aria-label={L("رمز المادة أو اسمها", "Material code or name")} value={matSearch} onChange={(e) => setMatSearch(e.target.value)} />
              </div>
            }
          />
        </section>
      )}

      {/* ════════════ Finished stock (266:5230) ════════════ */}
      {activeTab === "finished" && !loading && (
        <section className="hr-stack" aria-label={t("finishedGoods")}>
          <div className="stk-metrics">
            <div>
              <span className="stk-lbl">{L("متاح للشحن", "Available to ship")}</span>
              <span className="stk-mid">{kg(totalAvailableFG, 1)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{lang === "ar" ? `في ${availableLots.length} لوتًا متاحًا` : `in ${availableLots.length} available lots`}</span>
            </div>
            <div>
              <span className="stk-lbl">{t("totalReservedFG")}</span>
              <span className="stk-mid">{kg(totalReservedFG, 1)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{L("محجوزة للطلبات", "Reserved for orders")}</span>
            </div>
            <div>
              <span className="stk-lbl">{t("totalFreeFG")}</span>
              <span className="stk-mid">{kg(totalFreeFG, 1)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{L("حرّ للبيع", "Free to sell")}</span>
            </div>
          </div>

          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={L("بحث في اللوتات…", "Search lots…")} aria-label={L("بحث في اللوتات…", "Search lots…")}
              value={lotsSearch} onChange={(e) => setLotsSearch(e.target.value)} />
          </div>

          {filteredLots.length === 0 ? (
            <div className="hr-state"><h3>{t("noFinishedGoods")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={t("finishedGoods")}>
                <thead>
                  <tr>
                    <th>{t("lotNumber")}</th>
                    <th>{t("productName")}</th>
                    <th className="num hr-hide-compact">{t("totalQtyKg")}</th>
                    <th className="num">{t("availableQtyKg")}</th>
                    <th className="num">{t("reservedQtyKg")}</th>
                    <th className="num">{t("freeQtyKg")}</th>
                    <th>{t("lotStatusLabel")}</th>
                    <th className="hr-hide-compact">{t("date")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLots.map((lot) => {
                    const availRatio = lot.quantityKg > 0 ? lot.availableQty / lot.quantityKg : 0;
                    const freeQty = Math.max(0, lot.availableQty - (lot.reservedQty ?? 0));
                    return (
                      <tr key={lot.id}>
                        <td><span className="hr-id">{lot.batchNumber}</span></td>
                        <td className="m-title">
                          <span className="strong">{disp(lot.product.productNameEn, lot.product.productNameAr)}</span>
                          <span className="hr-msub">
                            <span className="hr-id">{lot.batchNumber}</span> · {t("availableQtyKg")} <span className="hr-num">{fmtQty(lot.availableQty, 1)}</span> · {t("freeQtyKg")} <span className="hr-num">{freeQty.toFixed(1)}</span>
                          </span>
                        </td>
                        <td className="num hr-hide-compact"><span className="hr-num">{fmtQty(lot.quantityKg, 1)}</span></td>
                        <td className="num">
                          <span className="hr-num">{fmtQty(lot.availableQty, 1)}</span>
                          <span className="hr-caption"> ({(availRatio * 100).toFixed(0)}%)</span>
                        </td>
                        <td className="num"><span className="hr-num">{fmtQty(lot.reservedQty ?? 0, 1)}</span></td>
                        <td className="num" style={{ fontWeight: 600 }}><span className="hr-num" style={freeQty > 0 ? undefined : { color: "var(--text-muted)", fontWeight: 400 }}>{freeQty.toFixed(1)}</span></td>
                        <td className="m-end">
                          <StatusDot map={LOT_STATUS} value={LOT_STATUS[lot.status] ? lot.status : "AVAILABLE"} />
                        </td>
                        <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{opsDate(lot.createdAt, lang)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>{lang === "ar" ? `${filteredLots.length} لوتات` : `${filteredLots.length} lots`}</td>
                    <td className="hr-hide-compact" />
                    <td className="num stk-tot"><span className="hr-num">{kg(totalAvailableFG, 1)}</span></td>
                    <td className="num stk-tot"><span className="hr-num">{kg(totalReservedFG, 1)}</span></td>
                    <td className="num stk-tot"><span className="hr-num">{kg(totalFreeFG, 1)}</span></td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ════════════ Movement ledger (268:5577) ════════════ */}
      {activeTab === "ledger" && !loading && (
        <section className="hr-stack" aria-label={t("movementLedger")}>
          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={L("بحث في الحركات…", "Search movements…")} aria-label={L("بحث في الحركات…", "Search movements…")}
              value={ledgerSearch} onChange={(e) => setLedgerSearch(e.target.value)} />
          </div>

          {filteredMovements.length === 0 ? (
            <div className="hr-state"><h3>{t("noLedgerMovements")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={t("movementLedger")}>
                <thead>
                  <tr>
                    <th>{L("الوقت", "Time")}</th>
                    <th>{t("movementType")}</th>
                    <th>{L("الصنف والفئة", "Item and category")}</th>
                    <th className="num">{L("قبل", "Before")}</th>
                    <th className="num">{L("بعد", "After")}</th>
                    <th className="num">{t("difference")}</th>
                    <th>{t("sourceDoc")}</th>
                    <th className="hr-hide-compact">{L("المستخدم", "User")}</th>
                  </tr>
                </thead>
                {ledgerGroups.map((g) => (
                  <tbody key={g.day}>
                    <tr className="stk-group"><td colSpan={8}>{g.day}</td></tr>
                    {g.rows.map((m) => {
                      const isGain = m.quantityChanged > 0;
                      const isZero = Math.abs(m.quantityChanged) < 0.001;
                      const src = SRC_LABELS[m.sourceDocType];
                      const srcLabel = src ? (lang === "ar" ? src[0] : src[1]) : m.sourceDocType;
                      const change = isZero ? "—" : `${isGain ? "+" : ""}${fmtQty(m.quantityChanged, 3)}`;
                      return (
                        <tr key={m.id}>
                          <td className="hr-caption" style={{ color: "var(--text-secondary)" }}><span className="hr-num">{timeOf(m.timestamp)}</span></td>
                          <td><StatusDot map={TYPE_MAP} value={TYPE_MAP[m.type] ? m.type : "OUT"} /></td>
                          <td className="m-title">
                            <span className="strong">{disp(m.entityLabel, m.entityLabelAr) || "—"}</span>
                            <span className="stk-sub hr-desktop-only">{m.category === "RAW_MATERIAL" ? t("catRawMaterial") : t("catFinishedGoods")}</span>
                            <span className="hr-msub">
                              <span className="hr-num">{timeOf(m.timestamp)}</span> · {(TYPE_MAP[m.type] ?? TYPE_MAP.OUT)[lang === "ar" ? 0 : 2]} · {srcLabel}
                            </span>
                          </td>
                          <td className="num"><span className="hr-num" style={{ color: "var(--text-secondary)" }}>{fmtQty(m.previousQuantity, 3)}</span></td>
                          <td className="num"><span className="hr-num">{fmtQty(m.newQuantity, 3)}</span></td>
                          <td className="num m-end" style={{ fontWeight: 600 }}>
                            <span className={`hr-num ${isZero ? "hr-muted" : isGain ? "stk-gain" : "stk-loss"}`}>{change}</span>
                          </td>
                          <td>
                            <span>{srcLabel}</span>
                            {m.notes ? <span className="stk-sub">{m.notes}</span> : null}
                          </td>
                          <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{m.userName ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          <p className="stk-foot">{L("السجل للإضافة فقط: لا تُحذف الحركات ولا تُعدَّل.", "The ledger is append-only: movements are never deleted or edited.")}</p>
        </section>
      )}
    </div>
    </OpsRoot>
  );
}
