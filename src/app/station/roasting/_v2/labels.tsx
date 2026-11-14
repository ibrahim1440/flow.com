"use client";
/**
 * D12 L1 / L2 — the 100×75 mm labels, printed from the browser (thermal / direct-thermal at the roaster). Black only:
 * a black band with the coffee's first letter, a huge bucket number (L1) or the lot number (L2), and a Code 128 barcode
 * (the shared print Barcode, JsBarcode's encoder, already in the application). Both languages on every label (the
 * owner's decision): Arabic and English side by side, whatever the screen's language.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Barcode } from "@/components/print/Codes";

export type BucketLabelData = { letter: string; coffee: string; coffeeEn: string; seqNo: number; kg: number; date: string; session: string; lot: string; barcode: string };
export type LotLabelData = { letter: string; coffee: string; coffeeEn: string; batchNumber: string; roastedKg: number; runs: string[]; buckets: number[]; greenKg: number; at: string; roaster: string };

const kg2 = (n: number) => n.toFixed(2);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The label's date, the same in both languages: dd-MMM-yyyy (Riyadh), with the time when asked — «08-Nov-2026 14:05». */
export function labelDate(at: Date | string | number = new Date(), withTime = false): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const d = `${p.day}-${MON[Number(p.month) - 1]}-${p.year}`;
  return withTime ? `${d} ${p.hour === "24" ? "00" : p.hour}:${p.minute}` : d;
}

/*
 * Both labels keep the barcode row fixed at the bottom (never pushed out: the text rows above it shrink and clip
 * instead), with its quiet zone; Arabic and English share each line («محمّص · Roasted»).
 */
export function BucketLabel({ d }: { d: BucketLabelData }) {
  return (
    <div className="rv2-label" data-testid="rv2-label-l1">
      <div className="rv2-label-band"><span>{d.coffee} · <bdi dir="ltr" lang="en">{d.coffeeEn}</bdi> · أخضر · Green</span><b>{d.letter}</b></div>
      <div className="rv2-label-mid">
        <div className="rv2-label-num"><small>دلو<br />Bucket</small><span>{d.seqNo}</span></div>
        <div className="rv2-label-facts">
          <b>{kg2(d.kg)} كجم · kg</b>
          <span><bdi dir="ltr">{d.date}</bdi></span>
          <code>{d.session}</code>
          <code>{d.lot}</code>
        </div>
      </div>
      <div className="rv2-label-code"><Barcode value={d.barcode} widthMm={80} heightMm={13} /></div>
    </div>
  );
}

export function LotLabel({ d }: { d: LotLabelData }) {
  return (
    <div className="rv2-label rv2-label-l2" data-testid="rv2-label-l2">
      <div className="rv2-label-band"><span>{d.coffee} · <bdi dir="ltr" lang="en">{d.coffeeEn}</bdi></span><b>{d.letter}</b></div>
      <div className="rv2-label-lot">
        <div className="rv2-label-lotno"><small>الدفعة · Lot</small><span>{d.batchNumber}</span></div>
        <div className="rv2-label-facts"><b>{kg2(d.roastedKg)} كجم · kg</b><span>محمّص · Roasted</span></div>
      </div>
      <div className="rv2-label-runs">
        <span><b>{d.runs.length === 2 ? "حمصتان · Two roasts" : "حمصة منفردة · Single"}</b> <bdi dir="ltr">{d.runs.join(" + ")}</bdi></span>
        <span>الدلو · Bucket <bdi dir="ltr">{d.buckets.join(" + ")}</bdi> · {kg2(d.greenKg)} كجم أخضر · kg green</span>
        <span>حُمّص · Roasted <bdi dir="ltr">{d.at}</bdi> · {d.roaster}</span>
      </div>
      <div className="rv2-label-code"><Barcode value={d.batchNumber} widthMm={72} heightMm={12} /></div>
    </div>
  );
}

/**
 * Station label — يطبع دائمًا (قرار المالك 13 Nov 2026، أرضية التحميص تعتمد عليها): the one print that does not follow
 * PRINT_CERTIFIED / PRINT_DOCUMENTS_ENABLED (tests/print/unit/print-disable-all.test.ts lists it as "station-always").
 *
 * Print one label now: rendered into a print-only layer (100×75 mm page) and window.print() once per mount (re-mount it —
 * a new `key` — to print again). The last label stays in the layer, hidden on screen.
 */
export function PrintLabel({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const t = setTimeout(() => {
      try { window.print(); } catch { /* no printer dialog */ }
    }, 60);
    return () => clearTimeout(t);
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(<div className="rv2-print" aria-hidden>{children}</div>, document.body);
}
