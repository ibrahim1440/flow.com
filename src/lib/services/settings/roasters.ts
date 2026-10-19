// Settings › Production & roasting › Roasters (Figma 377:2 RM1–RM5; ROASTERS.md §4, §6, §7).
//
// Configuration only. Capacity and limits are used for planning and validation; a roasted weight
// or a loss is never derived from them (each RoastingBatch carries its own measured weights).
// Nothing in this batch schedules or records against a roaster yet — the schedule (RM6–RM8) and the
// capacity check at «تسجيل دفعة» (§5.12) are later work — so these values are stored and shown,
// and read by nothing else.
//
// Pure: validation and the shapes the API returns. The routes do the reads and writes.
import { Decimal, parseFiniteDecimal } from "../commissions/engine";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/hr/sod";
import { normaliseNumberText } from "./sections";

export const ROASTER_TYPES = ["PRODUCTION", "SAMPLE"] as const;
export type RoasterType = (typeof ROASTER_TYPES)[number];
/** The statuses the approved frames offer (RM2 / RM3 / RM4b). RETIRED is in the model, not on a screen. */
export const ROASTER_STATUSES = ["AVAILABLE", "MAINTENANCE", "STOPPED"] as const;
export type RoasterStatus = (typeof ROASTER_STATUSES)[number] | "RETIRED";
export const MAINTENANCE_KINDS = ["ROUTINE", "ONE_OFF"] as const;
export const MAINTENANCE_STATUSES = ["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

export const NAME_MAX = 80;
export const TEXT_MAX = 160;
export const REASON_MAX = 300;
export const WEIGHT_MAX = 1000;
export const CYCLE_MAX = 1440;

export type FieldError = { field: string; ar: string; en: string; summaryAr: string; summaryEn: string };

export type RoasterValues = {
  name: string;
  manufacturerModel: string | null;
  type: RoasterType;
  nominalCapacityKg: Decimal;
  defaultTargetKg: Decimal;
  minBatchKg: Decimal;
  maxBatchKg: Decimal;
  cycleMinutes: number;
  defaultOperatorId: string | null;
  status: (typeof ROASTER_STATUSES)[number];
  statusReason: string | null;
  isDefault: boolean;
};

const kg = (d: Decimal) => d.toFixed(2);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function weight(v: unknown): Decimal | null {
  if (typeof v === "number") return Number.isFinite(v) ? new Decimal(v) : null;
  if (typeof v !== "string") return null;
  const t = normaliseNumberText(v);
  return /^\d+(\.\d+)?$/.test(t) ? parseFiniteDecimal(t) : null;
}

const LABEL: Record<string, [string, string]> = {
  nominalCapacityKg: ["السعة الاسمية", "Nominal capacity"],
  defaultTargetKg: ["الهدف الافتراضي", "Default target"],
  minBatchKg: ["الحد الأدنى للدفعة", "Minimum batch"],
  maxBatchKg: ["الحد الأقصى للدفعة", "Maximum batch"],
};

/**
 * A create body, or an update body merged over the current values → the values to store, or the
 * field errors (each field at most once, in the order the form shows them). The rules are the
 * frame's (RM2) and §5.2 (1): 0 < min ≤ target ≤ max ≤ nominal; cycle a whole number of minutes > 0;
 * a reason for «في الصيانة» / «متوقفة».
 */
export function validateRoaster(input: Record<string, unknown>): { ok: true; values: RoasterValues } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const add = (e: FieldError) => { if (!errors.some((x) => x.field === e.field)) errors.push(e); };

  const name = str(input.name);
  if (!name) add({ field: "name", ar: "اسم المحمصة مطلوب.", en: "The roaster name is required.", summaryAr: "اسم المحمصة مطلوب", summaryEn: "Roaster name is required" });
  else if (name.length > NAME_MAX) add({ field: "name", ar: `الاسم أطول من ${NAME_MAX} حرفًا.`, en: `The name is longer than ${NAME_MAX} characters.`, summaryAr: "اسم المحمصة طويل", summaryEn: "Roaster name is too long" });
  const mm = str(input.manufacturerModel);
  if (mm.length > TEXT_MAX) add({ field: "manufacturerModel", ar: `النص أطول من ${TEXT_MAX} حرفًا.`, en: `Longer than ${TEXT_MAX} characters.`, summaryAr: "الشركة المصنّعة والطراز طويل", summaryEn: "Manufacturer and model is too long" });

  const type = input.type;
  if (!ROASTER_TYPES.includes(type as RoasterType)) add({ field: "type", ar: "اختر النوع.", en: "Choose the type.", summaryAr: "النوع مطلوب", summaryEn: "Type is required" });

  const w: Record<string, Decimal | null> = {};
  for (const f of ["nominalCapacityKg", "defaultTargetKg", "minBatchKg", "maxBatchKg"]) {
    const d = weight(input[f]);
    const [la, le] = LABEL[f];
    if (!d || !d.greaterThan(0) || d.greaterThan(WEIGHT_MAX) || d.decimalPlaces() > 3) {
      add({ field: f, ar: `أدخل وزنًا أكبر من صفر وحتى ${WEIGHT_MAX} كغ.`, en: `Enter a weight greater than 0 and up to ${WEIGHT_MAX} kg.`, summaryAr: `${la} غير صالح`, summaryEn: `${le} is not valid` });
      w[f] = null;
    } else w[f] = d;
  }
  const { nominalCapacityKg: nom, defaultTargetKg: tgt, minBatchKg: min, maxBatchKg: max } = w;
  if (max && nom && max.greaterThan(nom)) add({ field: "maxBatchKg", ar: `الحد الأقصى أكبر من السعة الاسمية (${kg(nom)} كغ).`, en: `The maximum is above the nominal capacity (${kg(nom)} kg).`, summaryAr: "الحد الأقصى أكبر من السعة الاسمية", summaryEn: "Maximum is above the nominal capacity" });
  if (tgt && min && tgt.lessThan(min)) add({ field: "defaultTargetKg", ar: `الهدف أقل من الحد الأدنى (${kg(min)} كغ).`, en: `The target is below the minimum (${kg(min)} kg).`, summaryAr: "الهدف الافتراضي أقل من الحد الأدنى", summaryEn: "Default target is below the minimum" });
  if (tgt && max && tgt.greaterThan(max)) add({ field: "defaultTargetKg", ar: `الهدف أكبر من الحد الأقصى (${kg(max)} كغ).`, en: `The target is above the maximum (${kg(max)} kg).`, summaryAr: "الهدف الافتراضي أكبر من الحد الأقصى", summaryEn: "Default target is above the maximum" });
  if (min && max && min.greaterThan(max)) add({ field: "minBatchKg", ar: `الحد الأدنى أكبر من الحد الأقصى (${kg(max)} كغ).`, en: `The minimum is above the maximum (${kg(max)} kg).`, summaryAr: "الحد الأدنى أكبر من الحد الأقصى", summaryEn: "Minimum is above the maximum" });

  const cycleRaw = typeof input.cycleMinutes === "string" ? normaliseNumberText(input.cycleMinutes) : input.cycleMinutes;
  const cycle = typeof cycleRaw === "number" ? cycleRaw : typeof cycleRaw === "string" && /^\d+$/.test(cycleRaw) ? Number(cycleRaw) : NaN;
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > CYCLE_MAX) add({ field: "cycleMinutes", ar: `مدة الدورة عدد دقائق صحيح من 1 إلى ${CYCLE_MAX}.`, en: `The cycle is a whole number of minutes from 1 to ${CYCLE_MAX}.`, summaryAr: "مدة الدورة غير صالحة", summaryEn: "Cycle time is not valid" });

  const op = input.defaultOperatorId;
  if (op !== undefined && op !== null && op !== "" && typeof op !== "string") add({ field: "defaultOperatorId", ar: "اختر مشغّلًا من القائمة.", en: "Choose an operator from the list.", summaryAr: "المشغّل الافتراضي غير صالح", summaryEn: "Default operator is not valid" });

  const status = input.status ?? "AVAILABLE";
  if (!ROASTER_STATUSES.includes(status as RoasterValues["status"])) add({ field: "status", ar: "اختر الحالة.", en: "Choose the status.", summaryAr: "الحالة مطلوبة", summaryEn: "Status is required" });
  const reason = str(input.statusReason);
  if ((status === "MAINTENANCE" || status === "STOPPED") && !reason) add({ field: "statusReason", ar: "السبب مطلوب.", en: "A reason is required.", summaryAr: "سبب الحالة مطلوب", summaryEn: "A status reason is required" });
  if (reason.length > REASON_MAX) add({ field: "statusReason", ar: `السبب أطول من ${REASON_MAX} حرف.`, en: `The reason is longer than ${REASON_MAX} characters.`, summaryAr: "سبب الحالة طويل", summaryEn: "Status reason is too long" });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    values: {
      name, manufacturerModel: mm || null, type: type as RoasterType,
      nominalCapacityKg: nom!, defaultTargetKg: tgt!, minBatchKg: min!, maxBatchKg: max!, cycleMinutes: cycle,
      defaultOperatorId: typeof op === "string" && op ? op : null,
      status: status as RoasterValues["status"],
      statusReason: status === "AVAILABLE" ? null : reason,
      isDefault: input.isDefault === true,
    },
  };
}

