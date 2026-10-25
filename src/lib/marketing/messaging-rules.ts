// Who may be messaged, when, and the abandoned-cart sequence. Pure: the journey worker
// (services/marketing/journeys.ts) reads the facts from the database and asks this module what to
// do; this module never reads or writes anything itself, so every branch is unit-tested.
//
// ── The order of the checks is the policy ──
//   1. the kill switch (nothing leaves);
//   2. stop conditions that END the sequence for good: the order is complete, the cart expired,
//      the customer opted out, no usable phone, the sequence used its messages;
//   3. eligibility for a MARKETING message: an explicit opt-in on the central ledger
//      (WhatsApp Business policy) — "not opted out" is not enough;
//   4. timing that DEFERS without ending: the step's wait, quiet hours, the daily cap, the
//      per-customer weekly cap.
// A message is never sent because a check could not be made: unknown is treated as "no".

export type Consent = "OPTED_IN" | "OPTED_OUT" | null;

export type CartStep = { waitMinutes: number; templateId: string | null; label?: string };

export type CartJourneyConfig = {
  steps: CartStep[];
  /** Carts under this value are not chased (SAR). null = any value. */
  minCartValue: number | null;
  /** A cart older than this is no longer chased (hours). */
  expireAfterHours: number;
};

export const DEFAULT_CART_CONFIG: CartJourneyConfig = {
  steps: [
    { waitMinutes: 60, templateId: null, label: "تذكير أول" },
    { waitMinutes: 60 * 23, templateId: null, label: "متابعة" },
  ],
  minCartValue: null,
  expireAfterHours: 72,
};

/** Hard limits the screen cannot exceed (anti-spam). */
export const CART_LIMITS = { maxSteps: 3, minFirstWaitMinutes: 15, minGapMinutes: 60 * 4, maxExpireHours: 24 * 7 };

export function validateCartConfig(c: CartJourneyConfig): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c.steps) || c.steps.length === 0) errs.push("يجب أن تحتوي الرحلة على رسالة واحدة على الأقل.");
  if (c.steps.length > CART_LIMITS.maxSteps) errs.push(`الحد الأقصى ${CART_LIMITS.maxSteps} رسائل لكل سلة.`);
  c.steps.forEach((s, i) => {
    if (!Number.isInteger(s.waitMinutes) || s.waitMinutes < 0) errs.push(`مدة انتظار الرسالة ${i + 1} غير صالحة.`);
    else if (i === 0 && s.waitMinutes < CART_LIMITS.minFirstWaitMinutes) errs.push(`لا تُرسل الرسالة الأولى قبل ${CART_LIMITS.minFirstWaitMinutes} دقيقة من ترك السلة.`);
    else if (i > 0 && s.waitMinutes < CART_LIMITS.minGapMinutes) errs.push(`الفاصل بين الرسائل لا يقل عن ${CART_LIMITS.minGapMinutes / 60} ساعات.`);
    if (!s.templateId) errs.push(`اختر قالباً معتمداً للرسالة ${i + 1}.`);
  });
  if (!(c.expireAfterHours > 0 && c.expireAfterHours <= CART_LIMITS.maxExpireHours)) errs.push("مدة صلاحية السلة غير صالحة.");
  if (c.minCartValue !== null && !(c.minCartValue >= 0)) errs.push("الحد الأدنى لقيمة السلة غير صالح.");
  return errs;
}

export type Guards = {
  killed: boolean;
  timezone: string;
  quietStart: number;
  quietEnd: number;
  sentToday: number;
  maxPerDay: number;
  marketingThisWeekForPhone: number;
  maxPerCustomerPerWeek: number;
};

