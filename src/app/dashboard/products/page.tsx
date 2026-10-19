"use client";
// Products — Direction 2.1 (migration phase 2; Figma 256:3410 «جميع المنتجات», phone 271:6183).
//
// Visual port only. Finished Products: one row per sellable SKU, its bill of materials, the coffee
// / origin catalogue and the packaging materials a BOM draws on. The same requests as before
// (GET /api/products?activeOnly=false, /api/materials?activeOnly=false, /api/coffee-products,
// /api/green-beans; POST /api/products, /api/coffee-products, /api/materials; PATCH
// /api/products/:id; GET/PUT /api/products/:id/bom; the materials receive / count routes) and the
// same gates: the page is on the `inventory` module (see src/app/api/products/route.ts), the
// server checks every write. What the frozen frames draw that the backend has no model for —
// user-defined categories, bulk selection, SKU barcode, the product detail page, the one-page
// «إضافة منتج» form — is not built (docs/design/direction-2.1-rc/CATALOG-BACKEND.md).
import { useState, useEffect, useCallback, useMemo } from "react";
import { Btn, Dot, Field, Notice, OpsLoading, OpsRoot, PageHeader, Tabs, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { MaterialForm, MaterialsPanel, PlusIcon, type Material } from "../_components/stock-materials";

type Coffee = {
  id: string;
  productNameEn: string;
  productNameAr: string | null;
  countryEn: string;
  regionEn: string | null;
  processEn: string | null;
  expectedRoastLoss: number;
  defaultGreenBeanId: string | null;
};

type GreenBean = { id: string; serialNumber: string; beanType: string; quantityKg: number };

type Product = {
  id: string;
  skuCode: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  weightGrams: number;
  packSize: string;
  price: number;
  isActive: boolean;
  coffee: { id: string; productNameEn: string } | null;
  bomComponentCount: number;
  hasBom: boolean;
  availableUnits: number;
  reservedUnits: number;
  // Real stock that is NOT free to promise. Shown beside the sellable figure and never
  // added to it: a partial package exists on the shelf and someone has to be able to see
  // it, but it cannot be sold, reserved or dispatched until it is topped up.
  partialPackages: number;
  partialGrams: number;
};

type BomRow = {
  id?: string;
  type: "ROASTED_COFFEE" | "MATERIAL";
  coffeeProductId: string | null;
  materialItemId: string | null;
  quantityPerUnit: number;
};

function TrashIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>;
}

