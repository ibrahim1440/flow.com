"use client";
// Finished stock tab — Figma 266:5230: units per SKU (expandable to its lots, each with «تتبع» to
// the lot's traceability page), then the roasted coffee not yet packed. Units are the source of truth
// for unit-tracked lots; the legacy kilogram lots (rows from before unit tracking) stay listed below.
import { Fragment, useEffect, useMemo, useState } from "react";
import { FilterChip, OpsLoading, StatusDot, kg, opsDate, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { ChevronIcon, SortControl, TraceLink, fmtQty, int, timeOf } from "./shared";

type LotRow = { id: string; batchNumber: string; createdAt: string; status: string; available: number; reserved: number; free: number; actualContentGrams: number | null; orders: number[] };
type SkuRow = { skuId: string; skuCode: string; name: string; nameAr: string | null; weightGrams: number; isActive: boolean; category: string; available: number; reserved: number; free: number; partial: number; lots: number; orders: number[]; lotRows: LotRow[] };
type Unpacked = { id: string; batchNumber: string; date: string; status: string; roastProfile: string | null; name: string; nameAr: string | null; roastedKg: number; unpackedKg: number; packable: boolean };
type Legacy = { id: string; batchNumber: string; createdAt: string; status: string; quantityKg: number; availableQty: number; reservedQty: number; product: { productNameEn: string; productNameAr: string | null }; orders: number[] };
type FinishedOverview = {
  skus: SkuRow[];
  totals: { available: number; reserved: number; free: number; partial: number; lots: number; skusInStock: number; openOrders: number; unpackedPackableKg: number; unpackedPendingKg: number };
  unpacked: Unpacked[];
  legacy: Legacy[];
};
type Sort = "available" | "free" | "code";

const BATCH_STATUS: Record<string, [string, "success" | "warning" | "neutral" | "danger", string]> = {
  "Pending QC": ["في انتظار الجودة", "warning", "Awaiting QC"],
  Passed: ["مقبولة", "success", "Passed"],
  "Partially Packaged": ["معبأ جزئيًا", "success", "Partly packed"],
  Packaged: ["معبأ", "neutral", "Packed"],
  Rejected: ["مرفوضة", "danger", "Rejected"],
};
const LOT_STATUS: Record<string, [string, "success" | "warning" | "neutral", string]> = {
  AVAILABLE: ["متاح", "success", "Available"], RESERVED: ["محجوز", "warning", "Reserved"], SHIPPED: ["مشحون", "neutral", "Shipped"], PARTIAL: ["عبوة جزئية", "warning", "Partial"],
};
const LOT_ROWS = 3;
const SKU_CATEGORY: Record<string, [string, string]> = { ROASTED_COFFEE: ["بن محمص", "Roasted coffee"], GREEN_COFFEE: ["بن أخضر", "Green coffee"], MERCHANDISE: ["منتجات", "Merchandise"], OTHER: ["أخرى", "Other"] };

/**
 * `part` (unified inventory phase 1): "finished" — the units per SKU and the kilogram lots (the «المنتجات
 * الجاهزة» category); "roasted" — only the roasted coffee not yet packed (the «بن محمص» category); "all" — both,
 * as the former «المخزون التام» tab.
 */
export function FinishedTab({ refreshKey, part = "all" }: { refreshKey: number; part?: "all" | "finished" | "roasted" }) {
  const { lang } = useI18n();
  const L = useL();
  const [ov, setOv] = useState<FinishedOverview | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [sort, setSort] = useState<Sort>("available");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allUnpacked, setAllUnpacked] = useState(false);

  useEffect(() => {
    let off = false;
    fetch("/api/inventory/overview?section=finished").then((r) => (r.ok ? r.json() : null)).then((j) => { if (!off) setOv(j); });
    return () => { off = true; };
  }, [refreshKey]);

  const disp = (en: string | null | undefined, ar: string | null | undefined) => (lang === "ar" && ar ? ar : en ?? "—");
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = (ov?.skus ?? []).filter((x) => (x.isActive || x.lots > 0) && (!cat || x.category === cat)
      && (!s || `${x.skuCode} ${x.name} ${x.nameAr ?? ""} ${x.lotRows.map((l) => l.batchNumber).join(" ")}`.toLowerCase().includes(s)));
    if (sort === "available") r.sort((a, b) => b.available - a.available || a.skuCode.localeCompare(b.skuCode));
    if (sort === "free") r.sort((a, b) => b.free - a.free || a.skuCode.localeCompare(b.skuCode));
    if (sort === "code") r.sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    return r;
  }, [ov, q, cat, sort]);

  if (!ov) return <OpsLoading />;
  const T = ov.totals;
  const lotsWord = (n: number) => (lang === "ar" ? (n === 1 ? "لوت واحد" : n === 2 ? "لوتان" : n <= 10 ? `${n} لوتات` : `${n} لوتًا`) : `${n} ${n === 1 ? "lot" : "lots"}`);
  const ordersWord = (n: number) => (lang === "ar" ? (n === 1 ? "طلب واحد مفتوح" : n === 2 ? "طلبان مفتوحان" : `${n} طلبات مفتوحة`) : `${n} open ${n === 1 ? "order" : "orders"}`);
  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const unpacked = allUnpacked ? ov.unpacked : ov.unpacked.slice(0, 8);
  const kgU = lang === "ar" ? "كغ" : "kg";

  return (
    <section className="hr-stack" aria-label={part === "roasted" ? L("بن محمص غير معبأ", "Roasted coffee not yet packed") : L("المخزون التام", "Finished stock")}>
      {part !== "roasted" ? <>
      <div className="stk-metrics" style={part === "finished" ? { ["--stk-cols" as string]: 3 } : undefined}>
        <div>
          <span className="stk-lbl">{L("وحدات متاحة", "Units available")}</span>
          <span className="stk-mid">{int(T.available)}</span>
          <span className="stk-d">{lang === "ar" ? `في ${lotsWord(T.lots)} من ${T.skusInStock} أصناف` : `in ${lotsWord(T.lots)} of ${T.skusInStock} SKUs`}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("محجوزة للطلبات", "Reserved for orders")}</span>
          <span className="stk-mid">{int(T.reserved)}</span>
          <span className="stk-d">{ordersWord(T.openOrders)}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("حرّة للبيع", "Free to sell")}</span>
          <span className="stk-mid">{int(T.free)}</span>
          <span className="stk-d">{T.partial ? (lang === "ar" ? `${T.partial === 2 ? "عبوتان جزئيتان" : T.partial === 1 ? "عبوة جزئية" : `${T.partial} عبوات جزئية`} خارج البيع` : `${T.partial} partial package(s) not for sale`) : L("لا عبوات جزئية", "No partial packages")}</span>
        </div>
        {part === "all" ? <div>
          <span className="stk-lbl">{L("بن محمص غير معبأ", "Roasted, not packed")}</span>
          <span className="stk-mid">{kg(T.unpackedPackableKg)}<span className="stk-unit">{kgU}</span></span>
          <span className="stk-d">{L("قابل للتعبئة", "Ready to pack")} · {kg(T.unpackedPendingKg)} {kgU} {L("بانتظار الجودة", "awaiting QC")}</span>
        </div> : null}
      </div>

      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" placeholder={L("رمز الصنف أو رقم اللوت", "SKU code or lot number")} aria-label={L("رمز الصنف أو رقم اللوت", "SKU code or lot number")}
          value={q} onChange={(e) => setQ(e.target.value)} />
        <FilterChip label={L("الفئة", "Category")} value={cat} onChange={setCat} options={Object.entries(SKU_CATEGORY).map(([v, [ar, en]]) => ({ value: v, label: lang === "ar" ? ar : en }))} />
        <span className="stk-end">
          <SortControl<Sort> dir="down" value={sort} onChange={setSort} options={[
            { value: "available", label: L("المتاح", "Available") }, { value: "free", label: L("الحر", "Free") }, { value: "code", label: L("رمز الصنف", "SKU code") },
          ]} />
        </span>
      </div>

      {rows.length === 0 ? <div className="hr-state"><h3>{L("لا أصناف مطابقة.", "No matching SKUs.")}</h3></div> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("الوحدات لكل صنف", "Units per SKU")}>
            <thead>
              <tr>
                <th className="hr-hide-compact">{L("رمز الصنف", "SKU")}</th>
                <th>{L("المنتج", "Product")}</th>
                <th className="num">{L("متاح · وحدة", "Available · units")}</th>
                <th className="num">{L("محجوز", "Reserved")}</th>
                <th className="num">{L("حر", "Free")}</th>
                <th className="num hr-hide-compact">{L("عبوات جزئية", "Partial packages")}</th>
                <th className="num hr-hide-compact">{L("اللوتات", "Lots")}</th>
                <th className="hr-mobile-cell" aria-hidden="true" />
                <th aria-label={L("تتبع", "Trace")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const isOpen = open.has(s.skuId);
                const none = s.lots === 0;
                const older = s.lotRows.slice(LOT_ROWS);
                return (
                  <Fragment key={s.skuId}>
                    <tr className={isOpen ? "is-open" : undefined}>
                      <td className="hr-hide-compact"><span className="hr-id hr-caption">{s.skuCode}</span></td>
                      <td className="m-title">
                        {none ? <span className="strong">{disp(s.name, s.nameAr)}</span> : (
                          <button type="button" className="stk-exp" aria-expanded={isOpen} onClick={() => toggle(s.skuId)}>
                            <ChevronIcon open={isOpen} /><span className="strong">{disp(s.name, s.nameAr)}</span>
                          </button>
                        )}
                        <span className="hr-msub"><span className="hr-id">{s.skuCode}</span> · {L("محجوز", "reserved")} <span className="hr-num">{s.reserved}</span> · {L("حر", "free")} <span className="hr-num">{s.free}</span></span>
                      </td>
                      <td className="num">{none ? "—" : <span className="hr-num">{int(s.available)}</span>}</td>
                      <td className="num">{none || !s.reserved ? "—" : <span className="hr-num">{int(s.reserved)}</span>}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{none ? "—" : <span className="hr-num">{int(s.free)}</span>}</td>
                      <td className="num hr-hide-compact">{s.partial ? <span className="hr-num">{s.partial}</span> : "—"}</td>
                      <td className="num hr-hide-compact">{none ? "—" : <span className="hr-num">{s.lots}</span>}</td>
                      <td className="m-end hr-mobile-cell"><span className="hr-num" style={{ fontWeight: 600 }}>{none ? "—" : int(s.available)}</span>&nbsp;{L("وحدة", "units")}</td>
                      <td className="hr-caption" style={{ textAlign: "end" }}>{none ? <StatusDot map={{ X: ["لا مخزون", "neutral", "No stock"] }} value="X" /> : null}</td>
                    </tr>
                    {isOpen && s.lotRows.slice(0, LOT_ROWS).map((l) => (
                      <tr key={l.id} className="stk-lotrow">
                        <td className="hr-hide-compact" />
                        <td className="m-title">
                          {L("لوت", "Lot")} <span className="hr-id">{l.batchNumber}</span> · {L("عُبّئ", "packed")} {opsDate(l.createdAt, lang)} {timeOf(l.createdAt)}
                          {l.status === "PARTIAL" ? <> <span className="stk-flag tone-warning">{LOT_STATUS.PARTIAL[lang === "ar" ? 0 : 2]}{l.actualContentGrams ? ` · ${l.actualContentGrams} ${lang === "ar" ? "غ" : "g"}` : ""}</span></> : null}
                          <span className="hr-msub">{L("متاح", "available")} {l.available} · {L("محجوز", "reserved")} {l.reserved}{l.orders.length ? ` · ${l.orders.map((o) => `\u2066#${o}\u2069`).join("، ")}` : ""}</span>
                        </td>
                        <td className="num"><span className="hr-num">{l.available}</span></td>
                        <td className="num"><span className="hr-num">{l.reserved}</span></td>
                        <td className="num"><span className="hr-num">{l.free}</span></td>
                        <td className="hr-hide-compact" colSpan={2}>{l.orders.length ? <span className="hr-caption">{L("محجوز لـ", "Reserved for")} {l.orders.map((o) => `\u2066#${o}\u2069`).join("، ")}</span> : null}</td>
                        <td className="hr-mobile-cell" />
                        <td style={{ textAlign: "end" }}><TraceLink lotId={l.id} /></td>
                      </tr>
                    ))}
                    {isOpen && older.length ? (
                      <tr className="stk-lotrow">
                        <td className="hr-hide-compact" />
                        <td className="hr-caption">{lang === "ar" ? `و${lotsWord(older.length)} أقدم · من دفعات سابقة` : `and ${lotsWord(older.length)} older · earlier batches`}</td>
                        <td className="num"><span className="hr-num">{older.reduce((a, l) => a + l.available, 0)}</span></td>
                        <td className="num"><span className="hr-num">{older.reduce((a, l) => a + l.reserved, 0)}</span></td>
                        <td className="num"><span className="hr-num">{older.reduce((a, l) => a + l.free, 0)}</span></td>
                        <td className="hr-hide-compact" colSpan={2}>{older.some((l) => l.orders.length) ? <span className="hr-caption">{L("محجوز لـ", "Reserved for")} {[...new Set(older.flatMap((l) => l.orders))].map((o) => `\u2066#${o}\u2069`).join("، ")}</span> : null}</td>
                        <td className="hr-mobile-cell" />
                        <td />
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="hr-hide-compact" />
                <td>{lang === "ar" ? `${rows.length} أصناف بيع` : `${rows.length} SKUs`}</td>
                <td className="num stk-tot"><span className="hr-num">{int(rows.reduce((a, r) => a + r.available, 0))}</span></td>
                <td className="num stk-tot"><span className="hr-num">{int(rows.reduce((a, r) => a + r.reserved, 0))}</span></td>
                <td className="num stk-tot"><span className="hr-num">{int(rows.reduce((a, r) => a + r.free, 0))}</span></td>
                <td className="num stk-tot hr-hide-compact"><span className="hr-num">{rows.reduce((a, r) => a + r.partial, 0)}</span></td>
                <td className="num stk-tot hr-hide-compact"><span className="hr-num">{rows.reduce((a, r) => a + r.lots, 0)}</span></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      </> : (
        <div className="stk-metrics" style={{ ["--stk-cols" as string]: 2 }}>
          <div>
            <span className="stk-lbl">{L("قابل للتعبئة", "Ready to pack")}</span>
            <span className="stk-mid">{kg(T.unpackedPackableKg)}<span className="stk-unit">{kgU}</span></span>
            <span className="stk-d">{L("بعد قرار الجودة", "after the QC decision")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("بانتظار الجودة", "Awaiting QC")}</span>
            <span className="stk-mid">{kg(T.unpackedPendingKg)}<span className="stk-unit">{kgU}</span></span>
            <span className="stk-d">{L("يأتي من التحميص", "Comes from roasting")}</span>
          </div>
        </div>
      )}

      {part !== "finished" ? <>
      {/* بن محمص غير معبأ — RoastingBatch.roastedAvailableKg > 0 (packable only after QC acceptance). */}
      <div className="ops-sechead" style={{ marginTop: part === "roasted" ? 0 : 20 }}>
        <h2>{L("بن محمص غير معبأ", "Roasted coffee not yet packed")}</h2>
        <p className="hr-caption">{L("كغ · يُعبأ بعد قرار الجودة فقط", "kg · packed only after the QC decision")}</p>
      </div>
      {ov.unpacked.length === 0 ? <p className="hr-caption">{L("لا بن محمص بانتظار التعبئة.", "No roasted coffee waiting to be packed.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("بن محمص غير معبأ", "Roasted coffee not yet packed")}>
            <thead>
              <tr>
                <th>{L("الدفعة", "Batch")}</th>
                <th>{L("البن", "Coffee")}</th>
                <th className="hr-hide-compact">{L("التحميص", "Roasted")}</th>
                <th className="num hr-hide-compact">{L("محمص", "Roasted kg")}</th>
                <th className="num">{L("غير معبأ", "Unpacked")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th className="hr-hide-compact" />
              </tr>
            </thead>
            <tbody>
              {unpacked.map((u) => (
                <tr key={u.id}>
                  <td><span className="hr-id">{u.batchNumber}</span></td>
                  <td className="m-title">
                    <span className="strong">{disp(u.name, u.nameAr)}</span>{u.roastProfile ? <span className="hr-caption"> · {u.roastProfile}</span> : null}
                    <span className="hr-msub"><span className="hr-id">{u.batchNumber}</span> · {opsDate(u.date, lang)} {timeOf(u.date)}</span>
                  </td>
                  <td className="hr-hide-compact hr-caption">{opsDate(u.date, lang)} {timeOf(u.date)}</td>
                  <td className="num hr-hide-compact"><span className="hr-num">{fmtQty(u.roastedKg, 2)}</span></td>
                  <td className="num m-end" style={{ fontWeight: 600 }}><span className="hr-num">{fmtQty(u.unpackedKg, 2)}</span></td>
                  <td><StatusDot map={BATCH_STATUS} value={BATCH_STATUS[u.status] ? u.status : "Passed"} /></td>
                  <td className="hr-hide-compact hr-caption">{u.packable ? L("قابل للتعبئة", "Ready to pack") : L("غير قابل للتعبئة بعد", "Not packable yet")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  {lang === "ar" ? `${ov.unpacked.length} دفعات` : `${ov.unpacked.length} batches`}
                  {ov.unpacked.length > 8 ? <> · <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setAllUnpacked((v) => !v)}>{allUnpacked ? L("عرض أقل", "Show fewer") : L("عرض الكل", "Show all")}</button></> : null}
                </td>
                <td className="num stk-tot hr-hide-compact"><span className="hr-num">{kg(ov.unpacked.reduce((a, u) => a + u.roastedKg, 0))}</span></td>
                <td className="num stk-tot"><span className="hr-num">{kg(ov.unpacked.reduce((a, u) => a + u.unpackedKg, 0))}</span></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      </> : null}

      {part !== "roasted" && ov.legacy.length ? (
        <>
          <div className="ops-sechead" style={{ marginTop: 20 }}>
            <h2>{L("لوتات بالكيلو (قبل تتبع الوحدات)", "Kilogram lots (before unit tracking)")}</h2>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow">
              <thead><tr><th>{L("اللوت", "Lot")}</th><th>{L("المنتج", "Product")}</th><th className="num">{L("متاح · كغ", "Available · kg")}</th><th className="num">{L("محجوز", "Reserved")}</th><th>{L("الحالة", "Status")}</th><th /></tr></thead>
              <tbody>
                {ov.legacy.map((l) => (
                  <tr key={l.id}>
                    <td><span className="hr-id">{l.batchNumber}</span></td>
                    <td className="m-title"><span className="strong">{disp(l.product.productNameEn, l.product.productNameAr)}</span><span className="hr-msub">{L("متاح", "available")} {fmtQty(l.availableQty, 1)} {kgU}</span></td>
                    <td className="num"><span className="hr-num">{fmtQty(l.availableQty, 2)}</span></td>
                    <td className="num"><span className="hr-num">{fmtQty(l.reservedQty, 2)}</span></td>
                    <td className="m-end"><StatusDot map={LOT_STATUS} value={LOT_STATUS[l.status] ? l.status : "AVAILABLE"} /></td>
                    <td style={{ textAlign: "end" }}><TraceLink lotId={l.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
