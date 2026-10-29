// «القيود السهلة» (feat/recurring-journals) — a journal template's lines and how they become a journal. Pure (Decimal,
// no database): the service, the routes and the unit / golden tests share it.
//
//   · FIXED   each line carries an amount; the template balances (Σ debit = Σ credit > 0).
//   · PERCENT each line carries a percentage of the total entered at use time; the debit lines' percentages sum to
//             exactly 100 and so do the credit lines'. Applying it to a total T: every line but the LAST of its side is
//             T × % ÷ 100 rounded HALF-UP to the halala (the ledger's one rounding rule, ../money); the last line of the
//             side takes the remainder (T − Σ the others), so each side sums to T exactly and the journal balances
//             without a rounding line.
// A line that comes to zero (a tiny percentage of a small total) is refused: a journal line is never zero.
import { Decimal, MoneyError, ZERO, roundMoney, toDecimal } from "../money";

export const AMOUNT_MODES = ["FIXED", "PERCENT"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];
export const SIDES = ["D", "C"] as const;
export type Side = (typeof SIDES)[number];

export type TemplateLine = {
  accountId: string;
  side: Side;
  /** FIXED: the amount ("1250.00"). */
  amount?: string | null;
  /** PERCENT: the share of the total ("33.3333", up to 4 decimals). */
  percent?: string | null;
  description?: string | null;
  branchId?: string | null;
  costCenterId?: string | null;
  partyType?: string | null;
  partyId?: string | null;
};

export type AppliedLine = {
  accountId: string;
  debit: string;
  credit: string;
  description: string | null;
  branchId: string | null;
  costCenterId: string | null;
  partyType: string | null;
  partyId: string | null;
};

export type TemplateProblem = { index: number; code: string; ar: string; en: string };

export const MAX_TEMPLATE_LINES = 100;
const PCT = /^\d{1,3}(\.\d{1,4})?$/;
const HUNDRED = new Decimal(100);
const s = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Clean and check a template's lines for its mode; the problems are per line (index -1: the whole template). */
export function checkTemplateLines(mode: AmountMode, raw: unknown): { lines: TemplateLine[]; problems: TemplateProblem[] } {
  const problems: TemplateProblem[] = [];
  const p = (index: number, code: string, ar: string, en: string) => problems.push({ index, code, ar, en });
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < 2) p(-1, "LINES_MIN", "القالب يحتاج سطرين على الأقل.", "A template needs at least two lines.");
  if (list.length > MAX_TEMPLATE_LINES) p(-1, "LINES_MAX", `الحد الأقصى ${MAX_TEMPLATE_LINES} سطر.`, `At most ${MAX_TEMPLATE_LINES} lines.`);
  const lines: TemplateLine[] = [];
  let dr = ZERO, cr = ZERO, dp = ZERO, cp = ZERO, nd = 0, nc = 0;
  list.slice(0, MAX_TEMPLATE_LINES).forEach((r0, i) => {
    const r = (r0 && typeof r0 === "object" ? r0 : {}) as Record<string, unknown>;
    const accountId = s(r.accountId, 64);
    if (!accountId) p(i, "ACCOUNT", "اختر الحساب.", "Choose the account.");
    const side = r.side === "D" || r.side === "C" ? r.side : null;
    if (!side) p(i, "SIDE", "اختر مدين أو دائن.", "Choose debit or credit.");
    let amount: string | null = null, percent: string | null = null;
    if (mode === "FIXED") {
      try {
        const a = toDecimal(typeof r.amount === "number" && Number.isInteger(r.amount) ? r.amount : String(r.amount ?? ""));
        if (!a.equals(a.toDecimalPlaces(2)) || a.lessThanOrEqualTo(0)) throw new MoneyError("amount");
        amount = roundMoney(a).toFixed(2);
        if (side === "D") dr = dr.plus(amount); else if (side === "C") cr = cr.plus(amount);
      } catch {
        p(i, "AMOUNT", "المبلغ رقم أكبر من صفر بمنزلتين عشريتين على الأكثر.", "The amount is a number above zero with at most 2 decimals.");
      }
    } else {
      const t = typeof r.percent === "number" ? String(r.percent) : typeof r.percent === "string" ? r.percent.trim() : "";
      const v = PCT.test(t) ? new Decimal(t) : null;
      if (!v || v.lessThanOrEqualTo(0) || v.greaterThan(100)) p(i, "PERCENT", "النسبة أكبر من صفر وحتى 100 (4 منازل عشرية على الأكثر).", "The percentage is above zero and at most 100 (up to 4 decimals).");
      else {
        percent = v.toFixed(4);
        if (side === "D") dp = dp.plus(v); else if (side === "C") cp = cp.plus(v);
      }
    }
    if (side === "D") nd++; else if (side === "C") nc++;
    const partyType = s(r.partyType, 20), partyId = s(r.partyId, 64);
    if (!!partyType !== !!partyId) p(i, "PARTY", "حدّد الطرف ونوعه معًا.", "A party's type and id go together.");
    lines.push({
      accountId: accountId ?? "", side: (side ?? "D") as Side, amount, percent,
      description: s(r.description, 500), branchId: s(r.branchId, 64), costCenterId: s(r.costCenterId, 64), partyType, partyId,
    });
  });
  if (list.length >= 2 && (nd === 0 || nc === 0)) p(-1, "BOTH_SIDES", "القالب يحتاج سطرًا مدينًا وسطرًا دائنًا على الأقل.", "A template needs at least one debit and one credit line.");
  if (!problems.length) {
    if (mode === "FIXED" && !dr.equals(cr)) p(-1, "UNBALANCED", `القالب غير متوازن: المدين ${dr.toFixed(2)} والدائن ${cr.toFixed(2)}.`, `The template does not balance: debit ${dr.toFixed(2)}, credit ${cr.toFixed(2)}.`);
    if (mode === "PERCENT" && (!dp.equals(HUNDRED) || !cp.equals(HUNDRED))) {
      p(-1, "PERCENT_SUM", `مجموع النسب لكل جانب 100: المدين ${dp.toFixed(4)}٪ والدائن ${cp.toFixed(4)}٪.`, `The percentages of each side sum to 100: debit ${dp.toFixed(4)} %, credit ${cp.toFixed(4)} %.`);
    }
  }
  return { lines, problems };
}

