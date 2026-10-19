"use client";
// Products — Direction 2.1 (Figma 216:2: 256:3410 «جميع المنتجات», 258:3751 «تصنيفات المنتجات»,
// 276:4776 «إضافة تصنيف»; phone 271:6183).
//
// One row per coffee product (CoffeeProduct) with its sale SKUs, never one row per SKU. The list
// is flat (no category headings) and filtered, sorted and paginated on the server
// (GET /api/coffee-products?view=catalog). Bulk «نقل إلى تصنيف» / «تفعيل» run in one transaction
// (POST /api/coffee-products/move, /activate). Categories: GET/POST /api/categories, PATCH /
// DELETE /api/categories/:id, POST /api/categories/:id/products. Everything is on the `inventory`
// module (see src/app/api/products/route.ts); the server checks every write. Packaging
// materials and green coffee live in Inventory (INVENTORY.md: they are not catalog tabs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Dot, FilterChip, Notice, OpsBanner, OpsLoading, OpsPane, OpsRoot, PageHeader, Tabs, rowOpen, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { useD21Phone, useD21Title, usePhone } from "@/components/shell/page-context";
import { PlusIcon } from "../_components/stock-materials";
import {
  api, catName, CategoryDialog, MoveDialog, originLine, pName, priceRange, shortDate, useCanEditCatalog,
  type Category, type CategoryList, type CategoryRef, type ProductPage, type ProductRow,
} from "./_catalog/shared";

type Tab = "products" | "categories";

