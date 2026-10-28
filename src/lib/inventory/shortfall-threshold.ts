// The owner's shortfall threshold (feat/shortfall-threshold): a receiver's shortfall ABOVE the limit is not recorded on
// the receiver's authority — it needs inventory › adjust and the full stock-change gate (step-up), like any stock
// adjustment. Over the limit when ANY of:
//   per line —
//     · PERCENT  — qtyShort is more than `percent` % of the line's qty (default 2 %);
//     · VALUE    — the shortfall's value is more than `valueSar` SAR (default 500);
//     · ZERO     — the line is received at 0 (default on);
//     · UNKNOWN  — no cost is known for the item at all (no moving average, no last receipt, no purchase) — «قيمة غير
//                  معروفة»: a shortfall nobody can value is not waved through (council F2);
//   per transfer (council F1, splitting must not slip under the limit) —
//     · TRANSFER_VALUE — Σ of its lines' shortfall values is more than `valueSar` (named when no line alone is);
//   per receiver (council F1) —
//     · ROLLING  — Σ of the shortfall value THIS receiver recorded in the last 30 days, the current one included, is more
//                  than `rollingMultiple` × `valueSar` (default 2 ×).
// The value: the write-off's own — costing.issue on the item's cost holder at the moving average; a holder with no qty or
// no value falls back to the last known unit cost (the last receipt, else the last purchase), as the opening valuation
// does. Below the limit the c8716fd1 rules stay (a verified individual; the sender needs adjust; the supervisors are told).
// Settings › Inventory (SystemConfig.inventoryShortfall*; NULL = the default). Pure: no database, no Decimal (the
// preview route uses it too).

export const SHORTFALL_PERCENT_DEFAULT = 2;
export const SHORTFALL_VALUE_SAR_DEFAULT = 500;
export const SHORTFALL_ZERO_DEFAULT = true;
export const SHORTFALL_ROLLING_MULTIPLE_DEFAULT = 2;
export const SHORTFALL_ROLLING_DAYS = 30;
/** Settings at or past these are allowed, with a warning (council F3): «تحذير: الحد مرتفع، النقص الكبير سيمر بدون مشرف». */
export const HIGH_PERCENT = 50;
export const HIGH_VALUE_SAR = 10_000;

export type ShortfallLimits = { percent: number; valueSar: number; zeroNeedsAdjust: boolean; rollingMultiple: number };
export type Breach = "PERCENT" | "VALUE" | "ZERO" | "UNKNOWN";
export type TransferBreach = "TRANSFER_VALUE" | "ROLLING";
/** valueSar null = no cost known for the item. */
export type LineCheck = { lineNo: number; qty: number; qtyReceived: number; qtyShort: number; valueSar: number | null };
export type LineBreach = LineCheck & { breaches: Breach[] };
export type Judgement = { lines: LineBreach[]; transfer: TransferBreach[]; totalValue: number; rollingValue: number; rollingLimit: number; over: boolean };

const EPS = 1e-9;
type Num = { toString(): string } | number | null | undefined;
const num = (v: Num) => (v === null || v === undefined ? null : String(Number(v.toString())));

/** The limits in force: the stored values, else the defaults. */
export function shortfallLimitsFromRow(row: { inventoryShortfallPercent?: Num; inventoryShortfallValueSar?: Num; inventoryShortfallZeroNeedsAdjust?: boolean | null; inventoryShortfallRollingMultiple?: Num } | null | undefined): ShortfallLimits & { stored: { percent: string | null; valueSar: string | null; zeroNeedsAdjust: boolean | null; rollingMultiple: string | null } } {
  const p = num(row?.inventoryShortfallPercent), v = num(row?.inventoryShortfallValueSar), m = num(row?.inventoryShortfallRollingMultiple);
  const z = row?.inventoryShortfallZeroNeedsAdjust ?? null;
  return {
    percent: p === null ? SHORTFALL_PERCENT_DEFAULT : Number(p),
    valueSar: v === null ? SHORTFALL_VALUE_SAR_DEFAULT : Number(v),
    zeroNeedsAdjust: z === null ? SHORTFALL_ZERO_DEFAULT : z,
    rollingMultiple: m === null ? SHORTFALL_ROLLING_MULTIPLE_DEFAULT : Number(m),
    stored: { percent: p, valueSar: v, zeroNeedsAdjust: z, rollingMultiple: m },
  };
}

/** Council F3: the limits that let a large shortfall pass without a supervisor (a warning, never a block). */
export function highLimits(l: ShortfallLimits): ("PERCENT" | "VALUE" | "ZERO")[] {
  const out: ("PERCENT" | "VALUE" | "ZERO")[] = [];
  if (l.percent >= HIGH_PERCENT) out.push("PERCENT");
  if (l.valueSar >= HIGH_VALUE_SAR) out.push("VALUE");
  if (!l.zeroNeedsAdjust) out.push("ZERO");
  return out;
}

/** Which per-line limits one short line exceeds (empty: within, or no shortfall). Strictly MORE than the limit. */
export function lineBreaches(l: LineCheck, lim: ShortfallLimits): Breach[] {
  if (!(l.qtyShort > EPS) || !(l.qty > 0)) return [];
  const out: Breach[] = [];
  if (l.qtyShort > (l.qty * lim.percent) / 100 + EPS) out.push("PERCENT");
  if (l.valueSar === null) out.push("UNKNOWN");
  else if (l.valueSar > lim.valueSar + 0.005) out.push("VALUE");
  if (lim.zeroNeedsAdjust && l.qtyReceived <= EPS) out.push("ZERO");
  return out;
}

