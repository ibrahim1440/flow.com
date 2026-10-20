"use client";
// «إضافة منتج» — the one-page Add Product form (Figma 260:4107; INVENTORY.md «Product, SKU and
// Add Product»). Required ERP data (*): Arabic and English names, category, country and, per SKU,
// code, pack size and price. Everything marked «اختياري» is descriptive and can be completed later.
// Saved in ONE request — POST /api/coffee-products with skus[] — so the product, its SKUs (with
// barcode and active flag) and each SKU's BOM are created together or not at all.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn, Field, Notice, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { useUnsavedGuard } from "../../_components/useUnsavedGuard";
import { PlusIcon } from "../../_components/stock-materials";
import {
  ApiError, COUNTRIES, PROCESSES, TrashIcon, api, catName, CategoryDialog, useCanEditCatalog,
  type CategoryList, type CategoryRef, type Material,
} from "../_catalog/shared";

type Bean = { id: string; serialNumber: string; beanType: string; beanTypeAr?: string | null; quantityKg: number };
type Sku = { key: number; skuCode: string; weightGrams: string; price: string; barcode: string; isActive: boolean };
type BomLine = { key: number; type: "ROASTED_COFFEE" | "MATERIAL"; materialItemId: string; quantityPerUnit: string };

let seq = 0;
const nextKey = () => ++seq;