/** The FIXED template's total (Σ debit). */
export function fixedTotal(lines: TemplateLine[]): Decimal {
  return lines.filter((l) => l.side === "D").reduce((t, l) => t.plus(l.amount ?? 0), ZERO);
}

export class TemplateApplyError extends Error {
  code: string;
  ar: string;
  constructor(code: string, en: string, ar: string) {
    super(en);
    this.name = "TemplateApplyError";
    this.code = code;
    this.ar = ar;
  }
}

/**
 * The journal lines a template makes. FIXED: its amounts (the total is ignored). PERCENT: the total (> 0, at most 2
 * decimals) split per side — half-up to the halala, the remainder on the side's last line. The lines come back in
 * the template's order. Refuses an invalid template (checkTemplateLines first) or a line that comes to zero.
 */
export function applyTemplate(mode: AmountMode, lines: TemplateLine[], total?: string | null): AppliedLine[] {
  const dims = (l: TemplateLine) => ({ description: l.description ?? null, branchId: l.branchId ?? null, costCenterId: l.costCenterId ?? null, partyType: l.partyType ?? null, partyId: l.partyId ?? null });
  if (mode === "FIXED") {
    return lines.map((l) => ({ accountId: l.accountId, debit: l.side === "D" ? roundMoney(l.amount ?? "0").toFixed(2) : "0.00", credit: l.side === "C" ? roundMoney(l.amount ?? "0").toFixed(2) : "0.00", ...dims(l) }));
  }
  let t: Decimal;
  try {
    t = toDecimal(String(total ?? "").trim());
    if (!t.equals(t.toDecimalPlaces(2)) || t.lessThanOrEqualTo(0)) throw new MoneyError("total");
    t = roundMoney(t);
  } catch {
    throw new TemplateApplyError("TOTAL_REQUIRED", "Enter the total: a number above zero with at most 2 decimals.", "أدخل الإجمالي: رقم أكبر من صفر بمنزلتين عشريتين على الأكثر.");
  }
  const out: Decimal[] = new Array(lines.length).fill(ZERO);
  for (const side of SIDES) {
    const idx = lines.map((l, i) => (l.side === side ? i : -1)).filter((i) => i >= 0);
    let used = ZERO;
    idx.forEach((i, j) => {
      const amt = j === idx.length - 1 ? t.minus(used) : roundMoney(t.times(lines[i].percent ?? "0").dividedBy(HUNDRED));
      used = used.plus(amt);
      out[i] = amt;
    });
  }
  return lines.map((l, i) => {
    if (out[i].lessThanOrEqualTo(0)) {
      throw new TemplateApplyError("LINE_ZERO", `Line ${i + 1} comes to zero at this total: raise the total or the percentage.`, `السطر ${i + 1} يساوي صفرًا بهذا الإجمالي؛ ارفع الإجمالي أو النسبة.`);
    }
    return { accountId: l.accountId, debit: l.side === "D" ? out[i].toFixed(2) : "0.00", credit: l.side === "C" ? out[i].toFixed(2) : "0.00", ...dims(l) };
  });
}