export default function ProductsPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const [tab, setTab] = useState<"products" | "materials" | "coffees">("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [coffees, setCoffees] = useState<Coffee[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [showCoffeeForm, setShowCoffeeForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [showProductForm, setShowProductForm] = useState(false);
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [bomFor, setBomFor] = useState<Product | null>(null);

  // Bumping this re-runs the fetch effect. The effect body itself never calls setState
  // synchronously — everything lands in the async callback — which is what keeps it clear
  // of the cascading-render rule.
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, m, c, g] = await Promise.all([
        fetch("/api/products?activeOnly=false"),
        fetch("/api/materials?activeOnly=false"),
        fetch("/api/coffee-products"),
        fetch("/api/green-beans"),
      ]);
      const [pj, mj, cj, gj] = await Promise.all([
        p.ok ? p.json() : [],
        m.ok ? m.json() : [],
        c.ok ? c.json() : [],
        g.ok ? g.json() : [],
      ]);
      if (cancelled) return;
      setProducts(pj);
      setMaterials(mj);
      setCoffees(cj);
      setBeans(Array.isArray(gj) ? gj : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.skuCode.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  }, [products, search]);

  const visibleMaterials = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter(
      (m) => m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [materials, search]);

  const visibleCoffees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return coffees;
    return coffees.filter(
      (c) =>
        c.productNameEn.toLowerCase().includes(q) ||
        (c.productNameAr ?? "").toLowerCase().includes(q) ||
        c.countryEn.toLowerCase().includes(q)
    );
  }, [coffees, search]);

  const activeSkus = products.filter((p) => p.isActive).length;
  const searchBox = (
    <div className="stk-tool">
      <input type="search" className="hr-input hr-search" value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder={t("searchProductsPlaceholder")} aria-label={t("searchProductsPlaceholder")} />
    </div>
  );

  return (
    <OpsRoot className="stk-products">
    <div className="hr-page">
      <PageHeader
        title={t("productsNav")}
        actions={
          <Btn
            variant="primary"
            onClick={() =>
              tab === "products"
                ? setShowProductForm(true)
                : tab === "materials"
                ? setShowMaterialForm(true)
                : setShowCoffeeForm(true)
            }
          >
            <PlusIcon />
            {tab === "products" ? t("newProductBtn") : tab === "materials" ? t("newMaterialBtn") : t("newCoffeeBtn")}
          </Btn>
        }
      >
        {loading ? <span className="hr-caption">{t("productsSubtitle")}</span> : (
          <span className="hr-caption">
            {lang === "ar"
              ? `${products.length} صنف بيع · ${activeSkus} نشطة · ${coffees.length} بن / منشأ`
              : `${products.length} SKUs · ${activeSkus} active · ${coffees.length} coffees / origins`}
          </span>
        )}
      </PageHeader>

      {error && (
        <Notice tone="danger">
          <span style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <span>{error}</span>
            <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
          </span>
        </Notice>
      )}

      <Tabs
        label={t("productsNav")}
        value={tab}
        onChange={setTab}
        items={[
          { key: "products", label: t("tabProducts"), count: loading ? undefined : products.length },
          { key: "coffees", label: t("tabCoffees"), count: loading ? undefined : coffees.length },
          { key: "materials", label: t("tabMaterials"), count: loading ? undefined : materials.length },
        ]}
      />

      {loading ? (
        <OpsLoading />
      ) : tab === "products" ? (
        <>
          {searchBox}
          <ProductTable products={visibleProducts} onOpenBom={setBomFor} onChanged={load} onError={setError} />
          <p className="stk-foot">{L("المخزون الحر يُقرأ من لوتات المخزون التام، ولا يُعدَّل من الكتالوج.", "Free stock is read from the finished-stock lots; it is never edited from the catalogue.")}</p>
        </>
      ) : tab === "coffees" ? (
        <>
          {searchBox}
          <CoffeeTable coffees={visibleCoffees} products={products} />
        </>
      ) : (
        <MaterialsPanel materials={visibleMaterials} onChanged={load} onError={setError} search={searchBox} />
      )}

      {showProductForm && (
        <ProductForm
          coffees={coffees}
          onClose={() => setShowProductForm(false)}
          onSaved={() => {
            setShowProductForm(false);
            load();
          }}
          onError={setError}
        />
      )}

      {showMaterialForm && (
        <MaterialForm
          onClose={() => setShowMaterialForm(false)}
          onSaved={() => {
            setShowMaterialForm(false);
            load();
          }}
          onError={setError}
        />
      )}

      {showCoffeeForm && (
        <CoffeeForm
          beans={beans}
          onClose={() => setShowCoffeeForm(false)}
          onSaved={() => {
            setShowCoffeeForm(false);
            load();
          }}
          onError={setError}
        />
      )}

      {bomFor && (
        <BomEditor
          product={bomFor}
          coffees={coffees}
          materials={materials.filter((m) => m.isActive)}
          onClose={() => setBomFor(null)}
          onSaved={() => {
            setBomFor(null);
            load();
          }}
          onError={setError}
        />
      )}
    </div>
    </OpsRoot>
  );
}

