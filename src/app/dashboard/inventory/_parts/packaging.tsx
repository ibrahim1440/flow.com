"use client";
// Packaging materials tab — Figma 253:2987. The table and its receive / count dialogs are the shared
// MaterialsPanel; this adds the frame's 7-day usage and «packs coverable» metrics, the category
// filter chip, the sort and the recent movements (formulas: src/lib/inventory/metrics.ts).
import { useEffect, useMemo, useState } from "react";
import { Btn, FilterChip, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { PACK_WINDOW_DAYS } from "@/lib/inventory/metrics";
import { MaterialsPanel, type Material } from "../../_components/stock-materials";
import { MATERIAL_CATEGORY, RecentMovements, SortControl, int } from "./shared";

type Usage = { used: number; rate: number | null; coverage: number | "INF" | null };
type PackOverview = {
  total: number | null;
  usage: Record<string, Usage>;
  packs: { headline: { skuCode: string; name: string; nameAr: string | null; weightGrams: number; units: number; limiting: { name: string; nameAr: string | null } } | null };
};
type Sort = "coverage" | "stock" | "name";

export function PackagingTab({ materials, onChanged, onError, onOpenLedger, refreshKey }: {
  materials: Material[]; onChanged: () => void; onError: (m: string) => void; onOpenLedger: () => void; refreshKey: number;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [ov, setOv] = useState<PackOverview | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<Sort>("coverage");

  useEffect(() => {
    let off = false;
    fetch("/api/inventory/overview?section=packaging").then((r) => (r.ok ? r.json() : null)).then((j) => { if (!off) setOv(j); });
    return () => { off = true; };
  }, [refreshKey]);

  const catLabel = (c: string) => (MATERIAL_CATEGORY[c] ? (lang === "ar" ? MATERIAL_CATEGORY[c][0] : MATERIAL_CATEGORY[c][1]) : c);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = materials.filter((m) => (showInactive || m.isActive) && (!cat || m.category === cat) && (!s || `${m.code} ${m.name} ${m.nameAr ?? ""}`.toLowerCase().includes(s)));
    // «الأقل تغطية»: days of stock at the 7-day usage; a material not used in the window (or with too
    // little history) sorts after the ones that are, below-reorder first among equals.
    const cov = (m: Material) => { const u = ov?.usage[m.id]; return u?.coverage === "INF" || u?.coverage == null ? 1e9 : u.coverage; };
    if (sort === "coverage") rows.sort((a, b) => cov(a) - cov(b) || Number(b.belowReorderPoint) - Number(a.belowReorderPoint) || a.quantityOnHand - b.quantityOnHand);
    if (sort === "stock") rows.sort((a, b) => a.quantityOnHand - b.quantityOnHand);
    if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name, lang));
    return rows;
  }, [materials, q, cat, showInactive, sort, ov, lang]);

  const activeMats = materials.filter((m) => m.isActive);
  const low = activeMats.filter((m) => m.belowReorderPoint);
  const head = ov?.packs.headline ?? null;
  const size = (g: number) => (g >= 1000 ? `${g / 1000} ${lang === "ar" ? "كغ" : "kg"}` : `${g} ${lang === "ar" ? "غ" : "g"}`);

  return (
    <section className="hr-stack" aria-label={L("مواد التعبئة", "Packaging materials")}>
      <div className="stk-metrics">
        <div>
          <span className="stk-lbl">{L("مواد نشطة", "Active materials")}</span>
          <span className="stk-mid">{activeMats.length}</span>
          <span className="stk-d">{L("تعبئة · ملصقات · مستهلكات", "Packaging · labels · consumables")}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("تحت حد إعادة الطلب", "Below reorder point")}</span>
          <span className={`stk-mid${low.length ? " tone-warning" : ""}`}>{low.length}</span>
          <span className="stk-d">{low.map((m) => (lang === "ar" && m.nameAr ? m.nameAr : m.name)).join(lang === "ar" ? "، " : ", ") || "—"}</span>
        </div>
        <div>
          <span className="stk-lbl">{L(`مستهلك آخر ${PACK_WINDOW_DAYS} أيام`, `Used in the last ${PACK_WINDOW_DAYS} days`)}</span>
          <span className="stk-mid">{ov?.total == null ? "—" : int(ov.total)}{ov?.total == null ? null : <span className="stk-unit">{L("قطعة", "pieces")}</span>}</span>
          <span className="stk-d">{ov?.total == null ? L(`السجل أقصر من ${PACK_WINDOW_DAYS} أيام`, `History shorter than ${PACK_WINDOW_DAYS} days`) : L("استهلاك مكونات عند التعبئة", "Components drawn by packing")}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("تكفي للتعبئة", "Enough to pack")}</span>
          <span className="stk-mid">{head ? int(head.units) : "—"}{head ? <span className="stk-unit">{L("عبوة", "packs")}</span> : null}</span>
          <span className="stk-d">{head ? `${size(head.weightGrams)} · ${L("تحدّها", "limited by")} ${lang === "ar" && head.limiting.nameAr ? head.limiting.nameAr : head.limiting.name}` : L("لا منتج بمكوّنات تعبئة", "No product with packaging components")}</span>
        </div>
      </div>

      <MaterialsPanel
        materials={shown}
        onChanged={onChanged}
        onError={onError}
        search={
          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={L("رمز المادة أو اسمها", "Material code or name")}
              aria-label={L("رمز المادة أو اسمها", "Material code or name")} value={q} onChange={(e) => setQ(e.target.value)} />
            <FilterChip label={L("الفئة", "Category")} value={cat} onChange={setCat}
              options={Object.keys(MATERIAL_CATEGORY).map((c) => ({ value: c, label: catLabel(c) }))} />
            <Btn size="sm" className="stk-toggle" aria-pressed={showInactive} onClick={() => setShowInactive((p) => !p)}>
              {L("إظهار غير النشطة", "Show inactive")}
            </Btn>
            <span className="stk-end">
              <SortControl<Sort> value={sort} onChange={setSort} options={[
                { value: "coverage", label: L("الأقل تغطية", "Least covered") },
                { value: "stock", label: L("الأقل رصيدًا", "Lowest stock") },
                { value: "name", label: L("الاسم", "Name") },
              ]} />
            </span>
          </div>
        }
      />

      <RecentMovements category="PACKAGING_MATERIAL" withDoc title={L("آخر حركات مواد التعبئة", "Latest packaging movements")} onOpenLedger={onOpenLedger} refreshKey={refreshKey} />
    </section>
  );
}
