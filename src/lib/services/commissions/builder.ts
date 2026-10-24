// Commission plan builder — pure domain, no database and no HTTP.
//
// A COMPONENTS plan version (CommissionPlanVersion.components) is a set of switchable parts,
// each with every value editable:
//
//   A. order-sequence commission on NEW clients («عمولات العملاء الجدد») — a rate per order
//      number of the client (the last row means "and after"), on collected net sales;
//   B. target-achievement bonus («مكافأة تحقيق المستهدف الشهري») — a fixed amount, a management
//      decision or nothing, chosen by the bracket the month's achievement falls in;
//   C. marginal over-target incentive («الحوافز الإضافية بعد تجاوز المستهدف») — a rate on the
//      amount INSIDE each band of target only, never on total sales.
//
// The engine that turns this into money owed is the existing one (./accrual.ts): it computes the
// period's cumulative target amount and posts the difference to the append-only ledger. This file
// only answers "what is the period worth", exactly, so it can be asserted against the owner's
// spreadsheet without a database. Decimal throughout; amounts are rounded once, per component,
// half-up to two places, when they become money.
import { Decimal } from "@prisma/client/runtime/client";

type DecimalInput = string | number | Decimal;
const D = (v: DecimalInput) => new Decimal(v);
const ZERO = D(0);
const HUNDRED = D(100);
const money = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const BUILDER_SCHEMA = 1;

export type DurationUnit = "DAYS" | "MONTHS";
export type Duration = { value: number; unit: DurationUnit };

export type SequenceRow = { ratePercent: string };
export type BonusKind = "NONE" | "FIXED" | "DISCRETIONARY";
export type BonusBracket = {
  /** Inclusive lower bound, as a percent of target («80» = 80%). */
  fromPercent: string;
  /** Exclusive upper bound; null = "and above". */
  toPercent: string | null;
  kind: BonusKind;
  /** The fixed amount (FIXED). Ignored otherwise. */
  amount: string | null;
  /** Management may replace the fixed amount with a decided one (the owner's ≥150% row). */
  overridable: boolean;
};
export type OverTargetBand = { fromPercent: string; toPercent: string | null; ratePercent: string };
export type AchievementBase = "NEW_CLIENT_SALES" | "ALL_COLLECTED";

export type Components = {
  schema: number;
  period: "MONTHLY";
  /** What counts toward the target: the new-client sales the order rows pay on, or everything collected. */
  achievementBase: AchievementBase;
  orderSequence: {
    enabled: boolean;
    rows: SequenceRow[];
    /** Rate for existing / excluded clients and for orders after the eligibility window. */
    existingClientRatePercent: string;
    /**
     * Take the new-client window, the lapse period and the eligibility duration from «إعدادات
     * العمولات» (owner decision: the settings are the default, a plan may override). When false,
     * the three values below are the plan's own.
     */
    inheritSettings: boolean;
    /** A client is new when they bought nothing in this window before their acquisition. null = ever. */
    newClientWindow: Duration | null;
    /** Orders collected this long after acquisition still count as new-client orders. null = no limit (until the client lapses). */
    eligibilityAfterAcquisition: Duration | null;
    /** A client with no collected order for this long has lapsed: its sequence ends, a later purchase is a re-acquisition. null = never. */
    lapse: Duration | null;
  };
  targetBonus: { enabled: boolean; brackets: BonusBracket[] };
  overTarget: { enabled: boolean; bands: OverTargetBand[] };
};

export type BuilderProblem = { code: string; message: string; messageAr: string };

// ─── Templates ────────────────────────────────────────────────────────────────────

export type TemplateExplanation = { key: "general" | "orderSequence" | "targetBonus" | "overTarget"; ar: string; en: string };
export type CommissionTemplate = {
  key: string;
  code: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  components: Components;
  explanations: TemplateExplanation[];
};

/**
 * «نموذج حقبة الحالي» — the owner's current model, from the policy page «ثالثاً: هيكل العمولات
 * والحوافز» and the Sales_simulation workbook (Input / Commisions cal / Summary / Simulation),
 * value for value. The two policy gaps are filled with the defaults recorded in the report as
 * open questions: the new-client window (12 months) and the eligibility duration (no limit).
 */
