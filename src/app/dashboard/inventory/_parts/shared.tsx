"use client";
// Inventory (Figma 216:2) — the pieces the five tabs share: labels for movement types, sources and
// categories, the «recent movements» block (251:2482 / 253:2987), a coverage bar, number helpers.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { StatusDot, opsDate, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";

/** A stored quantity: "—" unless a finite number (Infinity arrives as JSON null). */
export const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

/** Thousands-separated whole number (1,088). */
export const int = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—";

export const TYPE_MAP: Record<string, [string, "success" | "neutral" | "warning" | "danger", string]> = {
  IN: ["وارد", "success", "In"],
  OUT: ["صادر", "neutral", "Out"],
  ADJUSTMENT: ["تسوية", "warning", "Adjustment"],
  LOSS: ["فاقد", "danger", "Loss"],
};

export const SRC_LABELS: Record<string, [string, string]> = {
  PURCHASE: ["شراء", "Purchase"],
  ROASTING_BATCH: ["دفعة تحميص", "Roasting batch"],
  DELIVERY: ["توصيل", "Delivery"],
  PACKING: ["تعبئة", "Packing"],
  BOM_CONSUMPTION: ["استهلاك مكونات", "Component use"],
  MANUAL_ADJUSTMENT: ["جرد يدوي", "Manual count"],
  BLEND: ["خلط", "Blend"],
  PRODUCTION_ORDER: ["أمر إنتاج", "Production order"],
  OPENING_BALANCE: ["رصيد افتتاحي (استلام)", "Opening balance (receipt)"],
  RECEIVING: ["استلام توريد", "Receiving"],
};

export const CAT_LABELS: Record<string, [string, string]> = {
  RAW_MATERIAL: ["مواد خام", "Raw material"],
  FINISHED_GOODS: ["منتج تام", "Finished goods"],
  ROASTED_COFFEE: ["بن محمص", "Roasted coffee"],
  // Every MaterialItem movement: packaging, labels and (unified inventory) café supplies.
  PACKAGING_MATERIAL: ["مواد ومستلزمات", "Materials and supplies"],
};

export const MATERIAL_CATEGORY: Record<string, [string, string]> = {
  PACKAGING: ["تعبئة", "Packaging"],
  LABEL: ["ملصق", "Label"],
  CONSUMABLE: ["مستهلك", "Consumable"],
  OTHER: ["أخرى", "Other"],
};

/** The unit word after a quantity: كغ / قطعة / وحدة / لتر. */
export function unitWord(unit: string | null | undefined, lang: "ar" | "en", n?: number): string {
  if (unit === "KG" || unit === "kg") return lang === "ar" ? "كغ" : "kg";
  if (unit === "GRAM") return lang === "ar" ? "غ" : "g";
  if (unit === "UNIT") return lang === "ar" ? "وحدة" : n === 1 ? "unit" : "units";
  if (unit === "LITER") return lang === "ar" ? "لتر" : n === 1 ? "litre" : "litres";
  return lang === "ar" ? (n !== undefined && n > 2 && n < 11 ? "قطع" : "قطعة") : n === 1 ? "piece" : "pieces";
}

export type EnrichedMovement = {
  id: string;
  type: "IN" | "OUT" | "ADJUSTMENT" | "LOSS";
  category: string;
  referenceEntityId: string | null;
  quantityChanged: number;
  previousQuantity: number;
  newQuantity: number;
  sourceDocType: string;
  sourceDocId: string | null;
  timestamp: string;
  notes: string | null;
  entityLabel: string | null;
  entityLabelAr: string | null;
  entityCode: string | null;
  unit: string | null;
  sourceRef: string | null;
  countNumber: number | null;
  userName: string | null;
};

export const timeOf = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Riyadh" });

/** «اليوم 10:20» → just the time for today, «أمس 16:40» otherwise (the frames' time column). */
export function whenShort(ts: string, lang: "ar" | "en"): string {
  const day = opsDate(ts, lang);
  const today = lang === "ar" ? "اليوم" : "Today";
  return day === today ? timeOf(ts) : `${day} ${timeOf(ts)}`;
}

/** The signed change with its unit, as the ledger and the recent-movements blocks show it. */
export function changeText(m: Pick<EnrichedMovement, "quantityChanged" | "unit" | "category">, lang: "ar" | "en"): string {
  const v = m.quantityChanged;
  if (!Number.isFinite(v) || Math.abs(v) < 0.0005) return "—";
  const discrete = m.unit === "PIECE" || m.unit === "UNIT";
  const n = discrete ? int(Math.abs(v)) : Math.abs(v).toFixed(2);
  // Arabic: the frames' «–5.00 كغ» (an en dash, which the RTL paragraph places at the number's right);
  // English: «−5.00 kg».
  const sign = v > 0 ? "+" : lang === "ar" ? "–" : "−";
  return `${sign}${n} ${unitWord(m.unit ?? "KG", lang, Math.abs(v))}`;
}

/** A signed quantity with its unit, laid out as the frames draw it (no LTR isolation). */
export function QtyChange({ m, className }: { m: Pick<EnrichedMovement, "quantityChanged" | "unit" | "category">; className?: string }) {
  const { lang } = useI18n();
  return <span className={`stk-qtyc${className ? ` ${className}` : ""}`}>{changeText(m, lang)}</span>;
}

export function MovementType({ type }: { type: string }) {
  return <StatusDot map={TYPE_MAP} value={TYPE_MAP[type] ? type : "OUT"} />;
}

/**
 * «آخر حركات …» (251:2482, 253:2987): the five newest movements of one category, from the
 * paginated ledger endpoint, with a link to the full ledger tab.
 */