/** Back-compatible: the over-limit lines only. */
export function breachesOf(lines: LineCheck[], lim: ShortfallLimits): LineBreach[] {
  return lines.map((l) => ({ ...l, breaches: lineBreaches(l, lim) })).filter((l) => l.breaches.length > 0);
}

/**
 * The whole judgement: per line, per transfer (Σ of its lines' values), per receiver over 30 days (`priorRolling`: what
 * this receiver recorded before, in SAR). A line of unknown value counts 0 in the sums (it is over the limit already).
 */
export function judgeShortfall(lines: LineCheck[], lim: ShortfallLimits, priorRolling = 0): Judgement {
  const short = lines.filter((l) => l.qtyShort > EPS);
  const all = short.map((l) => ({ ...l, breaches: lineBreaches(l, lim) }));
  const totalValue = round2(short.reduce((s, l) => s + (l.valueSar ?? 0), 0));
  const rollingValue = round2(priorRolling + totalValue);
  const rollingLimit = round2(lim.rollingMultiple * lim.valueSar);
  const transfer: TransferBreach[] = [];
  if (short.length) {
    // The sum is its own finding only when no single line is over the value limit already (it would say the same).
    if (totalValue > lim.valueSar + 0.005 && !all.some((l) => l.breaches.includes("VALUE"))) transfer.push("TRANSFER_VALUE");
    if (rollingValue > rollingLimit + 0.005) transfer.push("ROLLING");
  }
  const over = all.filter((l) => l.breaches.length > 0);
  return { lines: over, transfer, totalValue, rollingValue, rollingLimit, over: over.length > 0 || transfer.length > 0 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => String(Number(n.toFixed(2)));
const sar = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «تجاوز الحد» in words, per limit (Arabic, English). `showValues`: the shortfall's amount in SAR (cost readers only). */
export function breachWords(b: Breach | TransferBreach, lim: ShortfallLimits, l?: LineCheck | null, j?: Judgement | null, showValues = true): [string, string] {
  if (b === "PERCENT") return [`النقص أكثر من ${fmt(lim.percent)}٪ من الكمية${l ? ` (${fmt((l.qtyShort / l.qty) * 100)}٪)` : ""}`, `the shortfall is more than ${fmt(lim.percent)} % of the quantity${l ? ` (${fmt((l.qtyShort / l.qty) * 100)} %)` : ""}`];
  if (b === "VALUE") return [`قيمة النقص أكثر من ${fmt(lim.valueSar)} ر.س${l && showValues && l.valueSar !== null ? ` (${sar(l.valueSar)} ر.س)` : ""}`, `the shortfall's value is more than SAR ${fmt(lim.valueSar)}${l && showValues && l.valueSar !== null ? ` (SAR ${sar(l.valueSar)})` : ""}`];
  if (b === "UNKNOWN") return ["قيمة غير معروفة: لا تكلفة معروفة للصنف", "value unknown: no cost is known for the item"];
  if (b === "ZERO") return ["السطر استُلم بصفر", "the line was received at zero"];
  if (b === "TRANSFER_VALUE") return [`مجموع قيمة النقص في التحويل أكثر من ${fmt(lim.valueSar)} ر.س${j && showValues ? ` (${sar(j.totalValue)} ر.س)` : ""}`, `the transfer's total shortfall value is more than SAR ${fmt(lim.valueSar)}${j && showValues ? ` (SAR ${sar(j.totalValue)})` : ""}`];
  const lim2 = round2(lim.rollingMultiple * lim.valueSar);
  return [`مجموع النقص الذي سجّلته خلال ${SHORTFALL_ROLLING_DAYS} يومًا أكثر من ${fmt(lim2)} ر.س${j && showValues ? ` (${sar(j.rollingValue)} ر.س)` : ""}`, `the shortfall you recorded in ${SHORTFALL_ROLLING_DAYS} days is more than SAR ${fmt(lim2)}${j && showValues ? ` (SAR ${sar(j.rollingValue)})` : ""}`];
}

/** The judgement in words (Arabic, English): each line's limits, then the transfer's and the receiver's. */
export function judgementWords(j: Judgement, lim: ShortfallLimits, showValues = true): [string, string] {
  const ar = j.lines.map((l) => `السطر ${l.lineNo}: ${l.breaches.map((b) => breachWords(b, lim, l, j, showValues)[0]).join("، ")}`).concat(j.transfer.map((b) => breachWords(b, lim, null, j, showValues)[0]));
  const en = j.lines.map((l) => `line ${l.lineNo}: ${l.breaches.map((b) => breachWords(b, lim, l, j, showValues)[1]).join(", ")}`).concat(j.transfer.map((b) => breachWords(b, lim, null, j, showValues)[1]));
  return [ar.join("؛ "), en.join("; ")];
}

export const THRESHOLD_CODE = "SHORTFALL_THRESHOLD_ADJUST_REQUIRED";

/** 403 SHORTFALL_THRESHOLD_ADJUST_REQUIRED, naming each limit exceeded (and on which line). */
export function thresholdRefusal(j: Judgement, lim: ShortfallLimits, showValues = true) {
  const [ar, en] = judgementWords(j, lim, showValues);
  return {
    status: 403 as const, code: THRESHOLD_CODE,
    error: `النقص تجاوز الحد (${ar})؛ تسجيله يحتاج صلاحية «تسوية المخزون» وتأكيد الهوية. استلم الكمية كاملة أو اطلب من مشرف.`,
    errorEn: `The shortfall exceeds the limit (${en}): recording it needs «adjust stock» and an identity confirmation. Receive in full or ask a supervisor.`,
    limits: [...new Set<Breach | TransferBreach>([...j.lines.flatMap((l) => l.breaches), ...j.transfer])],
  };
}