/** A status change (RM4b): the new status, its reason (required unless «متاحة») and an optional until-date. */
export function validateStatusChange(input: Record<string, unknown>, now = new Date()): { ok: true; status: RoasterValues["status"]; reason: string | null; until: Date | null } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const status = input.status;
  if (!ROASTER_STATUSES.includes(status as RoasterValues["status"])) errors.push({ field: "status", ar: "اختر الحالة الجديدة.", en: "Choose the new status.", summaryAr: "الحالة الجديدة مطلوبة", summaryEn: "New status is required" });
  const reason = str(input.reason);
  if ((status === "MAINTENANCE" || status === "STOPPED") && !reason) errors.push({ field: "reason", ar: "السبب مطلوب.", en: "A reason is required.", summaryAr: "السبب مطلوب", summaryEn: "Reason is required" });
  if (reason.length > REASON_MAX) errors.push({ field: "reason", ar: `السبب أطول من ${REASON_MAX} حرف.`, en: `The reason is longer than ${REASON_MAX} characters.`, summaryAr: "السبب طويل", summaryEn: "Reason is too long" });
  let until: Date | null = null;
  if (input.until !== undefined && input.until !== null && input.until !== "") {
    const t = typeof input.until === "string" ? new Date(input.until) : null;
    if (!t || Number.isNaN(t.getTime()) || t.getTime() <= now.getTime()) errors.push({ field: "until", ar: "اختر تاريخًا قادمًا.", en: "Choose a date in the future.", summaryAr: "تاريخ «حتى» غير صالح", summaryEn: "The until-date is not valid" });
    else until = t;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, status: status as RoasterValues["status"], reason: status === "AVAILABLE" ? null : reason, until: status === "AVAILABLE" ? null : until };
}

