"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Package, Plus, Search, X, Layers, Boxes, AlertTriangle, Coffee, Tag, Save, Trash2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// Finished Products: one row per sellable SKU, its bill of materials, and the packaging
// materials a BOM draws on. Gated on the `inventory` module — see the note in
// src/app/api/products/route.ts for why this is not a new permission module.

type Coffee = { id: string; productNameEn: string; productNameAr: string | null };

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
};

type Material = {
  id: string;
  code: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  quantityOnHand: number;
  reorderPoint: number;
  isActive: boolean;
  usedInProductCount: number;
  belowReorderPoint: boolean;
};

type BomRow = {
  id?: string;
  type: "ROASTED_COFFEE" | "MATERIAL";
  coffeeProductId: string | null;
  materialItemId: string | null;
  quantityPerUnit: number;
};

export default function ProductsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"products" | "materials">("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [coffees, setCoffees] = useState<Coffee[]>([]);
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
      const [p, m, c] = await Promise.all([
        fetch("/api/products?activeOnly=false"),
        fetch("/api/materials?activeOnly=false"),
        fetch("/api/coffee-products"),
      ]);
      const [pj, mj, cj] = await Promise.all([
        p.ok ? p.json() : [],
        m.ok ? m.json() : [],
        c.ok ? c.json() : [],
      ]);
      if (cancelled) return;
      setProducts(pj);
      setMaterials(mj);
      setCoffees(cj);
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

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-2">
            <Package size={24} className="text-orange" /> {t("productsTitle")}
          </h1>
          <p className="text-brown text-sm font-medium">{t("productsSubtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => (tab === "products" ? setShowProductForm(true) : setShowMaterialForm(true))}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-oo-action-primary text-white text-sm font-bold hover:bg-oo-action-primary-hover transition-colors"
        >
          <Plus size={16} /> {tab === "products" ? t("newProductBtn") : t("newMaterialBtn")}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 text-red-700 text-sm font-medium px-4 py-2.5 flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {(["products", "materials"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
              tab === key
                ? "bg-oo-bg-elevated text-oo-text-primary border-2 border-oo-border-strong"
                : "bg-oo-bg-subtle text-oo-text-secondary border-2 border-transparent hover:border-oo-border-default"
            }`}
          >
            {key === "products" ? t("tabProducts") : t("tabMaterials")}
          </button>
        ))}
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-oo-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchProductsPlaceholder")}
            className="w-full ps-9 pe-3 py-2 rounded-xl border border-oo-border-default bg-white text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16">
          <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-brown text-sm font-medium">{t("loading")}</p>
        </div>
      ) : tab === "products" ? (
        <ProductTable products={visibleProducts} onOpenBom={setBomFor} onChanged={load} onError={setError} />
      ) : (
        <MaterialTable materials={visibleMaterials} onChanged={load} onError={setError} />
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
  const { t } = useI18n();

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
    return (
      <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border">
        <Package size={40} className="mx-auto mb-2" />
        <p>{t("noProductsYet")}</p>
      </div>
    );

  return (
    <div className="bg-white rounded-2xl border border-oo-border-default overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead>
          <tr className="border-b border-oo-border-default text-oo-text-secondary text-xs font-bold uppercase">
            <th className="text-start p-3">{t("skuCodeLabel")}</th>
            <th className="text-start p-3">{t("productNameLabel")}</th>
            <th className="text-start p-3">{t("coffeeOriginLabel")}</th>
            <th className="text-start p-3">{t("packSizeLabel")}</th>
            <th className="text-end p-3">{t("sellingPriceLabel")}</th>
            <th className="text-end p-3">{t("finishedStockLabel")}</th>
            <th className="text-start p-3">{t("bomLabel")}</th>
            <th className="text-end p-3" />
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className={`border-b border-oo-border-default last:border-0 ${p.isActive ? "" : "opacity-55"}`}>
              <td className="p-3 font-mono text-xs font-bold text-oo-text-primary">{p.skuCode}</td>
              <td className="p-3 font-semibold text-oo-text-primary">{p.name}</td>
              <td className="p-3 text-oo-text-secondary">{p.coffee?.productNameEn ?? "—"}</td>
              <td className="p-3 text-oo-text-secondary">{p.packSize}</td>
              <td className="p-3 text-end text-oo-text-secondary">{p.price.toFixed(2)}</td>
              <td className="p-3 text-end">
                <span className="font-extrabold text-oo-text-primary">{p.availableUnits}</span>
                <span className="text-oo-text-muted text-xs"> {t("unitsLabel")}</span>
                {p.reservedUnits > 0 && (
                  <div className="text-[11px] text-oo-text-muted">
                    {p.reservedUnits} {t("unitsLabel")} reserved
                  </div>
                )}
              </td>
              <td className="p-3">
                {p.hasBom ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-oo-status-success">
                    <Layers size={13} /> {p.bomComponentCount}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-oo-status-blocked">
                    <AlertTriangle size={13} /> {t("noBomWarning")}
                  </span>
                )}
              </td>
              <td className="p-3 text-end whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onOpenBom(p)}
                  className="px-3 py-1.5 rounded-lg border border-oo-border-strong text-xs font-bold text-oo-text-primary hover:bg-oo-bg-subtle"
                >
                  {t("bomLabel")}
                </button>
                <button
                  type="button"
                  onClick={() => toggleActive(p)}
                  className="ms-2 px-3 py-1.5 rounded-lg border border-oo-border-default text-xs font-semibold text-oo-text-secondary hover:bg-oo-bg-subtle"
                >
                  {p.isActive ? t("inactiveLabel") : t("activeLabel")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MaterialTable({
  materials,
  onChanged,
  onError,
}: {
  materials: Material[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [value, setValue] = useState("");

  async function saveCount(m: Material) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      onError("Counted quantity must be zero or more.");
      return;
    }
    const res = await fetch(`/api/materials/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newActualQuantity: n }),
    });
    if (!res.ok) onError((await res.json()).error ?? "Failed to adjust stock.");
    setAdjusting(null);
    setValue("");
    onChanged();
  }

  if (materials.length === 0)
    return (
      <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border">
        <Boxes size={40} className="mx-auto mb-2" />
        <p>{t("noMaterialsYet")}</p>
      </div>
    );

  return (
    <div className="bg-white rounded-2xl border border-oo-border-default overflow-x-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead>
          <tr className="border-b border-oo-border-default text-oo-text-secondary text-xs font-bold uppercase">
            <th className="text-start p-3">{t("materialCodeLabel")}</th>
            <th className="text-start p-3">{t("materialNameLabel")}</th>
            <th className="text-start p-3">{t("categoryLabel")}</th>
            <th className="text-end p-3">{t("onHandLabel")}</th>
            <th className="text-end p-3">{t("reorderPointLabel")}</th>
            <th className="text-end p-3">{t("usedInLabel")}</th>
            <th className="text-end p-3" />
          </tr>
        </thead>
        <tbody>
          {materials.map((m) => (
            <tr key={m.id} className={`border-b border-oo-border-default last:border-0 ${m.isActive ? "" : "opacity-55"}`}>
              <td className="p-3 font-mono text-xs font-bold text-oo-text-primary">{m.code}</td>
              <td className="p-3 font-semibold text-oo-text-primary">{m.name}</td>
              <td className="p-3 text-oo-text-secondary text-xs">{m.category}</td>
              <td className="p-3 text-end">
                <span className="font-extrabold text-oo-text-primary">{m.quantityOnHand}</span>
                {m.belowReorderPoint && (
                  <div className="text-[11px] font-semibold text-oo-status-blocked">{t("lowStockLabel")}</div>
                )}
              </td>
              <td className="p-3 text-end text-oo-text-secondary">{m.reorderPoint || "—"}</td>
              <td className="p-3 text-end text-oo-text-secondary">{m.usedInProductCount}</td>
              <td className="p-3 text-end whitespace-nowrap">
                {adjusting === m.id ? (
                  <span className="inline-flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="number"
                      min={0}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={t("adjustStockLabel")}
                      className="w-28 px-2 py-1.5 rounded-lg border border-oo-border-strong text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => saveCount(m)}
                      className="px-2.5 py-1.5 rounded-lg bg-oo-action-primary text-white text-xs font-bold"
                    >
                      <Save size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAdjusting(null); setValue(""); }}
                      className="px-2.5 py-1.5 rounded-lg border border-oo-border-default text-xs"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setAdjusting(m.id); setValue(String(m.quantityOnHand)); }}
                    className="px-3 py-1.5 rounded-lg border border-oo-border-strong text-xs font-bold text-oo-text-primary hover:bg-oo-bg-subtle"
                  >
                    {t("adjustStockLabel")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-8 shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-oo-border-default">
          <h2 className="font-extrabold text-oo-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={20} className="text-oo-text-muted" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
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

  const field = "w-full px-3 py-2 rounded-xl border border-oo-border-default text-sm";

  return (
    <Modal title={t("newProductBtn")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-bold text-oo-text-secondary">{t("coffeeOriginLabel")}</span>
          <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} className={field}>
            <option value="">—</option>
            {coffees.map((c) => (
              <option key={c.id} value={c.id}>{c.productNameEn}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold text-oo-text-secondary">{t("skuCodeLabel")}</span>
          <input value={form.skuCode} onChange={(e) => setForm({ ...form, skuCode: e.target.value })} className={field} placeholder="BRA-1KG" />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-oo-text-secondary">{t("productNameLabel")}</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} placeholder="Brazil Coffee – 1 KG" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("packSizeLabel")} (g)</span>
            <input type="number" min={1} value={form.weightGrams} onChange={(e) => setForm({ ...form, weightGrams: e.target.value })} className={field} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("sellingPriceLabel")}</span>
            <input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={field} />
          </label>
        </div>
        {/* Pack size is the divisor behind every unit balance, so the API refuses to change
            it later. Saying so here avoids a confusing 409 after the fact. */}
        <p className="text-[11px] text-oo-text-muted">
          Pack size cannot be changed after the product is created.
        </p>
        <button
          type="button"
          disabled={saving || !form.productId || !form.skuCode}
          onClick={submit}
          className="w-full py-2.5 rounded-xl bg-oo-action-primary text-white font-bold text-sm disabled:opacity-50"
        >
          {saving ? "…" : t("newProductBtn")}
        </button>
      </div>
    </Modal>
  );
}

function MaterialForm({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({ code: "", name: "", category: "PACKAGING", quantityOnHand: "0", reorderPoint: "0" });
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          category: form.category,
          quantityOnHand: Number(form.quantityOnHand),
          reorderPoint: Number(form.reorderPoint),
        }),
      });
      if (!res.ok) {
        onError((await res.json()).error ?? "Failed to create material.");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full px-3 py-2 rounded-xl border border-oo-border-default text-sm";

  return (
    <Modal title={t("newMaterialBtn")} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("materialCodeLabel")}</span>
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={field} placeholder="BAG-1KG" />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("categoryLabel")}</span>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={field}>
              <option value="PACKAGING">PACKAGING</option>
              <option value="LABEL">LABEL</option>
              <option value="CONSUMABLE">CONSUMABLE</option>
              <option value="OTHER">OTHER</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-bold text-oo-text-secondary">{t("materialNameLabel")}</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} placeholder="1KG Coffee Bag" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("onHandLabel")}</span>
            <input type="number" min={0} value={form.quantityOnHand} onChange={(e) => setForm({ ...form, quantityOnHand: e.target.value })} className={field} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-oo-text-secondary">{t("reorderPointLabel")}</span>
            <input type="number" min={0} value={form.reorderPoint} onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })} className={field} />
          </label>
        </div>
        <button
          type="button"
          disabled={saving || !form.code || !form.name}
          onClick={submit}
          className="w-full py-2.5 rounded-xl bg-oo-action-primary text-white font-bold text-sm disabled:opacity-50"
        >
          {saving ? "…" : t("newMaterialBtn")}
        </button>
      </div>
    </Modal>
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

  const field = "px-2.5 py-1.5 rounded-lg border border-oo-border-default text-sm";

  return (
    <Modal title={`${t("bomLabel")} — ${product.name}`} onClose={onClose}>
      {loading ? (
        <p className="text-sm text-oo-text-muted py-6 text-center">{t("loading")}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-oo-text-muted">
            {t("bomPerUnitLabel")} · {product.packSize}
          </p>

          {rows.length === 0 && (
            <p className="text-sm text-oo-text-muted bg-oo-bg-subtle rounded-xl p-3">{t("bomEmpty")}</p>
          )}

          {rows.map((r, idx) => (
            <div key={idx} className="flex items-center gap-2 flex-wrap border border-oo-border-default rounded-xl p-2.5">
              {r.type === "ROASTED_COFFEE" ? (
                <>
                  <Coffee size={15} className="text-oo-text-secondary" />
                  <select
                    value={r.coffeeProductId ?? ""}
                    onChange={(e) => update(idx, { coffeeProductId: e.target.value })}
                    className={`${field} flex-1 min-w-[160px]`}
                  >
                    <option value="">—</option>
                    {coffees.map((c) => (
                      <option key={c.id} value={c.id}>{c.productNameEn}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.001"
                    min={0}
                    value={r.quantityPerUnit}
                    onChange={(e) => update(idx, { quantityPerUnit: Number(e.target.value) })}
                    className={`${field} w-24`}
                  />
                  <span className="text-xs font-bold text-oo-text-muted">kg</span>
                </>
              ) : (
                <>
                  <Tag size={15} className="text-oo-text-secondary" />
                  <select
                    value={r.materialItemId ?? ""}
                    onChange={(e) => update(idx, { materialItemId: e.target.value })}
                    className={`${field} flex-1 min-w-[160px]`}
                  >
                    <option value="">—</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} ({m.code})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="1"
                    min={0}
                    value={r.quantityPerUnit}
                    onChange={(e) => update(idx, { quantityPerUnit: Number(e.target.value) })}
                    className={`${field} w-24`}
                  />
                  <span className="text-xs font-bold text-oo-text-muted">pcs</span>
                </>
              )}
              <button
                type="button"
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                className="p-1.5 rounded-lg text-oo-status-blocked hover:bg-red-50"
                aria-label="Remove component"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() =>
                setRows([...rows, { type: "ROASTED_COFFEE", coffeeProductId: product.coffee?.id ?? null, materialItemId: null, quantityPerUnit: product.weightGrams / 1000 }])
              }
              className="px-3 py-1.5 rounded-lg border border-oo-border-strong text-xs font-bold hover:bg-oo-bg-subtle"
            >
              <Coffee size={13} className="inline me-1" /> {t("bomAddCoffee")}
            </button>
            <button
              type="button"
              onClick={() => setRows([...rows, { type: "MATERIAL", coffeeProductId: null, materialItemId: null, quantityPerUnit: 1 }])}
              className="px-3 py-1.5 rounded-lg border border-oo-border-strong text-xs font-bold hover:bg-oo-bg-subtle"
            >
              <Tag size={13} className="inline me-1" /> {t("bomAddMaterial")}
            </button>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="w-full py-2.5 rounded-xl bg-oo-action-primary text-white font-bold text-sm disabled:opacity-50"
          >
            {saving ? "…" : t("bomSaveBtn")}
          </button>
        </div>
      )}
    </Modal>
  );
}