export type CartFacts = {
  cartStatus: "OPEN" | "CONVERTED" | "EXPIRED";
  abandonedAt: Date;
  value: number | null;
  phone: string | null;
  /** An order by the same customer placed after the cart was abandoned (any channel). */
  orderedSince: boolean;
  consent: Consent;
  /** The ERP customer's own «لا يريد رسائل واتساب» flag, when the phone matches one. */
  erpOptOut: boolean;
  /** Steps already sent (= the enrollment's stepIndex). */
  stepIndex: number;
  /** When the previous step was sent (null before the first). */
  lastSentAt: Date | null;
  /** The template of the step exists and is APPROVED. */
  templateApproved: (templateId: string | null) => boolean;
};

export type CartAction =
  | { kind: "STOP"; reason: StopReason }
  | { kind: "WAIT"; until: Date; reason: "STEP_WAIT" | "QUIET_HOURS" | "DAILY_CAP" | "WEEKLY_CAP" | "KILL_SWITCH" }
  | { kind: "SEND"; step: number; templateId: string };

export type StopReason =
  | "ORDER_COMPLETED" | "CART_EXPIRED" | "OPTED_OUT" | "NO_CONSENT" | "NO_PHONE" | "BELOW_MIN_VALUE"
  | "SEQUENCE_DONE" | "TEMPLATE_NOT_APPROVED";

export const STOP_REASON_AR: Record<StopReason, string> = {
  ORDER_COMPLETED: "اكتمل الطلب",
  CART_EXPIRED: "انتهت صلاحية السلة",
  OPTED_OUT: "العميل ألغى الاشتراك",
  NO_CONSENT: "لا توجد موافقة تسويقية مسجلة",
  NO_PHONE: "لا يوجد رقم جوال صالح",
  BELOW_MIN_VALUE: "قيمة السلة أقل من الحد",
  SEQUENCE_DONE: "أُرسلت كل رسائل التسلسل",
  TEMPLATE_NOT_APPROVED: "القالب غير معتمد من واتساب",
};

const MIN = 60_000;

export function nextCartAction(f: CartFacts, cfg: CartJourneyConfig, g: Guards, now: Date): CartAction {
  // 2. Ending conditions first: the kill switch only pauses, these end the sequence.
  if (f.cartStatus === "CONVERTED" || f.orderedSince) return { kind: "STOP", reason: "ORDER_COMPLETED" };
  if (f.consent === "OPTED_OUT" || f.erpOptOut) return { kind: "STOP", reason: "OPTED_OUT" };
  if (!f.phone) return { kind: "STOP", reason: "NO_PHONE" };
  if (f.stepIndex >= cfg.steps.length) return { kind: "STOP", reason: "SEQUENCE_DONE" };
  if (f.cartStatus === "EXPIRED" || now.getTime() - f.abandonedAt.getTime() > cfg.expireAfterHours * 60 * MIN) return { kind: "STOP", reason: "CART_EXPIRED" };
  if (cfg.minCartValue !== null && (f.value === null || f.value < cfg.minCartValue)) return { kind: "STOP", reason: "BELOW_MIN_VALUE" };
  // 3. Marketing needs an explicit opt-in.
  if (f.consent !== "OPTED_IN") return { kind: "STOP", reason: "NO_CONSENT" };
  const step = cfg.steps[f.stepIndex];
  if (!step.templateId || !f.templateApproved(step.templateId)) return { kind: "STOP", reason: "TEMPLATE_NOT_APPROVED" };

  // 4. Timing.
  const from = f.stepIndex === 0 ? f.abandonedAt : (f.lastSentAt ?? f.abandonedAt);
  const due = new Date(from.getTime() + step.waitMinutes * MIN);
  if (now < due) return { kind: "WAIT", until: due, reason: "STEP_WAIT" };
  if (g.killed) return { kind: "WAIT", until: new Date(now.getTime() + 15 * MIN), reason: "KILL_SWITCH" };
  if (inQuietHours(now, g)) return { kind: "WAIT", until: quietEndsAt(now, g), reason: "QUIET_HOURS" };
  if (g.sentToday >= g.maxPerDay) return { kind: "WAIT", until: nextLocalMidnight(now, g.timezone), reason: "DAILY_CAP" };
  if (g.marketingThisWeekForPhone >= g.maxPerCustomerPerWeek) return { kind: "WAIT", until: new Date(now.getTime() + 24 * 60 * MIN), reason: "WEEKLY_CAP" };
  return { kind: "SEND", step: f.stepIndex, templateId: step.templateId };
}

