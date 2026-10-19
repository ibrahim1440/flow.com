"use client";
// Product catalog — shared pieces of the Products screens (Figma 216:2: 256:3410 all products,
// 258:3751 categories, 276:4776 add category, 260:4107 add product, 262:4570 product page).
// Requests go to the catalog API (src/app/api/categories, src/app/api/coffee-products); the
// server checks every write on the `inventory` module, the screens only hide what a viewer
// cannot do.
import { Select } from "@/components/ui/Select";
import { useEffect, useState } from "react";
import { Btn, Field, Notice, OpsLoading, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { canEdit } from "@/lib/auth-shared";
import { useUser } from "../../user-context";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CategoryRef = { id: string; nameAr: string; nameEn: string | null; isActive: boolean };
export type Category = CategoryRef & {
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedByName: string | null;
  productCount: number;
  activeProductCount: number;
  skuCount: number;
  freeUnits: number;
};
export type CategoryList = { items: Category[]; uncategorised: { productCount: number; skuCount: number } };

export type ProductRow = {
  id: string;
  productNameAr: string | null;
  productNameEn: string;
  countryEn: string; countryAr: string | null;
  regionEn: string | null; regionAr: string | null;
  processEn: string | null; processAr: string | null;
  isActive: boolean;
  category: CategoryRef | null;
  skus: { id: string; skuCode: string; weightGrams: number; packSize: string; price: number; isActive: boolean; barcode: string | null }[];
  priceMin: number | null;
  priceMax: number | null;
  freeUnits: number;
  everProduced: boolean;
};
export type ProductPage = {
  items: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: { skuCount: number; activeProductCount: number; freeUnits: number };
};

export type Material = { id: string; code: string; name: string; nameAr?: string | null; quantityOnHand: number; isActive: boolean; unitOfMeasure: string };
export type Coffee = { id: string; productNameEn: string; productNameAr: string | null };

// ─── Helpers ─────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message: string, public status: number, public field?: string) {
    super(message);
  }
}

/** JSON request; a non-2xx answer throws its `error` text. */
export async function api<T>(url: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; field?: string };
    throw new ApiError(b.error ?? `Request failed (${res.status}).`, res.status, b.field);
  }
  return body as T;
}

export function useCanEditCatalog(): boolean {
  const user = useUser();
  return canEdit(user?.permissions ?? {}, "inventory");
}

/** The product's name line: Arabic, falling back to English (D3: never a blank row). */
export function pName(p: { productNameAr: string | null; productNameEn: string }, lang: "ar" | "en"): string {
  return lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn;
}

export function catName(c: { nameAr: string; nameEn: string | null }, lang: "ar" | "en"): string {
  return lang === "ar" ? c.nameAr : c.nameEn || c.nameAr;
}

/** «إثيوبيا · قوجي · مغسولة». */
export function originLine(p: Pick<ProductRow, "countryEn" | "countryAr" | "regionEn" | "regionAr" | "processEn" | "processAr">, lang: "ar" | "en"): string {
  const pick = (ar: string | null, en: string | null) => (lang === "ar" ? ar || en : en || ar);
  return [pick(p.countryAr, p.countryEn), pick(p.regionAr, p.regionEn), pick(p.processAr, p.processEn)].filter(Boolean).join(" · ");
}

export const money2 = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «46.00–165.00» or «48.00». */
export function priceRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—";
  return min === max ? money2(min) : `${money2(min)}–${money2(max)}`;
}

/** «250 غ» / «1 كغ» in Arabic; «250 g» / «1 kg» in English. */
export function packLabel(weightGrams: number, lang: "ar" | "en"): string {
  if (weightGrams >= 1000) return `${Number((weightGrams / 1000).toFixed(3)).toLocaleString("en-US")} ${lang === "ar" ? "كغ" : "kg"}`;
  return `${Number(weightGrams.toFixed(0)).toLocaleString("en-US")} ${lang === "ar" ? "غ" : "g"}`;
}

/** «2 أكتوبر» / «2 Oct». */
export function shortDate(iso: string | null | undefined, lang: "ar" | "en"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { day: "numeric", month: "long", timeZone: "Asia/Riyadh" }).format(d);
}

/** Coffee origins offered by the Add Product form, stored as countryEn + countryAr. */
export const COUNTRIES: [string, string][] = [
  ["Ethiopia", "إثيوبيا"], ["Colombia", "كولمبيا"], ["Brazil", "البرازيل"], ["Yemen", "اليمن"], ["Kenya", "كينيا"],
  ["Guatemala", "غواتيمالا"], ["Costa Rica", "كوستاريكا"], ["Honduras", "هندوراس"], ["Panama", "بنما"],
  ["El Salvador", "السلفادور"], ["Nicaragua", "نيكاراغوا"], ["Mexico", "المكسيك"], ["Peru", "بيرو"],
  ["Bolivia", "بوليفيا"], ["Ecuador", "الإكوادور"], ["Rwanda", "رواندا"], ["Burundi", "بوروندي"],
  ["Tanzania", "تنزانيا"], ["Uganda", "أوغندا"], ["Indonesia", "إندونيسيا"], ["India", "الهند"],
  ["Papua New Guinea", "بابوا غينيا الجديدة"], ["China", "الصين"], ["Blend", "خلطة"],
];
export const PROCESSES: [string, string][] = [
  ["Washed", "مغسولة"], ["Natural", "مجففة"], ["Honey", "عسلية"], ["Anaerobic", "لاهوائية"], ["Wet-hulled", "مقشورة رطبة"], ["Other", "أخرى"],
];

