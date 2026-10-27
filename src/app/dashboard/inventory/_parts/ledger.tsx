"use client";
// Movement ledger tab — Figma 268:5577: search, category / type / source filters, «تصدير» (CSV of
// the same filter, GET /api/inventory-movements/export), day groups and server-side pages.
import { useEffect, useMemo, useState } from "react";
import { Btn, FilterChip, OpsLoading, opsDate, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { CAT_LABELS, DownloadIcon, MovementType, QtyChange, SRC_LABELS, TYPE_MAP, fmtQty, int, timeOf, type EnrichedMovement } from "./shared";

const PAGE_SIZE = 25;

/** `itemCategories` (unified inventory): the «التصنيف» chip filters by item category (a main category covers its sub-categories). */
export function LedgerTab({ refreshKey, initial, itemCategories, initialItemCategory }: {
  refreshKey: number; initial?: { category?: string; type?: string; source?: string };
  itemCategories?: { id: string; nameAr: string; nameEn: string | null; parentId: string | null }[]; initialItemCategory?: string;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [type, setType] = useState(initial?.type ?? "");
  const [source, setSource] = useState(initial?.source ?? "");
  const [itemCategory, setItemCategory] = useState(initialItemCategory ?? "");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: EnrichedMovement[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => { const h = setTimeout(() => setQDebounced(q.trim()), 300); return () => clearTimeout(h); }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (type) p.set("type", type);
    if (source) p.set("source", source);
    if (itemCategory) p.set("itemCategory", itemCategory);
    if (qDebounced) p.set("q", qDebounced);
    return p;
  }, [category, type, source, itemCategory, qDebounced]);

  // A filter change goes back to page 1 (set by the handlers below, never from an effect).
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  useEffect(() => {
    let off = false;
    const p = new URLSearchParams(params);
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/inventory-movements?${p}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (!off) { setData(j); setError(false); } })
      .catch(() => { if (!off) setError(true); });
    return () => { off = true; };
  }, [params, page, refreshKey]);

  const groups = useMemo(() => {
    const out: { day: string; rows: EnrichedMovement[] }[] = [];
    for (const m of data?.rows ?? []) {
      const day = opsDate(m.timestamp, lang);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(m);
      else out.push({ day, rows: [m] });
    }
    return out;
  }, [data, lang]);

  const disp = (en: string | null, ar: string | null) => (lang === "ar" && ar ? ar : en ?? "—");
  const pair = (m: Record<string, [string, ...unknown[]]>, k: string, enIdx: number) => (m[k] ? String(lang === "ar" ? m[k][0] : m[k][enIdx]) : k);
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="hr-stack" aria-label={t("movementLedger")}>
      <div className="stk-tool">
        <input type="search" className="hr-input hr-search" placeholder={L("الصنف أو رقم المستند", "Item or document number")} aria-label={L("الصنف أو رقم المستند", "Item or document number")}
          value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {itemCategories && itemCategories.length ? (
          <FilterChip label={L("التصنيف", "Category")} value={itemCategory} onChange={reset(setItemCategory)}
            options={itemCategories.map((c) => {
              const p = c.parentId ? itemCategories.find((x) => x.id === c.parentId) : undefined;
              const n = (x: { nameAr: string; nameEn: string | null }) => (lang === "ar" ? x.nameAr : x.nameEn || x.nameAr);
              return { value: c.id, label: p ? `${n(p)} › ${n(c)}` : n(c) };
            })} />
        ) : null}
        <FilterChip label={L("نوع المخزون", "Stock kind")} value={category} onChange={reset(setCategory)} options={Object.keys(CAT_LABELS).map((k) => ({ value: k, label: pair(CAT_LABELS, k, 1) }))} />
        <FilterChip label={L("النوع", "Type")} value={type} onChange={reset(setType)} options={Object.keys(TYPE_MAP).map((k) => ({ value: k, label: pair(TYPE_MAP, k, 2) }))} />
        <FilterChip label={L("المصدر", "Source")} value={source} onChange={reset(setSource)} options={Object.keys(SRC_LABELS).map((k) => ({ value: k, label: pair(SRC_LABELS, k, 1) }))} />
        <span className="stk-end">
          <a className="hr-btn is-ghost is-sm" href={`/api/inventory-movements/export?${params}`} download data-testid="ledger-export">
            <DownloadIcon />{L("تصدير", "Export")}
          </a>
        </span>
      </div>

      {error ? <div className="hr-notice tone-danger" role="alert">{L("تعذّر تحميل السجل.", "Could not load the ledger.")}</div> : null}
      {!data && !error ? <OpsLoading /> : null}
      {data && data.rows.length === 0 ? <div className="hr-state"><h3>{t("noLedgerMovements")}</h3></div> : null}
      {data && data.rows.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={t("movementLedger")}>
            <thead>
              <tr>
                <th>{L("الوقت", "Time")}</th>
                <th>{t("movementType")}</th>
                <th>{L("الصنف والفئة", "Item and category")}</th>
                <th className="num">{L("قبل", "Before")}</th>
                <th className="num">{L("بعد", "After")}</th>
                <th className="num">{t("difference")}</th>
                <th>{L("المصدر والمستند", "Source and document")}</th>
                <th className="hr-hide-compact">{L("المستخدم", "User")}</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.day}>
                <tr className="stk-group"><td colSpan={8}>{g.day} <span className="hr-num">{g.rows.length}</span></td></tr>
                {g.rows.map((m) => {
                  const isGain = m.quantityChanged > 0;
                  const isZero = Math.abs(m.quantityChanged) < 0.0005;
                  const srcLabel = pair(SRC_LABELS, m.sourceDocType, 1);
                  const discrete = m.unit === "PIECE" || m.unit === "UNIT";
                  const digits = discrete ? 0 : 2;
                  return (
                    <tr key={m.id}>
                      <td className="hr-caption" style={{ color: "var(--text-secondary)" }}><span className="hr-num">{timeOf(m.timestamp)}</span></td>
                      <td><MovementType type={m.type} /></td>
                      <td className="m-title">
                        <span className="strong">{disp(m.entityLabel, m.entityLabelAr)}</span>
                        {m.entityCode && m.category !== "PACKAGING_MATERIAL" ? <span className="hr-caption"> · <span className="hr-id">{m.entityCode}</span></span> : null}
                        <span className="stk-sub hr-desktop-only">{pair(CAT_LABELS, m.category, 1)}</span>
                        <span className="hr-msub"><span className="hr-num">{timeOf(m.timestamp)}</span> · {pair(TYPE_MAP, m.type, 2)} · {srcLabel}</span>
                      </td>
                      <td className="num"><span className="hr-num" style={{ color: "var(--text-secondary)" }}>{discrete ? int(m.previousQuantity) : fmtQty(m.previousQuantity, digits)}</span></td>
                      <td className="num"><span className="hr-num">{discrete ? int(m.newQuantity) : fmtQty(m.newQuantity, digits)}</span></td>
                      <td className="num m-end" style={{ fontWeight: 600 }}>
                        <QtyChange m={m} className={isZero ? "hr-muted" : isGain ? "stk-gain" : "stk-loss"} />
                      </td>
                      <td>
                        <span>{m.countNumber !== null ? `${L("جرد", "Count")} #${m.countNumber}` : srcLabel}</span>
                        <span className="stk-sub hr-id">{m.countNumber !== null ? srcLabel : m.sourceRef ?? "—"}</span>
                        {m.notes && m.type === "ADJUSTMENT" ? <span className="stk-sub">{m.notes}</span> : null}
                      </td>
                      <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{m.userName ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}

      {data ? (
        <div className="stk-pager">
          <span>{lang === "ar" ? `${total.toLocaleString("en-US")} حركة · يظهر ${data.rows.length}` : `${total.toLocaleString("en-US")} movements · showing ${data.rows.length}`}</span>
          <span className="stk-pbtns">
            <span className="hr-num">{lang === "ar" ? `${from}–${to} من ${total}` : `${from}–${to} of ${total}`}</span>
            <Btn size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>{L("السابق", "Previous")}</Btn>
            <Btn size="sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>{L("التالي", "Next")}</Btn>
          </span>
        </div>
      ) : null}
      <p className="stk-foot">{L("السجل للإضافة فقط: لا تُحذف الحركات ولا تُعدَّل. كل تسوية تحمل سببها واسم من سجّلها.", "The ledger is append-only: movements are never deleted or edited. Every adjustment carries its reason and who recorded it.")}</p>
    </section>
  );
}
