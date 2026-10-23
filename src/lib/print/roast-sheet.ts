// The roast sheet «ورقة التحميص» (feat/print-docs): the A4 sheet operators keep at the roaster.
// Pure and client-safe — the server gathers the facts (src/lib/print/server/documents.ts), this file
// decides what each part of the printed page says, and DocumentSheet lays it out. Asserted without a
// browser in tests/print/unit/print-documents.test.ts.
//
// No Figma frame exists for a printed roast sheet (the «Record roast sheet» frames 344:3458 / 305:1457
// are the data-entry dialog, which this does not replace). The page follows the quotation document's
// A4 layout (QP-05 1295:987) and the Direction 2.1 tokens.
//
// Two variants:
//   · day   — «طباعة ورقة التحميص» from the schedule's day board: every slot of one Riyadh day on a
//             roaster (one sheet per roaster), planned green beside EMPTY columns the operator fills
//             by hand (actual green, actual roasted, roast time, loss, signature), then blank rows
//             for an unplanned roast. A slot already recorded prints its actual figures instead.
//   · batch — «طباعة» on one recorded batch: the same row filled with that batch's actual figures.
//
// Planned and actual are never merged (ROASTERS.md §5.9): the planned green is the slot's, the
// actual weights are the batch's, and nothing here computes one from the other except the stated
// expected roasted weight (planned green × (1 − the product's expected loss)).
import { riyadhTime } from "../services/schedule/planner";
import type { DocCell, DocColumn, DocLang } from "./quote-document";

export type RoastSheetLot = { serial: string; name: string | null; source: "recorded" | "default" | "fifo_fallback" };

/** One row: a planned slot (with its batch once recorded) or a batch recorded without a slot. */
export type RoastSheetEntry = {
  kind: "slot" | "batch";
  startsAt: string | null;
  endsAt: string | null;
  coffee: { ar: string; en: string };
  /** DEMAND (open orders) | STOCK (roast to stock) for a slot; for a batch, from its order line. */
  purpose: "DEMAND" | "STOCK" | null;
  orderNumber: number | null;
  operatorName: string | null;
  plannedGreenKg: number | null;
  /** The product's expected roast loss, percent (CoffeeProduct.expectedRoastLoss). */
  expectedLossPct: number | null;
  /** The recorded lot, or for a planned slot the lot the automatic choice would take today. */
  greenLot: RoastSheetLot | null;
  /** Slot: PLANNED | IN_PROGRESS | RECORDED | MISSED. Batch: RECORDED. */
  status: string;
  actual: { batchNumber: string; greenKg: number; roastedKg: number; batchStatus: string; recordedAt: string; roastProfile: string | null } | null;
};

export type RoastSheetRoaster = {
  id: string | null;
  name: string | null;
  window: { start: string; end: string } | null;
  maintenance: { title: string; startsAt: string; endsAt: string }[];
  entries: RoastSheetEntry[];
};

export type RoastSheetData = {
  mode: "day" | "batch";
  /** The Riyadh day (YYYY-MM-DD) the sheet is for. */
  day: string;
  roasters: RoastSheetRoaster[];
};

/** Blank rows printed under the day's slots for a roast that was not planned. */
export const ROAST_SHEET_BLANK_ROWS = 4;

const nf2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** «12.50» — two places, Latin digits, grouped. */
export const kgText = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf2(n));

/** (green − roasted) / green, in percent; null when there is no green to measure against. */
export function lossPercent(greenKg: number | null | undefined, roastedKg: number | null | undefined): number | null {
  if (!greenKg || !Number.isFinite(greenKg) || greenKg <= 0 || roastedKg === null || roastedKg === undefined || !Number.isFinite(roastedKg)) return null;
  return Math.round(((greenKg - roastedKg) / greenKg) * 1000) / 10;
}