export function RecentMovements({ category, title, onOpenLedger, refreshKey, withDoc, itemCategoryId }: {
  category: "RAW_MATERIAL" | "PACKAGING_MATERIAL"; title: string; onOpenLedger: () => void; refreshKey?: number; withDoc?: boolean;
  /** Unified inventory: only this item category's movements (a main category covers its sub-categories). */
  itemCategoryId?: string;
}) {
  const { lang } = useI18n();
  const L = useL();
  const [rows, setRows] = useState<EnrichedMovement[] | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory-movements?page=1&pageSize=10&category=${category}${itemCategoryId ? `&itemCategory=${encodeURIComponent(itemCategoryId)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!off) setRows(j ? (j.rows as EnrichedMovement[]).slice(0, 5) : []); });
    return () => { off = true; };
  }, [category, refreshKey, itemCategoryId]);
  const disp = (en: string | null, ar: string | null) => (lang === "ar" && ar ? ar : en ?? "—");
  return (
    <section className="hr-stack stk-recent" aria-label={title}>
      <div className="ops-sechead">
        <h2>{title}</h2>
        <button type="button" className="hr-btn is-ghost is-sm stk-lk" onClick={onOpenLedger}>
          {L("سجل الحركات", "Movement ledger")} <span aria-hidden="true">{lang === "ar" ? "‹" : "›"}</span>
        </button>
      </div>
      {rows === null ? <div className="hr-skel" style={{ width: "60%" }} /> : rows.length === 0 ? (
        <p className="hr-caption">{L("لا حركات بعد.", "No movements yet.")}</p>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow">
            <thead>
              <tr>
                <th>{L("الوقت", "Time")}</th>
                <th>{L("النوع", "Type")}</th>
                <th>{category === "RAW_MATERIAL" || itemCategoryId ? L("الصنف", "Item") : L("المادة", "Material")}</th>
                <th>{L("المصدر", "Source")}</th>
                {withDoc ? <th className="hr-hide-compact">{L("المستند", "Document")}</th> : null}
                <th className="num">{L("الكمية", "Quantity")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const src = SRC_LABELS[m.sourceDocType];
                return (
                  <tr key={m.id}>
                    <td className="hr-caption" style={{ color: "var(--text-secondary)" }}><span className="hr-num">{whenShort(m.timestamp, lang)}</span></td>
                    <td><MovementType type={m.type} /></td>
                    <td className="m-title">
                      <span className="strong">{disp(m.entityLabel, m.entityLabelAr)}</span>
                      {category === "RAW_MATERIAL" && m.entityCode ? <span className="hr-caption"> · <span className="hr-id">{m.entityCode}</span></span> : null}
                      <span className="hr-msub">{whenShort(m.timestamp, lang)} · {src ? (lang === "ar" ? src[0] : src[1]) : m.sourceDocType}</span>
                    </td>
                    <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{src ? (lang === "ar" ? src[0] : src[1]) : m.sourceDocType}</td>
                    {withDoc ? <td className="hr-hide-compact"><span className="hr-id hr-caption">{m.sourceRef ?? "—"}</span></td> : null}
                    <td className="num m-end" style={{ fontWeight: 500 }}><QtyChange m={m} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Coverage bar + «N يومًا» (251:2482 «التغطية بمعدل التحميص»). */
export function Coverage({ days, tone, pct }: { days: number | "INF" | null; tone?: "danger" | "warning"; pct: number }) {
  const { lang } = useI18n();
  const L = useL();
  if (days === null) return <span className="hr-caption" title={L("السجل أقصر من 14 يومًا", "History shorter than 14 days")}>—</span>;
  if (days === "INF") return <span className="hr-caption">{L("لا استهلاك", "No consumption")}</span>;
  return (
    <span className="stk-cov">
      <span className={`ops-bar${tone ? ` tone-${tone}` : " tone-neutral"}`} role="img" aria-label={`${days}`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className={`stk-covd${tone === "danger" ? " is-danger" : ""}`}>
        <span className="hr-num">{days}</span> {lang === "ar" ? (days > 2 && days < 11 ? "أيام" : "يومًا") : days === 1 ? "day" : "days"}
      </span>
    </span>
  );
}

export function TraceLink({ lotId }: { lotId: string }) {
  const L = useL();
  return <Link className="ops-link stk-trace" href={`/dashboard/inventory/lots/${lotId}`}>{L("تتبع", "Trace")}</Link>;
}

export function DownloadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>;
}

export function SortIcon({ dir }: { dir: "up" | "down" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{dir === "up" ? <path d="M12 19V5m0 0-5 5m5-5 5 5" /> : <path d="M12 5v14m0 0-5-5m5 5 5-5" />}</svg>;
}

export function ChevronIcon({ open }: { open: boolean }) {
  return <svg aria-hidden="true" className={`stk-chev${open ? " is-open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>;
}

/**
 * «ترتيب: التغطية ↑» (251:2482, 253:2987, 266:5230): a quiet text control at the toolbar's end. The
 * Direction 2.1 Select sits invisibly over it (as in FilterChip), so the keyboard, the popover and
 * the phone sheet are the Select's own.
 */
export function SortControl<K extends string>({ value, onChange, options, dir = "up" }: { value: K; onChange: (v: K) => void; options: { value: K; label: string }[]; dir?: "up" | "down" }) {
  const L = useL();
  const current = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className="stk-sort">
      <SortIcon dir={dir} />
      <span>{L("ترتيب:", "Sort:")} <span className="stk-sortv">{current}</span></span>
      <Select aria-label={L("ترتيب", "Sort")} value={value} onChange={(e) => onChange(e.target.value as K)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </span>
  );
}