export type MaintenanceValues = {
  title: string; kind: "ROUTINE" | "ONE_OFF"; recurrenceWeeks: number | null;
  startsAt: Date; endsAt: Date; status: (typeof MAINTENANCE_STATUSES)[number];
  requestedById: string | null; notes: string | null;
};

/** A maintenance window (RM4 «الصيانة»): title, kind, start before end, status. */
export function validateMaintenance(input: Record<string, unknown>): { ok: true; values: MaintenanceValues } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const title = str(input.title);
  if (!title) errors.push({ field: "title", ar: "العمل مطلوب.", en: "The work is required.", summaryAr: "العمل مطلوب", summaryEn: "Work is required" });
  else if (title.length > TEXT_MAX) errors.push({ field: "title", ar: `النص أطول من ${TEXT_MAX} حرفًا.`, en: `Longer than ${TEXT_MAX} characters.`, summaryAr: "العمل طويل", summaryEn: "Work is too long" });
  const kind = input.kind;
  if (!MAINTENANCE_KINDS.includes(kind as MaintenanceValues["kind"])) errors.push({ field: "kind", ar: "اختر النوع.", en: "Choose the type.", summaryAr: "النوع مطلوب", summaryEn: "Type is required" });
  let rec: number | null = null;
  if (kind === "ROUTINE" && input.recurrenceWeeks !== undefined && input.recurrenceWeeks !== null && input.recurrenceWeeks !== "") {
    const n = Number(typeof input.recurrenceWeeks === "string" ? normaliseNumberText(input.recurrenceWeeks) : input.recurrenceWeeks);
    if (!Number.isInteger(n) || n < 1 || n > 52) errors.push({ field: "recurrenceWeeks", ar: "التكرار عدد أسابيع من 1 إلى 52.", en: "Repeat every 1 to 52 weeks.", summaryAr: "التكرار غير صالح", summaryEn: "Repeat is not valid" });
    else rec = n;
  }
  const s = typeof input.startsAt === "string" ? new Date(input.startsAt) : null;
  const e = typeof input.endsAt === "string" ? new Date(input.endsAt) : null;
  if (!s || Number.isNaN(s.getTime())) errors.push({ field: "startsAt", ar: "حدّد موعد البداية.", en: "Set the start.", summaryAr: "موعد البداية مطلوب", summaryEn: "Start is required" });
  if (!e || Number.isNaN(e.getTime())) errors.push({ field: "endsAt", ar: "حدّد موعد النهاية.", en: "Set the end.", summaryAr: "موعد النهاية مطلوب", summaryEn: "End is required" });
  else if (s && !Number.isNaN(s.getTime()) && e.getTime() <= s.getTime()) errors.push({ field: "endsAt", ar: "النهاية قبل البداية.", en: "The end is before the start.", summaryAr: "النهاية قبل البداية", summaryEn: "End is before the start" });
  const status = input.status ?? "PLANNED";
  if (!MAINTENANCE_STATUSES.includes(status as MaintenanceValues["status"])) errors.push({ field: "status", ar: "اختر الحالة.", en: "Choose the status.", summaryAr: "الحالة مطلوبة", summaryEn: "Status is required" });
  const notes = str(input.notes);
  if (notes.length > REASON_MAX) errors.push({ field: "notes", ar: `الملاحظات أطول من ${REASON_MAX} حرف.`, en: `Notes are longer than ${REASON_MAX} characters.`, summaryAr: "الملاحظات طويلة", summaryEn: "Notes are too long" });
  const req = input.requestedById;
  if (req !== undefined && req !== null && req !== "" && typeof req !== "string") errors.push({ field: "requestedById", ar: "اختر من القائمة.", en: "Choose from the list.", summaryAr: "صاحب الطلب غير صالح", summaryEn: "Requested by is not valid" });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    values: {
      title, kind: kind as MaintenanceValues["kind"], recurrenceWeeks: kind === "ROUTINE" ? rec : null,
      startsAt: s!, endsAt: e!, status: status as MaintenanceValues["status"],
      requestedById: typeof req === "string" && req ? req : null, notes: notes || null,
    },
  };
}

