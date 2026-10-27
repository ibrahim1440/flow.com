"use client";
// The smart «+ إضافة صنف» (unified inventory, phase 1). One button for every kind of stock:
//   1. pick a category (the ones used recently first);
//   2. the form of its template —
//      GREEN_COFFEE      the green-coffee lot form, unchanged (POST /api/green-beans), then «اطبع الملصق»;
//      PACKAGING/GENERAL the item form with the category preselected and its unit (POST /api/materials);
//      ROASTED/FINISHED  nothing to add here: a short explanation and the way to production / products.
// Underneath an item is still an ordinary stock record booked to its category's inventory account.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useState } from "react";
import Link from "next/link";
import { Btn, Notice, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { MaterialForm, type MaterialCategoryOption } from "../../_components/stock-materials";
import { BeanForm, emptyForm, type FormState } from "./bean-form";

export type CategoryNode = MaterialCategoryOption & { isSystem: boolean; sortOrder: number; itemCount: number; lowCount: number; archivedAt: string | null; updatedByName: string | null };

const RECENT_KEY = "hiqbah.inventory.recentCategories";

export function readRecent(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 3)));
  } catch {
    /* private window: no memory, still works */
  }
}

type SavedBean = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null; quantityKg: number };

export function AddItemFlow({ categories, initialCategoryId, canReceive, onClose, onSaved, onError }: {
  categories: CategoryNode[]; initialCategoryId?: string | null; canReceive: boolean;
  onClose: () => void; onSaved: (msg: string) => void; onError: (msg: string) => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const active = categories.filter((c) => c.isActive);
  const start = initialCategoryId ? active.find((c) => c.id === initialCategoryId) : undefined;
  const [picked, setPicked] = useState<CategoryNode | null>(start ?? null);
  const [savingBean, setSavingBean] = useState(false);
  const [beanError, setBeanError] = useState("");
  const [savedBean, setSavedBean] = useState<SavedBean | null>(null);
  const [recent] = useState<string[]>(() => (typeof window === "undefined" ? [] : readRecent()));
  const name = (c: { nameAr: string; nameEn: string | null }) => (lang === "ar" ? c.nameAr : c.nameEn || c.nameAr);
  // A short line on what follows (never the category's own name again).
  const HINT: Record<string, [string, string]> = {
    GREEN_COFFEE: ["بيانات البن الكاملة + ملصق", "Full bean details + label"],
    PACKAGING: ["يُستهلك في التعبئة", "Used up in packing"],
    GENERAL: ["مخزون عام", "General stock"],
    ROASTED_COFFEE: ["يأتي من الإنتاج", "Comes from production"],
    FINISHED: ["يأتي من الإنتاج", "Comes from production"],
  };
  const hint = (c: CategoryNode) => {
    const t = HINT[c.template];
    return t ? (lang === "ar" ? t[0] : t[1]) : "";
  };
  const viewOnly = (c: CategoryNode) => c.template === "ROASTED_COFFEE" || c.template === "FINISHED";
  const roots = active.filter((c) => !c.parentId);
  const recentCats = recent.map((id) => active.find((c) => c.id === id)).filter((c): c is CategoryNode => !!c);
  const path = (c: CategoryNode) => {
    const p = c.parentId ? active.find((x) => x.id === c.parentId) : undefined;
    return p ? `${name(p)} › ${name(c)}` : name(c);
  };

  function choose(c: CategoryNode) {
    setPicked(c);
  }

  async function saveBean(f: FormState) {
    setSavingBean(true);
    const res = await fetch("/api/green-beans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
    setSavingBean(false);
    if (!res.ok) {
      const msg = localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّرت إضافة البن.", "Failed to add bean");
      setBeanError(msg);
      onError(msg);
      return;
    }
    if (picked) pushRecent(picked.id);
    setSavedBean(await res.json());
  }

  // ── Step 3 (green): the lot is saved — offer its label ─────────────────────
  if (savedBean) {
    const beanName = lang === "ar" && savedBean.beanTypeAr ? savedBean.beanTypeAr : savedBean.beanType;
    const q = encodeURIComponent(savedBean.beanType || savedBean.country);
    return (
      <Dialog open title={L("أُضيف اللوت", "Lot added")} sub={<><span>{beanName}</span> · <span className="hr-id">{savedBean.serialNumber}</span></>}
        onClose={() => { onSaved(L("أُضيف لوت البن الأخضر.", "Green coffee lot added.")); }}
        actions={<>
          <Link className="hr-btn is-primary" href={`/dashboard/labels?q=${q}&lot=${encodeURIComponent(savedBean.serialNumber)}`} data-testid="add-print-label">{L("اطبع الملصق", "Print label")}</Link>
          <Btn onClick={() => onSaved(L("أُضيف لوت البن الأخضر.", "Green coffee lot added."))} data-testid="add-done">{L("إغلاق", "Close")}</Btn>
        </>}>
        <div data-testid="add-label-prompt" className="hr-stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>{L(`سُجّل ${savedBean.quantityKg} كغ في «بن أخضر».`, `${savedBean.quantityKg} kg recorded under «Green coffee».`)}</p>
          <p className="hr-caption" style={{ margin: 0 }}>{L("ملصقات الأصل تُطبع من صفحة الملصقات لمنتج القهوة المرتبط بهذا البن؛ تفتح الصفحة والبحث جاهز باسم البن.", "Origin labels print from the Labels page for the coffee product of this bean; the page opens with the bean's name already searched.")}</p>
        </div>
      </Dialog>
    );
  }

  // ── Step 2: the form of the category's template ─────────────────────────────
  if (picked) {
    const back = () => setPicked(null);
    if (picked.template === "GREEN_COFFEE") {
      if (!canReceive) {
        return (
          <Dialog open title={path(picked)} onClose={onClose} actions={<><Btn onClick={back}>{L("رجوع", "Back")}</Btn><Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn></>}>
            <Notice tone="info">{L("إضافة البن الأخضر تحتاج صلاحية الاستلام (المخزون › استلام).", "Adding green coffee needs the receiving permission (Inventory › Receive).")}</Notice>
          </Dialog>
        );
      }
      return (
        <BeanForm title={L("إضافة بن أخضر", "Add green coffee")} initial={emptyForm()} onSave={saveBean} onClose={onClose} saving={savingBean} error={beanError} />
      );
    }
    if (picked.template === "ROASTED_COFFEE" || picked.template === "FINISHED") {
      const roasted = picked.template === "ROASTED_COFFEE";
      return (
        <Dialog open title={path(picked)} onClose={onClose}
          actions={<><Btn onClick={back}>{L("رجوع", "Back")}</Btn><Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn></>}>
          <div data-testid="add-view-only" className="hr-stack" style={{ gap: 10 }}>
            <p style={{ margin: 0 }}>
              {roasted
                ? L("البن المحمص لا يُضاف يدويًا: يدخل المخزون من دفعات التحميص بعد قرار الجودة، ويخرج عند التعبئة.", "Roasted coffee is not added by hand: it enters stock from roasting batches after the QC decision, and leaves when it is packed.")
                : L("المنتجات الجاهزة لا تُضاف يدويًا: وحداتها تأتي من التعبئة والإنتاج، ويُعرَّف المنتج نفسه (الصنف والوزن والمكوّنات) في «المنتجات».", "Finished products are not added by hand: their units come from packing and production, and the product itself (SKU, weight, components) is set up under «Products».")}
            </p>
            <p style={{ margin: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {roasted ? <Link className="hr-btn is-sm" href="/dashboard/production">{L("الإنتاج", "Production")}</Link> : null}
              <Link className="hr-btn is-sm" href="/dashboard/products">{L("المنتجات", "Products")}</Link>
            </p>
          </div>
        </Dialog>
      );
    }
    return (
      <MaterialForm category={picked} categories={active} onBack={back} onClose={onClose}
        onError={() => undefined /* shown inside the form */}
        onSaved={(m) => { pushRecent(picked.id); onSaved(lang === "ar" ? `أُضيف الصنف «${m.nameAr ?? m.name}».` : `Item «${m.name}» added.`); }} />
    );
  }

  // ── Step 1: the category ──────────────────────────────────────────────────
  // Roasted and finished stock come from production: shown, not pickable.
  const option = (c: CategoryNode, label?: string, minor?: boolean) => (
    <button key={`${label ?? ""}${c.id}`} type="button" className={`inv-pick${minor ? " is-minor" : ""}`} disabled={viewOnly(c)}
      aria-disabled={viewOnly(c) || undefined} onClick={() => choose(c)} data-testid={`pick-${c.id}`}>
      <span className="inv-pick-name">{label ?? name(c)}</span>
      <span className="inv-pick-hint">{hint(c)}</span>
    </button>
  );
  return (
    <Dialog open title={L("إضافة صنف", "Add item")} sub={L("اختر التصنيف أولًا، ثم يظهر النموذج المناسب له.", "Choose the category first; the right form follows.")} className="stk-wide" onClose={onClose}
      actions={<Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>}>
      <div className="inv-picker" data-testid="add-category-picker">
        {recentCats.length ? (
          <section>
            <h3 className="inv-pick-head">{L("المستخدمة مؤخرًا", "Used recently")}</h3>
            <div className="inv-pick-grid">{recentCats.map((c) => option(c, path(c)))}</div>
          </section>
        ) : null}
        {roots.map((r) => {
          const kids = active.filter((c) => c.parentId === r.id);
          const selectable = [...(r.template === "PACKAGING" || r.template === "GENERAL" ? [] : [r]), ...kids];
          return (
            <section key={r.id}>
              <h3 className="inv-pick-head">{name(r)}</h3>
              <div className="inv-pick-grid">
                {selectable.map((c) => option(c))}
                {r.template === "PACKAGING" || r.template === "GENERAL" ? option(r, L(`${name(r)} (عام)`, `${name(r)} (general)`), true) : null}
              </div>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