export default function AddProductPage() {
  const { lang } = useI18n();
  const L = useL();
  const router = useRouter();
  const canEdit = useCanEditCatalog();
  useD21Title(L("إضافة منتج", "Add product"));
  useD21Phone({ title: L("إضافة منتج", "Add product"), back: "/dashboard/products", ownBar: true });

  const [categories, setCategories] = useState<CategoryRef[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [beans, setBeans] = useState<Bean[]>([]);
  const [f, setF] = useState({
    productNameAr: "", productNameEn: "", categoryId: "", isActive: true,
    country: "", region: "", process: "", variety: "",
    cupNotes: "", roastPath: "", expectedRoastLoss: "15.0", defaultGreenBeanId: "",
  });
  const [skus, setSkus] = useState<Sku[]>(() => [{ key: nextKey(), skuCode: "", weightGrams: "250", price: "", barcode: "", isActive: true }]);
  const [boms, setBoms] = useState<Record<number, BomLine[]>>({});
  const [bomFor, setBomFor] = useState<number | null>(null);
  const [newCategory, setNewCategory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<{ msg: string; field?: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty && !saving);

  useEffect(() => {
    api<CategoryList>("/api/categories").then((c) => setCategories(c.items)).catch(() => undefined);
    api<Material[]>("/api/materials").then(setMaterials).catch(() => undefined);
    api<Bean[]>("/api/green-beans").then((b) => setBeans(Array.isArray(b) ? b : [])).catch(() => undefined);
  }, []);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setDirty(true); setF((s) => ({ ...s, [k]: v })); };
  const setSku = (key: number, patch: Partial<Sku>) => { setDirty(true); setSkus((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s))); };

  // Each SKU starts with «بن محمص · هذا المنتج» at its net weight; the BOM segment switches SKUs.
  const activeBomKey = bomFor !== null && skus.some((s) => s.key === bomFor) ? bomFor : skus[0]?.key ?? null;
  const bomOf = (key: number): BomLine[] => boms[key] ?? [{ key: -key, type: "ROASTED_COFFEE", materialItemId: "", quantityPerUnit: "" }];
  const setBom = (key: number, lines: BomLine[]) => { setDirty(true); setBoms((b) => ({ ...b, [key]: lines })); };

  const country = COUNTRIES.find(([en]) => en === f.country);
  const proc = PROCESSES.find(([en]) => en === f.process);
  const required = f.productNameAr.trim().length >= 2 && f.productNameEn.trim() && f.categoryId && f.country
    && skus.length > 0 && skus.every((s) => s.skuCode.trim() && Number(s.weightGrams) > 0 && s.price !== "" && Number(s.price) >= 0);

  async function save() {
    setSaving(true);
    setErr(null);
    // Free text goes to the field of the language it was typed in; lists carry both.
    const txt = (v: string) => (v.trim() ? v.trim() : null);
    const ar = lang === "ar";
    try {
      const body = {
        productNameAr: f.productNameAr, productNameEn: f.productNameEn,
        categoryId: f.categoryId || null, isActive: f.isActive,
        countryEn: country?.[0] ?? f.country, countryAr: country?.[1] ?? null,
        processEn: proc?.[0] ?? null, processAr: proc?.[1] ?? null,
        [ar ? "regionAr" : "regionEn"]: txt(f.region),
        [ar ? "varietyAr" : "varietyEn"]: txt(f.variety),
        [ar ? "cupNotesAr" : "cupNotesEn"]: txt(f.cupNotes),
        [ar ? "roastPathAr" : "roastPathEn"]: txt(f.roastPath),
        expectedRoastLoss: f.expectedRoastLoss,
        defaultGreenBeanId: f.defaultGreenBeanId || null,
        skus: skus.map((s) => ({
          skuCode: s.skuCode, weightGrams: Number(s.weightGrams), price: Number(s.price), barcode: s.barcode, isActive: s.isActive,
          bom: bomOf(s.key)
            .filter((l) => l.type === "ROASTED_COFFEE" || l.materialItemId)
            .map((l) => ({
              type: l.type,
              coffeeProductId: null, // ROASTED_COFFEE: this product
              materialItemId: l.type === "MATERIAL" ? l.materialItemId : null,
              quantityPerUnit: l.type === "ROASTED_COFFEE" && l.quantityPerUnit === "" ? Number(s.weightGrams) / 1000 : Number(l.quantityPerUnit),
            })),
        })),
      };
      const created = await api<{ id: string }>("/api/coffee-products", { json: body });
      setDirty(false);
      router.push(`/dashboard/products/${created.id}`);
    } catch (e) {
      setErr({ msg: e instanceof Error ? e.message : String(e), field: e instanceof ApiError ? e.field : undefined });
      setSaving(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const lbl = (ar: string, en: string, req?: boolean) => (req ? `${L(ar, en)} *` : `${L(ar, en)} ${L("(اختياري)", "(optional)")}`);

  if (!canEdit) {
    return (
      <OpsRoot className="stk-products">
        <div className="hr-page"><PageHeader title={L("إضافة منتج", "Add product")} /><Notice tone="warning">{L("إضافة المنتجات تحتاج صلاحية التعديل على المخزون.", "Adding products needs edit access to Inventory.")}</Notice></div>
      </OpsRoot>
    );
  }

  return (
    <OpsRoot className="stk-products cat-new">
      <div className="hr-page">
        <PageHeader title={L("إضافة منتج", "Add product")}>
          <span className="hr-caption">{L("منتج قهوة جديد • أصناف البيع والمكونات في القسمين الأخيرين", "A new coffee product • sale SKUs and components in the last two sections")}</span>
        </PageHeader>
        <p className="cat-legend"><span className="cat-req">*</span> {L("بيانات مطلوبة للنظام · الحقول المعلَّمة «اختياري» وصفية ويمكن إكمالها لاحقًا", "Data the system needs · fields marked «optional» are descriptive and can be completed later")}</p>
        {err ? <Notice tone="danger">{err.msg}</Notice> : null}

        <form className="cat-form" onSubmit={(e) => { e.preventDefault(); if (required && !saving) save(); }} data-testid="add-product-form">
          <section className="cat-sec">
            <header><h2 className="hr-section">{L("تعريف المنتج", "Product identity")}</h2><p>{L("ما يحتاجه النظام لإنشاء المنتج وتصنيفه.", "What the system needs to create and categorise the product.")}</p></header>
            <div className="hr-form">
              <Field label={lbl("الاسم بالعربية", "Arabic name", true)} error={err?.field === "productNameAr" ? err.msg : null}>
                <input className="hr-input" dir="rtl" value={f.productNameAr} maxLength={120} onChange={(e) => set("productNameAr", e.target.value)} data-testid="np-name-ar" />
              </Field>
              <Field label={lbl("الاسم بالإنجليزية", "English name", true)}>
                <input className="hr-input" dir="ltr" value={f.productNameEn} maxLength={120} onChange={(e) => set("productNameEn", e.target.value)} data-testid="np-name-en" />
              </Field>
              <Field label={lbl("التصنيف", "Category", true)} help={
                <><button type="button" className="cat-link" onClick={() => setNewCategory(true)} data-testid="np-new-category">+ {L("تصنيف جديد", "New category")}</button> · {L("يُفتح فوق النموذج ولا يضيع ما أدخلته", "opens over the form; nothing you entered is lost")}</>
              }>
                <Select className="hr-select" value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)} data-testid="np-category">
                  <option value="">{L("اختر تصنيفًا", "Choose a category")}</option>
                  {categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{catName(c, lang)}</option>)}
                </Select>
              </Field>
              <div className="hr-field">
                <span className="hr-label">{L("حالة المنتج", "Product status")}</span>
                <span className="ops-seg cat-seg" role="group" aria-label={L("حالة المنتج", "Product status")}>
                  <button type="button" aria-pressed={f.isActive} onClick={() => set("isActive", true)}>{L("نشط", "Active")}</button>
                  <button type="button" aria-pressed={!f.isActive} onClick={() => set("isActive", false)} data-testid="np-inactive">{L("غير نشط", "Inactive")}</button>
                </span>
                <span className="hr-help">{L("غير النشط لا يظهر في الطلبات وعروض الأسعار.", "An inactive product does not appear on orders or quotations.")}</span>
              </div>
            </div>
          </section>

          <section className="cat-sec">
            <header><h2 className="hr-section">{L("المنشأ", "Origin")}</h2><p>{L("الدولة مطلوبة، والباقي اختياري.", "The country is required; the rest is optional.")}</p></header>
            <div className="hr-form">
              <Field label={lbl("الدولة", "Country", true)}>
                <Select className="hr-select" value={f.country} onChange={(e) => set("country", e.target.value)} data-testid="np-country">
                  <option value="">{L("اختر الدولة", "Choose the country")}</option>
                  {COUNTRIES.map(([en, ar]) => <option key={en} value={en}>{lang === "ar" ? ar : en}</option>)}
                </Select>
              </Field>
              <Field label={lbl("المنطقة", "Region")}><input className="hr-input" value={f.region} onChange={(e) => set("region", e.target.value)} /></Field>
              <Field label={lbl("المعالجة", "Process")}>
                <Select className="hr-select" value={f.process} onChange={(e) => set("process", e.target.value)}>
                  <option value="">{L("غير محددة", "Not set")}</option>
                  {PROCESSES.map(([en, ar]) => <option key={en} value={en}>{lang === "ar" ? ar : en}</option>)}
                </Select>
              </Field>
              <Field label={lbl("الصنف النباتي", "Variety")}><input className="hr-input" value={f.variety} onChange={(e) => set("variety", e.target.value)} /></Field>
            </div>
          </section>

          <section className="cat-sec">
            <header><h2 className="hr-section">{L("الوصف والتحميص", "Description and roasting")}</h2><p>{L("وصف يظهر في الملصقات وعروض الأسعار.", "A description shown on labels and quotations.")}</p></header>
            <div className="hr-form">
              <Field label={lbl("ملاحظات التذوق", "Tasting notes")}><input className="hr-input" value={f.cupNotes} onChange={(e) => set("cupNotes", e.target.value)} /></Field>
              <Field label={lbl("مسار التحميص", "Roast path")}><input className="hr-input" value={f.roastPath} onChange={(e) => set("roastPath", e.target.value)} /></Field>
              <Field label={`${L("فقد التحميص المتوقع", "Expected roast loss")} · %`} help={L("يُحسب منه البن الأخضر اللازم للإنتاج.", "The green coffee a production needs is computed from it.")}>
                <input className="hr-input" type="number" min={0} max={50} step="0.1" dir="ltr" value={f.expectedRoastLoss} onChange={(e) => set("expectedRoastLoss", e.target.value)} />
              </Field>
              <Field label={lbl("البن الأخضر الافتراضي", "Default green coffee")} help={L("يُقترح عند بدء التحميص.", "Suggested when a roast starts.")}>
                <Select className="hr-select" value={f.defaultGreenBeanId} onChange={(e) => set("defaultGreenBeanId", e.target.value)}>
                  <option value="">{L("لم يُحدَّد", "Not set")}</option>
                  {beans.map((b) => <option key={b.id} value={b.id}>{(lang === "ar" && b.beanTypeAr) || b.beanType} · {b.serialNumber}</option>)}
                </Select>
              </Field>
            </div>
          </section>

          <section className="cat-sec">
            <header><h2 className="hr-section">{L("أصناف البيع", "Sale SKUs")}</h2><p>{L("كل حجم عبوة صنف مستقل للمنتج نفسه، بسعره ورمزه.", "Each pack size is its own SKU of the same product, with its price and code.")}</p></header>
            <div className="cat-skus">
              <table className="hr-table cat-skutable" aria-label={L("أصناف البيع", "Sale SKUs")}>
                <thead>
                  <tr>
                    <th>{lbl("رمز الصنف", "SKU code", true)}</th>
                    <th>{lbl("حجم العبوة", "Pack size", true)}</th>
                    <th>{lbl("سعر البيع · ر.س", "Price · SAR", true)}</th>
                    <th>{L("الباركود", "Barcode")}</th>
                    <th className="cat-ck">{L("نشط", "Active")}</th>
                    <th aria-label={L("حذف", "Remove")} />
                  </tr>
                </thead>
                <tbody>
                  {skus.map((s, i) => (
                    <tr key={s.key}>
                      <td data-label={L("رمز الصنف", "SKU code")}><input className="hr-input hr-id" dir="ltr" value={s.skuCode} maxLength={40} aria-label={`${L("رمز الصنف", "SKU code")} ${i + 1}`} onChange={(e) => setSku(s.key, { skuCode: e.target.value.toUpperCase() })} placeholder="YRG-250G" data-testid={`np-sku-code-${i}`} /></td>
                      <td data-label={L("حجم العبوة", "Pack size")}>
                        <span className="cat-unitin"><input className="hr-input" type="number" min={1} step="1" dir="ltr" value={s.weightGrams} aria-label={`${L("حجم العبوة", "Pack size")} ${i + 1}`} onChange={(e) => setSku(s.key, { weightGrams: e.target.value })} data-testid={`np-sku-weight-${i}`} /><span>{L("غ", "g")}</span></span>
                      </td>
                      <td data-label={L("سعر البيع", "Price")}><input className="hr-input" type="number" min={0} step="0.01" dir="ltr" value={s.price} aria-label={`${L("سعر البيع", "Price")} ${i + 1}`} onChange={(e) => setSku(s.key, { price: e.target.value })} placeholder="0.00" data-testid={`np-sku-price-${i}`} /></td>
                      <td data-label={L("الباركود", "Barcode")}><input className="hr-input hr-id" dir="ltr" value={s.barcode} maxLength={48} aria-label={`${L("الباركود", "Barcode")} ${i + 1}`} onChange={(e) => setSku(s.key, { barcode: e.target.value.trim() })} placeholder={L("اختياري", "Optional")} data-testid={`np-sku-barcode-${i}`} /></td>
                      <td className="cat-ck"><input type="checkbox" checked={s.isActive} aria-label={`${L("نشط", "Active")} ${i + 1}`} onChange={(e) => setSku(s.key, { isActive: e.target.checked })} /></td>
                      <td>{skus.length > 1 ? <Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label={L("حذف الصنف", "Remove SKU")} onClick={() => { setDirty(true); setSkus((ss) => ss.filter((x) => x.key !== s.key)); }}><TrashIcon /></Btn> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="cat-addrow">
                <button type="button" className="cat-link" onClick={() => { setDirty(true); setSkus((ss) => [...ss, { key: nextKey(), skuCode: "", weightGrams: "1000", price: "", barcode: "", isActive: true }]); }} data-testid="np-add-sku">
                  <PlusIcon />{L("إضافة حجم عبوة", "Add pack size")}
                </button>
                <span className="hr-help">{L("لا يُدخل المخزون هنا: يُحسب من لوتات التعبئة بعد الإنتاج.", "Stock is not entered here: it comes from the packing lots after production.")}</span>
              </p>
            </div>
          </section>

          <section className="cat-sec">
            <header><h2 className="hr-section">{L("المكونات لكل وحدة", "Components per unit")}</h2><p>{L("ما تستهلكه العبوة الواحدة عند التعبئة. لا يُنتج الصنف بدونها.", "What one pack consumes when it is packed. The SKU cannot be produced without them.")}</p></header>
            <div className="cat-bom">
              {activeBomKey !== null ? (
                <>
                  <span className="ops-seg cat-seg" role="group" aria-label={L("الصنف", "SKU")}>
                    {skus.map((s, i) => (
                      <button key={s.key} type="button" aria-pressed={s.key === activeBomKey} onClick={() => setBomFor(s.key)} className="hr-id" data-testid={`np-bom-tab-${i}`}>{s.skuCode || `${L("صنف", "SKU")} ${i + 1}`}</button>
                    ))}
                  </span>
                  <table className="hr-table cat-bomtable" aria-label={L("المكونات لكل وحدة", "Components per unit")}>
                    <thead><tr><th>{L("المكوّن", "Component")}</th><th>{L("المخزون الحالي", "Current stock")}</th><th>{L("لكل وحدة", "Per unit")}</th><th aria-label={L("حذف", "Remove")} /></tr></thead>
                    <tbody>
                      {bomOf(activeBomKey).map((l) => {
                        const sku = skus.find((s) => s.key === activeBomKey)!;
                        const lines = bomOf(activeBomKey);
                        const upd = (patch: Partial<BomLine>) => setBom(activeBomKey, lines.map((x) => (x.key === l.key ? { ...x, ...patch } : x)));
                        const m = l.materialItemId ? matById.get(l.materialItemId) : undefined;
                        return (
                          <tr key={l.key}>
                            <td className="cat-bomname">
                              {l.type === "ROASTED_COFFEE" ? (
                                <><span className="strong">{L("بن محمص · هذا المنتج", "Roasted coffee · this product")}</span><span className="stk-sub">{L("يُصرف من البن المحمص بعد التحميص", "Drawn from roasted coffee after roasting")}</span></>
                              ) : (
                                <Select className="hr-select" value={l.materialItemId} aria-label={L("مادة التعبئة", "Packaging material")} onChange={(e) => upd({ materialItemId: e.target.value })} data-testid="np-bom-material">
                                  <option value="">{L("اختر مادة تعبئة", "Choose a material")}</option>
                                  {materials.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{(lang === "ar" && x.nameAr) || x.name} · {x.code}</option>)}
                                </Select>
                              )}
                            </td>
                            <td className="cat-muted">
                              {l.type === "ROASTED_COFFEE" ? "—" : m ? <span className={m.quantityOnHand < 100 ? "cat-low" : undefined}>{L("متوفر", "On hand")} <span className="hr-num">{m.quantityOnHand.toLocaleString("en-US")}</span></span> : "—"}
                            </td>
                            <td>
                              <span className="cat-unitin">
                                <input className="hr-input" type="number" min={0} step={l.type === "ROASTED_COFFEE" ? "0.001" : "1"} dir="ltr" aria-label={L("لكل وحدة", "Per unit")}
                                  value={l.type === "ROASTED_COFFEE" && l.quantityPerUnit === "" ? String(Number(sku.weightGrams || 0) / 1000) : l.quantityPerUnit}
                                  onChange={(e) => upd({ quantityPerUnit: e.target.value })} />
                                <span>{l.type === "ROASTED_COFFEE" ? L("كغ", "kg") : L("قطعة", "pcs")}</span>
                              </span>
                            </td>
                            <td><Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label={L("حذف المكوّن", "Remove component")} onClick={() => setBom(activeBomKey, lines.filter((x) => x.key !== l.key))}><TrashIcon /></Btn></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {/* The stock column is read only: packaging materials are created, received and counted in
                      Inventory › packaging materials, on the inventory ledger (small-fixes batch). */}
                  <p className="hr-caption" data-testid="np-materials-readonly">
                    {L("هنا تُحدَّد مكونات الصنف فقط؛ مواد التعبئة نفسها وكمياتها تُدار في ", "Only the SKU's components are chosen here; the packaging materials and their stock are managed in ")}
                    <Link href="/dashboard/inventory?tab=pack">{L("المخزون › مواد التعبئة", "Inventory › Packaging materials")}</Link>.
                  </p>
                  <p className="cat-addrow">
                    <button type="button" className="cat-link" onClick={() => setBom(activeBomKey, [...bomOf(activeBomKey), { key: nextKey(), type: "MATERIAL", materialItemId: "", quantityPerUnit: "1" }])} data-testid="np-add-material">
                      <PlusIcon />{L("إضافة مادة تعبئة", "Add packaging material")}
                    </button>
                    {!bomOf(activeBomKey).some((l) => l.type === "ROASTED_COFFEE") ? (
                      <button type="button" className="cat-link" onClick={() => setBom(activeBomKey, [{ key: nextKey(), type: "ROASTED_COFFEE", materialItemId: "", quantityPerUnit: "" }, ...bomOf(activeBomKey)])}>
                        <PlusIcon />{L("بن محمص", "Roasted coffee")}
                      </button>
                    ) : null}
                  </p>
                </>
              ) : null}
            </div>
          </section>

          <div className="cat-formbar">
            <Btn variant="primary" type="submit" busy={saving} disabled={!required} data-testid="np-save">{L("حفظ المنتج", "Save product")}</Btn>
            <Link className="hr-btn is-ghost" href="/dashboard/products">{L("إلغاء", "Cancel")}</Link>
          </div>
        </form>
      </div>

      {newCategory ? (
        <CategoryDialog onClose={() => setNewCategory(false)} onSaved={(c) => { setNewCategory(false); setCategories((cs) => [...cs, c]); set("categoryId", c.id); }} />
      ) : null}
    </OpsRoot>
  );
}
