"use client";
// Packaging materials (MaterialItem) — Direction 2.1 (Figma 253:2987 «مواد التعبئة», 270:6058).
//
// The ONE place packaging materials are entered (small-fixes batch): the «مواد التعبئة» tab of
// Inventory, on the inventory ledger. The products screens (product page, add product) show a
// material's stock read only and link here. Requests, permission gates and validation: receive = inventory › receive (POST /api/materials/:id/receive), count =
// inventory › adjust (PATCH /api/materials/:id, reason required), create = POST /api/materials.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { Btn, Field, Notice, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { unitWord } from "../inventory/_parts/shared";
import { canEdit, hasSubPrivilege } from "@/lib/auth-shared";
import { PrintLabelButton } from "@/components/print/QuickPrint";
import { ScanInput, lookupScanCode } from "@/components/scan/ScanInput";
import { OpeningSiteField, SiteReorderEditor } from "../inventory/_parts/locations";

export type Material = {
  id: string;
  code: string;
  name: string;
  nameAr?: string | null;
  category: string;
  unitOfMeasure: string;
  quantityOnHand: number;
  reorderPoint: number;
  isActive: boolean;
  usedInProductCount: number;
  belowReorderPoint: boolean;
  /** The item category (unified inventory, 20261112090000_item_categories). */
  categoryId?: string | null;
  /** The shelf label's barcode payload «MT-00007» (20261114090000_green_lot_labels). */
  labelCode?: string;
};

const CATEGORY_AR: Record<string, string> = { PACKAGING: "تعبئة", LABEL: "ملصق", CONSUMABLE: "مستهلك", OTHER: "أخرى" };

export function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}
export function PlusIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
}

