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
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Btn, Field, Notice, OpsBanner, OpsLoading, OpsRoot, PageHeader, Tabs, useL,
} from "@/components/ops/ui";
import { canEdit } from "@/lib/auth-shared";
import { SEED } from "@/lib/inventory/item-categories";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { CheckIcon, PlusIcon, type Material } from "../_components/stock-materials";
import { GreenTab, LOW_KG, type GreenBean } from "./_parts/green";
import { BeanForm, type FormState } from "./_parts/bean-form";
import { AddItemFlow, type CategoryNode } from "./_parts/add-item";
import { AllItemsView, CategoryChips, CategoryRail } from "./_parts/categories";
import { PackagingTab } from "./_parts/packaging";
import { FinishedTab } from "./_parts/finished";
import { LedgerTab } from "./_parts/ledger";
import { CountsTab, StartCountDialog } from "./_parts/counts";

/** A stored quantity for display: "—" when it is not a finite number (Infinity arrives as JSON null), so one bad row cannot crash the screen. */
const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

// ─── Views ────────────────────────────────────────────────────────────────────

/** Page-level views: the items (by category), the movement ledger and the counts. */
type View = "stock" | "ledger" | "counts";
/** The former tabs (?tab=…) still open where they used to: green → «بن أخضر», pack → «المحمصة» (its bags,
 *  labels and other supplies), finished → «المنتجات الجاهزة», ledger / counts → those views. */
