"use client";
// Inventory — Direction 2.1 (migration phase 2; Figma page 216:2, frames 251:2482 green coffee,
// 253:2987 packaging materials, 266:5230 finished stock, 268:5577 movement ledger, 278:4772
// count dialog; phones 270:5944 / 270:6058 / 270:6164 / 270:6268 / 270:6388).
//
// Phase 2 ported the frames visually; batch "Inventory & products" (track B) builds what they draw
// that had no code: count sessions («الجرد والتسويات», «إجراء جرد»), green coffee grouped by bean
// with the 14-day roast rate and coverage, packaging usage and packs coverable, units per SKU and
// unpacked roasted coffee with «تتبع» to the lot trace page (/dashboard/inventory/lots/[id]), and
// the ledger's filters, pages and CSV export. Every figure is derived from the ledger
// (src/lib/inventory/metrics.ts); «—» where the history cannot support it. The tabs live in ./_parts.
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Languages } from "lucide-react";
import {
  Btn, Field, Notice, OpsBanner, OpsLoading, OpsRoot, PageHeader, Tabs, useL,
} from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { CheckIcon, MaterialForm, PlusIcon, type Material } from "../_components/stock-materials";
import { GreenTab, type GreenBean } from "./_parts/green";
import { PackagingTab } from "./_parts/packaging";
import { FinishedTab } from "./_parts/finished";
import { LedgerTab } from "./_parts/ledger";
import { CountsTab, StartCountDialog } from "./_parts/counts";