export function MaterialsPanel({
  materials,
  search,
  onChanged,
  onError,
  categories,
  showUsage = true,
  site,
  receiveSite,
  whereOf,
}: {
  materials: Material[];
  search?: React.ReactNode;
  onChanged: () => void;
  onError: (m: string) => void;
  /** The item categories: the category column names them, and «نقل» moves an item between them. */
  categories?: MaterialCategoryOption[];
  /** The «مستخدم في» (BOM usage) column — meaningful for packaging only; hidden for general / café stock. */
  showUsage?: boolean;
  /** Phase 3 (stock locations): the location a receipt / a count here is booked at, and its balance of an item. */
  site?: { id: string; name: string; qtyOf: (id: string) => number };
  /** Phase 3: where a receipt here goes when it differs from the count site (unfiltered: the default receiving site). */
  receiveSite?: { id: string; name: string };
  /** Phase 3: where an item's balance is (the per-location breakdown under its name). */
  whereOf?: (id: string) => React.ReactNode;
}) {
  const { t, lang } = useI18n();
  const recvSite = receiveSite ?? site;
  const L = useL();
  const user = useUser();
  // A count changes the on-hand quantity: an inventory adjustment (privileged, SOD.md §20). Offered
  // only to inventory › adjust holders; the server enforces it (verified individual + step-up).
  const canCount = hasSubPrivilege(user?.permissions ?? {}, "inventory", "adjust");
  // Receiving a delivery only ADDS stock: the routine receiving duty (PIN-only staff), audited
  // (review P2-4). POST /api/materials/:id/receive.
  const canReceive = hasSubPrivilege(user?.permissions ?? {}, "inventory", "receive");
  const [receiving, setReceiving] = useState<Material | null>(null);
  const [rqty, setRqty] = useState("");
  const [rref, setRref] = useState("");
  const [adjusting, setAdjusting] = useState<Material | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  // Moving an item to another category (PATCH categoryId). Within one inventory account always; to another
  // account only while it has no stock or cost — the server refuses otherwise and the reason shows here.
  const canMove = !!categories && canEdit(user?.permissions ?? {}, "inventory");
  const [moving, setMoving] = useState<Material | null>(null);
  // «حدود المواقع» (20261117090000): the item's reorder point per location, in its settings.
  const [sitePoints, setSitePoints] = useState<Material | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveError, setMoveError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);

  async function saveMove(m: Material) {
    setMoveBusy(true);
    setMoveError("");
    const res = await fetch(`/api/materials/${m.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryId: moveTo }) });
    setMoveBusy(false);
    if (!res.ok) {
      setMoveError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّر نقل الصنف.", "Could not move the item."));
      return;
    }
    setMoving(null);
    onChanged();
  }

  async function saveCount(m: Material) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      onError(L("الكمية المعدودة يجب ألا تكون سالبة.", "Counted quantity must be zero or more."));
      return;
    }
    const res = await fetch(`/api/materials/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // The reason is required (it is the only document behind a count).
      body: JSON.stringify({ newActualQuantity: n, reason: reason.trim(), ...(site ? { locationId: site.id } : {}) }),
    });
    if (!res.ok) onError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّرت تسوية المخزون.", "Failed to adjust stock."));
    setAdjusting(null);
    setValue("");
    setReason("");
    onChanged();
  }

  async function saveReceipt(m: Material) {
    const n = Number(rqty);
    if (!Number.isFinite(n) || n <= 0) {
      onError(L("الكمية المستلمة يجب أن تكون أكبر من صفر.", "Received quantity must be greater than zero."));
      return;
    }
    const res = await fetch(`/api/materials/${m.id}/receive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: n, reference: rref.trim(), ...(recvSite ? { locationId: recvSite.id } : {}) }),
    });
    if (!res.ok) onError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّر استلام المخزون.", "Failed to receive stock."));
    setReceiving(null);
    setRqty("");
    setRref("");
    onChanged();
  }

  const low = materials.filter((m) => m.belowReorderPoint).length;
  const legacyCat = (c: string) => (lang === "ar" ? CATEGORY_AR[c] ?? c : c.charAt(0) + c.slice(1).toLowerCase());
  const catOf = (m: Material) => (categories && m.categoryId ? categoryPath(categories.find((c) => c.id === m.categoryId), categories, lang) : legacyCat(m.category));
  const moveOptions = (categories ?? []).filter((c) => c.isActive && (c.template === "PACKAGING" || c.template === "GENERAL"));
  const used = (n: number) => (n === 0 ? L("غير مستخدمة", "Not used") : lang === "ar" ? (n === 1 ? "منتج واحد" : `${n} منتجات`) : `${n} ${n === 1 ? "product" : "products"}`);
  const systemQty = (m: Material) => (site ? site.qtyOf(m.id) : m.quantityOnHand);
  const delta = adjusting ? Number(value) - systemQty(adjusting) : NaN;

  // Receiving by scan: the shelf label's barcode opens that item's receipt (20261114090000_green_lot_labels).
  async function scanReceive(code: string) {
    const r = await lookupScanCode<{ id: string; name: string; nameAr: string | null; itemCode: string; unit: string; quantityOnHand: number; isActive: boolean; categoryId: string | null; code: string }>(code, lang, { only: "MATERIAL" });
    if (!r.ok) return { tone: "danger" as const, text: r.message };
    const h = r.hit;
    if (!h.isActive) return { tone: "danger" as const, text: L(`الصنف ${h.itemCode} غير نشط — لا يُستلم عليه.`, `Item ${h.itemCode} is inactive — nothing is received on it.`) };
    const m = materials.find((x) => x.id === h.id) ?? { id: h.id, code: h.itemCode, name: h.name, nameAr: h.nameAr, category: "", unitOfMeasure: h.unit, quantityOnHand: h.quantityOnHand, reorderPoint: 0, isActive: true, usedInProductCount: 0, belowReorderPoint: false, categoryId: h.categoryId, labelCode: h.code };
    setAdjusting(null); setReceiving(m); setRqty(""); setRref("");
    return { tone: "success" as const, text: L(`استلام: ${h.nameAr ?? h.name} · ${h.itemCode}`, `Receiving: ${h.name} · ${h.itemCode}`) };
  }

  return (
    <>
      {search}
      {canReceive ? <ScanInput testId="material-scan" compact onCode={scanReceive} placeholder={L("امسح ملصق الرف لاستلام الصنف", "Scan a shelf label to receive the item")} /> : null}
      {materials.length === 0 ? (
        <div className="hr-state"><h3>{t("noMaterialsYet")}</h3></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={t("tabMaterials")}>
            <thead>
              <tr>
                <th>{L("المادة", "Material")}</th>
                <th>{categories ? L("التصنيف", "Category") : t("categoryLabel")}</th>
                <th className="num">{t("onHandLabel")}</th>
                <th className="num">{t("reorderPointLabel")}</th>
                {showUsage ? <th className="hr-hide-compact">{t("usedInLabel")}</th> : null}
                <th aria-label={L("التنبيه", "Flag")} />
                <th aria-label={t("actions")} />
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} className={m.isActive ? undefined : "is-inactive"}>
                  <td className="m-title">
                    <span className="strong">{lang === "ar" && m.nameAr ? m.nameAr : m.name}</span>
                    <span className="stk-sub hr-id hr-desktop-only">{m.code}</span>
                    <span className="hr-msub">
                      <span className="hr-id">{m.code}</span> · {catOf(m)} · {t("onHandLabel")} <span className="hr-num">{m.quantityOnHand}</span>
                    </span>
                    {whereOf ? whereOf(m.id) : null}
                  </td>
                  <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{catOf(m)}</td>
                  <td className={`num${m.belowReorderPoint ? " is-low" : ""}`}><span className="hr-num">{m.quantityOnHand}</span> <span className="hr-caption">{unitWord(m.unitOfMeasure, lang, m.quantityOnHand)}</span></td>
                  <td className="num"><span className="hr-num">{m.reorderPoint || "—"}</span></td>
                  {showUsage ? <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{used(m.usedInProductCount)}</td> : null}
                  <td className="m-end" style={{ textAlign: "end" }}>
                    {m.belowReorderPoint ? <span className="stk-flag">{t("lowStockLabel")}</span> : null}
                  </td>
                  <td className="stk-acts stk-macts">
                    <PrintLabelButton template="MATERIAL_SHELF" variant="ghost" iconOnly label={L("ملصق رف", "Shelf label")} testId={`material-print-${m.code}`}
                      subtitle={`${lang === "ar" && m.nameAr ? m.nameAr : m.name} · ${m.code}`}
                      items={[{ kind: "material", materialId: m.id, label: `${lang === "ar" && m.nameAr ? m.nameAr : m.name} · ${m.code}` }]} />
                    {canReceive && m.isActive && (
                      <Btn size="sm" data-testid="material-receive"
                        onClick={() => { setAdjusting(null); setReceiving(m); setRqty(""); setRref(""); }}>
                        {t("receiveStockLabel")}
                      </Btn>
                    )}
                    {canMove && (
                      <Btn size="sm" variant="ghost" data-testid="material-site-points" onClick={() => setSitePoints(m)}>
                        {L("حدود المواقع", "Site points")}
                      </Btn>
                    )}
                    {canMove && (
                      <Btn size="sm" variant="ghost" data-testid="material-move"
                        onClick={() => { setMoving(m); setMoveTo(m.categoryId ?? ""); setMoveError(""); }}>
                        {L("نقل", "Move")}
                      </Btn>
                    )}
                    {canCount && (
                      <Btn size="sm" variant="ghost" title={t("adjustStockLabel")}
                        onClick={() => { setReceiving(null); setAdjusting(m); setValue(String(systemQty(m))); setReason(""); }}>
                        <CheckIcon />{L("جرد", "Count")}
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  {lang === "ar" ? `${materials.length} مواد · ${low} تحت حد إعادة الطلب` : `${materials.length} materials · ${low} below reorder point`}
                </td>
                <td colSpan={showUsage ? 5 : 4} style={{ textAlign: "end", fontSize: 12 }}>
                  {L("يزيد الرصيد بالاستلام أو الشراء · ويُصحَّح بالجرد", "Stock is added by a receipt or a purchase · corrected by a count")}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <Dialog
        open={!!sitePoints}
        title={L("حد إعادة الطلب في كل موقع", "Reorder point per location")}
        sub={sitePoints ? <><span>{lang === "ar" && sitePoints.nameAr ? sitePoints.nameAr : sitePoints.name}</span> · <span className="hr-id">{sitePoints.code}</span> · {L("حد الشركة", "Company point")} <span className="hr-num">{sitePoints.reorderPoint || "—"}</span></> : undefined}
        onClose={() => setSitePoints(null)}
        actions={<Btn onClick={() => setSitePoints(null)}>{L("إغلاق", "Close")}</Btn>}
      >
        {sitePoints ? <SiteReorderEditor itemKind="MATERIAL" entityId={sitePoints.id} unit={unitWord(sitePoints.unitOfMeasure, lang, 2)} canEdit={canMove} /> : null}
      </Dialog>

      <Dialog
        open={!!moving}
        title={L("نقل إلى تصنيف آخر", "Move to another category")}
        sub={moving ? <><span>{lang === "ar" && moving.nameAr ? moving.nameAr : moving.name}</span> · <span className="hr-id">{moving.code}</span></> : undefined}
        onClose={() => setMoving(null)}
        actions={moving ? (
          <>
            <Btn variant="primary" busy={moveBusy} disabled={!moveTo || moveTo === moving.categoryId} onClick={() => saveMove(moving)} data-testid="material-move-save">{L("نقل الصنف", "Move item")}</Btn>
            <Btn onClick={() => setMoving(null)}>{t("cancel")}</Btn>
          </>
        ) : undefined}
      >
        {moveError ? <Notice tone="danger"><span data-testid="move-refusal">{moveError}</span></Notice> : null}
        <Field label={L("التصنيف الجديد", "New category")} help={L("النقل بين تصنيفين على حساب مخزون مختلف يحتاج تحويل مخزون إن كان للصنف رصيد أو تكلفة.", "Moving between categories booked to different inventory accounts needs a stock transfer once the item has stock or cost.")}>
          <Select className="hr-select" data-testid="material-move-to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {moveOptions.map((c) => <option key={c.id} value={c.id}>{categoryPath(c, categories ?? [], lang)}</option>)}
          </Select>
        </Field>
      </Dialog>

      <Dialog
        open={!!receiving}
        title={t("receiveStockLabel")}
        sub={receiving ? <><span>{lang === "ar" && receiving.nameAr ? receiving.nameAr : receiving.name}</span> · <span className="hr-id">{receiving.code}</span></> : undefined}
        onClose={() => { setReceiving(null); setRqty(""); setRref(""); }}
        actions={receiving ? (
          <>
            <Btn variant="primary" disabled={!(Number(rqty) > 0) || rref.trim().length === 0} onClick={() => saveReceipt(receiving)}>{t("receiveStockLabel")}</Btn>
            <Btn onClick={() => { setReceiving(null); setRqty(""); setRref(""); }}>{t("cancel")}</Btn>
          </>
        ) : undefined}
      >
        {recvSite ? <p className="hr-caption" style={{ margin: 0 }} data-testid="material-receive-site">{L("موقع الاستلام", "Receiving location")}: <span className="strong">{recvSite.name}</span></p> : null}
        <div className="hr-form">
          <Field label={t("receivedQtyLabel")}>
            <input className="hr-input" data-testid="material-receive-qty" type="number" min={0} value={rqty}
              onChange={(e) => setRqty(e.target.value)} placeholder={t("receivedQtyLabel")} />
          </Field>
          <Field label={t("receiveRefLabel")}>
            <input className="hr-input" data-testid="material-receive-ref" value={rref} maxLength={120}
              onChange={(e) => setRref(e.target.value)} placeholder={t("receiveRefLabel")} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!adjusting}
        title={L("جرد وتسوية المخزون", "Count and adjust stock")}
        sub={adjusting ? <><span>{lang === "ar" && adjusting.nameAr ? adjusting.nameAr : adjusting.name}</span> · <span className="hr-id">{adjusting.code}</span></> : undefined}
        onClose={() => { setAdjusting(null); setValue(""); setReason(""); }}
        actions={adjusting ? (
          <>
            <Btn variant="primary" disabled={reason.trim().length < 8} onClick={() => saveCount(adjusting)}>{L("تسجيل التسوية", "Record adjustment")}</Btn>
            <Btn onClick={() => { setAdjusting(null); setValue(""); setReason(""); }}>{t("cancel")}</Btn>
          </>
        ) : undefined}
      >
        {adjusting ? (
          <>
            <div className="hr-form">
              <Field label={site ? `${L("الكمية في النظام", "System quantity")} · ${site.name}` : L("الكمية في النظام", "System quantity")}>
                <input className="hr-input" value={systemQty(adjusting)} disabled readOnly />
              </Field>
              <Field label={t("adjustStockLabel")}>
                <input className="hr-input" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("adjustStockLabel")} />
              </Field>
            </div>
            {Number.isFinite(delta) && value !== "" ? (
              <div className={`stk-diff${delta < 0 ? " tone-danger" : delta > 0 ? " tone-success" : ""}`}>
                <span>{L("الفارق", "Difference")}</span>
                <strong>{delta === 0 ? L("لا تغيير", "No change") : `${delta > 0 ? "+" : ""}${delta}`}</strong>
              </div>
            ) : null}
            <Field label={t("countReasonLabel")} help={L("مطلوب، 8 أحرف على الأقل.", "Required, at least 8 characters.")}>
              <input className="hr-input" data-testid="material-count-reason" value={reason} maxLength={500}
                onChange={(e) => setReason(e.target.value)} placeholder={t("countReasonLabel")} />
            </Field>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

/** An item category a material can be created in or moved to (GET /api/inventory/categories). */
export type MaterialCategoryOption = { id: string; nameAr: string; nameEn: string | null; parentId: string | null; template: string; defaultUnit: string; inventoryRole: string; isActive: boolean };

const UNIT_OPTIONS: [string, string, string][] = [["PIECE", "قطعة", "Piece"], ["UNIT", "وحدة", "Unit"], ["KG", "كيلوغرام", "Kilogram"], ["GRAM", "غرام", "Gram"], ["LITER", "لتر", "Litre"]];

/** «الأب › الابن» in the viewer's language. */
export function categoryPath(c: MaterialCategoryOption | undefined, all: MaterialCategoryOption[], lang: "ar" | "en"): string {
  if (!c) return "—";
  const name = (x: MaterialCategoryOption) => (lang === "ar" ? x.nameAr : x.nameEn || x.nameAr);
  const p = c.parentId ? all.find((x) => x.id === c.parentId) : undefined;
  return p ? `${name(p)} › ${name(c)}` : name(c);
}

/**
 * New stock item (MaterialItem) in an item category — the PACKAGING / GENERAL step of the smart «إضافة صنف»
 * flow. The category arrives preselected (and may be changed among the categories that hold such items); the
 * unit defaults to the category's. Plain names first: the Arabic name is required, the English one and the code
 * are optional (a code is generated). POST /api/materials with categoryId.
 */
export function MaterialForm({ category, categories, onClose, onSaved, onError, onBack, noOpening }: {
  category: MaterialCategoryOption; categories: MaterialCategoryOption[];
  onClose: () => void; onSaved: (m: { id: string; name: string; nameAr: string | null; unitOfMeasure?: string; categoryId?: string | null; code?: string }) => void; onError: (m: string) => void; onBack?: () => void;
  /** The purchase invoice's «صنف جديد»: created at zero — the invoice line receives the quantity. */
  noOpening?: boolean;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const user = useUser();
  const canReceive = hasSubPrivilege(user?.permissions ?? {}, "inventory", "receive");
  const options = categories.filter((c) => c.isActive && (c.template === "PACKAGING" || c.template === "GENERAL"));
  const [form, setForm] = useState({ categoryId: category.id, nameAr: "", nameEn: "", code: "", unitOfMeasure: category.defaultUnit || "PIECE", quantityOnHand: "0", reorderPoint: "0", locationId: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const chosen = options.find((c) => c.id === form.categoryId) ?? category;

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categoryId: form.categoryId,
          code: form.code.trim() || undefined,
          name: form.nameEn.trim() || form.nameAr.trim(),
          nameAr: form.nameAr.trim() || null,
          unitOfMeasure: form.unitOfMeasure,
          quantityOnHand: noOpening ? 0 : Number(form.quantityOnHand),
          ...(!noOpening && Number(form.quantityOnHand) > 0 && form.locationId ? { locationId: form.locationId } : {}),
          reorderPoint: Number(form.reorderPoint),
        }),
      });
      if (!res.ok) {
        const msg = localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّر إنشاء الصنف.", "Could not create the item.");
        setError(msg);
        onError(msg);
        return;
      }
      onSaved(await res.json());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={L("صنف جديد", "New item")}
      sub={categoryPath(chosen, categories, lang)}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={saving} disabled={!form.nameAr.trim()} onClick={submit} data-testid="item-save">{L("حفظ الصنف", "Save item")}</Btn>
          {onBack ? <Btn onClick={onBack}>{L("رجوع", "Back")}</Btn> : null}
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="hr-form" data-testid="material-form">
        <Field label={`${L("اسم الصنف", "Arabic name")} *`} wide>
          <input className="hr-input" dir="rtl" data-testid="item-name-ar" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} placeholder={L("مثال: حليب كامل الدسم", "e.g. حليب كامل الدسم")} />
        </Field>
        <Field label={L("الاسم بالإنجليزية", "English name")} help={L("اختياري", "Optional")}>
          <input className="hr-input" dir="ltr" data-testid="item-name-en" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} placeholder="Full-fat milk" />
        </Field>
        <Field label={t("categoryLabel")}>
          <Select className="hr-select" data-testid="item-category" value={form.categoryId}
            onChange={(e) => { const c = options.find((x) => x.id === e.target.value); setForm({ ...form, categoryId: e.target.value, unitOfMeasure: c?.defaultUnit || form.unitOfMeasure }); }}>
            {options.map((c) => <option key={c.id} value={c.id}>{categoryPath(c, categories, lang)}</option>)}
          </Select>
        </Field>
        <Field label={L("وحدة القياس", "Unit")}>
          <Select className="hr-select" data-testid="item-unit" value={form.unitOfMeasure} onChange={(e) => setForm({ ...form, unitOfMeasure: e.target.value })}>
            {UNIT_OPTIONS.map(([v, ar, en]) => <option key={v} value={v}>{lang === "ar" ? ar : en}</option>)}
          </Select>
        </Field>
        {noOpening ? null : <Field label={t("onHandLabel")} help={canReceive ? L("رصيد افتتاحي يُسجَّل كاستلام", "An opening balance, recorded as a receipt") : L("ابدأ بصفر واستلم التوريد لاحقًا", "Start at zero and receive the delivery later")}>
          <input className="hr-input" type="number" min={0} step="any" data-testid="item-qty" value={form.quantityOnHand} disabled={!canReceive} onChange={(e) => setForm({ ...form, quantityOnHand: e.target.value })} />
        </Field>}
        {noOpening || !canReceive ? null : <OpeningSiteField qty={Number(form.quantityOnHand)} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} />}
        <Field label={t("reorderPointLabel")}>
          <input className="hr-input" type="number" min={0} step="any" value={form.reorderPoint} onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })} />
        </Field>
        <Field label={L("الرمز", "Code")} help={L("اختياري — يُولَّد تلقائيًا", "Optional — generated if left empty")}>
          <input className="hr-input" dir="ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="MILK-1L" />
        </Field>
      </div>
    </Dialog>
  );
}
