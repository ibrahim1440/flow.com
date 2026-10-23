// QC station W3 — the pure rules of a roast-profile QC specification and of one inspection (owner
// decisions of 23 Oct 2026). Client-safe: no database, no server import. The station screen, the
// ERP screens and the server share this one definition, and the unit tests assert it directly.
//
//   · The reference is a roast-profile VERSION that was APPROVED: whole-bean and ground colour, each
//     target ± tolerance, measured with a named device on a named scale (DiFluid, Agtron scale).
//     Without one the batch is «المواصفة قيد المعايرة»: no numeric conformity is shown, acceptance is
//     manual and documented. A batch is never its own reference.
//   · Every inspection freezes the spec it was judged against (SpecSnapshot) — a later version never
//     changes a past result.
//   · Colour is «أفتح من الهدف / مطابق / أغمق من الهدف» per reading. On the Agtron scale a HIGHER
//     number is a LIGHTER roast. Under- or over-development is NEVER inferred from colour.
//   · Roast loss is reference information only: it never holds a batch.
//   · Outside the approved spec, any visible defect, or sensory non-conforming / needs review →
//     HOLD («محجوزة»). Never an automatic rejection. Foreign objects / contamination → a hold that no
//     commercial exception can release.

export const QC_HOLD_STATUS = "QC Hold";

export type Verdict = "LIGHTER" | "ON_TARGET" | "DARKER";
export type SensoryResult = "CONFORMING" | "NON_CONFORMING" | "NEEDS_REVIEW";
export const SENSORY_RESULTS: SensoryResult[] = ["CONFORMING", "NON_CONFORMING", "NEEDS_REVIEW"];
export type DefectKey = "uneven" | "scorched" | "pale" | "foreign";
export const DEFECT_KEYS: DefectKey[] = ["uneven", "scorched", "pale", "foreign"];
export type HoldReason =
  | "WHOLE_OUT" | "GROUND_OUT" | "DEFECT_UNEVEN" | "DEFECT_SCORCHED" | "DEFECT_PALE" | "FOREIGN_OBJECT"
  | "SENSORY_NON_CONFORMING" | "SENSORY_REVIEW" | "MANUAL_HOLD";
export type SensoryWhy = "APPROVAL" | "FIRST_OF_DAY" | "DEVIATION";

/** The device and scale a reading is taken on, unless the version names others (owner: DiFluid, Agtron). */
export const DEFAULT_DEVICE = "DiFluid";
export const DEFAULT_SCALE = "Agtron";
/** A colour reading on the Agtron scale is a positive number; anything above 200 is a typing error. */
export const COLOR_MIN = 0;
export const COLOR_MAX = 200;

export type SpecSnapshot =
  | {
      state: "APPROVED";
      profileId: string; profileName: string; versionId: string; version: number;
      whole: { target: number; tol: number }; ground: { target: number; tol: number };
      device: string; scale: string; sensoryRequirements: string | null; approvedAt: string; approvedByName: string | null;
    }
  | { state: "CALIBRATING"; profileId: string | null; profileName: string | null; versionId: null; version: null; draftVersion: number | null };

/** The spec a version freezes (APPROVED or RETIRED rows carry a complete spec — DB CHECK). */
export function snapshotOf(
  v: { id: string; version: number; status: string; wholeTarget: number | null; wholeTol: number | null; groundTarget: number | null; groundTol: number | null; device: string | null; scale: string | null; sensoryRequirements: string | null; approvedAt: Date | string | null; approvedByName: string | null; profile: { id: string; name: string } } | null,
  calibrating?: { profileId: string | null; profileName: string | null; draftVersion: number | null },
): SpecSnapshot {
  if (v && v.status !== "DRAFT" && v.wholeTarget !== null && v.wholeTol !== null && v.groundTarget !== null && v.groundTol !== null && v.device && v.scale) {
    return {
      state: "APPROVED", profileId: v.profile.id, profileName: v.profile.name, versionId: v.id, version: v.version,
      whole: { target: v.wholeTarget, tol: v.wholeTol }, ground: { target: v.groundTarget, tol: v.groundTol },
      device: v.device, scale: v.scale, sensoryRequirements: v.sensoryRequirements,
      approvedAt: v.approvedAt ? new Date(v.approvedAt).toISOString() : "", approvedByName: v.approvedByName,
    };
  }
  return { state: "CALIBRATING", profileId: calibrating?.profileId ?? null, profileName: calibrating?.profileName ?? null, versionId: null, version: null, draftVersion: calibrating?.draftVersion ?? null };
}