function ProductTable({
  products,
  onOpenBom,
  onChanged,
  onError,
}: {
  products: Product[];
  onOpenBom: (p: Product) => void;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const L = useL();

  async function toggleActive(p: Product) {
    const res = await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) onError((await res.json()).error ?? "Failed to update product.");
    onChanged();
  }

  if (products.length === 0)
    return <div className="hr-state"><h3>{t("noProductsYet")}</h3></div>;

  const free = products.reduce((s, p) => s + (p.isActive ? p.availableUnits : 0), 0);
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-mrow" aria-label={t("tabProducts")}>
        <thead>
          <tr>
            <th>{t("productNameLabel")}</th>
            <th>{t("skuCodeLabel")}</th>
            <th className="hr-hide-compact">{t("coffeeOriginLabel")}</th>
            <th>{t("packSizeLabel")}</th>
            <th className="num hr-hide-compact">{lang === "ar" ? "السعر · ر.س" : "Price · SAR"}</th>
            <th className="num">{t("finishedStockLabel")}</th>
            <th>{t("bomLabel")}</th>
            <th>{L("الحالة", "Status")}</th>
            <th aria-label={L("الإجراءات", "Actions")} />
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className={p.isActive ? undefined : "is-inactive"}>
              <td className="m-title">
                <span className="strong">{p.name}</span>
                <span className="hr-msub">
                  <span className="hr-id">{p.skuCode}</span> · {p.packSize} · <span className="hr-num">{p.availableUnits}</span> {t("unitsLabel")}
                </span>
              </td>
              <td><span className="hr-id">{p.skuCode}</span></td>
              <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{p.coffee?.productNameEn ?? "—"}</td>
              <td>{p.packSize}</td>
              <td className="num hr-hide-compact"><span className="hr-num">{p.price.toFixed(2)}</span></td>
              <td className="num">
                <strong className="hr-num">{p.availableUnits}</strong>
                <span className="hr-caption"> {t("unitsLabel")}</span>
                {p.reservedUnits > 0 && (
                  <span className="stk-sub">
                    {p.reservedUnits} {t("unitsLabel")} reserved
                  </span>
                )}
                {p.partialPackages > 0 && (
                  <span className="stk-sub" style={{ color: "var(--status-warning)", fontWeight: 500 }} title={t("pkgPartialWarnBody")}>
                    + {p.partialPackages} {t("pkgPartialOnShelf")} ({p.partialGrams} g)
                  </span>
                )}
              </td>
              <td>
                {p.hasBom ? (
                  <span className="hr-caption" style={{ color: "var(--text-secondary)" }}>
                    {lang === "ar" ? `${p.bomComponentCount} مكونات` : `${p.bomComponentCount} components`}
                  </span>
                ) : (
                  <span className="stk-flag">{t("noBomWarning")}</span>
                )}
              </td>
              <td className="m-end">
                <Dot tone={p.isActive ? "success" : "neutral"}>{p.isActive ? t("activeLabel") : t("inactiveLabel")}</Dot>
              </td>
              <td className="stk-acts stk-macts">
                <Btn size="sm" onClick={() => onOpenBom(p)}>{t("bomLabel")}</Btn>
                <Btn size="sm" variant="ghost" onClick={() => toggleActive(p)}>
                  {p.isActive ? t("inactiveLabel") : t("activeLabel")}
                </Btn>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5}>
              {lang === "ar"
                ? `${products.length} صنف بيع · ${products.filter((p) => p.isActive).length} نشطة`
                : `${products.length} SKUs · ${products.filter((p) => p.isActive).length} active`}
            </td>
            <td className="num stk-tot"><span className="hr-num">{free}</span></td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// The coffee / origin catalog: the parent every finished SKU is made from. Creating one