/** A stored quantity for display: "—" when it is not a finite number (Infinity arrives as JSON null), so one bad row cannot crash the screen. */
const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "raw" | "pack" | "finished" | "ledger" | "counts";
const TABS: readonly Tab[] = ["raw", "pack", "finished", "ledger", "counts"];

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
          <Btn variant="primary" type="submit" form="adjust-form" disabled={saving || notes.trim().length < 8}>{saving ? "…" : L("تسجيل التسوية", "Record adjustment")}</Btn>
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
        <Field label={`${L("سبب التسوية", "Reason for the adjustment")} *`} help={L("مطلوب، 8 أحرف على الأقل. يظهر في سجل الحركات مع اسمك.", "Required, at least 8 characters. Shown in the ledger with your name.")}>
          <textarea className="hr-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500}
            placeholder={L("مثال: فرق وزن بعد نقل الأكياس إلى الرف A2", "e.g. weight difference after moving the bags to shelf A2")} />
        </Field>
      </form>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const L = useL();
  const sp = useSearchParams();
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "receive");
  const canAdjust  = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");
  // Bean record edit / (de)activate / delete is catalogue maintenance: the receiving duty or adjust
  // (owner decision, inventory Option A). The count (a stock adjustment) stays adjust-only; a count
  // SHEET may be started and filled in by either duty, and only adjust posts it.
  const canMaintain = canReceive || canAdjust;

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const q = sp.get("tab");
    return (TABS as readonly string[]).includes(q ?? "") ? (q as Tab) : "raw";
  });
  const [countId, setCountId] = useState<string | null>(() => sp.get("count"));
  const [refreshKey, setRefreshKey] = useState(0);

  const [beans, setBeans]         = useState<GreenBean[] | null>(null);
  const [materials, setMaterials] = useState<Material[] | null>(null);

  const [search, setSearch]             = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  const [addOpen, setAddOpen]           = useState(false);
  const [editTarget, setEditTarget]     = useState<GreenBean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GreenBean | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<GreenBean | null>(null);
  const [materialFormOpen, setMaterialFormOpen] = useState(false);
  const [startCount, setStartCount] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  function showToast(msg: string, type: "ok" | "err") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  const loadBeans = useCallback(async () => {
    const res = await fetch("/api/green-beans?all=1");
    if (res.ok) setBeans(await res.json());
  }, []);
  const loadMaterials = useCallback(async () => {
    const res = await fetch("/api/materials?activeOnly=false");
    if (res.ok) setMaterials(await res.json());
  }, []);
  /** After any stock change: lists, metrics and recent movements reload. */
  const refreshAll = useCallback(() => { loadBeans(); loadMaterials(); setRefreshKey((k) => k + 1); }, [loadBeans, loadMaterials]);

  // First load: beans and materials (the count picker and both stock tabs use them), state set after the await.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [b, m] = await Promise.all([fetch("/api/green-beans?all=1"), fetch("/api/materials?activeOnly=false")]);
      const [bj, mj] = await Promise.all([b.ok ? b.json() : [], m.ok ? m.json() : []]);
      if (cancelled) return;
      setBeans(bj);
      setMaterials(mj);
    })();
    return () => { cancelled = true; };
  }, []);

  function openTab(tab: Tab) {
    setActiveTab(tab);
    if (tab !== "counts") setCountId(null);
  }

  // ── CRUD handlers (unchanged logic) ──────────────────────────────────────

  async function handleAdd(f: FormState) {
    setSaving(true);
    const res = await fetch("/api/green-beans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(j.error || "Failed to add bean", "err");
      return;
    }
    setAddOpen(false);
    refreshAll();
  }

  async function handleEdit(f: FormState) {
    if (!editTarget) return;
    setSaving(true);
    const res = await fetch(`/api/green-beans/${editTarget.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
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
    await fetch(`/api/green-beans/${bean.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !bean.isActive }) });
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

  const activeBeans = (beans ?? []).filter((b) => b.isActive);
  const activeMaterials = (materials ?? []).filter((m) => m.isActive);
  const loading = beans === null || materials === null;

  const headerAction = (
    <>
      {canMaintain ? (
        <Btn onClick={() => setStartCount(true)} data-testid="start-count"><CheckIcon />{L("إجراء جرد", "Start a count")}</Btn>
      ) : null}
      {activeTab === "pack" ? (
        <Btn variant="primary" onClick={() => setMaterialFormOpen(true)}><PlusIcon />{t("newMaterialBtn")}</Btn>
      ) : canReceive ? (
        <Btn variant="primary" onClick={() => setAddOpen(true)}><PlusIcon />{L("إضافة مخزون", "Add stock")}</Btn>
      ) : null}
    </>
  );

  return (
    <OpsRoot className="stk-inventory">
    <div className="hr-page">

      {addOpen && (
        <BeanForm title={t("registerNewStock")} initial={emptyForm()} onSave={handleAdd} onClose={() => setAddOpen(false)} saving={saving} />
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
        <DeleteConfirmModal bean={deleteTarget} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} deleting={deleting} />
      )}
      {adjustTarget && (
        <AdjustmentModal
          bean={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onSuccess={(noChange) => {
            showToast(noChange ? t("adjustNoChange") : t("adjustSuccess"), "ok");
            setAdjustTarget(null);
            refreshAll();
          }}
        />
      )}
      {materialFormOpen && (
        <MaterialForm
          onClose={() => setMaterialFormOpen(false)}
          onSaved={() => { setMaterialFormOpen(false); refreshAll(); }}
          onError={(m) => showToast(m, "err")}
        />
      )}
      {startCount && beans && materials && (
        <StartCountDialog
          beans={beans}
          materials={materials}
          defaultCategory={activeTab === "pack" ? "PACKAGING_MATERIAL" : "RAW_MATERIAL"}
          onClose={() => setStartCount(false)}
          onCreated={(id) => { setStartCount(false); setCountId(id); setActiveTab("counts"); }}
        />
      )}

      <PageHeader title={t("inventory")} actions={headerAction}>
        <span className="hr-caption">
          {lang === "ar"
            ? `${activeBeans.length} لوت بن أخضر · ${activeMaterials.length} مادة تعبئة`
            : `${activeBeans.length} green coffee lots · ${activeMaterials.length} packaging materials`}
        </span>
      </PageHeader>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

      {/* 251:2482: البن الأخضر · مواد التعبئة · المخزون التام · سجل الحركات · الجرد والتسويات */}
      <Tabs
        label={t("inventory")}
        value={activeTab}
        onChange={openTab}
        items={[
          { key: "raw", label: L("البن الأخضر", "Green coffee"), count: beans ? activeBeans.length : undefined },
          { key: "pack", label: t("tabMaterials"), count: materials ? activeMaterials.length : undefined },
          { key: "finished", label: t("finishedGoods") },
          { key: "ledger", label: t("movementLedger") },
          { key: "counts", label: L("الجرد والتسويات", "Counts and adjustments") },
        ]}
      />

      {loading && (activeTab === "raw" || activeTab === "pack") ? <OpsLoading /> : null}

      {activeTab === "raw" && beans ? (
        <GreenTab
          beans={beans} search={search} onSearch={setSearch} showInactive={showInactive} onToggleInactive={() => setShowInactive((p) => !p)}
          canAdjust={canAdjust} canMaintain={canMaintain} canReceive={canReceive}
          onCount={setAdjustTarget} onEdit={setEditTarget} onToggleActive={handleToggleActive} onDelete={setDeleteTarget}
          onOpenLedger={() => openTab("ledger")} refreshKey={refreshKey}
        />
      ) : null}
      {activeTab === "pack" && materials ? (
        <PackagingTab materials={materials} onChanged={refreshAll} onError={(m) => showToast(m, "err")} onOpenLedger={() => openTab("ledger")} refreshKey={refreshKey} />
      ) : null}
      {activeTab === "finished" ? <FinishedTab refreshKey={refreshKey} /> : null}
      {activeTab === "ledger" ? <LedgerTab refreshKey={refreshKey} /> : null}
      {activeTab === "counts" ? (
        <CountsTab openId={countId} onOpen={setCountId} canEdit={canMaintain} canPost={canAdjust} onStart={() => setStartCount(true)} onPosted={refreshAll} />
      ) : null}
    </div>
    </OpsRoot>
  );
}