/** Agtron: higher = lighter. Within target ± tol (inclusive, to 0.05 against rounding) = on target. */
export function colorVerdict(reading: number, target: number, tol: number): Verdict {
  const eps = 0.05;
  if (reading > target + tol + eps) return "LIGHTER";
  if (reading < target - tol - eps) return "DARKER";
  return "ON_TARGET";
}

/** A reading from a form: a number in (0, 200], one decimal at most kept; null when absent. */
export function parseReading(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).trim()) : NaN;
  if (!Number.isFinite(n) || n <= COLOR_MIN || n > COLOR_MAX) return { ok: false };
  return { ok: true, value: Math.round(n * 10) / 10 };
}

/** An optional number in [min, max]; null when absent. */
export function parseOptional(raw: unknown, min: number, max: number): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export type Defects = Record<DefectKey, boolean>;
export const NO_DEFECTS: Defects = { uneven: false, scorched: false, pale: false, foreign: false };
export const anyDefect = (d: Defects) => DEFECT_KEYS.some((k) => d[k]);

/** Loss in % of the green weight (reference only); null when the weights do not allow it. */
export function lossPercent(greenKg: number, roastedKg: number): number | null {
  if (!(greenKg > 0) || !(roastedKg > 0) || roastedKg > greenKg) return null;
  return Math.round(((greenKg - roastedKg) / greenKg) * 1000) / 10;
}

