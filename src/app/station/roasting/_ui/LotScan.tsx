"use client";
// The roasting station's green-lot scan (20261114090000_green_lot_labels): the roaster scans the label of the sack the
// green is drawn from. GET /api/station/roasting/lot refuses an inactive lot, one short of the green weight, or (for a
// roaster without production › roast_to_stock) another coffee — the reason in both languages; otherwise the lot is
// chosen for this roast and its id goes with «تسجيل الدفعة» (the roast POST re-checks the stock atomically).
import { ScanInput, lookupScanCode, type ScanFeedback } from "@/components/scan/ScanInput";

export type ScannedLot = { id: string; serial: string; code: string; nameAr: string | null; nameEn: string; kg: number };
type Hit = { id: string; code: string; serialNumber: string; beanType: string; beanTypeAr: string | null; quantityKg: number };

export function StationLotScan({ lang, productId, greenKg, auto, lot, onLot }: {
  lang: "ar" | "en"; productId: string | null; greenKg: number;
  /** The lot the server would pick by itself (product default / FIFO), shown until a sack is scanned. */
  auto: { serial: string; nameAr: string | null; nameEn: string } | null;
  lot: ScannedLot | null; onLot: (l: ScannedLot | null) => void;
}) {
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  async function onCode(code: string): Promise<ScanFeedback> {
    const r = await lookupScanCode<Hit>(code, lang, { productId: productId ?? undefined, kg: greenKg > 0 ? +greenKg.toFixed(3) : undefined }, "/api/station/roasting/lot");
    if (!r.ok) return { tone: "danger", text: r.message };
    const h = r.hit;
    onLot({ id: h.id, serial: h.serialNumber, code: h.code, nameAr: h.beanTypeAr, nameEn: h.beanType, kg: h.quantityKg });
    const name = lang === "ar" ? h.beanTypeAr || h.beanType : h.beanType;
    return { tone: "success", text: L(`سيُسحب من ${name} · ${h.serialNumber} — المتاح ${Math.round(h.quantityKg * 100) / 100} كغ`, `Drawing from ${name} · ${h.serialNumber} — ${Math.round(h.quantityKg * 100) / 100} kg available`) };
  }
  const shown = lot ?? auto;
  return (
    <div className="ws-lotscan" data-testid="station-lot-scan">
      <div className="ws-lotscan-h">
        <b>{L("مصدر البن الأخضر", "Green source")}</b>
        <span data-testid="station-lot-current">
          {shown ? <>{lang === "ar" ? shown.nameAr || shown.nameEn : shown.nameEn} · <bdi dir="ltr">{shown.serial}</bdi></> : "—"}
          {lot ? <> · {L("ممسوح", "scanned")} · <button type="button" className="st-textlink" onClick={() => onLot(null)} data-testid="station-lot-clear">{L("العودة للتلقائي", "Back to automatic")}</button></> : <> · {L("تلقائي", "automatic")}</>}
        </span>
      </div>
      <ScanInput listen lang={lang} onCode={onCode} testId="station-lot" placeholder={L("امسح ملصق الكيس الذي تسحب منه", "Scan the label of the sack you draw from")} />
    </div>
  );
}
