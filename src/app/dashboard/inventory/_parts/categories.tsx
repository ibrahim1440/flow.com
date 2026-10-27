"use client";
// Unified inventory, phase 1 — the category navigation of the inventory page and its «الكل» view.
//   ≥1024: a side rail («الكل», then each main category with its sub-categories, item counts and low-stock badges);
//   below: chips that scroll sideways (the main categories, then the selected one's sub-categories).
// The «الكل» view lists every stock item (green lots and items) with its category, in plain words.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { SEED } from "@/lib/inventory/item-categories";
import { categoryPath, type Material } from "../../_components/stock-materials";
import type { CategoryNode } from "./add-item";
import type { GreenBean } from "./green";
import { LOW_KG } from "./green";
import { fmtQty, int, unitWord } from "./shared";

const nameOf = (c: { nameAr: string; nameEn: string | null }, lang: "ar" | "en") => (lang === "ar" ? c.nameAr : c.nameEn || c.nameAr);

/** Items in a category and its sub-categories; low-stock likewise (green lots below the low line count as low). */
function totals(c: CategoryNode, all: CategoryNode[], greenLow: number): { n: number; low: number } {
  const kids = c.parentId ? [] : all.filter((x) => x.parentId === c.id);
  const lowOf = (x: CategoryNode) => (x.template === "GREEN_COFFEE" ? greenLow : x.lowCount);
  return { n: c.itemCount + kids.reduce((a, k) => a + k.itemCount, 0), low: lowOf(c) + kids.reduce((a, k) => a + lowOf(k), 0) };
}

function Count({ n, low, lang }: { n: number; low: number; lang: "ar" | "en" }) {
  return (
    <span className="inv-end">
      {low > 0 ? <span className="inv-low" title={lang === "ar" ? `${low} تحت حد إعادة الطلب` : `${low} below reorder point`} aria-label={lang === "ar" ? `${low} منخفض` : `${low} low`}>{low}</span> : null}
      <span className="inv-n">{n}</span>
    </span>
  );
}

export function CategoryRail({ categories, value, onChange, totalItems, greenLow, canManage }: {
  categories: CategoryNode[]; value: string; onChange: (id: string) => void; totalItems: number; greenLow: number; canManage: boolean;
}) {
  const { lang } = useI18n();
  const L = useL();
  const roots = categories.filter((c) => !c.parentId);
  const allLow = roots.reduce((a, r) => a + totals(r, categories, greenLow).low, 0);
  return (
    <nav className="inv-rail" aria-label={L("التصنيفات", "Categories")} data-testid="category-rail">
      <button type="button" aria-current={value === "all"} onClick={() => onChange("all")} data-testid="cat-all">
        <span>{L("الكل", "All")}</span><Count n={totalItems} low={allLow} lang={lang} />
      </button>
      {roots.map((r) => {
        const t = totals(r, categories, greenLow);
        return (
          <div key={r.id} className="inv-rail-group">
            <button type="button" className="is-root" aria-current={value === r.id} onClick={() => onChange(r.id)} data-testid={`cat-${r.id}`}>
              <span>{nameOf(r, lang)}</span><Count n={t.n} low={t.low} lang={lang} />
            </button>
            {categories.filter((c) => c.parentId === r.id).map((c) => {
              const k = totals(c, categories, greenLow);
              return (
                <button key={c.id} type="button" className="is-child" aria-current={value === c.id} onClick={() => onChange(c.id)} data-testid={`cat-${c.id}`}>
                  <span>{nameOf(c, lang)}</span><Count n={k.n} low={k.low} lang={lang} />
                </button>
              );
            })}
          </div>
        );
      })}
      <p className="inv-rail-foot">
        <Link className="ops-link" href="/dashboard/inventory/categories">{canManage ? L("إدارة التصنيفات", "Manage categories") : L("عرض التصنيفات", "View categories")}</Link>
      </p>
    </nav>
  );
}