/** The hour of `d` in the given IANA zone. */
export function localHour(d: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(d);
  return Number(h);
}

export function inQuietHours(d: Date, g: Pick<Guards, "timezone" | "quietStart" | "quietEnd">): boolean {
  if (g.quietStart === g.quietEnd) return false;
  const h = localHour(d, g.timezone);
  return g.quietStart < g.quietEnd ? h >= g.quietStart && h < g.quietEnd : h >= g.quietStart || h < g.quietEnd;
}

/** The first top of the hour at or after `d` that is outside quiet hours. */
export function quietEndsAt(d: Date, g: Pick<Guards, "timezone" | "quietStart" | "quietEnd">): Date {
  let t = new Date(Math.ceil(d.getTime() / (60 * MIN)) * 60 * MIN);
  for (let i = 0; i < 25 && inQuietHours(t, g); i++) t = new Date(t.getTime() + 60 * MIN);
  return t;
}

export function nextLocalMidnight(d: Date, timezone: string): Date {
  let t = new Date(Math.ceil(d.getTime() / (60 * MIN)) * 60 * MIN);
  for (let i = 0; i < 25 && localHour(t, timezone) !== 0; i++) t = new Date(t.getTime() + 60 * MIN);
  return t;
}

/** The start (UTC instant) of the local day containing `d`. */
export function localDayStart(d: Date, timezone: string): Date {
  // Step back from the hour containing d to the hour that is local midnight (whole-hour zones).
  let t = new Date(Math.floor(d.getTime() / (60 * MIN)) * 60 * MIN);
  for (let i = 0; i < 25 && localHour(t, timezone) !== 0; i++) t = new Date(t.getTime() - 60 * MIN);
  return t;
}

/** A one-off campaign message: same consent and caps, no sequence. */
export function campaignMessageAllowed(args: { consent: Consent; erpOptOut: boolean; phone: string | null; category: "MARKETING" | "UTILITY"; templateApproved: boolean }): { ok: true } | { ok: false; reasonAr: string } {
  if (!args.phone) return { ok: false, reasonAr: STOP_REASON_AR.NO_PHONE };
  if (args.consent === "OPTED_OUT" || args.erpOptOut) return { ok: false, reasonAr: STOP_REASON_AR.OPTED_OUT };
  if (args.category === "MARKETING" && args.consent !== "OPTED_IN") return { ok: false, reasonAr: STOP_REASON_AR.NO_CONSENT };
  if (!args.templateApproved) return { ok: false, reasonAr: STOP_REASON_AR.TEMPLATE_NOT_APPROVED };
  return { ok: true };
}

/** {{1}}, {{2}} … filled from the ordered values; missing values leave the template unsendable. */
export function renderTemplate(body: string, values: string[]): { ok: true; text: string } | { ok: false; missing: number[] } {
  const missing: number[] = [];
  const text = body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
    const v = values[Number(n) - 1];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.push(Number(n));
      return "";
    }
    return String(v);
  });
  return missing.length ? { ok: false, missing } : { ok: true, text };
}

/** Recovery rate as the owner defined it: eligible carts converted within the window ÷ eligible carts targeted × 100. */
export function cartRecoveryRate(targeted: number, recovered: number): number | null {
  if (targeted <= 0) return null;
  return Math.round((recovered / targeted) * 10000) / 100;
}

/** Cost per recovered order: messaging cost of recovery ÷ recovered orders attributed. */
export function costPerRecovery(cost: number | null, recovered: number): number | null {
  if (cost === null || recovered <= 0) return null;
  return Math.round((cost / recovered) * 100) / 100;
}