// had no screen at all before — it was API-only — which made the Products section
// unusable from empty, because the origin dropdown had nothing to offer.
function CoffeeTable({ coffees, products }: { coffees: Coffee[]; products: Product[] }) {
  const { t } = useI18n();

  if (coffees.length === 0)
    return <div className="hr-state"><h3>{t("noCoffeesYet")}</h3></div>;

  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-mrow" aria-label={t("tabCoffees")}>
        <thead>
          <tr>
            <th>{t("coffeeNameEnLabel")}</th>
            <th>{t("countryLabel")}</th>
            <th className="hr-hide-compact">{t("regionLabel")}</th>
            <th>{t("processLabel")}</th>
            <th className="num">{t("roastLossLabel")}</th>
            <th className="num">{t("skuCountLabel")}</th>
          </tr>
        </thead>
        <tbody>
          {coffees.map((c) => {
            const skus = products.filter((p) => p.coffee?.id === c.id);
            return (
              <tr key={c.id}>
                <td className="m-title">
                  <span className="strong">{c.productNameAr || c.productNameEn}</span>
                  {c.productNameAr ? <span className="stk-sub hr-desktop-only" dir="ltr" style={{ textAlign: "start" }}><bdi>{c.productNameEn}</bdi></span> : null}
                  <span className="hr-msub">
                    {c.countryEn}{c.regionEn ? ` · ${c.regionEn}` : ""}{c.processEn ? ` · ${c.processEn}` : ""}
                    {skus.length ? <> · <span className="hr-id">{skus.map((p) => p.skuCode).join(" · ")}</span></> : null}
                  </span>
                </td>
                <td>{c.countryEn}</td>
                <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{c.regionEn || "—"}</td>
                <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{c.processEn || "—"}</td>
                <td className="num"><span className="hr-num">{c.expectedRoastLoss}%</span></td>
                <td className="num m-end" style={{ fontWeight: 600 }}><span className="hr-num">{skus.length}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProductForm({
  coffees,
  onClose,
  onSaved,
  onError,
}: {
  coffees: Coffee[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({ productId: "", skuCode: "", name: "", weightGrams: "1000", price: "0" });
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: form.productId,
          skuCode: form.skuCode,
          name: form.name || undefined,
          weightGrams: Number(form.weightGrams),
          price: Number(form.price),
        }),
      });
      if (!res.ok) {
        onError((await res.json()).error ?? "Failed to create product.");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={t("newProductBtn")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={saving} disabled={!form.productId || !form.skuCode} onClick={submit}>{t("newProductBtn")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      {/* An empty dropdown here is a dead end, and the reason is not obvious — say it
          plainly rather than letting the user hunt for a disabled button. */}
      {coffees.length === 0 && <Notice tone="warning">{t("noCoffeesForProduct")}</Notice>}
      <div className="hr-form">
        <Field label={t("coffeeOriginLabel")} wide>
          <select className="hr-select" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
            <option value="">—</option>
            {coffees.map((c) => (
              <option key={c.id} value={c.id}>{c.productNameEn}</option>
            ))}
          </select>
        </Field>
        <Field label={t("skuCodeLabel")}>
          <input className="hr-input hr-id" dir="ltr" value={form.skuCode} onChange={(e) => setForm({ ...form, skuCode: e.target.value })} placeholder="BRA-1KG" />
        </Field>
        <Field label={t("productNameLabel")}>
          <input className="hr-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Brazil Coffee – 1 KG" />
        </Field>
        {/* Pack size is the divisor behind every unit balance, so the API refuses to change
            it later. Saying so here avoids a confusing 409 after the fact. */}
        <Field label={`${t("packSizeLabel")} (g)`} help="Pack size cannot be changed after the product is created.">
          <input className="hr-input" type="number" min={1} value={form.weightGrams} onChange={(e) => setForm({ ...form, weightGrams: e.target.value })} />
        </Field>
        <Field label={t("sellingPriceLabel")}>
          <input className="hr-input" type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function CoffeeForm({
  beans,
  onClose,
  onSaved,
  onError,
}: {
  beans: GreenBean[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    productNameEn: "", productNameAr: "", countryEn: "", regionEn: "", processEn: "",
    defaultGreenBeanId: "", expectedRoastLoss: "15",
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/coffee-products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productNameEn: form.productNameEn,
          productNameAr: form.productNameAr || undefined,
          countryEn: form.countryEn,
          regionEn: form.regionEn || undefined,
          processEn: form.processEn || undefined,
          defaultGreenBeanId: form.defaultGreenBeanId || undefined,
          expectedRoastLoss: Number(form.expectedRoastLoss),
        }),
      });
      if (!res.ok) {
        onError((await res.json()).error ?? "Failed to create coffee.");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={t("newCoffeeBtn")}
      className="stk-wide"
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={saving} disabled={!form.productNameEn.trim() || !form.countryEn.trim()} onClick={submit}>{t("newCoffeeBtn")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      <div className="hr-form">
        <Field label={t("coffeeNameEnLabel")}>
          <input className="hr-input" dir="ltr" value={form.productNameEn} onChange={(e) => setForm({ ...form, productNameEn: e.target.value })} placeholder="Brazil Santos" />
        </Field>
        <Field label={t("coffeeNameArLabel")}>
          <input className="hr-input" dir="rtl" value={form.productNameAr} onChange={(e) => setForm({ ...form, productNameAr: e.target.value })} placeholder="برازيل سانتوس" />
        </Field>
        <Field label={t("countryLabel")}>
          <input className="hr-input" value={form.countryEn} onChange={(e) => setForm({ ...form, countryEn: e.target.value })} placeholder="Brazil" />
        </Field>
        <Field label={t("regionLabel")}>
          <input className="hr-input" value={form.regionEn} onChange={(e) => setForm({ ...form, regionEn: e.target.value })} />
        </Field>
        <Field label={t("processLabel")}>
          <input className="hr-input" value={form.processEn} onChange={(e) => setForm({ ...form, processEn: e.target.value })} placeholder="Washed" />
        </Field>
        {/* Drives the green-bean draw on every production order derived from this
            coffee: expectedGreenBeanKg = target / (1 - loss). */}
        <Field label={t("roastLossLabel")}>
          <input className="hr-input" type="number" min={0} max={50} step="0.1" value={form.expectedRoastLoss}
            onChange={(e) => setForm({ ...form, expectedRoastLoss: e.target.value })} />
        </Field>
        <Field label={t("defaultGreenBeanLabel")} wide help={beans.length === 0 ? t("noGreenBeansYet") : undefined}>
          <select className="hr-select" value={form.defaultGreenBeanId} onChange={(e) => setForm({ ...form, defaultGreenBeanId: e.target.value })}>
            <option value="">—</option>
            {beans.map((b) => (
              <option key={b.id} value={b.id}>{b.beanType} ({b.quantityKg}kg)</option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function BomEditor({
  product,
  coffees,
  materials,
  onClose,
  onSaved,
  onError,
}: {
  product: Product;
  coffees: Coffee[];
  materials: Material[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const L = useL();
  const [rows, setRows] = useState<BomRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/products/${product.id}/bom`);
      if (res.ok) {
        const data = await res.json();
        setRows(
          (data.components ?? []).map((c: BomRow) => ({
            id: c.id,
            type: c.type,
            coffeeProductId: c.coffeeProductId,
            materialItemId: c.materialItemId,
            quantityPerUnit: c.quantityPerUnit,
          }))
        );
      }
      setLoading(false);
    })();
  }, [product.id]);

  function update(idx: number, patch: Partial<BomRow>) {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${product.id}/bom`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          components: rows.map((r) => ({
            type: r.type,
            coffeeProductId: r.coffeeProductId,
            materialItemId: r.materialItemId,
            quantityPerUnit: r.quantityPerUnit,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onError(data.error ?? "Failed to save components.");
        return;
      }
      if (Array.isArray(data.warnings) && data.warnings.length > 0) onError(data.warnings.join(" "));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={`${t("bomLabel")} — ${product.name}`}
      sub={<>{t("bomPerUnitLabel")} · {product.packSize} · <span className="hr-id">{product.skuCode}</span></>}
      className="stk-wide"
      onClose={onClose}
      actions={loading ? undefined : (
        <>
          <Btn variant="primary" busy={saving} onClick={save}>{t("bomSaveBtn")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      )}
    >
      {loading ? (
        <OpsLoading rows={3} />
      ) : (
        <div className="hr-stack" style={{ gap: 0 }}>
          {rows.length === 0 && <Notice tone="info">{t("bomEmpty")}</Notice>}

          {rows.map((r, idx) => (
            <div key={idx} className="stk-bomrow">
              <span className="stk-kind">{r.type === "ROASTED_COFFEE" ? L("بن محمص", "Roasted coffee") : L("مادة تعبئة", "Packaging material")}</span>
              {r.type === "ROASTED_COFFEE" ? (
                <>
                  <select className="hr-select" aria-label={L("بن محمص", "Roasted coffee")} value={r.coffeeProductId ?? ""} onChange={(e) => update(idx, { coffeeProductId: e.target.value })}>
                    <option value="">—</option>
                    {coffees.map((c) => (
                      <option key={c.id} value={c.id}>{c.productNameEn}</option>
                    ))}
                  </select>
                  <input className="hr-input" type="number" step="0.001" min={0} aria-label={t("bomPerUnitLabel")} value={r.quantityPerUnit}
                    onChange={(e) => update(idx, { quantityPerUnit: Number(e.target.value) })} />
                  <span className="stk-u">kg</span>
                </>
              ) : (
                <>
                  <select className="hr-select" aria-label={L("مادة تعبئة", "Packaging material")} value={r.materialItemId ?? ""} onChange={(e) => update(idx, { materialItemId: e.target.value })}>
                    <option value="">—</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} ({m.code})</option>
                    ))}
                  </select>
                  <input className="hr-input" type="number" step="1" min={0} aria-label={t("bomPerUnitLabel")} value={r.quantityPerUnit}
                    onChange={(e) => update(idx, { quantityPerUnit: Number(e.target.value) })} />
                  <span className="stk-u">pcs</span>
                </>
              )}
              <Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label="Remove component" title="Remove component"
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}>
                <TrashIcon />
              </Btn>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 12 }}>
            <Btn size="sm" variant="ghost"
              onClick={() =>
                setRows([...rows, { type: "ROASTED_COFFEE", coffeeProductId: product.coffee?.id ?? null, materialItemId: null, quantityPerUnit: product.weightGrams / 1000 }])
              }
            >
              <PlusIcon />{t("bomAddCoffee")}
            </Btn>
            <Btn size="sm" variant="ghost"
              onClick={() => setRows([...rows, { type: "MATERIAL", coffeeProductId: null, materialItemId: null, quantityPerUnit: 1 }])}
            >
              <PlusIcon />{t("bomAddMaterial")}
            </Btn>
          </div>
        </div>
      )}
    </Dialog>
  );
}