export function CategoryChips({ categories, value, onChange, totalItems, greenLow }: {
  categories: CategoryNode[]; value: string; onChange: (id: string) => void; totalItems: number; greenLow: number;
}) {
  const { lang } = useI18n();
  const L = useL();
  const roots = categories.filter((c) => !c.parentId);
  const cur = categories.find((c) => c.id === value);
  const root = cur ? (cur.parentId ? categories.find((c) => c.id === cur.parentId) : cur) : undefined;
  const kids = root ? categories.filter((c) => c.parentId === root.id) : [];
  return (
    <div className="inv-chips" data-testid="category-chips">
      <div className="inv-chiprow" role="group" aria-label={L("التصنيفات", "Categories")}>
        <button type="button" aria-pressed={value === "all"} onClick={() => onChange("all")}>{L("الكل", "All")} <span className="hr-num">{totalItems}</span></button>
        {roots.map((r) => {
          const t = totals(r, categories, greenLow);
          return (
            <button key={r.id} type="button" aria-pressed={root?.id === r.id} onClick={() => onChange(r.id)}>
              {nameOf(r, lang)} <span className="hr-num">{t.n}</span>{t.low ? <span className="inv-low">{t.low}</span> : null}
            </button>
          );
        })}
      </div>
      {kids.length ? (
        <div className="inv-chiprow is-sub" role="group" aria-label={root ? nameOf(root, lang) : ""}>
          {kids.map((c) => (
            <button key={c.id} type="button" aria-pressed={value === c.id} onClick={() => onChange(c.id)}>
              {nameOf(c, lang)} <span className="hr-num">{totals(c, categories, greenLow).n}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type Row = { key: string; name: string; sub: string; catId: string; catLabel: string; qty: string; unit: string; reorder: string; low: boolean; kind: "green" | "item" };

/** «الكل»: every active stock item with its category, quantity and unit; low ones first. */
export function AllItemsView({ beans, materials, categories, onOpenCategory }: {
  beans: GreenBean[]; materials: Material[]; categories: CategoryNode[]; onOpenCategory: (id: string) => void;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [q, setQ] = useState("");
  const green = categories.find((c) => c.id === SEED.green);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const b of beans.filter((x) => x.isActive)) {
      out.push({
        key: `g:${b.id}`, kind: "green", name: lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType, sub: b.serialNumber,
        catId: SEED.green, catLabel: green ? categoryPath(green, categories, lang) : L("بن أخضر", "Green coffee"),
        qty: fmtQty(b.quantityKg, 2), unit: unitWord("KG", lang), reorder: "—", low: b.quantityKg > 0 && b.quantityKg < LOW_KG,
      });
    }
    for (const m of materials.filter((x) => x.isActive)) {
      const c = categories.find((x) => x.id === m.categoryId);
      out.push({
        key: `m:${m.id}`, kind: "item", name: lang === "ar" && m.nameAr ? m.nameAr : m.name, sub: m.code,
        catId: c?.id ?? "", catLabel: c ? categoryPath(c, categories, lang) : "—",
        qty: String(m.quantityOnHand), unit: unitWord(m.unitOfMeasure, lang, m.quantityOnHand), reorder: m.reorderPoint ? String(m.reorderPoint) : "—", low: m.belowReorderPoint,
      });
    }
    const s = q.trim().toLowerCase();
    const shown = s ? out.filter((r) => `${r.name} ${r.sub} ${r.catLabel}`.toLowerCase().includes(s)) : out;
    return shown.sort((a, b) => Number(b.low) - Number(a.low) || a.catLabel.localeCompare(b.catLabel, lang) || a.name.localeCompare(b.name, lang));
  }, [beans, materials, categories, green, lang, q, L]);
  const low = rows.filter((r) => r.low).length;
  const roots = categories.filter((c) => !c.parentId).length;

  return (
    <section className="hr-stack" aria-label={L("كل الأصناف", "All items")} data-testid="inventory-all">
      <div className="stk-metrics inv-kpis" style={{ ["--stk-cols" as string]: 3 }}>
        <div>
          <span className="stk-lbl">{L("أصناف نشطة", "Active items")}</span>
          <span className="stk-mid">{int(rows.length)}</span>
          <span className="stk-d">{L(`في ${roots} تصنيفات رئيسية`, `in ${roots} main categories`)}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("تحت حد إعادة الطلب", "Below reorder point")}</span>
          <span className={`stk-mid${low ? " tone-warning" : ""}`}>{low}</span>
          <span className="stk-d">{low ? L("تظهر أولًا في القائمة", "listed first") : L("لا شيء منخفض", "Nothing low")}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("البن المحمص والمنتجات الجاهزة", "Roasted coffee and finished products")}</span>
          <span className="stk-mid">{int(categories.filter((c) => c.template === "ROASTED_COFFEE" || c.template === "FINISHED").reduce((a, c) => a + c.itemCount, 0))}</span>
          <span className="stk-d">{L("من التحميص والتعبئة — في تصنيفاتها", "from roasting and packing — in their categories")}</span>
        </div>
      </div>
      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={L("اسم الصنف أو التصنيف", "Item or category name")} aria-label={L("اسم الصنف أو التصنيف", "Item or category name")} />
      </div>
      {rows.length === 0 ? (
        <div className="hr-state"><h3>{q ? L("لا أصناف مطابقة.", "No matching items.") : L("لا أصناف بعد — ابدأ بـ«إضافة صنف».", "No items yet — start with «Add item».")}</h3></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("كل الأصناف", "All items")}>
            <thead>
              <tr>
                <th>{L("الصنف", "Item")}</th>
                <th>{L("التصنيف", "Category")}</th>
                <th className="num">{L("الرصيد", "On hand")}</th>
                <th className="num hr-hide-compact">{L("حد إعادة الطلب", "Reorder point")}</th>
                <th aria-label={L("التنبيه", "Flag")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="m-title">
                    <span className="strong">{r.name}</span>
                    <span className="stk-sub hr-id hr-desktop-only">{r.sub}</span>
                    <span className="hr-msub">{r.catLabel} · <span className="hr-num">{r.qty}</span> {r.unit}</span>
                  </td>
                  <td>
                    {r.catId ? <button type="button" className="hr-btn is-ghost is-sm" onClick={() => onOpenCategory(r.catId)}>{r.catLabel}</button> : r.catLabel}
                  </td>
                  <td className={`num${r.low ? " is-low" : ""}`}><span className="hr-num">{r.qty}</span> <span className="hr-caption">{r.unit}</span></td>
                  <td className="num hr-hide-compact"><span className="hr-num">{r.reorder}</span></td>
                  <td className="m-end" style={{ textAlign: "end" }}>{r.low ? <span className="stk-flag">{L("منخفض", "Low")}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