export function CheckSvg() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4.5 4.5L19 7" /></svg>;
}
export function TrashIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>;
}

// ─── Add / edit category (Figma 276:4776) ─────────────────────────────────────

/**
 * «إضافة تصنيف» (create, with an optional product list to move in) or «تعديل التصنيف» (edit).
 * Calls back with the saved category so the Add Product form can select it.
 */
export function CategoryDialog({
  category,
  products,
  onClose,
  onSaved,
}: {
  category?: Category | null;
  products?: { id: string; name: string; categoryName: string | null }[];
  onClose: () => void;
  onSaved: (c: CategoryRef) => void;
}) {
  const L = useL();
  const [nameAr, setNameAr] = useState(category?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(category?.nameEn ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editing = !!category;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = { nameAr, nameEn: nameEn || null, description: description || null };
      const saved = editing
        ? await api<CategoryRef>(`/api/categories/${category!.id}`, { method: "PATCH", json: body })
        : await api<CategoryRef>("/api/categories", { json: { ...body, productIds: [...picked] } });
      onSaved(saved);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      testId="category-dialog"
      title={editing ? L("تعديل التصنيف", "Edit category") : L("إضافة تصنيف", "Add category")}
      sub={L("يجمع المنتجات في القوائم والفلاتر والتقارير. يمكن تعديله أو أرشفته لاحقًا.", "Groups products in lists, filters and reports. It can be edited or archived later.")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={busy} disabled={nameAr.trim().length < 2} onClick={save} data-testid="category-save">
            {editing ? L("حفظ التصنيف", "Save category") : L("إنشاء التصنيف", "Create category")}
          </Btn>
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
        </>
      }
    >
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div className="hr-stack" style={{ gap: 14 }}>
        <Field label={`${L("اسم التصنيف", "Category name")} *`}>
          <input className="hr-input" dir="rtl" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} placeholder={L("مثال: محاصيل أمريكا الوسطى", "e.g. محاصيل أمريكا الوسطى")} data-testid="category-name-ar" />
        </Field>
        <Field label={`${L("الاسم بالإنجليزية", "English name")} ${L("(اختياري)", "(optional)")}`}>
          <input className="hr-input" dir="ltr" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} placeholder="Central American origins" />
        </Field>
        <Field label={`${L("الوصف", "Description")} ${L("(اختياري)", "(optional)")}`}>
          <input className="hr-input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {!editing && products && products.length > 0 ? (
          <div className="cat-picks">
            <span className="hr-label">{L("المنتجات", "Products")} <span className="cat-opt">{L("(اختياري)", "(optional)")}</span></span>
            <ul>
              {products.map((p) => (
                <li key={p.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(p.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
                    <span className="cat-pick-name">{p.name}</span>
                  </label>
                  <span className="cat-pick-now">{p.categoryName ? `${L("حاليًا", "Now")}: ${p.categoryName}` : L("بلا تصنيف", "Uncategorised")}</span>
                </li>
              ))}
            </ul>
            <span className="hr-help">{L("المنتجات المحددة تُنقل من تصنيفها الحالي.", "Selected products move out of their current category.")}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// ─── Move to category (bulk «نقل إلى تصنيف», pane «نقل») ───────────────────────

export function MoveDialog({
  count,
  categories,
  currentId,
  onClose,
  onMove,
}: {
  count: number;
  categories: CategoryRef[];
  currentId?: string | null;
  onClose: () => void;
  onMove: (categoryId: string | null) => Promise<void>;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [target, setTarget] = useState<string>(currentId === undefined ? "" : currentId ?? "__none__");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      open
      testId="move-dialog"
      title={L("نقل إلى تصنيف", "Move to category")}
      sub={lang === "ar" ? `${count} ${count === 1 ? "منتج" : "منتجات"} · لا يتغير المخزون ولا أصناف البيع.` : `${count} product${count === 1 ? "" : "s"} · stock and SKUs are untouched.`}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={busy} disabled={!target} data-testid="move-confirm"
            onClick={async () => {
              setBusy(true); setErr(null);
              try { await onMove(target === "__none__" ? null : target); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
            }}>
            {L("نقل", "Move")}
          </Btn>
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
        </>
      }
    >
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <Field label={L("التصنيف", "Category")}>
        <Select className="hr-select" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="move-target">
          <option value="">{L("اختر تصنيفًا", "Choose a category")}</option>
          {categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{catName(c, lang)}</option>)}
          <option value="__none__">{L("بلا تصنيف", "Uncategorised")}</option>
        </Select>
      </Field>
    </Dialog>
  );
}

// ─── BOM editor for one existing SKU (product page «تعديل المكونات») ─────────

type BomRow = { type: "ROASTED_COFFEE" | "MATERIAL"; coffeeProductId: string | null; materialItemId: string | null; quantityPerUnit: number };

export function BomDialog({
  sku,
  productId,
  onClose,
  onSaved,
}: {
  sku: { id: string; skuCode: string; weightGrams: number };
  productId: string;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [rows, setRows] = useState<BomRow[] | null>(null);
  const [coffees, setCoffees] = useState<Coffee[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bom, c, m] = await Promise.all([
          api<{ components: BomRow[] }>(`/api/products/${sku.id}/bom`),
          api<Coffee[]>("/api/coffee-products"),
          api<Material[]>("/api/materials"),
        ]);
        if (cancelled) return;
        setRows(bom.components.map((r) => ({ type: r.type, coffeeProductId: r.coffeeProductId, materialItemId: r.materialItemId, quantityPerUnit: r.quantityPerUnit })));
        setCoffees(c);
        setMaterials(m.filter((x) => x.isActive));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sku.id]);

  const update = (i: number, patch: Partial<BomRow>) => setRows((rs) => (rs ?? []).map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ warnings?: string[] }>(`/api/products/${sku.id}/bom`, { method: "PUT", json: { components: rows } });
      onSaved(r.warnings ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      testId="bom-dialog"
      className="stk-wide"
      title={`${L("المكونات لكل وحدة", "Components per unit")} · ${sku.skuCode}`}
      sub={L("ما تستهلكه العبوة الواحدة عند التعبئة.", "What one pack consumes when it is packed.")}
      onClose={onClose}
      actions={rows ? (
        <>
          <Btn variant="primary" busy={busy} onClick={save} data-testid="bom-save">{L("حفظ المكونات", "Save components")}</Btn>
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
        </>
      ) : undefined}
    >
      {err ? <Notice tone="danger">{err}</Notice> : null}
      {!rows ? <OpsLoading rows={3} /> : (
        <div className="hr-stack" style={{ gap: 0 }}>
          {rows.length === 0 ? <Notice tone="info">{L("لا مكونات بعد. لا يُنتج الصنف بدونها.", "No components yet. The SKU cannot be produced without them.")}</Notice> : null}
          {rows.map((r, i) => (
            <div key={i} className="stk-bomrow">
              <span className="stk-kind">{r.type === "ROASTED_COFFEE" ? L("بن محمص", "Roasted coffee") : L("مادة تعبئة", "Packaging material")}</span>
              {r.type === "ROASTED_COFFEE" ? (
                <Select className="hr-select" aria-label={L("بن محمص", "Roasted coffee")} value={r.coffeeProductId ?? ""} onChange={(e) => update(i, { coffeeProductId: e.target.value || null })}>
                  <option value="">—</option>
                  {coffees.map((c) => <option key={c.id} value={c.id}>{pName(c, lang)}</option>)}
                </Select>
              ) : (
                <Select className="hr-select" aria-label={L("مادة تعبئة", "Packaging material")} value={r.materialItemId ?? ""} onChange={(e) => update(i, { materialItemId: e.target.value || null })}>
                  <option value="">—</option>
                  {materials.map((m) => <option key={m.id} value={m.id}>{(lang === "ar" && m.nameAr) || m.name} ({m.code})</option>)}
                </Select>
              )}
              <input className="hr-input" type="number" min={0} step={r.type === "ROASTED_COFFEE" ? "0.001" : "1"} aria-label={L("لكل وحدة", "Per unit")}
                value={r.quantityPerUnit} onChange={(e) => update(i, { quantityPerUnit: Number(e.target.value) })} />
              <span className="stk-u">{r.type === "ROASTED_COFFEE" ? L("كغ", "kg") : L("قطعة", "pcs")}</span>
              <Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label={L("حذف المكوّن", "Remove component")} onClick={() => setRows((rs) => (rs ?? []).filter((_, k) => k !== i))}><TrashIcon /></Btn>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 12 }}>
            <Btn size="sm" variant="ghost" onClick={() => setRows((rs) => [...(rs ?? []), { type: "ROASTED_COFFEE", coffeeProductId: productId, materialItemId: null, quantityPerUnit: sku.weightGrams / 1000 }])}>
              + {L("بن محمص", "Roasted coffee")}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setRows((rs) => [...(rs ?? []), { type: "MATERIAL", coffeeProductId: null, materialItemId: null, quantityPerUnit: 1 }])}>
              + {L("مادة تعبئة", "Packaging material")}
            </Btn>
          </div>
        </div>
      )}
    </Dialog>
  );
}