const HIQBAH_CURRENT: CommissionTemplate = {
  key: "HIQBAH_CURRENT",
  code: "HIQBAH",
  nameAr: "نموذج حقبة الحالي",
  nameEn: "Hiqbah current model",
  descriptionAr: "عمولة العملاء الجدد حسب ترتيب الطلب، ومكافأة تحقيق المستهدف، وحافز حدّي فوق المستهدف — كما في سياسة العمولات المعتمدة.",
  descriptionEn: "New-client commission by order sequence, a target-achievement bonus and a marginal over-target incentive — as in the approved commission policy.",
  components: {
    schema: BUILDER_SCHEMA,
    period: "MONTHLY",
    achievementBase: "NEW_CLIENT_SALES",
    orderSequence: {
      enabled: true,
      rows: [{ ratePercent: "2.5" }, { ratePercent: "2" }, { ratePercent: "1.5" }],
      existingClientRatePercent: "0",
      inheritSettings: true,
      newClientWindow: { value: 12, unit: "MONTHS" },
      eligibilityAfterAcquisition: null,
      lapse: { value: 12, unit: "MONTHS" },
    },
    targetBonus: {
      enabled: true,
      brackets: [
        { fromPercent: "0", toPercent: "80", kind: "NONE", amount: null, overridable: false },
        { fromPercent: "80", toPercent: "100", kind: "DISCRETIONARY", amount: null, overridable: false },
        { fromPercent: "100", toPercent: "120", kind: "FIXED", amount: "500.00", overridable: false },
        { fromPercent: "120", toPercent: "150", kind: "FIXED", amount: "800.00", overridable: false },
        { fromPercent: "150", toPercent: null, kind: "FIXED", amount: "1000.00", overridable: true },
      ],
    },
    overTarget: {
      enabled: true,
      bands: [
        { fromPercent: "100", toPercent: "120", ratePercent: "0.5" },
        { fromPercent: "120", toPercent: "150", ratePercent: "1" },
        { fromPercent: "150", toPercent: null, ratePercent: "1.5" },
      ],
    },
  },
  explanations: [
    {
      key: "general",
      ar: "تعد العمولات والحوافز مزايا متغيرة وغير مضمونة، ولا تُستحق إلا بعد تحقق شروط الأهلية، والتحصيل الفعلي، واعتماد الإدارة المختصة.",
      en: "Commissions and incentives are variable and not guaranteed. They become due only after the eligibility conditions are met, after actual collection, and after approval by the competent management.",
    },
    {
      key: "orderSequence",
      ar: "العميل الجديد: لم يسبق له الشراء من الشركة خلال الفترة التي تحددها الإدارة، ولم يكن ضمن قاعدة العملاء النشطين أو الجاري التفاوض معهم قبل مباشرة موظف المبيعات. تُحسب العمولة على صافي المبيعات المحصّلة فعلياً: أول طلب محصّل 2.5%، ثاني طلب 2%، ثالث طلب وما بعده 1.5%.",
      en: "A new client has not bought from the company during the period management sets, and was not in the active client base or already in negotiation before the salesperson started. Commission is on net sales actually collected: first collected order 2.5%, second 2%, third and later 1.5%.",
    },
    {
      key: "targetBonus",
      ar: "تُصرف مكافأة تحقيق المستهدف بناءً على نسبة تحقيق المستهدف الشهري من المبيعات المحصّلة المؤهلة: أقل من 80% لا مكافأة؛ من 80% إلى 99% حسب موافقة الإدارة (مكافأة تقديرية بسيطة أو لا مكافأة)؛ 100% = 500 ريال؛ 120% = 800 ريال؛ 150% = 1,000 ريال أو حسب موافقة الإدارة.",
      en: "The target bonus follows the month's achievement of qualified collected sales: below 80% none; 80%–99% at management's discretion (a small discretionary bonus or none); 100% = SAR 500; 120% = SAR 800; 150% = SAR 1,000 or as management approves.",
    },
    {
      key: "overTarget",
      ar: "في حال تجاوز المستهدف الشهري تُحتسب عمولة إضافية على المبلغ الزائد فقط فوق المستهدف، وليس على كامل المبيعات: 0.5% على الزائد فوق 100% حتى 120%، و1% على الزائد فوق 120% حتى 150%، و1.5% على الزائد فوق 150%.",
      en: "Above the monthly target an extra commission is paid on the amount above target only, never on total sales: 0.5% on the excess from 100% to 120%, 1% from 120% to 150%, and 1.5% above 150%.",
    },
  ],
};

/** Every ready-made template. A list so more can be added later without a schema change. */
export const COMMISSION_TEMPLATES: CommissionTemplate[] = [HIQBAH_CURRENT];