/** Whether a login may be assigned and scheduled as an operator: production › start_batch (§6). */
export function canOperate(e: { role: string; permissions: string; active: boolean }): boolean {
  if (!e.active) return false;
  // Exactly what the session grants: an empty stored document means the role's defaults.
  const p = effectivePermissions(e.permissions, e.role);
  return hasModuleAccess(p, "production") && hasSubPrivilege(p, "production", "start_batch");
}

/** Whether a login is listed on «المشغّلون» at all: it can open production (authorized or not). */
export function seesProduction(e: { role: string; permissions: string; active: boolean }): boolean {
  if (!e.active) return false;
  return hasModuleAccess(effectivePermissions(e.permissions, e.role), "production");
}

type RoasterRow = {
  id: string; name: string; manufacturerModel: string | null; type: string;
  nominalCapacityKg: { toString(): string }; defaultTargetKg: { toString(): string }; minBatchKg: { toString(): string }; maxBatchKg: { toString(): string };
  cycleMinutes: number; defaultOperatorId: string | null; status: string; statusReason: string | null; statusUntil: Date | null; statusSince: Date;
  isDefault: boolean; createdAt: Date; updatedAt: Date;
};

const fixed = (v: { toString(): string }) => new Decimal(v.toString()).toFixed(2);

/** A roaster as the API returns it: weights as "6.00", dates as ISO strings. */
export function roasterOut(r: RoasterRow, names: Map<string, string> = new Map()) {
  return {
    id: r.id, name: r.name, manufacturerModel: r.manufacturerModel, type: r.type,
    nominalCapacityKg: fixed(r.nominalCapacityKg), defaultTargetKg: fixed(r.defaultTargetKg),
    minBatchKg: fixed(r.minBatchKg), maxBatchKg: fixed(r.maxBatchKg), cycleMinutes: r.cycleMinutes,
    defaultOperatorId: r.defaultOperatorId, defaultOperatorName: r.defaultOperatorId ? names.get(r.defaultOperatorId) ?? null : null,
    status: r.status, statusReason: r.statusReason, statusUntil: r.statusUntil?.toISOString() ?? null, statusSince: r.statusSince.toISOString(),
    isDefault: r.isDefault, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** The audited view of a roaster: the configuration fields, weights as text. */
export function roasterAudit(r: RoasterRow | (RoasterValues & { statusUntil?: Date | null })): Record<string, unknown> {
  return {
    name: r.name, manufacturerModel: r.manufacturerModel, type: r.type,
    nominalCapacityKg: fixed(r.nominalCapacityKg), defaultTargetKg: fixed(r.defaultTargetKg),
    minBatchKg: fixed(r.minBatchKg), maxBatchKg: fixed(r.maxBatchKg), cycleMinutes: r.cycleMinutes,
    defaultOperatorId: r.defaultOperatorId, status: r.status, statusReason: r.statusReason ?? null,
    statusUntil: r.statusUntil ? new Date(r.statusUntil).toISOString() : null, isDefault: r.isDefault,
  };
}

/** A 400 body for field errors: the frame's summary («تعذّر الحفظ: 3 حقول تحتاج تصحيحًا») is built by the page. */
export function fieldErrorBody(errors: FieldError[]) {
  return { error: errors[0]?.ar ?? "تعذّر الحفظ.", errorEn: errors[0]?.en ?? "Could not save.", code: "INVALID_FIELDS", fields: errors };
}
