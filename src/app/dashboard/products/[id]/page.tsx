"use client";
// The product page (Figma 262:4570): one coffee product with all its sale SKUs. Metric strip,
// the SKU table (code, pack size, barcode, price, available / reserved / free — read from the
// finished-stock lots, never edited here — components, status), each SKU's components per unit
// with the stock they draw on, and the product data. GET /api/coffee-products/:id; edits go to
// PATCH /api/coffee-products/:id (product, category, status), POST /api/products (a new SKU),
// PATCH /api/products/:skuId (price, barcode, status) and PUT /api/products/:skuId/bom.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Btn, Dot, Field, Notice, OpsBanner, OpsLoading, OpsRoot, rowOpen, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { PlusIcon } from "../../_components/stock-materials";
import { SiteReorderEditor } from "../../inventory/_parts/locations";
import {
  BomDialog, COUNTRIES, PROCESSES, api, catName, money2, packLabel, pName, shortDate, useCanEditCatalog,
  type CategoryList, type CategoryRef,
} from "../_catalog/shared";

type BomReq = { type: "ROASTED_COFFEE" | "MATERIAL"; nameEn: string | null; nameAr: string | null; code: string | null; quantityPerUnit: number; quantityAvailable: number; unitOfMeasure: string; coffeeProductId: string | null };
type Sku = {
  id: string; skuCode: string; barcode: string | null; weightGrams: number; packSize: string; price: number; isActive: boolean;
  availableUnits: number; reservedUnits: number; freeUnits: number; partialPackages: number; partialGrams: number; bomComponentCount: number; bomPerUnit: BomReq[];
};
type Product = {
  id: string; productNameAr: string | null; productNameEn: string; isActive: boolean; createdAt: string;
  countryEn: string; countryAr: string | null; regionEn: string | null; regionAr: string | null; processEn: string | null; processAr: string | null;
  varietyEn: string | null; varietyAr: string | null; cupNotesEn: string | null; cupNotesAr: string | null; roastPathEn: string | null; roastPathAr: string | null;
  expectedRoastLoss: number; defaultGreenBeanId: string | null;
  defaultGreenBean: { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null } | null;
  category: CategoryRef | null;
  skus: Sku[];
  metrics: { skuCount: number; activeSkuCount: number; freeUnits: number; availableUnits: number; reservedUnits: number; reservedOrders: number[]; lotCount: number; roastedUnpackedKg: number; awaitingQcKg: number };
};

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useI18n();
  const L = useL();
  const canEdit = useCanEditCatalog();
  const [p, setP] = useState<Product | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [bomSku, setBomSku] = useState<string | null>(null);
  const [editBom, setEditBom] = useState(false);
  const [editSku, setEditSku] = useState<Sku | null>(null);
  const [addSku, setAddSku] = useState(false);
  const [editProduct, setEditProduct] = useState(false);
  const [toast, setToast] = useState<{ tone: "success" | "danger" | "warning"; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Product>(`/api/coffee-products/${id}`).then((x) => { if (!cancelled) { setP(x); setErr(null); } }).catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [id, key]);
  const reload = () => setKey((k) => k + 1);

  const name = p ? pName(p, lang) : "";
  useD21Title(p ? name : null);
  useD21Phone(p ? { title: name, back: "/dashboard/products" } : null);

  if (err) return <OpsRoot className="stk-products"><div className="hr-page"><Notice tone="danger">{err}</Notice><Link href="/dashboard/products" className="hr-btn">{L("المنتجات", "Products")}</Link></div></OpsRoot>;
  if (!p) return <OpsRoot className="stk-products"><div className="hr-page"><OpsLoading /></div></OpsRoot>;

  const m = p.metrics;
  const n = (v: number) => v.toLocaleString("en-US");
  const pick = (ar: string | null, en: string | null) => (lang === "ar" ? ar || en : en || ar) || "—";
  const activeSku = p.skus.find((s) => s.id === bomSku) ?? p.skus[0] ?? null;
  // The pack count the packaging materials of the chosen SKU still cover, and the one that limits it.
  const cover = activeSku ? activeSku.bomPerUnit.filter((b) => b.type === "MATERIAL" && b.quantityPerUnit > 0)
    .map((b) => ({ b, packs: Math.floor(b.quantityAvailable / b.quantityPerUnit) }))
    .sort((a, b) => a.packs - b.packs)[0] ?? null : null;

  return (
    <OpsRoot className="stk-products cat-detail">
      <div className="hr-page">
        <div className="hr-pagehead cat-dhead">
          <div className="cat-dtitle">
            {p.category ? <span className="cat-eyebrow">{catName(p.category, lang)}</span> : <span className="cat-eyebrow">{L("بلا تصنيف", "Uncategorised")}</span>}
            <h1 className="hr-title">{name}</h1>
            <div className="hr-meta">
              {lang === "ar" && p.productNameAr ? <span className="hr-caption" dir="ltr"><bdi>{p.productNameEn}</bdi></span> : null}
              <Dot tone={p.isActive ? "success" : "neutral"}>{p.isActive ? L("نشط", "Active") : L("غير نشط", "Inactive")}</Dot>
              <span className="hr-caption">{L("أُنشئ", "Created")} {shortDate(p.createdAt, lang)}</span>
            </div>
          </div>
          {canEdit ? (
            <div className="hr-actions">
              <Btn onClick={() => setEditProduct(true)} data-testid="product-edit">{L("تعديل", "Edit")}</Btn>
              <Btn variant="primary" onClick={() => setAddSku(true)} data-testid="product-add-sku"><PlusIcon />{L("إضافة صنف بيع", "Add SKU")}</Btn>
            </div>
          ) : null}
        </div>

        {toast ? <OpsBanner tone={toast.tone === "warning" ? "warning" : toast.tone} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

        <div className="stk-metrics">
          <div>
            <span className="stk-lbl">{L("أصناف البيع", "Sale SKUs")}</span>
            <span className="stk-mid">{n(m.skuCount)}</span>
            <span className="stk-d">{m.skuCount === 0 ? L("لا أصناف بعد", "No SKUs yet") : m.activeSkuCount === m.skuCount ? (m.skuCount === 2 ? L("كلاهما نشط", "Both active") : L("كلها نشطة", "All active")) : L(`${m.activeSkuCount} نشطة`, `${m.activeSkuCount} active`)}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("حر للبيع", "Free to sell")}</span>
            <span className="stk-mid">{n(m.freeUnits)}<span className="stk-unit">{L("وحدة", "units")}</span></span>
            <span className="stk-d">{L(`من ${n(m.availableUnits)} وحدة متاحة`, `of ${n(m.availableUnits)} units available`)}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("محجوز", "Reserved")}</span>
            <span className="stk-mid">{n(m.reservedUnits)}</span>
            <span className="stk-d">{m.reservedOrders.length ? `${L("للطلب", "For order")} ${m.reservedOrders.slice(0, 3).map((o) => `#${o}`).join(" · ")}` : L("لا حجوزات", "No reservations")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("بن محمص غير معبأ", "Roasted, not packed")}</span>
            <span className="stk-mid">{m.roastedUnpackedKg.toFixed(2)}<span className="stk-unit">{L("كغ", "kg")}</span></span>
            <span className="stk-d">{m.awaitingQcKg > 0 ? L(`${m.awaitingQcKg.toFixed(2)} كغ بانتظار الجودة`, `${m.awaitingQcKg.toFixed(2)} kg awaiting QC`) : L("لا شيء بانتظار الجودة", "Nothing awaiting QC")}</span>
          </div>
        </div>

        <div className="cat-sechead">
          <h2 className="hr-section">{L("أصناف البيع", "Sale SKUs")}</h2>
          <span className="hr-caption">{L("كل حجم عبوة صنف مستقل · المخزون من لوتات المخزون التام", "Each pack size is its own SKU · stock from the finished-stock lots")}</span>
        </div>
        {p.skus.length === 0 ? <div className="hr-state"><h3>{L("لا أصناف بيع بعد.", "No sale SKUs yet.")}</h3></div> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow cat-table" aria-label={L("أصناف البيع", "Sale SKUs")} data-testid="sku-table">
              <thead>
                <tr>
                  <th>{L("رمز الصنف", "SKU code")}</th>
                  <th>{L("حجم العبوة", "Pack size")}</th>
                  <th className="hr-hide-compact">{L("الباركود", "Barcode")}</th>
                  <th className="num">{L("سعر البيع · ر.س", "Price · SAR")}</th>
                  <th className="num">{L("متاح", "Available")}</th>
                  <th className="num">{L("محجوز", "Reserved")}</th>
                  <th className="num">{L("حر", "Free")}</th>
                  <th className="hr-hide-compact">{L("المكونات", "Components")}</th>
                  <th>{L("الحالة", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {p.skus.map((s) => (
                  <tr key={s.id} {...(canEdit ? rowOpen(() => setEditSku(s)) : {})} className={`${canEdit ? "is-clickable " : ""}${s.isActive ? "" : "is-inactive"}`} aria-selected={activeSku?.id === s.id || undefined} data-testid={`sku-row-${s.skuCode}`}>
                    <td className="m-title">
                      <span className="hr-id strong" dir="ltr">{s.skuCode}</span>
                      <span className="hr-msub">{packLabel(s.weightGrams, lang)} · {money2(s.price)} · {L("حر", "free")} <span className="hr-num">{n(s.freeUnits)}</span></span>
                    </td>
                    <td>{packLabel(s.weightGrams, lang)}</td>
                    <td className="hr-hide-compact"><span className="hr-id cat-muted" dir="ltr">{s.barcode || "—"}</span></td>
                    <td className="num"><span className="hr-num">{money2(s.price)}</span></td>
                    <td className="num"><span className="hr-num">{n(s.availableUnits)}</span></td>
                    <td className="num"><span className="hr-num">{s.reservedUnits ? n(s.reservedUnits) : "—"}</span></td>
                    <td className="num">
                      <strong className="hr-num">{n(s.freeUnits)}</strong>
                      {s.partialPackages > 0 ? (
                        <span className="stk-sub" style={{ color: "var(--status-warning)", fontWeight: 500 }}>
                          + {s.partialPackages} {L("جزئية", "partial")} (<span className="hr-num">{s.partialGrams}</span> {L("غ", "g")})
                        </span>
                      ) : null}
                    </td>
                    <td className="hr-hide-compact cat-muted">{s.bomComponentCount ? L(`${s.bomComponentCount} مكونات`, `${s.bomComponentCount} components`) : <span className="stk-flag">{L("بلا مكونات", "No components")}</span>}</td>
                    <td className="m-end"><Dot tone={s.isActive ? "success" : "neutral"}>{s.isActive ? L("نشط", "Active") : L("غير نشط", "Inactive")}</Dot></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>{L(`${p.skus.length} أصناف · ${m.lotCount} لوتات`, `${p.skus.length} SKUs · ${m.lotCount} lots`)}</td>
                  <td className="num stk-tot"><span className="hr-num">{n(m.availableUnits)}</span></td>
                  <td className="num stk-tot"><span className="hr-num">{n(m.reservedUnits)}</span></td>
                  <td className="num stk-tot"><span className="hr-num">{n(m.freeUnits)}</span></td>
                  <td colSpan={2} className="cat-endlink"><Link href="/dashboard/inventory">{L("عرض في المخزون التام", "View in finished stock")}</Link></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="cat-cols">
          <section className="cat-col">
            <div className="cat-sechead">
              <h2 className="hr-section">{L("المكونات لكل وحدة", "Components per unit")}</h2>
              {canEdit && activeSku ? <Btn size="sm" variant="ghost" onClick={() => setEditBom(true)} data-testid="product-edit-bom">{L("تعديل المكونات", "Edit components")}</Btn> : null}
            </div>
            {activeSku ? (
              <>
                {p.skus.length > 1 ? (
                  <span className="ops-seg cat-seg" role="group" aria-label={L("الصنف", "SKU")}>
                    {p.skus.map((s) => <button key={s.id} type="button" className="hr-id" aria-pressed={s.id === activeSku.id} onClick={() => setBomSku(s.id)}>{s.skuCode}</button>)}
                  </span>
                ) : null}
                {activeSku.bomPerUnit.length === 0 ? <p className="hr-caption">{L("لا مكونات لهذا الصنف بعد؛ لا يمكن إنتاجه.", "This SKU has no components yet; it cannot be produced.")}</p> : (
                  <ul className="cat-bomlist" data-testid="bom-list">
                    {activeSku.bomPerUnit.map((b, i) => (
                      <li key={i}>
                        <span className="cat-pl-main">
                          <span className="strong">{(lang === "ar" ? b.nameAr || b.nameEn : b.nameEn || b.nameAr) ?? "—"}</span>
                          <span className="cat-muted">
                            {b.type === "ROASTED_COFFEE" ? L("بن محمص", "Roasted coffee") : <><span className="hr-id" dir="ltr">{b.code}</span> · {L("متوفر", "on hand")} <span className="hr-num">{n(b.quantityAvailable)}</span></>}
                          </span>
                        </span>
                        <span className="cat-qty"><span className="hr-num">{b.type === "ROASTED_COFFEE" ? b.quantityPerUnit.toFixed(3) : n(b.quantityPerUnit)}</span> {b.type === "ROASTED_COFFEE" ? L("كغ", "kg") : L("قطعة", "pcs")}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {cover ? <p className="stk-foot">{L(`تكفي مواد التعبئة لـ ${n(cover.packs)} عبوة · تحدّها ${(cover.b.nameAr || cover.b.nameEn) ?? ""}.`, `Packaging covers ${n(cover.packs)} packs · limited by ${(cover.b.nameEn || cover.b.nameAr) ?? ""}.`)}</p> : null}
                {/* One place to enter packaging materials (small-fixes batch): their stock is received,
                    counted and created in Inventory › packaging materials, on the inventory ledger.
                    Here it is read only, with the way there. */}
                {activeSku.bomPerUnit.some((b) => b.type === "MATERIAL") ? (
                  <p className="hr-caption" data-testid="bom-materials-readonly">
                    {L("كميات مواد التعبئة للعرض هنا؛ تُستلم وتُجرد وتُضاف في ", "Packaging-material stock is shown here only; it is received, counted and added in ")}
                    <Link href="/dashboard/inventory?tab=pack" data-testid="bom-materials-link">{L("المخزون › مواد التعبئة", "Inventory › Packaging materials")}</Link>.
                  </p>
                ) : null}
              </>
            ) : <p className="hr-caption">{L("أضف صنف بيع أولًا.", "Add a SKU first.")}</p>}
          </section>

          <section className="cat-col">
            <div className="cat-sechead">
              <h2 className="hr-section">{L("بيانات المنتج", "Product data")}</h2>
              {canEdit ? <Btn size="sm" variant="ghost" onClick={() => setEditProduct(true)}>{L("تعديل", "Edit")}</Btn> : null}
            </div>
            <dl className="hr-kv cat-kv">
              <div><dt>{L("التصنيف", "Category")}</dt><dd>{p.category ? catName(p.category, lang) : L("بلا تصنيف", "Uncategorised")}</dd></div>
              <div><dt>{L("الدولة", "Country")}</dt><dd>{pick(p.countryAr, p.countryEn)}</dd></div>
              <div><dt>{L("المنطقة", "Region")}</dt><dd>{pick(p.regionAr, p.regionEn)}</dd></div>
              <div><dt>{L("المعالجة", "Process")}</dt><dd>{pick(p.processAr, p.processEn)}</dd></div>
              <div><dt>{L("الصنف النباتي", "Variety")}</dt><dd>{pick(p.varietyAr, p.varietyEn)}</dd></div>
              <div><dt>{L("ملاحظات التذوق", "Tasting notes")}</dt><dd>{pick(p.cupNotesAr, p.cupNotesEn)}</dd></div>
              <div><dt>{L("مسار التحميص", "Roast path")}</dt><dd>{pick(p.roastPathAr, p.roastPathEn)}</dd></div>
              <div><dt>{L("فقد التحميص المتوقع", "Expected roast loss")}</dt><dd className="hr-num">{p.expectedRoastLoss.toFixed(1)}%</dd></div>
              <div><dt>{L("البن الأخضر الافتراضي", "Default green coffee")}</dt><dd><span className="hr-id" dir="ltr">{p.defaultGreenBean?.serialNumber ?? "—"}</span></dd></div>
            </dl>
          </section>
        </div>
      </div>

      {editBom && activeSku ? (
        <BomDialog sku={activeSku} productId={p.id} onClose={() => setEditBom(false)}
          onSaved={(w) => { setEditBom(false); reload(); setToast(w.length ? { tone: "warning", msg: w.join(" ") } : { tone: "success", msg: L("حُفظت المكونات.", "Components saved.") }); }} />
      ) : null}
      {editSku ? <SkuDialog sku={editSku} productId={p.id} onClose={() => setEditSku(null)} onSaved={() => { setEditSku(null); reload(); setToast({ tone: "success", msg: L("حُفظ الصنف.", "SKU saved.") }); }} /> : null}
      {addSku ? <SkuDialog productId={p.id} onClose={() => setAddSku(false)} onSaved={(sid) => { setAddSku(false); setBomSku(sid); reload(); setToast({ tone: "success", msg: L("أُضيف صنف البيع. أضف مكوناته.", "SKU added. Add its components.") }); }} /> : null}
      {editProduct ? <ProductDialog product={p} onClose={() => setEditProduct(false)} onSaved={() => { setEditProduct(false); reload(); setToast({ tone: "success", msg: L("حُفظ المنتج.", "Product saved.") }); }} /> : null}
    </OpsRoot>
  );
}

/** Add a SKU (POST /api/products) or edit one (PATCH /api/products/:id). Pack size is fixed once created. */
function SkuDialog({ sku, productId, onClose, onSaved }: { sku?: Sku; productId: string; onClose: () => void; onSaved: (id: string) => void }) {
  const L = useL();
  const [code, setCode] = useState(sku?.skuCode ?? "");
  const [weight, setWeight] = useState(sku ? String(sku.weightGrams) : "250");
  const [price, setPrice] = useState(sku ? String(sku.price) : "");
  const [barcode, setBarcode] = useState(sku?.barcode ?? "");
  const [active, setActive] = useState(sku?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (sku) {
        await api(`/api/products/${sku.id}`, { method: "PATCH", json: { skuCode: code, price: Number(price), barcode, isActive: active } });
        onSaved(sku.id);
      } else {
        const r = await api<{ id: string }>("/api/products", { json: { productId, skuCode: code, weightGrams: Number(weight), price: Number(price), barcode, isActive: active } });
        onSaved(r.id);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return (
    <Dialog open testId="sku-dialog" title={sku ? `${L("صنف البيع", "SKU")} · ${sku.skuCode}` : L("إضافة صنف بيع", "Add SKU")} onClose={onClose}
      actions={<><Btn variant="primary" busy={busy} disabled={!code.trim() || !(Number(weight) > 0) || price === ""} onClick={save} data-testid="sku-save">{L("حفظ", "Save")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div className="hr-form">
        <Field label={`${L("رمز الصنف", "SKU code")} *`}><input className="hr-input hr-id" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} data-testid="sku-code" /></Field>
        <Field label={`${L("حجم العبوة · غ", "Pack size · g")} *`} help={sku ? L("لا يتغير بعد الإنشاء: المخزون والطلبات قيست به.", "Fixed once created: stock and orders were measured against it.") : undefined}>
          <input className="hr-input" type="number" min={1} dir="ltr" value={weight} disabled={!!sku} onChange={(e) => setWeight(e.target.value)} data-testid="sku-weight" />
        </Field>
        <Field label={`${L("سعر البيع · ر.س", "Price · SAR")} *`}><input className="hr-input" type="number" min={0} step="0.01" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="sku-price" /></Field>
        <Field label={`${L("الباركود", "Barcode")} ${L("(اختياري)", "(optional)")}`} help={L("13 رقمًا تُتحقق كـ EAN-13.", "13 digits are checked as EAN-13.")}>
          <input className="hr-input hr-id" dir="ltr" value={barcode} onChange={(e) => setBarcode(e.target.value.trim())} data-testid="sku-barcode" />
        </Field>
        <label className="hr-field is-wide cat-checkline"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> <span>{L("نشط · يظهر في الطلبات الجديدة", "Active · offered on new orders")}</span></label>
      </div>
      {/* Reorder point per location for a finished SKU (units of AVAILABLE stock at each site) — saved on its own. */}
      {sku ? <SiteReorderEditor itemKind="PRODUCT_SKU" entityId={sku.id} unit={L("وحدة", "units")} canEdit /> : null}
    </Dialog>
  );
}

/** «تعديل» the product: names, category, status, origin and roasting data. */
function ProductDialog({ product: p, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const { lang } = useI18n();
  const L = useL();
  const ar = lang === "ar";
  const [cats, setCats] = useState<CategoryRef[]>([]);
  const [f, setF] = useState({
    productNameAr: p.productNameAr ?? "", productNameEn: p.productNameEn, categoryId: p.category?.id ?? "", isActive: p.isActive,
    countryEn: p.countryEn, processEn: p.processEn ?? "",
    region: (ar ? p.regionAr : p.regionEn) ?? "", variety: (ar ? p.varietyAr : p.varietyEn) ?? "",
    cupNotes: (ar ? p.cupNotesAr : p.cupNotesEn) ?? "", roastPath: (ar ? p.roastPathAr : p.roastPathEn) ?? "",
    expectedRoastLoss: String(p.expectedRoastLoss),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<CategoryList>("/api/categories").then((c) => setCats(c.items)).catch(() => undefined); }, []);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const country = COUNTRIES.find(([en]) => en === f.countryEn);
  const proc = PROCESSES.find(([en]) => en === f.processEn);
  async function save() {
    setBusy(true); setErr(null);
    const t = (v: string) => (v.trim() ? v.trim() : null);
    try {
      await api(`/api/coffee-products/${p.id}`, {
        method: "PATCH",
        json: {
          ...(f.productNameAr.trim() || p.productNameAr ? { productNameAr: f.productNameAr } : {}),
          productNameEn: f.productNameEn, categoryId: f.categoryId || null, isActive: f.isActive,
          countryEn: f.countryEn, ...(country ? { countryAr: country[1] } : {}),
          processEn: proc?.[0] ?? (f.processEn || null), processAr: proc?.[1] ?? null,
          [ar ? "regionAr" : "regionEn"]: t(f.region), [ar ? "varietyAr" : "varietyEn"]: t(f.variety),
          [ar ? "cupNotesAr" : "cupNotesEn"]: t(f.cupNotes), [ar ? "roastPathAr" : "roastPathEn"]: t(f.roastPath),
          expectedRoastLoss: f.expectedRoastLoss,
        },
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  const catOptions = cats.filter((c) => c.isActive || c.id === p.category?.id);
  return (
    <Dialog open testId="product-dialog" className="stk-wide" title={L("تعديل المنتج", "Edit product")} onClose={onClose}
      actions={<><Btn variant="primary" busy={busy} disabled={!f.productNameEn.trim() || !f.countryEn} onClick={save} data-testid="product-save">{L("حفظ المنتج", "Save product")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div className="hr-form">
        <Field label={`${L("الاسم بالعربية", "Arabic name")} *`}><input className="hr-input" dir="rtl" value={f.productNameAr} onChange={(e) => set("productNameAr", e.target.value)} /></Field>
        <Field label={`${L("الاسم بالإنجليزية", "English name")} *`}><input className="hr-input" dir="ltr" value={f.productNameEn} onChange={(e) => set("productNameEn", e.target.value)} /></Field>
        <Field label={L("التصنيف", "Category")}>
          <Select className="hr-select" value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)} data-testid="pd-category">
            <option value="">{L("بلا تصنيف", "Uncategorised")}</option>
            {catOptions.map((c) => <option key={c.id} value={c.id}>{catName(c, lang)}{c.isActive ? "" : ` (${L("مؤرشف", "archived")})`}</option>)}
          </Select>
        </Field>
        <div className="hr-field">
          <span className="hr-label">{L("حالة المنتج", "Product status")}</span>
          <span className="ops-seg cat-seg" role="group" aria-label={L("حالة المنتج", "Product status")}>
            <button type="button" aria-pressed={f.isActive} onClick={() => set("isActive", true)}>{L("نشط", "Active")}</button>
            <button type="button" aria-pressed={!f.isActive} onClick={() => set("isActive", false)} data-testid="pd-inactive">{L("غير نشط", "Inactive")}</button>
          </span>
          <span className="hr-help">{L("غير النشط لا يظهر في الطلبات الجديدة؛ الطلبات القائمة لا تتأثر.", "An inactive product leaves new orders; existing orders are untouched.")}</span>
        </div>
        <Field label={`${L("الدولة", "Country")} *`}>
          <Select className="hr-select" value={f.countryEn} onChange={(e) => set("countryEn", e.target.value)}>
            {!country ? <option value={f.countryEn}>{pName({ productNameAr: p.countryAr, productNameEn: p.countryEn }, lang)}</option> : null}
            {COUNTRIES.map(([en, a]) => <option key={en} value={en}>{ar ? a : en}</option>)}
          </Select>
        </Field>
        <Field label={L("المعالجة", "Process")}>
          <Select className="hr-select" value={f.processEn} onChange={(e) => set("processEn", e.target.value)}>
            <option value="">{L("غير محددة", "Not set")}</option>
            {f.processEn && !proc ? <option value={f.processEn}>{f.processEn}</option> : null}
            {PROCESSES.map(([en, a]) => <option key={en} value={en}>{ar ? a : en}</option>)}
          </Select>
        </Field>
        <Field label={L("المنطقة", "Region")}><input className="hr-input" value={f.region} onChange={(e) => set("region", e.target.value)} /></Field>
        <Field label={L("الصنف النباتي", "Variety")}><input className="hr-input" value={f.variety} onChange={(e) => set("variety", e.target.value)} /></Field>
        <Field label={L("ملاحظات التذوق", "Tasting notes")}><input className="hr-input" value={f.cupNotes} onChange={(e) => set("cupNotes", e.target.value)} /></Field>
        <Field label={L("مسار التحميص", "Roast path")}><input className="hr-input" value={f.roastPath} onChange={(e) => set("roastPath", e.target.value)} /></Field>
        <Field label={`${L("فقد التحميص المتوقع", "Expected roast loss")} · %`}><input className="hr-input" type="number" min={0} max={50} step="0.1" dir="ltr" value={f.expectedRoastLoss} onChange={(e) => set("expectedRoastLoss", e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