export function templateByKey(key: string): CommissionTemplate | null {
  return COMMISSION_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** A deep copy, so a caller editing a template's components never edits the template. */
export function cloneComponents(c: Components): Components {
  return JSON.parse(JSON.stringify(c)) as Components;
}

// ─── Parsing and validation ──────────────────────────────────────────────────────

/** A finite decimal from a string or number, or null. Hex/binary/octal, NaN and Infinity refused. */
function fin(v: unknown): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && (/^[+-]?0[xbo]/i.test(v.trim()) || v.trim() === "")) return null;
  try {
    const d = new Decimal(String(v).trim());
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

const P = (code: string, en: string, ar: string): BuilderProblem => ({ code, message: en, messageAr: ar });

function parseDuration(v: unknown, label: string, labelAr: string, problems: BuilderProblem[]): Duration | null {
  if (v === null || v === undefined || v === "") return null;
  const o = v as Record<string, unknown>;
  const unit = o.unit === "DAYS" ? "DAYS" : o.unit === "MONTHS" ? "MONTHS" : null;
  const value = Number(o.value);
  if (!unit || !Number.isInteger(value) || value < 1 || (unit === "DAYS" ? value > 3650 : value > 120)) {
    problems.push(P("DURATION_INVALID", `${label} must be 1–3650 days or 1–120 months.`, `${labelAr}: من 1 إلى 3650 يوماً أو من 1 إلى 120 شهراً.`));
    return null;
  }
  return { value, unit };
}

/**
 * Normalise and validate request JSON into Components. Every problem is reported, not only the
 * first, so a long table of brackets is corrected in one pass. Numbers are kept as canonical
 * decimal strings (never floats) in what is stored.
 */
export function parseComponents(raw: unknown): { components: Components | null; problems: BuilderProblem[] } {
  const problems: BuilderProblem[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { components: null, problems: [P("COMPONENTS_REQUIRED", "The plan components are missing.", "مكوّنات الخطة مفقودة.")] };
  }
  const r = raw as Record<string, unknown>;
  const rate = (v: unknown, label: string, labelAr: string): string => {
    const d = fin(v);
    if (!d || d.lessThan(0) || d.greaterThan(100)) {
      problems.push(P("RATE_RANGE", `${label} must be a percentage between 0 and 100.`, `${labelAr}: نسبة بين 0 و100.`));
      return "0";
    }
    return d.toString();
  };
  const pct = (v: unknown, label: string, labelAr: string): string => {
    const d = fin(v);
    if (!d || d.lessThan(0) || d.greaterThan(10000)) {
      problems.push(P("PERCENT_RANGE", `${label} must be a percentage of target between 0 and 10000.`, `${labelAr}: نسبة من المستهدف بين 0 و10000.`));
      return "0";
    }
    return d.toString();
  };

  // A.
  const os = (r.orderSequence ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(os.rows) ? os.rows : [];
  if ((os.enabled === true && rawRows.length < 1) || rawRows.length > 20) {
    problems.push(P("SEQUENCE_ROWS", "The order-sequence table needs 1 to 20 rows.", "جدول ترتيب الطلبات يحتاج من صف واحد إلى 20 صفاً."));
  }
  const rows = rawRows.slice(0, 20).map((x, i) =>
    ({ ratePercent: rate((x as Record<string, unknown>)?.ratePercent, `Order ${i + 1} rate`, `نسبة الطلب رقم ${i + 1}`) }));
  const orderSequence: Components["orderSequence"] = {
    enabled: os.enabled === true,
    rows,
    existingClientRatePercent: rate(os.existingClientRatePercent ?? "0", "The existing-client rate", "نسبة العملاء الحاليين"),
    inheritSettings: os.inheritSettings !== false,
    newClientWindow: parseDuration(os.newClientWindow, "The new-client window", "فترة العميل الجديد", problems),
    eligibilityAfterAcquisition: parseDuration(os.eligibilityAfterAcquisition, "The eligibility duration", "مدة الأهلية بعد الاكتساب", problems),
    lapse: parseDuration(os.lapse, "The lapse period", "مدة انقطاع العميل", problems),
  };

  // B.
  const tb = (r.targetBonus ?? {}) as Record<string, unknown>;
  const rawBrackets = Array.isArray(tb.brackets) ? tb.brackets : [];
  if (rawBrackets.length > 20) problems.push(P("BRACKETS_MAX", "At most 20 bonus brackets.", "20 شريحة مكافأة كحد أقصى."));
  const brackets: BonusBracket[] = rawBrackets.slice(0, 20).map((x, i) => {
    const b = (x ?? {}) as Record<string, unknown>;
    const kind: BonusKind = b.kind === "FIXED" ? "FIXED" : b.kind === "DISCRETIONARY" ? "DISCRETIONARY" : "NONE";
    let amount: string | null = null;
    if (kind === "FIXED") {
      const a = fin(b.amount);
      if (!a || a.lessThan(0) || a.greaterThan(10_000_000) || a.decimalPlaces() > 2) {
        problems.push(P("BONUS_AMOUNT", `Bracket ${i + 1} needs a fixed amount of 0 or more (two decimals at most).`, `الشريحة ${i + 1} تحتاج مبلغاً ثابتاً صفراً أو أكثر (منزلتان عشريتان كحد أقصى).`));
      } else amount = a.toFixed(2);
    }
    return {
      fromPercent: pct(b.fromPercent, `Bracket ${i + 1} start`, `بداية الشريحة ${i + 1}`),
      toPercent: b.toPercent === null || b.toPercent === undefined || b.toPercent === "" ? null : pct(b.toPercent, `Bracket ${i + 1} end`, `نهاية الشريحة ${i + 1}`),
      kind,
      amount,
      overridable: kind === "FIXED" && b.overridable === true,
    };
  });
  checkBands(brackets, "BRACKET", "Bonus brackets", "شرائح المكافأة", problems);
  const targetBonus = { enabled: tb.enabled === true, brackets };
  if (targetBonus.enabled && brackets.length === 0) {
    problems.push(P("BRACKETS_EMPTY", "The target bonus is on but has no brackets.", "مكافأة المستهدف مفعّلة بلا شرائح."));
  }

  // C.
  const ot = (r.overTarget ?? {}) as Record<string, unknown>;
  const rawBands = Array.isArray(ot.bands) ? ot.bands : [];
  if (rawBands.length > 20) problems.push(P("BANDS_MAX", "At most 20 over-target bands.", "20 شريحة حافز كحد أقصى."));
  const bands: OverTargetBand[] = rawBands.slice(0, 20).map((x, i) => {
    const b = (x ?? {}) as Record<string, unknown>;
    return {
      fromPercent: pct(b.fromPercent, `Band ${i + 1} start`, `بداية الشريحة ${i + 1}`),
      toPercent: b.toPercent === null || b.toPercent === undefined || b.toPercent === "" ? null : pct(b.toPercent, `Band ${i + 1} end`, `نهاية الشريحة ${i + 1}`),
      ratePercent: rate(b.ratePercent, `Band ${i + 1} rate`, `نسبة الشريحة ${i + 1}`),
    };
  });
  checkBands(bands, "BAND", "Over-target bands", "شرائح الحافز", problems);
  const overTarget = { enabled: ot.enabled === true, bands };
  if (overTarget.enabled && bands.length === 0) {
    problems.push(P("BANDS_EMPTY", "The over-target incentive is on but has no bands.", "حافز تجاوز المستهدف مفعّل بلا شرائح."));
  }

  const achievementBase: AchievementBase = r.achievementBase === "ALL_COLLECTED" ? "ALL_COLLECTED" : "NEW_CLIENT_SALES";
  if (r.period !== undefined && r.period !== "MONTHLY") {
    problems.push(P("PERIOD_UNSUPPORTED", "Only a monthly period is supported.", "الفترة الشهرية فقط مدعومة."));
  }
  if (!orderSequence.enabled && !targetBonus.enabled && !overTarget.enabled) {
    problems.push(P("NOTHING_ENABLED", "Switch on at least one component.", "فعّل مكوّناً واحداً على الأقل."));
  }

  const components: Components = { schema: BUILDER_SCHEMA, period: "MONTHLY", achievementBase, orderSequence, targetBonus, overTarget };
  return { components: problems.length ? null : components, problems };
}

/** Bands sorted, non-empty, non-overlapping, nothing above an open band. Gaps pay nothing. */
function checkBands(list: { fromPercent: string; toPercent: string | null }[], code: string, label: string, labelAr: string, problems: BuilderProblem[]) {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const from = D(b.fromPercent);
    if (b.toPercent !== null && D(b.toPercent).lessThanOrEqualTo(from)) {
      problems.push(P(`${code}_EMPTY`, `${label}: row ${i + 1} ends at or before it starts.`, `${labelAr}: الصف ${i + 1} ينتهي قبل أن يبدأ أو عنده.`));
    }
    const prev = list[i - 1];
    if (!prev) continue;
    if (prev.toPercent === null) {
      problems.push(P(`${code}_AFTER_OPEN`, `${label}: nothing can follow an open-ended row.`, `${labelAr}: لا يأتي صف بعد صف مفتوح «فأكثر».`));
    } else if (from.lessThan(D(prev.toPercent))) {
      problems.push(P(`${code}_OVERLAP`, `${label}: rows ${i} and ${i + 1} overlap or are out of order.`, `${labelAr}: الصفان ${i} و${i + 1} متداخلان أو بغير ترتيب.`));
    }
  }
}

/** Components already stored are trusted to have passed parseComponents; re-parse defensively. */
export function readComponents(stored: unknown): Components {
  const { components, problems } = parseComponents(stored);
  if (!components) throw { _appCode: 500, message: `A stored plan version is not valid: ${problems[0]?.message ?? "unknown"}` };
  return components;
}

// ─── Arithmetic ──────────────────────────────────────────────────────────────────

export type ClientStatus = "NEW" | "EXISTING" | "EXCLUDED" | "EXPIRED" | "UNKNOWN";

// ─── Client relationship: acquisition, lapse, re-acquisition ──────────────────────

export type ClientRules = { window: Duration | null; eligibility: Duration | null; lapse: Duration | null };

export type ClientHistoryInput = {
  /** Recorded collections of the client ON OR AFTER the activation date, any order. */
  events: { ref: string; at: Date; orderKey: string }[];
  excluded: boolean;
  /** Created before the activation date (an existing customer of the opening setup). */
  preExisting: boolean;
  /** Opening setup: collected orders before activation; null = not set. */
  priorOrders: number | null;
  /** The client's last purchase before activation (pre-existing clients), for the lapse test. */
  lastPurchaseBefore: Date | null;
  /** Did the client buy (an order not born of this epoch's deals) within the window before `at`? */
  boughtWithinWindowBefore: (at: Date, epochOrderKeys: Set<string>) => boolean;
};

export type ClientHistory = Map<string, { status: ClientStatus; sequence: number | null; epochStart: Date | null }>;

/**
 * Per collection of one client: its status and its order number, under the owner's rules
 * (binding decisions of 24 Oct):
 *  - An «epoch» of the relationship starts at the client's first collection after activation, and
 *    again whenever a collection comes after the client has LAPSED (no collected order for the
 *    lapse period). The sequence counts orders within the epoch: 1, 2, 3+ …
 *  - A pre-existing client (created before activation) is EXISTING unless the opening setup gave its
 *    prior orders N, in which case its first epoch is NEW and continues at N+1 (an N set on a later
 *    client — the audited «تعديل ترتيب الطلب» — does the same).
 *  - Any other epoch is NEW if the client bought nothing within the new-client window before it.
 *  - Eligibility runs from the epoch start (null = until the client lapses).
 *  - The manual exclusion «مستثنى من عمولة العميل الجديد» overrides all of it.
 * An order whose payments straddle a lapse stays in the epoch of its first payment.
 */
export function classifyClientHistory(h: ClientHistoryInput, rules: ClientRules): ClientHistory {
  const out: ClientHistory = new Map();
  const events = [...h.events].sort((a, b) => a.at.getTime() - b.at.getTime() || a.ref.localeCompare(b.ref));
  const byKey = new Map<string, { epoch: number; seq: number }>();
  const epochs: { start: Date; status: "NEW" | "EXISTING"; offset: number; count: number; keys: Set<string> }[] = [];
  let prevAt: Date | null = h.preExisting ? h.lastPurchaseBefore : null;
  // Keys of each epoch, to tell the epoch's own deal orders from earlier purchases.
  const keysFrom = (i: number) => new Set(events.slice(i).map((e) => e.orderKey));

  events.forEach((e, i) => {
    const lapsed = prevAt !== null && rules.lapse !== null && e.at.getTime() >= addDuration(prevAt, rules.lapse).getTime();
    if (epochs.length === 0 || lapsed) {
      let status: "NEW" | "EXISTING";
      let offset = 0;
      // The opening setup (or, after activation, the audited order-sequence edit) decides the first epoch.
      if (epochs.length === 0 && !lapsed && (h.preExisting || h.priorOrders !== null)) {
        status = h.priorOrders === null ? "EXISTING" : "NEW";
        offset = h.priorOrders ?? 0;
      } else {
        status = h.boughtWithinWindowBefore(e.at, keysFrom(i)) ? "EXISTING" : "NEW";
      }
      epochs.push({ start: e.at, status, offset, count: 0, keys: new Set() });
    }
    prevAt = e.at;
    const ep = epochs.length - 1;
    if (!byKey.has(e.orderKey)) {
      epochs[ep].count++;
      byKey.set(e.orderKey, { epoch: ep, seq: epochs[ep].offset + epochs[ep].count });
    }
    const k = byKey.get(e.orderKey)!;
    const epoch = epochs[k.epoch];
    let status: ClientStatus = epoch.status;
    if (h.excluded) status = "EXCLUDED";
    else if (status === "NEW" && rules.eligibility && e.at.getTime() >= addDuration(epoch.start, rules.eligibility).getTime()) status = "EXPIRED";
    out.set(e.ref, { status, sequence: k.seq, epochStart: epoch.start });
  });
  return out;
}

/** The rate an order of a client pays under component A. Sequence is 1-based. */
export function sequenceRate(c: Components, status: ClientStatus, sequence: number | null): { ratePercent: Decimal; row: number | null } {
  const os = c.orderSequence;
  if (!os.enabled) return { ratePercent: ZERO, row: null };
  if (status !== "NEW" || sequence === null || sequence < 1 || os.rows.length === 0) {
    return { ratePercent: D(os.existingClientRatePercent), row: null };
  }
  const row = Math.min(sequence, os.rows.length);
  return { ratePercent: D(os.rows[row - 1].ratePercent), row };
}

/** Is `qualified` at or above `percent` of `target`? Exact — no division, so 99.99% is never 100%. */
function reaches(qualified: Decimal, target: Decimal, percent: string): boolean {
  return qualified.times(HUNDRED).greaterThanOrEqualTo(target.times(D(percent)));
}

export type BracketHit = {
  index: number;
  kind: BonusKind;
  fromPercent: string;
  toPercent: string | null;
  /** The plan's own amount: the fixed amount, or zero for NONE / DISCRETIONARY. */
  planAmount: Decimal;
  overridable: boolean;
};

/** Which bonus bracket a month reaches, or null (no target, component off, or a gap). */
export function bonusBracket(c: Components, qualified: Decimal, target: Decimal | null): BracketHit | null {
  if (!c.targetBonus.enabled || !target || target.lessThanOrEqualTo(0)) return null;
  for (let i = c.targetBonus.brackets.length - 1; i >= 0; i--) {
    const b = c.targetBonus.brackets[i];
    if (!reaches(qualified, target, b.fromPercent)) continue;
    if (b.toPercent !== null && reaches(qualified, target, b.toPercent)) return null; // in a gap above this row
    return {
      index: i, kind: b.kind, fromPercent: b.fromPercent, toPercent: b.toPercent,
      planAmount: b.kind === "FIXED" && b.amount ? D(b.amount) : ZERO,
      overridable: b.overridable,
    };
  }
  return null;
}

export type BandResult = { fromPercent: string; toPercent: string | null; ratePercent: string; excess: Decimal; amount: Decimal };

/**
 * Component C: each band pays its rate on the part of the qualified sales INSIDE the band only —
 * `MAX(0, MIN(Q, T×to) − T×from) × rate` — exactly the workbook's formula. Never on total sales.
 */
export function overTargetIncentive(c: Components, qualified: Decimal, target: Decimal | null): { bands: BandResult[]; exact: Decimal } {
  if (!c.overTarget.enabled || !target || target.lessThanOrEqualTo(0)) {
    return { bands: c.overTarget.bands.map((b) => ({ ...b, excess: ZERO, amount: ZERO })), exact: ZERO };
  }
  let exact = ZERO;
  const bands = c.overTarget.bands.map((b) => {
    const lo = target.times(D(b.fromPercent)).dividedBy(HUNDRED);
    const hi = b.toPercent === null ? qualified : Decimal.min(qualified, target.times(D(b.toPercent)).dividedBy(HUNDRED));
    const excess = Decimal.max(ZERO, hi.minus(lo));
    const amount = excess.times(D(b.ratePercent)).dividedBy(HUNDRED);
    exact = exact.plus(amount);
    return { ...b, excess, amount };
  });
  return { bands, exact };
}

export type PeriodLine = {
  /** Collection event (or a simulated line). */
  ref: string;
  customerId: string | null;
  /** This employee's share of the collection's qualifying base. */
  base: Decimal;
  status: ClientStatus;
  /** The order's number for that client (1 = first collected order), null when unknown. */
  sequence: number | null;
};

export type Decision = { bracketIndex: number; kind: "DISCRETIONARY" | "OVERRIDE"; amount: Decimal } | null;

export type PeriodComputation = {
  lines: (PeriodLine & { ratePercent: Decimal; row: number | null; amount: Decimal; newClient: boolean })[];
  /** Per order-sequence row: the base collected on it and its commission (unrounded). */
  rows: { row: number; ratePercent: string; base: Decimal; amount: Decimal }[];
  existing: { ratePercent: string; base: Decimal; amount: Decimal };
  collectedBase: Decimal;
  qualifiedBase: Decimal;
  target: Decimal | null;
  achievementPercent: Decimal | null;
  diffAmount: Decimal | null;
  diffPercent: Decimal | null;
  bracket: BracketHit | null;
  /** NONE: no decision needed; PENDING: a DISCRETIONARY bracket awaits one; DECIDED: one applies. */
  decisionStatus: "NONE" | "PENDING" | "DECIDED";
  bands: BandResult[];
  exact: { clientCommission: Decimal; targetBonus: Decimal; overTarget: Decimal; total: Decimal };
  clientCommission: Decimal;
  targetBonus: Decimal;
  overTargetIncentive: Decimal;
  totalVariable: Decimal;
};

/** The whole month for one employee under one COMPONENTS version. */
export function computePeriod(input: { components: Components; target: Decimal | null; lines: PeriodLine[]; decision?: Decision }): PeriodComputation {
  const c = input.components;
  const target = input.target && input.target.greaterThan(0) ? input.target : null;

  const rows = c.orderSequence.rows.map((r, i) => ({ row: i + 1, ratePercent: r.ratePercent, base: ZERO, amount: ZERO }));
  const existing = { ratePercent: c.orderSequence.existingClientRatePercent, base: ZERO, amount: ZERO };
  let collected = ZERO;
  let newClientSales = ZERO;
  let aExact = ZERO;

  const lines = input.lines.map((l) => {
    const { ratePercent, row } = sequenceRate(c, l.status, l.sequence);
    const amount = l.base.times(ratePercent).dividedBy(HUNDRED);
    collected = collected.plus(l.base);
    if (row !== null) {
      rows[row - 1].base = rows[row - 1].base.plus(l.base);
      rows[row - 1].amount = rows[row - 1].amount.plus(amount);
      newClientSales = newClientSales.plus(l.base);
    } else {
      existing.base = existing.base.plus(l.base);
      existing.amount = existing.amount.plus(amount);
    }
    aExact = aExact.plus(amount);
    return { ...l, ratePercent, row, amount, newClient: row !== null };
  });

  // With component A off, "new-client sales" cannot be told apart, so everything collected counts.
  const qualified = c.achievementBase === "ALL_COLLECTED" || !c.orderSequence.enabled ? collected : newClientSales;

  const achievementPercent = target ? qualified.dividedBy(target).times(HUNDRED) : null;
  const diffAmount = target ? qualified.minus(target) : null;
  const diffPercent = target ? qualified.dividedBy(target).minus(1).times(HUNDRED) : null;

  const bracket = bonusBracket(c, qualified, target);
  let bExact = ZERO;
  let decisionStatus: PeriodComputation["decisionStatus"] = "NONE";
  const d = input.decision ?? null;
  if (bracket) {
    const applies = d && d.bracketIndex === bracket.index
      && ((bracket.kind === "DISCRETIONARY" && d.kind === "DISCRETIONARY") || (bracket.overridable && d.kind === "OVERRIDE"));
    if (bracket.kind === "DISCRETIONARY") {
      if (applies) { bExact = d!.amount; decisionStatus = "DECIDED"; } else decisionStatus = "PENDING";
    } else if (bracket.kind === "FIXED") {
      if (applies) { bExact = d!.amount; decisionStatus = "DECIDED"; } else bExact = bracket.planAmount;
    }
  }

  const { bands, exact: cExact } = overTargetIncentive(c, qualified, target);

  const clientCommission = money(aExact);
  const targetBonus = money(bExact);
  const overTargetIncentiveAmt = money(cExact);
  return {
    lines, rows, existing,
    collectedBase: collected, qualifiedBase: qualified, target,
    achievementPercent, diffAmount, diffPercent,
    bracket, decisionStatus, bands,
    exact: { clientCommission: aExact, targetBonus: bExact, overTarget: cExact, total: aExact.plus(bExact).plus(cExact) },
    clientCommission,
    targetBonus,
    overTargetIncentive: overTargetIncentiveAmt,
    totalVariable: clientCommission.plus(targetBonus).plus(overTargetIncentiveAmt),
  };
}

/** The next bracket / band threshold above the current achievement, for "how far to the next step". */
export function nextThreshold(c: Components, qualified: Decimal, target: Decimal | null): { percent: string; amountToGo: Decimal } | null {
  if (!target || target.lessThanOrEqualTo(0)) return null;
  const points = new Set<string>();
  if (c.targetBonus.enabled) for (const b of c.targetBonus.brackets) points.add(D(b.fromPercent).toString());
  if (c.overTarget.enabled) for (const b of c.overTarget.bands) points.add(D(b.fromPercent).toString());
  const sorted = [...points].map((p) => D(p)).filter((p) => p.greaterThan(0)).sort((a, b) => a.comparedTo(b));
  for (const p of sorted) {
    if (!reaches(qualified, target, p.toString())) {
      return { percent: p.toString(), amountToGo: money(target.times(p).dividedBy(HUNDRED).minus(qualified)) };
    }
  }
  return null;
}

// ─── Simulation («محاكاة») ───────────────────────────────────────────────────────

export type OrderMix =
  /** Fixed collected amounts per order row, the same in every scenario — the workbook's Input sheet. */
  | { mode: "AMOUNTS"; amounts: string[] }
  /** The scenario's sales split across the order rows by these percentages (they need not total 100). */
  | { mode: "PERCENT"; percents: string[] };

export type Scenario = { label: string; percentOfTarget?: string; amount?: string };

export type SimulationInput = {
  components: Components;
  target: string;
  mix: OrderMix;
  scenarios: Scenario[];
  /** Fixed pay, shown only to people who may see pay; null when hidden. */
  fixedPay?: string | null;
  /** The amount management would grant in a DISCRETIONARY bracket (the workbook's 80–99% input). */
  discretionaryAmount?: string | null;
  /** A management override of an overridable bracket; blank = the plan's amount. */
  overrideAmount?: string | null;
};

export type SimulationRow = {
  label: string;
  sales: Decimal;
  achievementPercent: Decimal;
  clientCommission: Decimal;
  targetBonus: Decimal;
  overTargetIncentive: Decimal;
  totalVariable: Decimal;
  totalMonthly: Decimal | null;
};

/**
 * Scenario table like the workbook's «Simulation» sheet. Unrounded on purpose: the sheet does not
 * round, and the acceptance check compares figure for figure. The screen rounds for display.
 *
 * Mix AMOUNTS reproduces the sheet exactly: its client-commission column is the Input sheet's
 * fixed order amounts × rates in every scenario, whatever the scenario's sales. Mix PERCENT is
 * the more useful reading — the scenario's sales split across the order rows.
 */
export function simulate(input: SimulationInput): { base: SimulationRow; rows: SimulationRow[] } {
  const c = input.components;
  const target = D(input.target);
  const disc = fin(input.discretionaryAmount) ?? ZERO;
  const override = fin(input.overrideAmount);
  const fixed = fin(input.fixedPay);
  const rowsN = c.orderSequence.rows.length;

  const aOn = (sales: Decimal | null): { a: Decimal; mixTotal: Decimal } => {
    if (!c.orderSequence.enabled) return { a: ZERO, mixTotal: sales ?? ZERO };
    if (input.mix.mode === "AMOUNTS") {
      let a = ZERO; let t = ZERO;
      input.mix.amounts.slice(0, rowsN).forEach((v, i) => {
        const amt = fin(v) ?? ZERO;
        a = a.plus(amt.times(D(c.orderSequence.rows[i].ratePercent)).dividedBy(HUNDRED));
        t = t.plus(amt);
      });
      return { a, mixTotal: t };
    }
    const percents = input.mix.percents.slice(0, rowsN).map((v) => fin(v) ?? ZERO);
    let a = ZERO;
    percents.forEach((p, i) => {
      a = a.plus((sales ?? ZERO).times(p).dividedBy(HUNDRED).times(D(c.orderSequence.rows[i].ratePercent)).dividedBy(HUNDRED));
    });
    return { a, mixTotal: sales ?? ZERO };
  };

  const bOn = (q: Decimal): Decimal => {
    const hit = bonusBracket(c, q, target);
    if (!hit) return ZERO;
    if (hit.kind === "DISCRETIONARY") return disc;
    if (hit.kind === "FIXED") return hit.overridable && override && override.greaterThan(0) ? override : hit.planAmount;
    return ZERO;
  };

  const row = (label: string, sales: Decimal, a: Decimal): SimulationRow => {
    const b = bOn(sales);
    const cc = overTargetIncentive(c, sales, target).exact;
    const total = a.plus(b).plus(cc);
    return {
      label, sales,
      achievementPercent: target.isZero() ? ZERO : sales.dividedBy(target).times(HUNDRED),
      clientCommission: a, targetBonus: b, overTargetIncentive: cc,
      totalVariable: total,
      totalMonthly: fixed ? fixed.plus(total) : null,
    };
  };

  // The base row: the Input sheet itself — qualified sales = the mix amounts.
  const baseMix = aOn(null);
  const base = row("input", baseMix.mixTotal, baseMix.a);

  const rows = input.scenarios.slice(0, 30).map((s) => {
    const sales = s.amount !== undefined && s.amount !== null && s.amount !== ""
      ? (fin(s.amount) ?? ZERO)
      : target.times(fin(s.percentOfTarget) ?? ZERO).dividedBy(HUNDRED);
    const a = input.mix.mode === "AMOUNTS" ? baseMix.a : aOn(sales).a;
    return row(s.label, sales, a);
  });
  return { base, rows };
}

/** The workbook's default scenario list: 50/70/80/90/100/120/150/180/200 % of target. */
export const DEFAULT_SCENARIO_PERCENTS = ["50", "70", "80", "90", "100", "120", "150", "180", "200"];

// ─── Durations ───────────────────────────────────────────────────────────────────

/** `at` moved by a duration, months by calendar (UTC; the engine's instants are UTC). */
export function addDuration(at: Date, d: Duration, sign: 1 | -1 = 1): Date {
  const x = new Date(at.getTime());
  if (d.unit === "DAYS") x.setUTCDate(x.getUTCDate() + sign * d.value);
  else x.setUTCMonth(x.getUTCMonth() + sign * d.value);
  return x;
}