/** What the planned green should come out as at the product's expected loss. */
export function expectedRoastedKg(plannedGreenKg: number | null, lossPct: number | null): number | null {
  if (plannedGreenKg === null || !Number.isFinite(plannedGreenKg) || lossPct === null || !Number.isFinite(lossPct)) return null;
  return Math.round(plannedGreenKg * (1 - lossPct / 100) * 100) / 100;
}

/** «07:00–07:20», Riyadh time; «07:00» without an end; «—» without a start. */
export function clockRange(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "—";
  const a = riyadhTime(new Date(startsAt));
  return endsAt ? `${a}–${riyadhTime(new Date(endsAt))}` : a;
}

const STATUS: Record<string, { ar: string; en: string }> = {
  PLANNED: { ar: "مخططة", en: "Planned" },
  IN_PROGRESS: { ar: "جارية", en: "In progress" },
  RECORDED: { ar: "مسجّلة", en: "Recorded" },
  MISSED: { ar: "فائتة", en: "Missed" },
  CANCELLED: { ar: "ملغاة", en: "Cancelled" },
};
export const slotStatusText = (s: string, lang: DocLang) => STATUS[s]?.[lang] ?? s;

const BATCH_STATUS: Record<string, { ar: string; en: string }> = {
  "Pending QC": { ar: "بانتظار الجودة", en: "Pending QC" },
  Passed: { ar: "مقبولة", en: "Passed" },
  Rejected: { ar: "مرفوضة", en: "Rejected" },
  Packaged: { ar: "معبأة", en: "Packaged" },
  Completed: { ar: "مكتملة", en: "Completed" },
  Blended: { ar: "مخلوطة", en: "Blended" },
};
export const batchStatusText = (s: string, lang: DocLang) => BATCH_STATUS[s]?.[lang] ?? s;

/** The columns, in reading order: # · time · coffee (lot under it) · operator · planned green · the hand-filled five. */
export const ROAST_SHEET_COLUMNS = [
  "index", "time", "coffee", "operator", "planned", "actualGreen", "actualRoasted", "roastTime", "loss", "signature",
] as const;
export type RoastSheetColumnKey = (typeof ROAST_SHEET_COLUMNS)[number];

const COLUMN_LABELS: Record<RoastSheetColumnKey, { ar: string; en: string }> = {
  index: { ar: "#", en: "#" },
  time: { ar: "الوقت", en: "Time" },
  coffee: { ar: "القهوة واللوت الأخضر", en: "Coffee & green lot" },
  operator: { ar: "المشغّل", en: "Operator" },
  planned: { ar: "أخضر مخطط · كغ", en: "Planned green · kg" },
  actualGreen: { ar: "أخضر فعلي · كغ", en: "Actual green · kg" },
  actualRoasted: { ar: "محمص فعلي · كغ", en: "Actual roasted · kg" },
  roastTime: { ar: "زمن التحميص", en: "Roast time" },
  loss: { ar: "الفاقد %", en: "Loss %" },
  signature: { ar: "التوقيع", en: "Signature" },
};

/** The columns the operator writes in when the row has no recorded batch. */
export const WRITE_IN_COLUMNS: readonly RoastSheetColumnKey[] = ["actualGreen", "actualRoasted", "roastTime", "loss", "signature"];

export function roastSheetColumns(lang: DocLang): DocColumn[] {
  return ROAST_SHEET_COLUMNS.map((key) => ({
    key,
    label: COLUMN_LABELS[key][lang],
    numeric: key === "planned" || key === "actualGreen" || key === "actualRoasted" || key === "loss",
    muted: key === "index",
    writeIn: WRITE_IN_COLUMNS.includes(key),
  }));
}

const coffeeName = (e: RoastSheetEntry, lang: DocLang) => (lang === "ar" ? e.coffee.ar : e.coffee.en) || "—";
/** One run kept whole in the other direction (FSI … PDI): a serial, «#1046», «15%» in an Arabic line. */
const iso = (s: string) => `\u2068${s}\u2069`;

