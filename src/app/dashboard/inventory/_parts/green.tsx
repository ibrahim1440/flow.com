"use client";
// Green coffee tab — Figma 251:2482 (1440) / 270:5944 (390). Lots are grouped by bean (the same
// coffee bought more than once), each bean with its 14-day roast draw and the coverage of its
// balance at that rate (src/lib/inventory/metrics.ts; «—» when the history is shorter than 14 days).
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { Btn, kg, opsDate, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { beanGroupKey, coverageBarPct, coverageTone, ROAST_WINDOW_DAYS } from "@/lib/inventory/metrics";
import { CheckIcon } from "../../_components/stock-materials";
import { ChevronIcon, Coverage, RecentMovements, SortControl, fmtQty } from "./shared";
import { PrintLabelButton } from "@/components/print/QuickPrint";
import { lotPagePath } from "@/lib/scan/codes";

export type GreenBean = {
  id: string; serialNumber: string;
  beanType: string; beanTypeAr: string | null;
  country: string; countryAr: string | null;
  region: string | null; regionAr: string | null;
  variety: string | null;
  process: string | null; processAr: string | null;
  altitude: string | null; location: string | null;
  quantityKg: number; isActive: boolean;
  receivedDate: string; createdAt: string;
  /** The label code «GL-00042» and the sacks (20261114090000_green_lot_labels). */
  labelCode?: string; sackCount?: number | null; sackWeightKg?: number | null;
};

type GroupStat = { consumed: number; rate: number | null; coverage: number | "INF" | null };
type GreenOverview = { overall: { consumed: number; rate: number | null }; groups: Record<string, GroupStat> };

/** The legacy screen's low-stock rule: below 20 kg (now per bean, «أصناف أقل من 20 كغ»). The built-in
 *  line; the owner may set another in Settings › Inventory (GET /api/settings/inventory), read below. */
export const LOW_KG = 20;

type Sort = "coverage" | "balance" | "name";

export function GreenTab({
  beans, search, onSearch, showInactive, onToggleInactive, canAdjust, canMaintain, canReceive,
  onCount, onEdit, onToggleActive, onDelete, onOpenLedger, refreshKey, whereOf,
}: {
  beans: GreenBean[]; search: string; onSearch: (v: string) => void; showInactive: boolean; onToggleInactive: () => void;
  canAdjust: boolean; canMaintain: boolean; canReceive: boolean;
  onCount: (b: GreenBean) => void; onEdit: (b: GreenBean) => void; onToggleActive: (b: GreenBean) => void; onDelete: (b: GreenBean) => void;
  onOpenLedger: () => void; refreshKey: number;
  /** Phase 3 (stock locations): where a lot's balance is — «مصنع التحميص 40 · المقهى 5». */
  whereOf?: (beanId: string) => React.ReactNode;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const [ov, setOv] = useState<GreenOverview | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>("coverage");

  // Settings › Inventory: the low-stock line in force (the built-in 20 kg until the owner sets one).
  const [lowKg, setLowKg] = useState<number>(LOW_KG);
  useEffect(() => {
    let off = false;
    fetch("/api/settings/inventory").then((r) => (r.ok ? r.json() : null)).then((j) => {
      const v = Number(j?.effectiveLowStockGreenKg);
      if (!off && Number.isFinite(v) && v > 0) setLowKg(v);
    }).catch(() => undefined);
    return () => { off = true; };
  }, []);

  useEffect(() => {
    let off = false;
    fetch("/api/inventory/overview?section=green").then((r) => (r.ok ? r.json() : null)).then((j) => { if (!off) setOv(j); });
    return () => { off = true; };
  }, [refreshKey]);

  const disp = (en: string | null | undefined, ar: string | null | undefined) => (lang === "ar" && ar ? ar : en ?? "—");
  const kgU = lang === "ar" ? "كغ" : "kg";

  // Group the (visible) lots by bean; each group carries the bean-level rate and coverage.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const m = new Map<string, { key: string; lots: GreenBean[]; balance: number; stat: GroupStat | null }>();
    for (const b of beans) {
      if (!showInactive && !b.isActive) continue;
      if (q && !`${b.beanType} ${b.beanTypeAr ?? ""} ${b.country} ${b.countryAr ?? ""} ${b.serialNumber} ${b.labelCode ?? ""}`.toLowerCase().includes(q)) continue;
      const key = beanGroupKey(b);
      const g = m.get(key) ?? { key, lots: [], balance: 0, stat: ov?.groups[key] ?? null };
      g.lots.push(b);
      if (b.isActive && Number.isFinite(b.quantityKg)) g.balance += b.quantityKg;
      m.set(key, g);
    }
    const list = [...m.values()];
    for (const g of list) g.lots.sort((a, b) => a.receivedDate.localeCompare(b.receivedDate));
    const cov = (g: (typeof list)[number]) => (g.stat?.coverage === "INF" ? 1e9 : g.stat?.coverage ?? 1e8);
    if (sort === "coverage") list.sort((a, b) => cov(a) - cov(b) || a.balance - b.balance);
    if (sort === "balance") list.sort((a, b) => b.balance - a.balance);
    if (sort === "name") list.sort((a, b) => disp(a.lots[0].beanType, a.lots[0].beanTypeAr).localeCompare(disp(b.lots[0].beanType, b.lots[0].beanTypeAr), lang));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disp depends on lang only
  }, [beans, showInactive, search, ov, sort, lang]);

  const active = beans.filter((b) => b.isActive);
  const total = active.reduce((s, b) => s + (Number.isFinite(b.quantityKg) ? b.quantityKg : 0), 0);
  const activeGroups = new Set(active.map(beanGroupKey));
  const lowGroups = [...activeGroups].map((k) => ({ k, lots: active.filter((b) => beanGroupKey(b) === k) }))
    .map((g) => ({ ...g, bal: g.lots.reduce((s, b) => s + b.quantityKg, 0) }))
    .filter((g) => g.bal < lowKg);
  const lastReceipt = active.reduce<GreenBean | null>((a, b) => (!a || b.receivedDate > a.receivedDate ? b : a), null);
  const shownLots = groups.reduce((s, g) => s + g.lots.length, 0);
  const shownBalance = groups.reduce((s, g) => s + g.balance, 0);
  const shownConsumed = groups.reduce((s, g) => s + (g.stat?.consumed ?? 0), 0);
  const rate = ov?.overall.rate ?? null;

  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const lotsWord = (n: number) => (lang === "ar" ? (n === 1 ? "لوت واحد" : n === 2 ? "لوتان" : n <= 10 ? `${n} لوتات` : `${n} لوتًا`) : `${n} ${n === 1 ? "lot" : "lots"}`);
  const beansWord = (n: number) => (lang === "ar" ? (n === 1 ? "صنف واحد" : n === 2 ? "صنفان" : n <= 10 ? `${n} أصناف` : `${n} صنفًا`) : `${n} ${n === 1 ? "bean" : "beans"}`);

  return (
    <section className="hr-stack" aria-label={L("البن الأخضر", "Green coffee")}>
      <div className="stk-metrics">
        <div>
          <span className="stk-lbl">{L("البن الأخضر في المخزون", "Green coffee in stock")}</span>
          <span className="stk-mid">{kg(total)}<span className="stk-unit">{kgU}</span></span>
          <span className="stk-d">{lang === "ar" ? `${lotsWord(active.length)} من ${beansWord(activeGroups.size)}` : `${lotsWord(active.length)} of ${beansWord(activeGroups.size)}`}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("التحميص اليومي", "Daily roasting")}</span>
          <span className="stk-mid">{rate === null ? "—" : rate.toFixed(1)}{rate === null ? null : <span className="stk-unit">{kgU}</span>}</span>
          <span className="stk-d">{rate === null ? L(`السجل أقصر من ${ROAST_WINDOW_DAYS} يومًا`, `History shorter than ${ROAST_WINDOW_DAYS} days`) : L(`متوسط آخر ${ROAST_WINDOW_DAYS} يومًا`, `Average of the last ${ROAST_WINDOW_DAYS} days`)}</span>
        </div>
        <div>
          <span className="stk-lbl">{L(`أصناف أقل من ${lowKg} كغ`, `Beans below ${lowKg} kg`)}</span>
          <span className={`stk-mid${lowGroups.length ? " tone-danger" : ""}`}>{lowGroups.length}</span>
          <span className="stk-d">{lowGroups.map((g) => disp(g.lots[0].beanType, g.lots[0].beanTypeAr)).join(lang === "ar" ? "، " : ", ") || "—"}</span>
        </div>
        <div>
          <span className="stk-lbl">{L("آخر استلام", "Last receipt")}</span>
          <span className="stk-mid">{lastReceipt ? kg(lastReceipt.quantityKg) : "—"}{lastReceipt ? <span className="stk-unit">{kgU}</span> : null}</span>
          <span className="stk-d">{lastReceipt ? `${opsDate(lastReceipt.receivedDate, lang)} · ${disp(lastReceipt.beanType, lastReceipt.beanTypeAr)}` : "—"}</span>
        </div>
      </div>

      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" placeholder={L("الصنف أو الرقم التسلسلي", "Bean or serial number")} aria-label={t("searchBeans")}
          value={search} onChange={(e) => onSearch(e.target.value)} />
        <Btn size="sm" className="stk-toggle" aria-pressed={showInactive} onClick={onToggleInactive}>
          <FilterIcon />{L("إظهار غير النشطة", "Show inactive")}
        </Btn>
        <span className="stk-end">
          <SortControl<Sort> value={sort} onChange={setSort} options={[
            { value: "coverage", label: L("التغطية", "Coverage") },
            { value: "balance", label: L("الرصيد", "Balance") },
            { value: "name", label: L("الاسم", "Name") },
          ]} />
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="hr-state"><h3>{t("noBeansFound")}</h3></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("البن الأخضر", "Green coffee")}>
            <thead>
              <tr>
                <th>{L("البن الأخضر", "Green coffee")}</th>
                <th className="hr-hide-compact">{L("اللوت", "Lot")}</th>
                <th className="num">{lang === "ar" ? "الرصيد · كغ" : "Balance · kg"}</th>
                <th className="num hr-hide-compact">{lang === "ar" ? `تحميص ${ROAST_WINDOW_DAYS} يومًا · كغ` : `Roasted ${ROAST_WINDOW_DAYS} d · kg`}</th>
                <th>{L("التغطية بمعدل التحميص", "Coverage at the roast rate")}</th>
                <th className="hr-mobile-cell" aria-hidden="true" />
                <th aria-label={t("actions")} />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const first = g.lots[0];
                const isOpen = open.has(g.key);
                const low = g.balance < lowKg && g.lots.some((l) => l.isActive);
                const cov = g.stat?.coverage ?? null;
                const covN = cov === "INF" || cov === null ? null : cov;
                const tone = coverageTone(cov === "INF" ? Infinity : cov);
                const proc = disp(first.process, first.processAr);
                const allInactive = g.lots.every((l) => !l.isActive);
                return (
                  <Fragment key={g.key}>
                    <tr className={`${isOpen ? "is-open" : ""}${allInactive ? " is-inactive" : ""}`}>
                      <td className="m-title">
                        <button type="button" className="stk-exp" aria-expanded={isOpen} onClick={() => toggle(g.key)}>
                          <ChevronIcon open={isOpen} />
                          <span className="strong">{disp(first.beanType, first.beanTypeAr)}</span>
                        </button>
                        {first.process || first.processAr ? <span className="hr-caption hr-desktop-only"> · {proc}</span> : null}
                        {low ? <> <span className="stk-flag hr-desktop-only">{L(`أقل من ${lowKg} كغ`, `Below ${lowKg} kg`)}</span></> : null}
                        <span className="hr-msub">
                          {lotsWord(g.lots.length)}{first.process || first.processAr ? ` · ${proc}` : ""}
                        </span>
                      </td>
                      <td className="hr-hide-compact">{g.lots.length === 1 ? <span className="hr-id hr-caption">{first.serialNumber}</span> : <span className="hr-caption">{lotsWord(g.lots.length)}</span>}</td>
                      <td className={`num${low ? " is-low" : ""}`} style={{ fontWeight: 600 }}><span className="hr-num">{fmtQty(g.balance, 2)}</span></td>
                      <td className="num hr-hide-compact"><span className="hr-num">{g.stat ? fmtQty(g.stat.consumed, 2) : "—"}</span></td>
                      <td className="hr-hide-mobile"><Coverage days={cov} tone={tone} pct={coverageBarPct(covN)} /></td>
                      <td className="m-end hr-mobile-cell" style={{ flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <span style={{ fontWeight: 600 }}><span className="hr-num" style={low ? { color: "var(--status-danger)" } : undefined}>{fmtQty(g.balance, 2)}</span>&nbsp;{kgU}</span>
                        <span className="hr-caption">
                          {cov === null ? "—" : cov === "INF" ? L("لا استهلاك", "No consumption") : lang === "ar" ? `تغطية ${cov} ${cov > 2 && cov < 11 ? "أيام" : "يومًا"}` : `${cov} days cover`}
                        </span>
                        {low ? <span className="stk-flag">{L(`أقل من ${lowKg} كغ`, `Below ${lowKg} kg`)}</span> : null}
                      </td>
                      <td className="stk-acts stk-macts">
                        {canReceive && (low || tone === "danger") ? (
                          <Link className="hr-btn is-sm" href={`/dashboard/purchases?bean=${encodeURIComponent(g.lots[g.lots.length - 1].id)}`}>{L("تسجيل مشتريات", "Record purchase")}</Link>
                        ) : null}
                      </td>
                    </tr>
                    {isOpen && g.lots.map((bean) => (
                      <tr key={bean.id} className={`stk-lotrow${bean.isActive ? "" : " is-inactive"}`}>
                        <td className="m-title">
                          {bean.labelCode ? <Link className="ops-link hr-id" href={lotPagePath(bean.labelCode)} data-testid={`lot-link-${bean.labelCode}`} title={L("صفحة اللوت", "Lot page")}>{bean.serialNumber}</Link> : <span className="hr-id">{bean.serialNumber}</span>}
                          {bean.labelCode ? <span className="hr-caption hr-id"> · {bean.labelCode}</span> : null}{bean.sackCount ? <span className="hr-caption"> · {lang === "ar" ? `${bean.sackCount} كيس` : `${bean.sackCount} sacks`}</span> : null}{bean.location ? <span> · {L("رف", "Shelf")} {bean.location}</span> : null}
                          {!bean.isActive ? <> <span className="stk-flag tone-warning">{t("inactive")}</span></> : null}
                          <span className="hr-msub">{L("استلام", "Received")} {opsDate(bean.receivedDate, lang)} · <span className="hr-num">{fmtQty(bean.quantityKg, 2)}</span> {kgU}</span>
                          {whereOf ? whereOf(bean.id) : null}
                        </td>
                        <td className="hr-hide-compact">{L("استلام", "Received")} {opsDate(bean.receivedDate, lang)}</td>
                        <td className="num"><span className="hr-num">{fmtQty(bean.quantityKg, 2)}</span></td>
                        <td className="hr-hide-compact" />
                        <td className="hr-hide-mobile" />
                        <td className="hr-mobile-cell" />
                        <td className="stk-acts stk-macts">
                          <PrintLabelButton template="GREEN_LOT" variant="ghost" iconOnly testId={`lot-print-${bean.labelCode ?? bean.id}`}
                            subtitle={`${disp(bean.beanType, bean.beanTypeAr)} · ${bean.serialNumber}`}
                            items={[{ kind: "green", greenBeanId: bean.id, label: `${disp(bean.beanType, bean.beanTypeAr)} · ${bean.serialNumber}`, sacks: { count: bean.sackCount ?? null, kg: bean.sackWeightKg ?? null } }]} />
                          {canAdjust && (
                            <Btn size="sm" variant="ghost" title={t("performCount")} onClick={() => onCount(bean)}>
                              <CheckIcon />{L("جرد", "Count")}
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn" title={t("edit")} aria-label={t("edit")} onClick={() => onEdit(bean)}>
                              <Pencil size={16} />
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn" title={bean.isActive ? t("deactivate") : t("activate")} aria-label={bean.isActive ? t("deactivate") : t("activate")} onClick={() => onToggleActive(bean)}>
                              {bean.isActive ? <PowerOff size={16} /> : <Power size={16} />}
                            </Btn>
                          )}
                          {canMaintain && (
                            <Btn size="sm" variant="ghost" className="hr-iconbtn" title={t("delete")} aria-label={t("delete")} onClick={() => onDelete(bean)}>
                              <Trash2 size={16} />
                            </Btn>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>{lang === "ar" ? `${beansWord(groups.length)} · ${lotsWord(shownLots)}` : `${beansWord(groups.length)} · ${lotsWord(shownLots)}`}</td>
                <td className="hr-hide-compact" />
                <td className="num stk-tot"><span className="hr-num">{kg(shownBalance)}</span></td>
                <td className="num stk-tot hr-hide-compact"><span className="hr-num">{ov ? kg(shownConsumed) : "—"}</span></td>
                <td colSpan={3} style={{ textAlign: "end" }}>
                  {rate === null ? L("معدل التحميص: —", "Roast rate: —") : lang === "ar" ? `${rate.toFixed(1)} كغ يوميًا · متوسط آخر ${ROAST_WINDOW_DAYS} يومًا` : `${rate.toFixed(1)} kg a day · last ${ROAST_WINDOW_DAYS} days`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <RecentMovements category="RAW_MATERIAL" title={L("آخر حركات البن الأخضر", "Latest green coffee movements")} onOpenLedger={onOpenLedger} refreshKey={refreshKey} />
    </section>
  );
}

function FilterIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" /></svg>;
}
