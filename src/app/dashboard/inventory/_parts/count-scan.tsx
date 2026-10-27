"use client";
// Scanning in «الجرد والتسويات» (20261114090000_green_lot_labels): the one scan input (keyboard-wedge or camera) on the
// count sheet and on «إجراء جرد». A scanned green lot «GL-…» or shelf label «MT-…» focuses its count line — or adds it
// to the open sheet first (PATCH /api/inventory/counts/:id { add }) — so the counter scans, types the quantity, scans
// the next sack. Kept apart from counts.tsx so the sheet itself changes by a few lines only.
import { ScanInput, lookupScanCode, type ScanFeedback } from "@/components/scan/ScanInput";
import { useI18n } from "@/lib/i18n/context";

type Category = "RAW_MATERIAL" | "PACKAGING_MATERIAL";
type Hit = { kind: "GREEN_LOT" | "MATERIAL" | "SKU"; id: string; code: string; serialNumber?: string; beanType?: string; beanTypeAr?: string | null; name?: string; nameAr?: string | null; itemCode?: string; isActive: boolean };

const catOf = (h: Hit): Category | null => (h.kind === "GREEN_LOT" ? "RAW_MATERIAL" : h.kind === "MATERIAL" ? "PACKAGING_MATERIAL" : null);
const nameOf = (h: Hit, lang: "ar" | "en") => (h.kind === "GREEN_LOT" ? `${(lang === "ar" && h.beanTypeAr) || h.beanType} · ${h.serialNumber}` : `${(lang === "ar" && h.nameAr) || h.name} · ${h.itemCode}`);

/** Focus (and briefly mark) the counted-quantity box of a line. */
export function focusCountLine(lineId: string) {
  const row = document.querySelector<HTMLElement>(`[data-count-line="${CSS.escape(lineId)}"]`);
  const input = row?.querySelector<HTMLInputElement>("input[data-testid='count-qty']");
  row?.scrollIntoView({ block: "center", behavior: "smooth" });
  row?.classList.add("is-scanned");
  setTimeout(() => row?.classList.remove("is-scanned"), 1600);
  input?.focus();
  input?.select();
}

/**
 * The count sheet's scan: `lines` are the sheet's (category, entityId); `add` puts a new item on the open sheet and
 * returns its line id.
 */
export function CountSheetScan({ lines, add }: {
  lines: { id: string; category: Category; entityId: string }[];
  add: (category: Category, entityId: string) => Promise<string | null>;
}) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  async function onCode(code: string): Promise<ScanFeedback> {
    const r = await lookupScanCode<Hit>(code, lang === "en" ? "en" : "ar");
    if (!r.ok) return { tone: "danger", text: r.message };
    const h = r.hit as Hit;
    const cat = catOf(h);
    if (!cat) return { tone: "warning", text: L("هذا باركود منتج جاهز — الجرد هنا للبن الأخضر ومواد التعبئة.", "That is a finished-product barcode — this count is for green coffee and packaging materials.") };
    const line = lines.find((l) => l.category === cat && l.entityId === h.id);
    if (line) { focusCountLine(line.id); return { tone: "success", text: L(`في الورقة: ${nameOf(h, "ar")} — أدخل الكمية المعدودة.`, `On the sheet: ${nameOf(h, "en")} — enter the counted quantity.`) }; }
    if (!h.isActive) return { tone: "danger", text: L(`${nameOf(h, "ar")} غير نشط — لا يُضاف إلى الجرد.`, `${nameOf(h, "en")} is inactive — not added to the count.`) };
    const id = await add(cat, h.id);
    if (!id) return { tone: "danger", text: L("تعذّرت إضافته إلى ورقة الجرد.", "Could not add it to the count sheet.") };
    setTimeout(() => focusCountLine(id), 50);
    return { tone: "success", text: L(`أُضيف إلى الجرد: ${nameOf(h, "ar")} — أدخل الكمية المعدودة.`, `Added to the count: ${nameOf(h, "en")} — enter the counted quantity.`) };
  }
  return <ScanInput listen onCode={onCode} testId="count-scan" placeholder={L("امسح ملصق اللوت أو الرف", "Scan a lot or shelf label")} />;
}

/** «إجراء جرد»: a scan ticks the item in the picker (switching to its tab). */
export function StartCountScan({ onPick }: { onPick: (category: Category, entityId: string) => "added" | "already" }) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  async function onCode(code: string): Promise<ScanFeedback> {
    const r = await lookupScanCode<Hit>(code, lang === "en" ? "en" : "ar");
    if (!r.ok) return { tone: "danger", text: r.message };
    const h = r.hit as Hit;
    const cat = catOf(h);
    if (!cat) return { tone: "warning", text: L("هذا باركود منتج جاهز — الجرد هنا للبن الأخضر ومواد التعبئة.", "That is a finished-product barcode — this count is for green coffee and packaging materials.") };
    if (!h.isActive) return { tone: "danger", text: L(`${nameOf(h, "ar")} غير نشط.`, `${nameOf(h, "en")} is inactive.`) };
    const res = onPick(cat, h.id);
    return res === "already"
      ? { tone: "info", text: L(`محدد من قبل: ${nameOf(h, "ar")}`, `Already selected: ${nameOf(h, "en")}`) }
      : { tone: "success", text: L(`حُدّد للجرد: ${nameOf(h, "ar")}`, `Selected for the count: ${nameOf(h, "en")}`) };
  }
  return <ScanInput listen onCode={onCode} testId="start-count-scan" placeholder={L("امسح الملصقات لتحديدها", "Scan labels to select them")} />;
}
