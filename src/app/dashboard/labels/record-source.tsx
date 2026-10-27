"use client";
// The labels page's record sources (20261114090000_green_lot_labels): «لوطات البن الأخضر» (the sack label: bean,
// receipt, «كيس n من N», barcode + QR) and «أصناف المخزون» (the shelf label: name, category, unit, barcode). Select
// rows, then one print dialog — per-sack for lots. Needs the inventory module (the server's rule for both templates).
import { useEffect, useMemo, useState } from "react";
import { Btn, Flag, OpsEmpty, OpsError, OpsLoading, countNoun, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { PrintDialog, type DialogItem } from "@/components/print/PrintDialog";
import { PRINT_GATE_NOTE_ID } from "@/components/print/Certification";
import { ScanInput, lookupScanCode, type ScanFeedback } from "@/components/scan/ScanInput";

export type RecordKind = "green" | "materials";
type Lot = { id: string; labelCode: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null; process: string | null; processAr: string | null; quantityKg: number; isActive: boolean; receivedDate: string; sackCount: number | null; sackWeightKg: number | null };
type Mat = { id: string; code: string; labelCode: string; name: string; nameAr: string | null; isActive: boolean; quantityOnHand: number; unitOfMeasure: string };

const LOT_FORMS: [string, string, string, string, string, string] = ["لوت واحد", "لوتان", "لوتات", "لوتًا", "lot", "lots"];
const ITEM_FORMS: [string, string, string, string, string, string] = ["صنف واحد", "صنفان", "أصناف", "صنفًا", "item", "items"];

export function RecordSource({ kind, canPrint, certified, initialSearch, preselect, onPrinted }: {
  kind: RecordKind; canPrint: boolean; certified: boolean | null; initialSearch?: string; preselect?: string; onPrinted: (jobId: string) => void;
}) {
  const L = useL();
  const { lang } = useI18n();
  const [rows, setRows] = useState<(Lot | Mat)[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState(initialSearch ?? "");
  const [inactive, setInactive] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the list reloads when the source changes
    setRows(null); setSelected([]);
    fetch(kind === "green" ? "/api/green-beans?all=1" : "/api/materials?activeOnly=false", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return r.json(); })
      .then((d: (Lot | Mat)[]) => {
        if (!alive) return;
        setRows(d); setErr(null);
        if (preselect && kind === "green") {
          const hit = (d as Lot[]).find((l) => l.serialNumber === preselect || l.labelCode === preselect);
          if (hit) setSelected([hit.id]);
        }
      })
      .catch((e) => { if (alive) setErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [kind, tick, preselect]);

  const lotName = (l: Lot) => (lang === "ar" && l.beanTypeAr ? l.beanTypeAr : l.beanType);
  const matName = (m: Mat) => (lang === "ar" && m.nameAr ? m.nameAr : m.name);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => (inactive || r.isActive) && (!s || (kind === "green"
      ? `${(r as Lot).beanType} ${(r as Lot).beanTypeAr ?? ""} ${(r as Lot).country} ${(r as Lot).serialNumber} ${(r as Lot).labelCode}`
      : `${(r as Mat).name} ${(r as Mat).nameAr ?? ""} ${(r as Mat).code} ${(r as Mat).labelCode}`).toLowerCase().includes(s)));
  }, [rows, q, inactive, kind]);
  const toggle = (id: string) => setSelected((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const items: DialogItem[] = selected.flatMap((id): DialogItem[] => {
    const r = rows?.find((x) => x.id === id);
    if (!r) return [];
    if (kind === "green") { const l = r as Lot; return [{ kind: "green", greenBeanId: l.id, label: `${lotName(l)} · ${l.serialNumber}`, sacks: { count: l.sackCount, kg: l.sackWeightKg } }]; }
    const m = r as Mat; return [{ kind: "material", materialId: m.id, label: `${matName(m)} · ${m.code}` }];
  });

  // A scan in the list selects the lot / item (a stack of sacks to relabel).
  async function onScan(code: string): Promise<ScanFeedback> {
    const r = await lookupScanCode<{ id: string; kind: string }>(code, lang === "en" ? "en" : "ar", { only: kind === "green" ? "GREEN_LOT" : "MATERIAL" });
    if (!r.ok) return { tone: "danger", text: r.message };
    const row = rows?.find((x) => x.id === r.hit.id);
    if (!row) return { tone: "danger", text: L("ليس في هذه القائمة.", "Not in this list.") };
    if (!selected.includes(row.id)) setSelected((x) => [...x, row.id]);
    return { tone: "success", text: `${L("حُدّد", "Selected")}: ${kind === "green" ? `${lotName(row as Lot)} · ${(row as Lot).serialNumber}` : `${matName(row as Mat)} · ${(row as Mat).code}`}` };
  }

  const forms = kind === "green" ? LOT_FORMS : ITEM_FORMS;
  return (
    <section className="hr-stack" aria-label={kind === "green" ? L("لوطات البن الأخضر", "Green coffee lots") : L("أصناف المخزون", "Stock items")} data-testid={`labels-records-${kind}`}>
      <div className="lbl-rec-tool">
        <input className="hr-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }}
          placeholder={kind === "green" ? L("الصنف أو الرقم التسلسلي أو رمز اللوت…", "Bean, serial or lot code…") : L("اسم الصنف أو رمزه…", "Item name or code…")} aria-label={L("بحث", "Search")} />
        <div style={{ flex: "1 1 260px", maxWidth: 420 }}><ScanInput compact onCode={onScan} testId="labels-scan" /></div>
        <Btn size="sm" aria-pressed={inactive} onClick={() => setInactive((v) => !v)}>{L("إظهار غير النشطة", "Show inactive")}</Btn>
        {canPrint ? (
          <Btn variant="primary" disabled={selected.length === 0 || certified !== true} onClick={() => setDialog(true)} data-testid="labels-print-records"
            aria-describedby={certified === false ? PRINT_GATE_NOTE_ID : undefined}>
            {L("طباعة المحدد", "Print selected")} (<span className="hr-num">{selected.length}</span>)
          </Btn>
        ) : null}
      </div>
      {err ? <OpsError message={err} onRetry={() => setTick((t) => t + 1)} /> : !rows ? <OpsLoading rows={6} /> : shown.length === 0 ? (
        <OpsEmpty title={q ? L("لا نتائج لهذا البحث", "No results for this search") : kind === "green" ? L("لا لوطات بن أخضر", "No green coffee lots") : L("لا أصناف", "No items")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow lbl-table" aria-label={kind === "green" ? L("لوطات البن الأخضر", "Green coffee lots") : L("أصناف المخزون", "Stock items")} data-testid="labels-records-table">
            <thead><tr>
              <th style={{ width: 44 }}><span className="hr-sr">{L("تحديد", "Select")}</span></th>
              <th>{kind === "green" ? L("اللوت", "Lot") : L("الصنف", "Item")}</th>
              <th className="hr-hide-mobile">{L("رمز الباركود", "Barcode")}</th>
              <th className="num">{kind === "green" ? L("الرصيد · كغ", "Balance · kg") : L("الرصيد", "On hand")}</th>
              {kind === "green" ? <th>{L("الأكياس", "Sacks")}</th> : null}
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const on = selected.includes(r.id);
                const l = r as Lot, m = r as Mat;
                const title = kind === "green" ? lotName(l) : matName(m);
                return (
                  <tr key={r.id} aria-selected={on} className={`is-clickable${r.isActive ? "" : " is-inactive"}`} onClick={() => toggle(r.id)}>
                    <td className="m-end lbl-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={on} onChange={() => toggle(r.id)} aria-label={`${L("تحديد", "Select")} ${title}`} style={{ width: 18, height: 18 }} />
                    </td>
                    <td className="m-title">
                      <span className="lbl-name">{title}</span>
                      <span className="hr-caption"><bdi dir="ltr" className="hr-id">{kind === "green" ? l.serialNumber : m.code}</bdi>{kind === "green" && (l.process || l.processAr) ? ` · ${lang === "ar" ? l.processAr || l.process : l.process}` : ""}</span>
                      <span className="hr-msub"><bdi dir="ltr" className="hr-id">{r.labelCode}</bdi>{!r.isActive ? ` · ${L("غير نشط", "inactive")}` : ""}</span>
                    </td>
                    <td className="hr-hide-mobile"><bdi dir="ltr" className="hr-id">{r.labelCode}</bdi></td>
                    <td className="num"><span className="hr-num">{kind === "green" ? (Math.round(l.quantityKg * 100) / 100) : m.quantityOnHand}</span></td>
                    {kind === "green" ? <td>{l.sackCount ? <span className="hr-caption"><bdi dir="ltr">{l.sackCount}{l.sackWeightKg ? ` × ${l.sackWeightKg}` : ""}</bdi></span> : <Flag tone="warning">{L("لم تُسجّل", "Not recorded")}</Flag>}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <span className="hr-caption">{countNoun(shown.length, lang, forms)} · {L("المحدد", "Selected")}: <span className="hr-num">{selected.length}</span></span>
      {dialog && canPrint && certified === true ? (
        <PrintDialog open onClose={() => setDialog(false)} items={items} initialTemplate={kind === "green" ? "GREEN_LOT" : "MATERIAL_SHELF"}
          subtitle={`${countNoun(items.length, lang, forms)} ${L("محددة في الملصقات", "selected in Labels")}`}
          onPrinted={(id) => { onPrinted(id); setDialog(false); }} />
      ) : null}
    </section>
  );
}