/** The line under the coffee: the green lot, and what the row is for. */
function coffeeSub(e: RoastSheetEntry, lang: DocLang): string | null {
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const parts: string[] = [];
  if (e.greenLot) {
    const tag = e.greenLot.source === "recorded" ? "" : e.greenLot.source === "fifo_fallback" ? L(" (بديل الأقدم)", " (oldest fallback)") : L(" (متوقع)", " (expected)");
    parts.push(`${L("لوت", "Lot")} ${iso(e.greenLot.serial)}${tag}`);
  } else {
    parts.push(L("اللوت: يحدده المشرف", "Lot: set by the supervisor"));
  }
  if (e.orderNumber !== null) parts.push(iso(`#${e.orderNumber}`));
  else if (e.purpose === "STOCK") parts.push(L("للمخزون", "For stock"));
  if (e.actual) parts.push(iso(e.actual.batchNumber));
  return parts.map(iso).join(" · ");
}

/**
 * One row → its cells, in ROAST_SHEET_COLUMNS order. A row with a recorded batch prints the batch's
 * actual weights and loss; otherwise those columns are left empty for the operator's hand.
 */
export function roastSheetCells(e: RoastSheetEntry, ordinal: number, lang: DocLang): DocCell[] {
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const expected = expectedRoastedKg(e.plannedGreenKg, e.expectedLossPct);
  const a = e.actual;
  const loss = a ? lossPercent(a.greenKg, a.roastedKg) : null;
  const byKey: Record<RoastSheetColumnKey, DocCell> = {
    index: { main: String(ordinal) },
    time: { main: clockRange(e.startsAt, e.endsAt), sub: e.kind === "slot" ? slotStatusText(e.status, lang) : L("بلا خانة", "No slot") },
    coffee: { main: coffeeName(e, lang), sub: coffeeSub(e, lang), subMono: false },
    operator: { main: e.operatorName || "—" },
    planned: {
      main: e.plannedGreenKg === null ? "—" : kgText(e.plannedGreenKg),
      sub: expected === null ? null : `${L("متوقع", "Exp.")} ${iso(kgText(expected))}`,
    },
    actualGreen: { main: a ? kgText(a.greenKg) : "" },
    actualRoasted: { main: a ? kgText(a.roastedKg) : "" },
    roastTime: { main: "" },
    loss: { main: loss === null ? "" : `${loss.toFixed(1)}%`, sub: a && e.expectedLossPct !== null ? `${L("متوقع", "Exp.")} ${iso(`${e.expectedLossPct}%`)}` : null },
    signature: { main: "" },
  };
  return ROAST_SHEET_COLUMNS.map((k) => byKey[k]);
}

/** A row for a roast that was not planned: only the ordinal, everything else by hand. */
export function blankRoastSheetCells(ordinal: number): DocCell[] {
  return ROAST_SHEET_COLUMNS.map((k) => ({ main: k === "index" ? String(ordinal) : "" }));
}

export function roastSheetTotals(entries: RoastSheetEntry[]) {
  const planned = entries.reduce((s, e) => s + (e.plannedGreenKg ?? 0), 0);
  const recorded = entries.filter((e) => e.actual);
  return {
    rows: entries.length,
    slots: entries.filter((e) => e.kind === "slot").length,
    plannedGreenKg: Math.round(planned * 100) / 100,
    recorded: recorded.length,
    actualGreenKg: Math.round(recorded.reduce((s, e) => s + (e.actual?.greenKg ?? 0), 0) * 100) / 100,
    actualRoastedKg: Math.round(recorded.reduce((s, e) => s + (e.actual?.roastedKg ?? 0), 0) * 100) / 100,
  };
}

/** The reference printed in the footer: «RS-20261023» for a day (and roaster), «RS-<batch>» for a batch. */
export function roastSheetDocNumber(data: Pick<RoastSheetData, "mode" | "day">, entry?: RoastSheetEntry | null): string {
  if (data.mode === "batch" && entry?.actual) return `RS-${entry.actual.batchNumber}`;
  return `RS-${data.day.replace(/-/g, "")}`;
}