export default function ProductsPage() {
  const { lang } = useI18n();
  const L = useL();
  const router = useRouter();
  const params = useSearchParams();
  const phone = usePhone();
  const tab: Tab = params.get("tab") === "categories" ? "categories" : "products";
  const setTab = (t: Tab) => router.replace(t === "categories" ? "/dashboard/products?tab=categories" : "/dashboard/products", { scroll: false });
  const canEdit = useCanEditCatalog();

  const [cats, setCats] = useState<CategoryList | null>(null);
  const [catsKey, setCatsKey] = useState(0);
  const reloadCats = useCallback(() => setCatsKey((k) => k + 1), []);
  const [toast, setToast] = useState<{ tone: "success" | "danger"; msg: string } | null>(null);
  const [addCategory, setAddCategory] = useState(false);
  const [listKey, setListKey] = useState(0);
  const [openCatId, setOpenCatId] = useState<string | null>(null);
  const [editingCat, setEditingCat] = useState<Category | null>(null);

  useD21Title(tab === "categories" ? L("تصنيفات المنتجات", "Product categories") : L("جميع المنتجات", "All products"));
  useD21Phone(canEdit ? { title: L("المنتجات", "Products"), action: { href: "/dashboard/products/new", label: L("إضافة منتج", "Add product"), icon: "plus" } } : { title: L("المنتجات", "Products") });

  useEffect(() => {
    let cancelled = false;
    api<CategoryList>("/api/categories?includeArchived=1").then((c) => { if (!cancelled) setCats(c); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [catsKey]);

  const activeCats = (cats?.items ?? []).filter((c) => c.isActive);
  const paneCat = tab === "categories" ? cats?.items.find((c) => c.id === openCatId) ?? null : null;
  const catsChanged = () => { reloadCats(); setListKey((k) => k + 1); };
  const productTotal = cats ? cats.items.reduce((s, c) => s + c.productCount, 0) + cats.uncategorised.productCount : null;
  const skuTotal = cats ? cats.items.reduce((s, c) => s + c.skuCount, 0) + cats.uncategorised.skuCount : null;

  return (
    <OpsRoot className="stk-products cat-products">
      <div className={`hr-split${paneCat ? " has-preview" : ""}`}>
        <div className="hr-page">
          <PageHeader
            title={L("المنتجات", "Products")}
            actions={canEdit ? (
              tab === "categories" ? (
                <>
                  <Link className="hr-btn" href="/dashboard/products/new"><PlusIcon />{L("إضافة منتج", "Add product")}</Link>
                  <Btn variant="primary" onClick={() => setAddCategory(true)} data-testid="add-category"><PlusIcon />{L("إضافة تصنيف", "Add category")}</Btn>
                </>
              ) : (
                <Link className="hr-btn is-primary" href="/dashboard/products/new" data-testid="add-product"><PlusIcon />{L("إضافة منتج", "Add product")}</Link>
              )
            ) : null}
          >
            {productTotal !== null ? (
              <span className="hr-caption">
                {lang === "ar"
                  ? `${productTotal} منتجات • ${skuTotal} صنف بيع • ${activeCats.length} تصنيفات`
                  : `${productTotal} products • ${skuTotal} SKUs • ${activeCats.length} categories`}
              </span>
            ) : null}
          </PageHeader>

          {toast ? <OpsBanner tone={toast.tone} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

          <Tabs
            underline={!phone}
            label={L("المنتجات", "Products")}
            value={tab}
            onChange={setTab}
            items={[
              { key: "products", label: phone ? L("المنتجات", "Products") : L("جميع المنتجات", "All products"), count: phone || productTotal === null ? undefined : productTotal },
              { key: "categories", label: phone ? L("التصنيفات", "Categories") : L("تصنيفات المنتجات", "Product categories"), count: phone || !cats ? undefined : activeCats.length },
            ]}
          />

          {tab === "products" ? (
            <ProductsTab key={listKey} categories={cats?.items ?? []} canEdit={canEdit} onChanged={reloadCats} onToast={setToast} />
          ) : (
            <CategoriesTab cats={cats} openId={paneCat?.id ?? null} onOpen={setOpenCatId} />
          )}
        </div>
        {paneCat && cats ? (
          <CategoryPane key={paneCat.id} category={paneCat} categories={cats.items} canEdit={canEdit} onClose={() => setOpenCatId(null)}
            onEdit={() => setEditingCat(paneCat)} onChanged={catsChanged} onToast={setToast} />
        ) : null}
      </div>
      {editingCat ? (
        <CategoryDialog category={editingCat} onClose={() => setEditingCat(null)} onSaved={() => { setEditingCat(null); catsChanged(); setToast({ tone: "success", msg: L("حُفظ التصنيف.", "Category saved.") }); }} />
      ) : null}

      {addCategory ? (
        <AddCategory onClose={() => setAddCategory(false)} onSaved={(c) => { setAddCategory(false); reloadCats(); setListKey((k) => k + 1); setToast({ tone: "success", msg: L(`أُنشئ التصنيف «${c.nameAr}».`, `Category «${c.nameAr}» created.`) }); }} />
      ) : null}
    </OpsRoot>
  );
}

/** The Add Category dialog with the product list to move in (all products, by name). */
function AddCategory({ onClose, onSaved }: { onClose: () => void; onSaved: (c: CategoryRef) => void }) {
  const { lang } = useI18n();
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  useEffect(() => {
    api<ProductPage>("/api/coffee-products?view=catalog&pageSize=200").then((p) => setProducts(p.items)).catch(() => setProducts([]));
  }, []);
  if (!products) return null;
  return (
    <CategoryDialog
      products={products.map((p) => ({ id: p.id, name: pName(p, lang), categoryName: p.category ? catName(p.category, lang) : null }))}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// ─── «جميع المنتجات» (256:3410) ──────────────────────────────────────────────

const PAGE_SIZE = 25;

function ProductsTab({ categories, canEdit, onChanged, onToast }: {
  categories: Category[];
  canEdit: boolean;
  onChanged: () => void;
  onToast: (t: { tone: "success" | "danger"; msg: string }) => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const router = useRouter();
  const phone = usePhone();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"name" | "-name">("name");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProductPage | null>(null);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Selection survives paging (id → the row as last seen); it clears when the filter changes.
  const [sel, setSel] = useState<Map<string, ProductRow>>(new Map());
  const [allResults, setAllResults] = useState(false);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const filterKey = `${q}|${categoryId}|${status}|${sort}`;
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    if (lastFilter.current === filterKey) return;
    lastFilter.current = filterKey;
    setPage(1);
    setSel(new Map());
    setAllResults(false);
  }, [filterKey]);

  const query = useMemo(() => {
    const sp = new URLSearchParams({ view: "catalog", sort, page: String(page), pageSize: String(PAGE_SIZE), lang });
    if (q) sp.set("q", q);
    if (categoryId) sp.set("categoryId", categoryId);
    if (status) sp.set("status", status);
    return sp.toString();
  }, [q, categoryId, status, sort, page, lang]);

  useEffect(() => {
    let cancelled = false;
    api<ProductPage>(`/api/coffee-products?${query}`)
      .then((d) => {
        if (cancelled) return;
        setErr(null);
        setData(d);
        // The phone list grows as it scrolls (INVENTORY.md «Mobile»); the desktop shows one page.
        setRows((prev) => (phone && d.page > 1 ? [...prev, ...d.items] : d.items));
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [query, reload, phone]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!phone || !data || !sentinel.current) return;
    if (data.page * data.pageSize >= data.total) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setPage((p) => (p === data.page ? p + 1 : p)); });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [phone, data]);

  const refresh = () => { setReload((k) => k + 1); onChanged(); };
  const pageIds = rows.map((r) => r.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const pageSome = pageIds.some((id) => sel.has(id));
  const toggle = (r: ProductRow) => { setAllResults(false); setSel((s) => { const n = new Map(s); if (n.has(r.id)) n.delete(r.id); else n.set(r.id, r); return n; }); };
  const togglePage = () => {
    setAllResults(false);
    setSel((s) => { const n = new Map(s); if (pageAll) for (const r of rows) n.delete(r.id); else for (const r of rows) n.set(r.id, r); return n; });
  };
  const selCount = allResults ? data?.total ?? 0 : sel.size;
  const selRows = [...sel.values()];
  const filterBody = { q, categoryId: categoryId || null, status: status || "all" };
  const selectionBody = allResults ? { filter: filterBody } : { productIds: [...sel.keys()] };
  const anyInactive = allResults ? status !== "active" : selRows.some((r) => !r.isActive);
  const anyActive = allResults ? status !== "inactive" : selRows.some((r) => r.isActive);

  async function bulk(url: string, body: Record<string, unknown>, done: (n: number) => string) {
    setBusy(true);
    try {
      const r = await api<{ updated: number }>(url, { json: { ...selectionBody, ...body } });
      onToast({ tone: "success", msg: done(r.updated) });
      setSel(new Map()); setAllResults(false);
      refresh();
    } catch (e) {
      onToast({ tone: "danger", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const statusOptions = [{ value: "active", label: L("نشط", "Active") }, { value: "inactive", label: L("غير نشط", "Inactive") }];
  const catOptions = [
    ...categories.filter((c) => c.isActive || c.id === categoryId).map((c) => ({ value: c.id, label: catName(c, lang) })),
    { value: "none", label: L("بلا تصنيف", "Uncategorised") },
  ];
  const n = (v: number) => v.toLocaleString("en-US");
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="stk-tool cat-tool">
        <input type="search" className="hr-input hr-search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={L("اسم المنتج أو رمز الصنف", "Product name or SKU code")} aria-label={L("اسم المنتج أو رمز الصنف", "Product name or SKU code")} data-testid="products-search" />
        <span className="hr-desktop-only cat-chips">
          <FilterChip label={L("التصنيف", "Category")} value={categoryId} onChange={setCategoryId} options={catOptions} />
          <FilterChip label={L("الحالة", "Status")} value={status} onChange={setStatus} options={statusOptions} />
        </span>
        <span className="stk-sp" />
        <button type="button" className="hr-btn is-ghost is-sm cat-sort hr-desktop-only" onClick={() => setSort((s) => (s === "name" ? "-name" : "name"))}
          aria-label={L("ترتيب حسب الاسم", "Sort by name")}>
          {L("ترتيب", "Sort")}: {L("الاسم", "Name")} {sort === "name" ? "↑" : "↓"}
        </button>
      </div>

      {canEdit && selCount > 0 ? (
        <div className="cat-selbar" role="region" aria-label={L("المحدد", "Selection")} data-testid="selection-bar">
          <input type="checkbox" checked aria-label={L("إلغاء التحديد", "Clear selection")} onChange={() => { setSel(new Map()); setAllResults(false); }} />
          <span className="cat-selbar-text">
            {L("محدد", "Selected")} <b className="hr-num">{n(selCount)}</b>
            {!allResults ? <> · {selRows.slice(0, 3).map((r) => pName(r, lang)).join(lang === "ar" ? "، " : ", ")}{selRows.length > 3 ? "…" : ""}</> : <> · {L("كل نتائج الفلتر الحالي", "every result of the current filter")}</>}
          </span>
          {!allResults && pageAll && data && data.total > rows.length ? (
            <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setAllResults(true)} data-testid="select-all-results">
              {L(`تحديد كل النتائج (${n(data.total)})`, `Select all results (${n(data.total)})`)}
            </button>
          ) : null}
          <span className="stk-sp" />
          <Btn size="sm" disabled={busy} onClick={() => setMoving(true)} data-testid="bulk-move">{L("نقل إلى تصنيف", "Move to category")}</Btn>
          {anyInactive ? (
            <Btn size="sm" busy={busy} onClick={() => bulk("/api/coffee-products/activate", { isActive: true }, (k) => L(`فُعِّل ${k} من المنتجات.`, `${k} products activated.`))} data-testid="bulk-activate">{L("تفعيل", "Activate")}</Btn>
          ) : null}
          {anyActive ? (
            <Btn size="sm" busy={busy} onClick={() => bulk("/api/coffee-products/activate", { isActive: false }, (k) => L(`أُوقف ${k} من المنتجات؛ لن تظهر في الطلبات الجديدة.`, `${k} products deactivated; they no longer appear on new orders.`))} data-testid="bulk-deactivate">{L("إيقاف", "Deactivate")}</Btn>
          ) : null}
          <Btn size="sm" variant="ghost" onClick={() => { setSel(new Map()); setAllResults(false); }}>{L("إلغاء التحديد", "Clear selection")}</Btn>
        </div>
      ) : null}

      {err ? <Notice tone="danger">{err}</Notice> : null}
      {!data ? <OpsLoading /> : rows.length === 0 ? (
        <div className="hr-state"><h3>{q || categoryId || status ? L("لا منتجات تطابق الفلتر.", "No products match the filter.") : L("لا منتجات بعد.", "No products yet.")}</h3></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow cat-table" aria-label={L("جميع المنتجات", "All products")} data-testid="products-table">
            <thead>
              <tr>
                {canEdit ? (
                  <th className="cat-ck">
                    <input type="checkbox" aria-label={L("تحديد الصفحة", "Select page")} checked={pageAll}
                      ref={(el) => { if (el) el.indeterminate = !pageAll && pageSome; }} onChange={togglePage} />
                  </th>
                ) : null}
                <th>{L("المنتج", "Product")}</th>
                <th className="hr-hide-compact">{L("المنشأ والمعالجة", "Origin and process")}</th>
                <th>{L("أصناف البيع", "SKUs")}</th>
                <th className="num hr-hide-compact">{L("السعر · ر.س", "Price · SAR")}</th>
                <th className="num">{L("حر للبيع · وحدة", "Free · units")}</th>
                <th>{L("الحالة", "Status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const open = () => router.push(`/dashboard/products/${p.id}`);
                const codes = p.skus.map((s) => s.skuCode).join(" · ");
                return (
                  <tr key={p.id} {...rowOpen(open)} aria-selected={sel.has(p.id) || undefined} className={`is-clickable cat-row${p.isActive ? "" : " is-inactive"}`} data-testid={`product-row-${p.id}`}>
                    {canEdit ? (
                      <td className="cat-ck" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={pName(p, lang)} checked={allResults || sel.has(p.id)} disabled={allResults} onChange={() => toggle(p)} />
                      </td>
                    ) : null}
                    <td className="m-title">
                      <span className="strong">{pName(p, lang)}</span>
                      {lang === "ar" && p.productNameAr ? <span className="stk-sub hr-desktop-only" dir="ltr" style={{ textAlign: "start" }}><bdi>{p.productNameEn}</bdi></span> : null}
                      <span className="hr-msub"><span className="hr-id" dir="ltr"><bdi>{codes || "—"}</bdi></span></span>
                    </td>
                    <td className="hr-hide-compact cat-muted">{originLine(p, lang) || "—"}</td>
                    <td><span className="hr-id cat-codes" dir="ltr"><bdi>{codes || "—"}</bdi></span></td>
                    <td className="num hr-hide-compact"><span className="hr-num">{priceRange(p.priceMin, p.priceMax)}</span></td>
                    <td className="num cat-free">
                      {p.freeUnits > 0 ? <strong className="hr-num">{n(p.freeUnits)}</strong>
                        : <span className="cat-muted">{p.everProduced ? L("لا مخزون", "No stock") : L("لم يُنتج بعد", "Not produced yet")}</span>}
                    </td>
                    <td className="cat-status">
                      <Dot tone={p.isActive ? "success" : "neutral"}>{p.isActive ? L("نشط", "Active") : L("غير نشط", "Inactive")}</Dot>
                    </td>
                    <td className="hr-mobile-cell m-end cat-mend">
                      <span className="cat-mfree hr-num">{p.freeUnits > 0 ? n(p.freeUnits) : p.everProduced ? "0" : "—"}</span>
                      <Dot tone={p.isActive ? "success" : "neutral"}>{p.isActive ? L("نشط", "Active") : L("غير نشط", "Inactive")}</Dot>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {data ? (
              <tfoot>
                <tr>
                  {canEdit ? <td /> : null}
                  <td colSpan={4} className="cat-foot-sum">
                    {lang === "ar"
                      ? `${n(data.total)} منتجات · ${n(data.totals.skuCount)} صنف بيع · ${n(data.totals.activeProductCount)} نشطة`
                      : `${n(data.total)} products · ${n(data.totals.skuCount)} SKUs · ${n(data.totals.activeProductCount)} active`}
                  </td>
                  <td className="num stk-tot"><span className="hr-num">{n(data.totals.freeUnits)}</span></td>
                  <td />
                </tr>
                {!phone && data.total > data.pageSize ? (
                  <tr className="cat-pager">
                    <td colSpan={canEdit ? 7 : 6}>
                      <span className="hr-num">{n((data.page - 1) * data.pageSize + 1)}–{n(Math.min(data.total, data.page * data.pageSize))}</span> {L("من", "of")} <span className="hr-num">{n(data.total)}</span>
                      <Btn size="sm" variant="ghost" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>{L("السابق", "Previous")}</Btn>
                      <Btn size="sm" variant="ghost" disabled={data.page >= totalPages} onClick={() => setPage(data.page + 1)}>{L("التالي", "Next")}</Btn>
                    </td>
                  </tr>
                ) : null}
              </tfoot>
            ) : null}
          </table>
          <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />
        </div>
      )}
      <p className="stk-foot hr-desktop-only">{L("المخزون الحر يُقرأ من لوتات المخزون التام، ولا يُعدَّل من الكتالوج.", "Free stock is read from the finished-stock lots; it is never edited from the catalogue.")}</p>

      {moving ? (
        <MoveDialog
          count={selCount}
          categories={categories}
          onClose={() => setMoving(false)}
          onMove={async (target) => {
            const r = await api<{ updated: number }>("/api/coffee-products/move", { json: { ...selectionBody, categoryId: target } });
            setMoving(false);
            onToast({ tone: "success", msg: L(`نُقل ${r.updated} من المنتجات.`, `${r.updated} products moved.`) });
            setSel(new Map()); setAllResults(false);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

// ─── «تصنيفات المنتجات» (258:3751) ───────────────────────────────────────────

function CategoriesTab({ cats, openId, onOpen }: { cats: CategoryList | null; openId: string | null; onOpen: (id: string) => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  if (!cats) return <OpsLoading />;
  const s = search.trim().toLowerCase();
  const list = cats.items.filter((c) => (status === "all" || c.isActive) && (!s || c.nameAr.toLowerCase().includes(s) || (c.nameEn ?? "").toLowerCase().includes(s)));
  const active = cats.items.filter((c) => c.isActive).length;
  const archived = cats.items.length - active;
  const n = (v: number) => v.toLocaleString("en-US");

  return (
    <>
        <div className="stk-tool">
          <input type="search" className="hr-input hr-search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={L("اسم التصنيف", "Category name")} aria-label={L("اسم التصنيف", "Category name")} />
          <span className="hr-desktop-only">
            <FilterChip label={L("الحالة", "Status")} value={status === "all" ? "all" : "active"} onChange={(v) => setStatus(v || "active")}
              allLabel={L("نشطة", "Active")} options={[{ value: "all", label: L("نشطة ومؤرشفة", "Active and archived") }]} />
          </span>
          <span className="stk-sp" />
          <span className="hr-caption hr-desktop-only cat-sortlabel">{L("ترتيب", "Sort")}: {L("يدوي", "manual")}</span>
        </div>

        <div className="hr-tablewrap">
          <table className="hr-table is-mrow cat-table" aria-label={L("تصنيفات المنتجات", "Product categories")} data-testid="categories-table">
            <thead>
              <tr>
                <th>{L("التصنيف", "Category")}</th>
                <th className="num">{L("المنتجات", "Products")}</th>
                <th className="num">{L("أصناف البيع", "SKUs")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th className="hr-hide-compact">{L("آخر تعديل", "Last edited")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} {...rowOpen(() => onOpen(c.id))} aria-selected={openId === c.id || undefined} className={`is-clickable cat-row${c.isActive ? "" : " is-inactive"}`} data-testid={`category-row-${c.id}`}>
                  <td className="m-title">
                    <span className="strong">{catName(c, lang)}</span>
                    {c.description ? <span className="stk-sub">{c.description}</span> : null}
                    <span className="hr-msub">{lang === "ar" ? `${n(c.productCount)} منتجات · ${n(c.skuCount)} أصناف` : `${n(c.productCount)} products · ${n(c.skuCount)} SKUs`}</span>
                  </td>
                  <td className="num">{c.isActive || c.productCount ? <span className="hr-num">{n(c.productCount)}</span> : "—"}</td>
                  <td className="num">{c.isActive || c.skuCount ? <span className="hr-num">{n(c.skuCount)}</span> : "—"}</td>
                  <td className="m-end"><Dot tone={c.isActive ? "success" : "neutral"}>{c.isActive ? L("نشط", "Active") : L("مؤرشف", "Archived")}</Dot></td>
                  <td className="hr-hide-compact cat-muted">{shortDate(c.updatedAt, lang)}</td>
                </tr>
              ))}
              {!s ? (
                <tr className="cat-row is-virtual">
                  <td className="m-title">
                    <span className="strong">{L("بلا تصنيف", "Uncategorised")}</span>
                    <span className="stk-sub">{L("منتجات لم يُحدَّد تصنيفها", "Products without a category")}</span>
                    <span className="hr-msub">{lang === "ar" ? `${n(cats.uncategorised.productCount)} منتجات` : `${n(cats.uncategorised.productCount)} products`}</span>
                  </td>
                  <td className="num">{cats.uncategorised.productCount ? <span className="hr-num">{n(cats.uncategorised.productCount)}</span> : "—"}</td>
                  <td className="num">{cats.uncategorised.skuCount ? <span className="hr-num">{n(cats.uncategorised.skuCount)}</span> : "—"}</td>
                  <td className="m-end cat-muted">{L("تلقائي", "Automatic")}</td>
                  <td className="hr-hide-compact" />
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>
                  {lang === "ar"
                    ? `${n(active)} تصنيفات نشطة · ${n(archived)} مؤرشف · كل منتج في تصنيف واحد`
                    : `${n(active)} active categories · ${n(archived)} archived · each product is in one category`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="stk-foot">{L("التصنيفات مستوى واحد. المؤرشف يختفي من القوائم والفلاتر وتبقى منتجاته قابلة للعرض.", "Categories are one level. An archived one leaves the lists and filters; its products stay viewable.")}</p>
    </>
  );
}

type CategoryDetail = Category & { products: { id: string; productNameAr: string | null; productNameEn: string; isActive: boolean; productSkus: { id: string; skuCode: string }[] }[] };

function CategoryPane({ category, categories, canEdit, onClose, onEdit, onChanged, onToast }: {
  category: Category;
  categories: Category[];
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onToast: (t: { tone: "success" | "danger"; msg: string }) => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [detail, setDetail] = useState<CategoryDetail | null>(null);
  const [key, setKey] = useState(0);
  const [moveOf, setMoveOf] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<CategoryDetail>(`/api/categories/${category.id}`).then((d) => { if (!cancelled) setDetail(d); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [category.id, key, category.updatedAt]);

  const refresh = () => { setKey((k) => k + 1); onChanged(); };
  const held = detail?.products.length ?? category.productCount;

  async function archive(isActive: boolean) {
    setBusy(true);
    try {
      await api(`/api/categories/${category.id}`, { method: "PATCH", json: { isActive } });
      onToast({ tone: "success", msg: isActive ? L("استُعيد التصنيف.", "Category restored.") : L("أُرشف التصنيف؛ يختفي من القوائم والفلاتر.", "Category archived; it leaves the lists and filters.") });
      refresh();
    } catch (e) {
      onToast({ tone: "danger", msg: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/categories/${category.id}`, { method: "DELETE" });
      onToast({ tone: "success", msg: L("حُذف التصنيف.", "Category deleted.") });
      onClose();
      onChanged();
    } catch (e) {
      onToast({ tone: "danger", msg: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  }

  return (
    <OpsPane
      testId="category-pane"
      label={catName(category, lang)}
      drawer="open"
      title={
        <span className="cat-panetitle">
          {catName(category, lang)} <Dot tone={category.isActive ? "success" : "neutral"}>{category.isActive ? L("نشط", "Active") : L("مؤرشف", "Archived")}</Dot>
          {canEdit ? <Btn size="sm" variant="ghost" className="cat-paneedit-btn" onClick={onEdit} data-testid="category-edit">{L("تعديل", "Edit")}</Btn> : null}
        </span>
      }
      onClose={onClose}
      busy={busy}
      footer={canEdit ? (
        <div className="cat-panefoot">
          <div className="cat-panefoot-btns">
            <Btn busy={busy} onClick={() => archive(!category.isActive)} data-testid="category-archive">{category.isActive ? L("أرشفة التصنيف", "Archive category") : L("استعادة التصنيف", "Restore category")}</Btn>
            <Btn variant={held > 0 ? "secondary" : "danger"} disabled={busy || held > 0} onClick={() => setConfirmDelete(true)} data-testid="category-delete">{L("حذف", "Delete")}</Btn>
          </div>
          {held > 0 ? <span className="hr-help">{L("لا يُحذف تصنيف يحتوي منتجات. انقل منتجاته أولًا، أو أرشفه ليختفي من القوائم.", "A category holding products cannot be deleted. Move its products first, or archive it to take it out of the lists.")}</span> : null}
        </div>
      ) : undefined}
    >
      {category.description ? <p className="cat-panedesc">{category.description}</p> : null}
      <dl className="hr-kv cat-kv">
        <div><dt>{L("المنتجات", "Products")}</dt><dd className="hr-num">{(detail?.productCount ?? category.productCount).toLocaleString("en-US")}</dd></div>
        <div><dt>{L("أصناف البيع", "SKUs")}</dt><dd className="hr-num">{(detail?.skuCount ?? category.skuCount).toLocaleString("en-US")}</dd></div>
        <div><dt>{L("الاسم بالإنجليزية", "English name")}</dt><dd dir="ltr">{category.nameEn || "—"}</dd></div>
        <div><dt>{L("آخر تعديل", "Last edited")}</dt><dd>{shortDate(category.updatedAt, lang)}{category.updatedByName ? ` · ${category.updatedByName}` : ""}</dd></div>
      </dl>

      <div className="cat-panesec">
        <h3 className="hr-section">{L("المنتجات في التصنيف", "Products in the category")}</h3>
        {canEdit && category.isActive ? <Btn size="sm" variant="ghost" onClick={() => setAdding(true)} data-testid="category-add-products"><PlusIcon />{L("إضافة منتجات", "Add products")}</Btn> : null}
      </div>
      {!detail ? <OpsLoading rows={3} /> : detail.products.length === 0 ? (
        <p className="hr-caption">{L("لا منتجات في هذا التصنيف.", "No products in this category.")}</p>
      ) : (
        <ul className="cat-panelist">
          {detail.products.map((p) => (
            <li key={p.id}>
              <span className="cat-pl-main">
                <Link href={`/dashboard/products/${p.id}`} className="strong">{pName(p, lang)}</Link>
                <span className="hr-id" dir="ltr"><bdi>{p.productSkus.map((s) => s.skuCode).join(" · ") || "—"}</bdi></span>
              </span>
              <Dot tone={p.isActive ? "success" : "neutral"}>{p.isActive ? L("نشط", "Active") : L("غير نشط", "Inactive")}</Dot>
              {canEdit ? <Btn size="sm" variant="ghost" onClick={() => setMoveOf(p.id)}>{L("نقل", "Move")}</Btn> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="hr-help">{L("المنتج في تصنيف واحد فقط. «نقل» يغيّر تصنيفه دون أن يمس أصنافه أو مخزونه.", "A product is in one category only. «Move» changes its category without touching its SKUs or stock.")}</p>

      {moveOf ? (
        <MoveDialog count={1} categories={categories.filter((c) => c.id !== category.id)} onClose={() => setMoveOf(null)}
          onMove={async (target) => {
            await api(`/api/coffee-products/${moveOf}`, { method: "PATCH", json: { categoryId: target } });
            setMoveOf(null);
            onToast({ tone: "success", msg: L("نُقل المنتج.", "Product moved.") });
            refresh();
          }} />
      ) : null}
      {adding ? <AddProductsDialog category={category} onClose={() => setAdding(false)} onDone={(k) => { setAdding(false); onToast({ tone: "success", msg: L(`نُقل ${k} من المنتجات إلى التصنيف.`, `${k} products moved into the category.`) }); refresh(); }} /> : null}
      {confirmDelete ? (
        <Dialog open title={L("حذف التصنيف", "Delete category")} onClose={() => setConfirmDelete(false)}
          actions={<><Btn variant="danger" busy={busy} onClick={remove}>{L("حذف", "Delete")}</Btn><Btn onClick={() => setConfirmDelete(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
          <p>{L(`يُحذف «${category.nameAr}» نهائيًا.`, `«${category.nameAr}» is deleted for good.`)}</p>
        </Dialog>
      ) : null}
    </OpsPane>
  );
}

/** «إضافة منتجات» in the pane: products outside this category, moved in at once. */
function AddProductsDialog({ category, onClose, onDone }: { category: Category; onClose: () => void; onDone: (n: number) => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<ProductPage>("/api/coffee-products?view=catalog&pageSize=200").then((p) => setRows(p.items.filter((x) => x.category?.id !== category.id))).catch(() => setRows([]));
  }, [category.id]);
  return (
    <Dialog open testId="add-products-dialog" title={L("إضافة منتجات", "Add products")} sub={catName(category, lang)} onClose={onClose}
      actions={<>
        <Btn variant="primary" busy={busy} disabled={picked.size === 0} onClick={async () => {
          setBusy(true); setErr(null);
          try { const r = await api<{ moved: number }>(`/api/categories/${category.id}/products`, { json: { productIds: [...picked] } }); onDone(r.moved); }
          catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
        }}>{L("نقل إلى التصنيف", "Move into category")}</Btn>
        <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
      </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      {!rows ? <OpsLoading rows={3} /> : rows.length === 0 ? <p className="hr-caption">{L("كل المنتجات في هذا التصنيف.", "Every product is already in this category.")}</p> : (
        <div className="cat-picks">
          <ul>
            {rows.map((p) => (
              <li key={p.id}>
                <label>
                  <input type="checkbox" checked={picked.has(p.id)} onChange={() => setPicked((s) => { const x = new Set(s); if (x.has(p.id)) x.delete(p.id); else x.add(p.id); return x; })} />
                  <span className="cat-pick-name">{pName(p, lang)}</span>
                </label>
                <span className="cat-pick-now">{p.category ? `${L("حاليًا", "Now")}: ${catName(p.category, lang)}` : L("بلا تصنيف", "Uncategorised")}</span>
              </li>
            ))}
          </ul>
          <span className="hr-help">{L("المنتجات المحددة تُنقل من تصنيفها الحالي.", "Selected products move out of their current category.")}</span>
        </div>
      )}
    </Dialog>
  );
}