/** The Riyadh calendar day of a moment (YYYY-MM-DD): «the first batch of the profile per day». */
export function riyadhDay(d: Date | string | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

/**
 * Is a sensory evaluation required, and why (owner decision: profile approval; the first batch of
 * the profile each day; a deviating batch). `firstOfDay`: no inspection of this profile has
 * recorded a sensory result yet today (Riyadh) — the server reads it. Deviating: a colour off target
 * against an APPROVED spec, or any visible defect.
 */
export function sensoryRequirement(a: { approval?: boolean; firstOfDay: boolean; verdicts: (Verdict | null)[]; defects: Defects }): SensoryWhy | null {
  if (a.approval) return "APPROVAL";
  if (a.verdicts.some((v) => v && v !== "ON_TARGET") || anyDefect(a.defects)) return "DEVIATION";
  if (a.firstOfDay) return "FIRST_OF_DAY";
  return null;
}

export type InspectionInput = {
  whole: number | null; ground: number | null;
  defects: Defects;
  sensory: SensoryResult | null;
  /** Under calibration only: the documented manual decision. */
  manual: "ACCEPT" | "HOLD" | null; manualNote: string | null;
};

export type InspectionVerdict =
  | { ok: false; code: "READINGS_REQUIRED" | "SENSORY_REQUIRED" | "MANUAL_DECISION_REQUIRED" | "MANUAL_NOTE_REQUIRED"; why?: SensoryWhy }
  | { ok: true; wholeVerdict: Verdict | null; groundVerdict: Verdict | null; sensoryWhy: SensoryWhy | null; hold: boolean; holdReasons: HoldReason[]; foreign: boolean; conforming: boolean };

/**
 * The outcome of one inspection against its frozen spec. Pure; the server applies it.
 * Both readings are required (whole AND ground, owner decision). HOLD when anything is outside the
 * approved spec, any defect is ticked, the sensory result is not «مطابق», or (under calibration)
 * the inspector holds it by hand. Otherwise the batch is conforming (released, subject to the QC
 * minimum of evaluators).
 */
export function judgeInspection(spec: SpecSnapshot, input: InspectionInput, ctx: { firstOfDay: boolean }): InspectionVerdict {
  if (input.whole === null || input.ground === null) return { ok: false, code: "READINGS_REQUIRED" };
  const approved = spec.state === "APPROVED";
  const wholeVerdict = approved ? colorVerdict(input.whole, spec.whole.target, spec.whole.tol) : null;
  const groundVerdict = approved ? colorVerdict(input.ground, spec.ground.target, spec.ground.tol) : null;
  const why = sensoryRequirement({ firstOfDay: ctx.firstOfDay, verdicts: [wholeVerdict, groundVerdict], defects: input.defects });
  if (why && !input.sensory) return { ok: false, code: "SENSORY_REQUIRED", why };
  const reasons: HoldReason[] = [];
  if (wholeVerdict && wholeVerdict !== "ON_TARGET") reasons.push("WHOLE_OUT");
  if (groundVerdict && groundVerdict !== "ON_TARGET") reasons.push("GROUND_OUT");
  if (input.defects.uneven) reasons.push("DEFECT_UNEVEN");
  if (input.defects.scorched) reasons.push("DEFECT_SCORCHED");
  if (input.defects.pale) reasons.push("DEFECT_PALE");
  if (input.defects.foreign) reasons.push("FOREIGN_OBJECT");
  if (input.sensory === "NON_CONFORMING") reasons.push("SENSORY_NON_CONFORMING");
  if (input.sensory === "NEEDS_REVIEW") reasons.push("SENSORY_REVIEW");
  if (!approved && reasons.length === 0) {
    // «المواصفة قيد المعايرة»: no numbers decide; the inspector decides and documents it.
    if (input.manual !== "ACCEPT" && input.manual !== "HOLD") return { ok: false, code: "MANUAL_DECISION_REQUIRED" };
    if (!input.manualNote || input.manualNote.trim().length < 3) return { ok: false, code: "MANUAL_NOTE_REQUIRED" };
    if (input.manual === "HOLD") reasons.push("MANUAL_HOLD");
  }
  const hold = reasons.length > 0;
  return { ok: true, wholeVerdict, groundVerdict, sensoryWhy: why, hold, holdReasons: reasons, foreign: input.defects.foreign, conforming: !hold };
}

/** CONVERT: does a held batch's last inspection meet ANOTHER product's approved spec? (no defect, sensory not failed) */
export function meetsSpec(spec: SpecSnapshot, r: { whole: number | null; ground: number | null; defects: Defects; sensory: SensoryResult | null }): { ok: boolean; wholeVerdict: Verdict | null; groundVerdict: Verdict | null; why: string[] } {
  if (spec.state !== "APPROVED") return { ok: false, wholeVerdict: null, groundVerdict: null, why: ["TARGET_NOT_APPROVED"] };
  if (r.whole === null || r.ground === null) return { ok: false, wholeVerdict: null, groundVerdict: null, why: ["READINGS_REQUIRED"] };
  const w = colorVerdict(r.whole, spec.whole.target, spec.whole.tol);
  const g = colorVerdict(r.ground, spec.ground.target, spec.ground.tol);
  const why: string[] = [];
  if (w !== "ON_TARGET") why.push("WHOLE_OUT");
  if (g !== "ON_TARGET") why.push("GROUND_OUT");
  if (anyDefect(r.defects)) why.push("DEFECT");
  if (r.sensory === "NON_CONFORMING" || r.sensory === "NEEDS_REVIEW") why.push("SENSORY");
  return { ok: why.length === 0, wholeVerdict: w, groundVerdict: g, why };
}

/**
 * Separation of duties (owner decision 4; UR-S19): who may NOT decide an exception or a disposition —
 * its requester, and the inspector of the inspection it is about. Pure; the services, the screens and
 * the tables' CHECKs apply the same rule.
 */
export function sodBlock(actorId: string, e: { requestedById: string; inspectorId: string | null }): "requester" | "inspector" | null {
  if (actorId === e.requestedById) return "requester";
  if (e.inspectorId && actorId === e.inspectorId) return "inspector";
  return null;
}

// ── Words (Arabic first; the station and the ERP show these) ──────────────────────────────────
type Bi = { ar: string; en: string };
export const VERDICT_WORD: Record<Verdict, Bi> = {
  LIGHTER: { ar: "أفتح من الهدف", en: "Lighter than target" },
  ON_TARGET: { ar: "مطابق", en: "On target" },
  DARKER: { ar: "أغمق من الهدف", en: "Darker than target" },
};
export const SENSORY_WORD: Record<SensoryResult, Bi> = {
  CONFORMING: { ar: "مطابق", en: "Conforming" },
  NON_CONFORMING: { ar: "غير مطابق", en: "Non-conforming" },
  NEEDS_REVIEW: { ar: "يحتاج مراجعة", en: "Needs review" },
};
export const DEFECT_WORD: Record<DefectKey, Bi> = {
  uneven: { ar: "عدم التجانس", en: "Non-uniform" },
  scorched: { ar: "احتراق", en: "Scorching" },
  pale: { ar: "حبوب شاحبة", en: "Pale beans" },
  foreign: { ar: "أجسام غريبة", en: "Foreign objects" },
};
export const HOLD_REASON_WORD: Record<HoldReason, Bi> = {
  WHOLE_OUT: { ar: "لون الحبوب خارج المواصفة", en: "Whole-bean colour outside spec" },
  GROUND_OUT: { ar: "لون المطحون خارج المواصفة", en: "Ground colour outside spec" },
  DEFECT_UNEVEN: { ar: "عدم تجانس", en: "Non-uniform" },
  DEFECT_SCORCHED: { ar: "احتراق", en: "Scorching" },
  DEFECT_PALE: { ar: "حبوب شاحبة", en: "Pale beans" },
  FOREIGN_OBJECT: { ar: "أجسام غريبة / تلوث", en: "Foreign objects / contamination" },
  SENSORY_NON_CONFORMING: { ar: "التقييم الحسي غير مطابق", en: "Sensory non-conforming" },
  SENSORY_REVIEW: { ar: "التقييم الحسي يحتاج مراجعة", en: "Sensory needs review" },
  MANUAL_HOLD: { ar: "حجز يدوي (المواصفة قيد المعايرة)", en: "Held by hand (spec under calibration)" },
};
export const SENSORY_WHY_WORD: Record<SensoryWhy, Bi> = {
  APPROVAL: { ar: "اعتماد إصدار الملف", en: "profile version approval" },
  FIRST_OF_DAY: { ar: "أول دفعة من هذا الملف اليوم", en: "first batch of this profile today" },
  DEVIATION: { ar: "الدفعة منحرفة", en: "the batch deviates" },
};
export const EXCEPTION_REASONS = ["TASTE_ACCEPTED", "BLEND_SUITABLE", "CUSTOMER_APPROVAL", "OTHER"] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];
export const EXCEPTION_REASON_WORD: Record<ExceptionReason, Bi> = {
  TASTE_ACCEPTED: { ar: "مقبول بالتذوق", en: "Accepted on taste" },
  BLEND_SUITABLE: { ar: "مناسب للخلط", en: "Suitable for blending" },
  CUSTOMER_APPROVAL: { ar: "موافقة العميل", en: "Customer approval" },
  OTHER: { ar: "أخرى", en: "Other" },
};
export const PERMITTED_USES = ["GENERAL", "CUSTOMER", "INTERNAL"] as const;
export type PermittedUse = (typeof PERMITTED_USES)[number];
export const PERMITTED_USE_WORD: Record<PermittedUse, Bi> = {
  GENERAL: { ar: "بيع وتعبئة عادية", en: "Normal sale and packing" },
  CUSTOMER: { ar: "لعميل محدد بموافقته", en: "A named customer, with their approval" },
  INTERNAL: { ar: "استخدام داخلي وعينات", en: "Internal use and samples" },
};
export const DISPOSITION_KINDS = ["CONVERT", "BLEND", "DESTROY"] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];
export const DISPOSITION_WORD: Record<DispositionKind, Bi> = {
  CONVERT: { ar: "تحويل إلى منتج آخر", en: "Convert to another product" },
  BLEND: { ar: "خلط بوصفة معتمدة", en: "Blend by an approved recipe" },
  DESTROY: { ar: "إتلاف", en: "Destroy" },
};

