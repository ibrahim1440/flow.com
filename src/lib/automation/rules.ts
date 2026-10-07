/**
 * The shape of an automation rule, and the one validator every write goes through.
 *
 * Pure: no database, no Next. The routes check what only the database can answer (does the
 * chosen employee exist) after this has accepted the shape.
 *
 * A rule is: an event, conditions that must all hold, and up to ten steps run in order. A
 * step is a WhatsApp message to one recipient, or a wait that delays every step after it.
 */
import { getEvent, getVariable, recipientsFor, type RecipientKind } from "./catalog";
import { isConditionOp, OPS_WITHOUT_VALUE, NUMERIC_OPS, type Condition } from "./conditions";
import { normalizePhoneForWhatsApp } from "./phone";
import { TEMPLATE_MAX_LENGTH, unknownPlaceholders } from "./template";

export const MAX_STEPS = 10;
export const MAX_CONDITIONS = 10;
/** Seven days. A longer wait is a reminder system, which this is not. */
export const MAX_WAIT_MINUTES = 7 * 24 * 60;

export type Recipient =
  | { kind: Exclude<RecipientKind, "employee" | "phone"> }
  | { kind: "employee"; employeeId: string }
  | { kind: "phone"; phone: string; name?: string };

export type WhatsAppStep = { type: "whatsapp"; to: Recipient; template: string };
export type WaitStep = { type: "wait"; minutes: number };
export type Step = WhatsAppStep | WaitStep;

export type RuleInput = {
  name: string;
  description: string | null;
  eventType: string;
  isActive: boolean;
  locale: "ar" | "en";
  conditions: Condition[];
  steps: Step[];
};

export type RuleValidation = { ok: true; value: RuleInput } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

export function validateRuleInput(body: unknown): RuleValidation {
  const errors: string[] = [];
  if (!isObj(body)) return { ok: false, errors: ["The rule must be an object."] };

  const name = str(body.name);
  if (!name) errors.push("Name is required.");
  else if (name.length > 120) errors.push("Name must be 120 characters or fewer.");

  const description = str(body.description);
  if (description.length > 500) errors.push("Description must be 500 characters or fewer.");

  const eventType = str(body.eventType);
  const event = getEvent(eventType);
  if (!event) errors.push("Choose a valid event.");

  const locale = body.locale === "en" ? "en" : body.locale === undefined || body.locale === "ar" ? "ar" : null;
  if (!locale) errors.push("Language must be ar or en.");

  if (body.isActive !== undefined && typeof body.isActive !== "boolean") errors.push("isActive must be true or false.");
  const isActive = body.isActive === true;

  // ── Conditions ──
  const conditions: Condition[] = [];
  const rawConditions = body.conditions ?? [];
  if (!Array.isArray(rawConditions)) errors.push("Conditions must be a list.");
  else if (rawConditions.length > MAX_CONDITIONS) errors.push(`At most ${MAX_CONDITIONS} conditions.`);
  else if (event) {
    rawConditions.forEach((c, i) => {
      const n = i + 1;
      if (!isObj(c)) return errors.push(`Condition ${n} is malformed.`);
      const field = str(c.field);
      const def = getVariable(event, field);
      if (!def) return errors.push(`Condition ${n}: "${field}" is not a field of this event.`);
      if (!isConditionOp(c.op)) return errors.push(`Condition ${n}: unknown comparison.`);
      if (OPS_WITHOUT_VALUE.has(c.op)) return conditions.push({ field, op: c.op });
      const value = str(c.value);
      if (value.length > 200) return errors.push(`Condition ${n}: value is too long.`);
      if (NUMERIC_OPS.has(c.op) && (value === "" || !Number.isFinite(Number(value)))) {
        return errors.push(`Condition ${n}: a number is required.`);
      }
      if (def.kind === "enum" && (c.op === "eq" || c.op === "neq") && !def.options?.some((o) => o.value === value)) {
        return errors.push(`Condition ${n}: choose one of the listed values.`);
      }
      conditions.push({ field, op: c.op, value });
    });
  }

  // ── Steps ──
  const steps: Step[] = [];
  const rawSteps = body.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) errors.push("Add at least one step.");
  else if (rawSteps.length > MAX_STEPS) errors.push(`At most ${MAX_STEPS} steps.`);
  else if (event) {
    const allowed = recipientsFor(event);
    rawSteps.forEach((s, i) => {
      const n = i + 1;
      if (!isObj(s)) return errors.push(`Step ${n} is malformed.`);

      if (s.type === "wait") {
        const minutes = Number(s.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES) {
          return errors.push(`Step ${n}: a wait is between 1 minute and 7 days.`);
        }
        return steps.push({ type: "wait", minutes });
      }

      if (s.type !== "whatsapp") return errors.push(`Step ${n}: unknown step type.`);

      const template = typeof s.template === "string" ? s.template.trim() : "";
      if (!template) return errors.push(`Step ${n}: the message is empty.`);
      if (template.length > TEMPLATE_MAX_LENGTH) {
        return errors.push(`Step ${n}: the message must be ${TEMPLATE_MAX_LENGTH} characters or fewer.`);
      }
      const unknown = unknownPlaceholders(event, template);
      if (unknown.length) {
        return errors.push(`Step ${n}: unknown variable${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `{{${k}}}`).join(", ")}.`);
      }

      const to = isObj(s.to) ? s.to : null;
      const kind = to ? str(to.kind) : "";
      if (!to || !(allowed as string[]).includes(kind)) {
        return errors.push(`Step ${n}: choose who receives the message.`);
      }
      if (kind === "employee") {
        const employeeId = str(to.employeeId);
        if (!employeeId) return errors.push(`Step ${n}: choose an employee.`);
        return steps.push({ type: "whatsapp", to: { kind: "employee", employeeId }, template });
      }
      if (kind === "phone") {
        const phone = normalizePhoneForWhatsApp(str(to.phone));
        if (!phone.ok) return errors.push(`Step ${n}: ${phone.reason}`);
        const recipientName = str(to.name).slice(0, 80);
        return steps.push({
          type: "whatsapp",
          to: { kind: "phone", phone: phone.phone, ...(recipientName ? { name: recipientName } : {}) },
          template,
        });
      }
      steps.push({ type: "whatsapp", to: { kind: kind as Exclude<RecipientKind, "employee" | "phone"> }, template });
    });

    if (steps.length === rawSteps.length) {
      if (!steps.some((s) => s.type === "whatsapp")) errors.push("Add at least one message step.");
      if (steps[steps.length - 1]?.type === "wait") errors.push("A wait must be followed by a message.");
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { name, description: description || null, eventType, isActive, locale: locale!, conditions, steps },
  };
}

/** Read a stored rule back. Stored JSON was validated on the way in; this only re-types it. */
export function parseStoredSteps(raw: unknown): Step[] {
  return Array.isArray(raw) ? (raw as Step[]) : [];
}

export function parseStoredConditions(raw: unknown): Condition[] {
  return Array.isArray(raw) ? (raw as Condition[]) : [];
}

/**
 * When each message step becomes due, relative to the event: the sum of the waits before it.
 * Index-aligned with `steps`; null for wait steps.
 */
export function stepOffsetsMinutes(steps: Step[]): (number | null)[] {
  let offset = 0;
  return steps.map((s) => {
    if (s.type === "wait") {
      offset += s.minutes;
      return null;
    }
    return offset;
  });
}