const LEGACY_TAB: Record<string, { view: View; cat?: string }> = {
  raw: { view: "stock", cat: SEED.green }, pack: { view: "stock", cat: SEED.roastery }, finished: { view: "stock", cat: SEED.finished },
  ledger: { view: "ledger" }, counts: { view: "counts" },
};

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
      setError(localizeApiError(j) || t("adjustFailed"));
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
  // «إضافة صنف»: a green lot needs receive; a stock item needs inventory edit access (POST /api/materials).
  const canAdd = canReceive || (!!user && canEdit(user.permissions, "inventory"));

  const [view, setView] = useState<View>(() => {
    const legacy = LEGACY_TAB[sp.get("tab") ?? ""];
    const v = sp.get("view");
    if (v === "ledger" || v === "counts") return v;
    if (sp.get("count")) return "counts";
    return legacy?.view ?? "stock";
  });
  const [sel, setSel] = useState<string>(() => sp.get("cat") || LEGACY_TAB[sp.get("tab") ?? ""]?.cat || "all");
  const [countId, setCountId] = useState<string | null>(() => sp.get("count"));
  const [refreshKey, setRefreshKey] = useState(0);

  const [beans, setBeans]         = useState<GreenBean[] | null>(null);
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [categories, setCategories] = useState<CategoryNode[] | null>(null);

  const [search, setSearch]             = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  const [addOpen, setAddOpen]           = useState(false);
  const [editTarget, setEditTarget]     = useState<GreenBean | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GreenBean | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<GreenBean | null>(null);
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
  const loadCategories = useCallback(async () => {
    const res = await fetch("/api/inventory/categories");
    if (res.ok) setCategories(await res.json());
  }, []);
  /** After any stock change: lists, categories, metrics and recent movements reload. */
  const refreshAll = useCallback(() => { loadBeans(); loadMaterials(); loadCategories(); setRefreshKey((k) => k + 1); }, [loadBeans, loadMaterials, loadCategories]);

  // First load: beans, materials and the categories (state set after the await).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [b, m, c] = await Promise.all([fetch("/api/green-beans?all=1"), fetch("/api/materials?activeOnly=false"), fetch("/api/inventory/categories")]);
      const [bj, mj, cj] = await Promise.all([b.ok ? b.json() : [], m.ok ? m.json() : [], c.ok ? c.json() : []]);
      if (cancelled) return;
      setBeans(bj);
      setMaterials(mj);
      setCategories(cj);
    })();
    return () => { cancelled = true; };
  }, []);

  // The address follows the view and the category, so a link opens the same place.
  useEffect(() => {
    try {
      const p = new URLSearchParams();
      if (view !== "stock") p.set("view", view);
      if (sel !== "all") p.set("cat", sel);
      if (view === "counts" && countId) p.set("count", countId);
      const qs = p.toString();
      window.history.replaceState(window.history.state, "", qs ? `?${qs}` : window.location.pathname);
    } catch { /* the address is a convenience */ }
  }, [view, sel, countId]);

  function openView(v: View) {
    setView(v);
    if (v !== "counts") setCountId(null);
  }
  function openCategory(id: string) {
    setSel(id);
    setView("stock");
  }

  // ── CRUD handlers (unchanged logic) ──────────────────────────────────────

  async function handleEdit(f: FormState) {
    if (!editTarget) return;
    setSaving(true);
    const res = await fetch(`/api/green-beans/${editTarget.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(localizeApiError(j) || L("تعذّر تحديث البن.", "Failed to update bean"), "err");
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
      showToast(localizeApiError(j) || L("تعذّر الحذف.", "Delete failed"), "err");
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    loadBeans();
  }

  const activeBeans = (beans ?? []).filter((b) => b.isActive);
  const activeMaterials = (materials ?? []).filter((m) => m.isActive);
  const loading = beans === null || materials === null || categories === null;

  // ── The selected category ───────────────────────────────────────────────
  const cats = useMemo(() => categories ?? [], [categories]);
  const current = sel === "all" ? null : cats.find((c) => c.id === sel) ?? null;
  const subtree = useMemo(() => (current ? cats.filter((c) => c.id === current.id || c.parentId === current.id) : []), [cats, current]);
  const subtreeIds = useMemo(() => new Set(subtree.map((c) => c.id)), [subtree]);
  const scopedMaterials = useMemo(() => (materials ?? []).filter((m) => !!m.categoryId && subtreeIds.has(m.categoryId)), [materials, subtreeIds]);
  const greenLow = activeBeans.filter((b) => b.quantityKg > 0 && b.quantityKg < LOW_KG).length;
  const nameOf = (c: { nameAr: string; nameEn: string | null }) => (lang === "ar" ? c.nameAr : c.nameEn || c.nameAr);
  const isMaterialCat = (c: CategoryNode) => c.template === "PACKAGING" || c.template === "GENERAL";

  const headerAction = (
    <>
      <Link className="hr-btn is-ghost" href="/dashboard/inventory/categories" data-testid="inventory-categories-link">{L("التصنيفات", "Categories")}</Link>
      {canMaintain ? (
        <Btn onClick={() => setStartCount(true)} data-testid="start-count"><CheckIcon />{L("إجراء جرد", "Start a count")}</Btn>
      ) : null}
      {canAdd ? (
        <Btn variant="primary" onClick={() => setAddOpen(true)} disabled={!categories} data-testid="add-item"><PlusIcon />{L("إضافة صنف", "Add item")}</Btn>
      ) : null}
    </>
  );

  let content: React.ReactNode = null;
  if (loading) content = <OpsLoading />;
  else if (!current) {
    content = (
      <AllItemsView beans={beans!} materials={materials!} categories={cats} onOpenCategory={openCategory} />
    );
  } else if (current.template === "GREEN_COFFEE") {
    content = (
      <GreenTab
        beans={beans!} search={search} onSearch={setSearch} showInactive={showInactive} onToggleInactive={() => setShowInactive((p) => !p)}
        canAdjust={canAdjust} canMaintain={canMaintain} canReceive={canReceive}
        onCount={setAdjustTarget} onEdit={setEditTarget} onToggleActive={handleToggleActive} onDelete={setDeleteTarget}
        onOpenLedger={() => openView("ledger")} refreshKey={refreshKey}
      />
    );
  } else if (current.template === "ROASTED_COFFEE") {
    content = (
      <>
        <p className="inv-note">{L("يأتي من دفعات التحميص ويخرج عند التعبئة — لا يُضاف يدويًا.", "Comes from roasting batches and leaves when packed — never added by hand.")}</p>
        <FinishedTab refreshKey={refreshKey} part="roasted" />
      </>
    );
  } else if (current.template === "FINISHED") {
    content = (
      <>
        <p className="inv-note">{L("وحدات المنتجات الجاهزة تأتي من التعبئة والإنتاج؛ يُعرَّف المنتج في ", "Finished units come from packing and production; the product is set up under ")}<Link className="ops-link" href="/dashboard/products">{L("المنتجات", "Products")}</Link>.</p>
        <FinishedTab refreshKey={refreshKey} part="finished" />
      </>
    );
  } else {
    // A materials category, or a root: its items and its sub-categories' items.
    const others = !current.parentId ? cats.filter((c) => c.parentId === current.id && !isMaterialCat(c)) : [];
    const subMaterialCats = subtree.filter(isMaterialCat);
    content = (
      <>
        {others.length ? (
          <div className="inv-shortcuts">
            {others.map((c) => (
              <a key={c.id} href={`?cat=${c.id}`} onClick={(e) => { e.preventDefault(); openCategory(c.id); }} data-testid={`shortcut-${c.id}`}>
                {nameOf(c)} <span className="hr-num">{c.itemCount}</span>
              </a>
            ))}
          </div>
        ) : null}
        <PackagingTab
          materials={scopedMaterials} categories={cats} subCategories={!current.parentId ? subMaterialCats : undefined}
          packMetrics={current.inventoryRole === "INVENTORY_PACKAGING"} title={nameOf(current)} itemCategoryId={current.id}
          onChanged={refreshAll} onError={(m) => showToast(m, "err")} onOpenLedger={() => openView("ledger")} refreshKey={refreshKey}
        />
      </>
    );
  }

  const countMaterials = current && isMaterialCat(current) ? scopedMaterials : materials ?? [];

  return (
    <OpsRoot className="stk-inventory">
    <div className="hr-page">

      {addOpen && categories && (
        <AddItemFlow
          categories={categories}
          initialCategoryId={current && current.template !== "FINISHED" && current.template !== "ROASTED_COFFEE" ? current.id : null}
          canReceive={canReceive}
          onClose={() => setAddOpen(false)}
          onError={() => undefined /* shown inside the dialog */}
          onSaved={(msg) => { setAddOpen(false); showToast(msg, "ok"); refreshAll(); }}
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
      {startCount && beans && materials && (
        <StartCountDialog
          beans={beans}
          materials={countMaterials}
          defaultCategory={current && current.template !== "GREEN_COFFEE" && isMaterialCat(current) ? "PACKAGING_MATERIAL" : "RAW_MATERIAL"}
          onClose={() => setStartCount(false)}
          onCreated={(id) => { setStartCount(false); setCountId(id); setView("counts"); }}
        />
      )}

      <PageHeader title={t("inventory")} actions={headerAction}>
        <span className="hr-caption">
          {lang === "ar"
            ? `${activeBeans.length} لوت بن أخضر · ${activeMaterials.length} صنف`
            : `${activeBeans.length} green coffee lots · ${activeMaterials.length} items`}
        </span>
      </PageHeader>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}><span data-testid="inventory-toast">{toast.msg}</span></OpsBanner> : null}

      <Tabs
        label={t("inventory")}
        value={view}
        onChange={openView}
        items={[
          { key: "stock", label: L("الأصناف", "Items"), count: categories ? activeBeans.length + activeMaterials.length : undefined },
          { key: "ledger", label: t("movementLedger") },
          { key: "counts", label: L("الجرد والتسويات", "Counts and adjustments") },
        ]}
      />

      {view === "stock" ? (
        <div className="inv-layout">
          {categories ? <CategoryRail categories={cats} value={sel} onChange={openCategory} totalItems={activeBeans.length + activeMaterials.length} greenLow={greenLow} canManage={canMaintain} /> : <div />}
          <div className="inv-main hr-stack">
            {categories ? <CategoryChips categories={cats} value={sel} onChange={openCategory} totalItems={activeBeans.length + activeMaterials.length} greenLow={greenLow} /> : null}
            {content}
          </div>
        </div>
      ) : null}
      {view === "ledger" ? <LedgerTab refreshKey={refreshKey} itemCategories={cats} initialItemCategory={sel !== "all" ? sel : ""} /> : null}
      {view === "counts" ? (
        <CountsTab openId={countId} onOpen={setCountId} canEdit={canMaintain} canPost={canAdjust} onStart={() => setStartCount(true)} onPosted={refreshAll} />
      ) : null}
    </div>
    </OpsRoot>
  );
}