/**
 * The standard sample preparation, grinding and measurement timing shown at the station (owner:
 * «Standardise sample preparation, grinding, and measurement timing»; device guide
 * https://digitizefluid.com/pages/documents). The device guide could not be fetched when this was
 * written (the network refused the host), so these steps are the generic, device-independent
 * practice and name no device specification; the device's own guide stays the reference for its
 * setup, calibration and sample amount.
 */
export const MEASURE_CHECKLIST: Bi[] = [
  { ar: "انتظر حتى تبرد العينة تمامًا إلى حرارة الغرفة، وقِس في التوقيت نفسه بعد التحميص لكل دفعة.", en: "Let the sample cool fully to room temperature, and measure at the same time after roasting for every batch." },
  { ar: "خذ العينة من الدفعة بعد التقليب (من أكثر من موضع)، لا من السطح وحده.", en: "Take the sample from the mixed batch (from more than one spot), not from the surface only." },
  { ar: "نظّف وعاء القياس وجفّفه، وتحقق من معايرة الجهاز حسب دليله قبل أول قراءة في اليوم.", en: "Clean and dry the measuring cup, and check the device's calibration per its guide before the first reading of the day." },
  { ar: "حبوب كاملة: املأ الوعاء بالكمية التي يحددها دليل الجهاز، وسوِّ السطح، ثم سجّل القراءة.", en: "Whole bean: fill the cup with the amount the device guide states, level the surface, then record the reading." },
  { ar: "مطحون: اطحن بإعداد الطاحونة الثابت نفسه في كل مرة، واضغط السطح بالطريقة نفسها، وقِس فورًا بعد الطحن.", en: "Ground: grind at the same fixed grinder setting every time, tamp the surface the same way, and measure right after grinding." },
  { ar: "سجّل الجهاز والمقياس مع كل قراءة. إن اختلفت قراءتان متتاليتان كثيرًا فأعد القياس.", en: "Record the device and the scale with every reading. If two consecutive readings differ a lot, measure again." },
];
