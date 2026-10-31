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
import { parseEmailAddress } from "./email-mode";

export const MAX_STEPS = 10;
export const MAX_CONDITIONS = 10;
/** Seven days. A longer wait is a reminder system, which this is not. */
export const MAX_WAIT_MINUTES = 7 * 24 * 60;

export type Recipient =
  | { kind: Exclude<RecipientKind, "employee" | "phone"> }
  | { kind: "employee"; employeeId: string }
  | { kind: "phone"; phone: string; name?: string };

/**
 * `templateEn` (owner language decision 3): the English text of a step addressed to staff (anyone but
 * the customer or a typed number), sent to employees who receive English (employee-lang.ts). Absent on
 * customer and phone steps — their text is the rule's own, in the rule's language, as always.
 */
export type WhatsAppStep = { type: "whatsapp"; to: Recipient; template: string; templateEn?: string };

/** A step whose recipients are employees: the step may carry an English text (employee-lang.ts). */
export const isStaffRecipient = (kind: string): boolean => kind !== "customer" && kind !== "phone";
export type WaitStep = { type: "wait"; minutes: number };

/**
 * Batch 25: an e-mail step. Phase 1 reaches the event's CUSTOMER or one fixed address — employees have no work e-mail
 * on record yet. `attach: "quote_pdf"` (only on the quotation event, only to the customer) attaches the event's OWN
 * quotation, re-checked at send time. Tax-invoice events cannot e-mail (locked until ZATCA clears / reports invoices).
 */
export type EmailRecipient = { kind: "customer" } | { kind: "email"; email: string; name?: string };
export type EmailStep = { type: "email"; to: EmailRecipient; subject: string; template: string; attach?: "quote_pdf" };
export type Step = WhatsAppStep | WaitStep | EmailStep;

/** Events whose e-mail is locked in phase 1: the tax invoice (ZATCA is not live). */
export const EMAIL_LOCKED_EVENTS: readonly string[] = ["sales.invoice_status_changed"];
/** The only event a document may be attached on, and the document. */
export const QUOTE_ATTACH_EVENT = "sales.quote_status_changed";
export const SUBJECT_MAX_LENGTH = 150;
export const isMessageStep = (s: Step): s is WhatsAppStep | EmailStep => s.type === "whatsapp" || s.type === "email";

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

      if (s.type === "email") {
        if (EMAIL_LOCKED_EVENTS.includes(eventType)) return errors.push(`Step ${n}: tax invoice e-mails are locked until ZATCA clears or reports invoices.`);
        const rawSubject = typeof s.subject === "string" ? s.subject : "";
        if (/[\r\n]/.test(rawSubject)) return errors.push(`Step ${n}: the subject must be one line.`);
        const subject = rawSubject.trim();
        if (!subject) return errors.push(`Step ${n}: write the e-mail subject.`);
        if (subject.length > SUBJECT_MAX_LENGTH) return errors.push(`Step ${n}: the subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`);
        const template = typeof s.template === "string" ? s.template.trim() : "";
        if (!template) return errors.push(`Step ${n}: the message is empty.`);
        if (template.length > TEMPLATE_MAX_LENGTH) return errors.push(`Step ${n}: the message must be ${TEMPLATE_MAX_LENGTH} characters or fewer.`);
        const unknown = [...unknownPlaceholders(event, subject), ...unknownPlaceholders(event, template)];
        if (unknown.length) return errors.push(`Step ${n}: unknown variable${unknown.length > 1 ? "s" : ""} ${[...new Set(unknown)].map((k) => `{{${k}}}`).join(", ")}.`);
        const to = isObj(s.to) ? s.to : null;
        const kind = to ? str(to.kind) : "";
        let recipient: EmailRecipient;
        if (kind === "customer") {
          if (!(event.recipients as string[]).includes("customer")) return errors.push(`Step ${n}: this event has no customer to e-mail.`);
          recipient = { kind: "customer" };
        } else if (kind === "email") {
          const email = parseEmailAddress(to!.email);
          if (!email) return errors.push(`Step ${n}: enter one valid e-mail address.`);
          const recipientName = str(to!.name).slice(0, 80);
          recipient = { kind: "email", email, ...(recipientName ? { name: recipientName } : {}) };
        } else {
          return errors.push(`Step ${n}: an e-mail goes to the customer or to one address.`);
        }
        let attach: { attach?: "quote_pdf" } = {};
        if (s.attach !== undefined && s.attach !== null && s.attach !== "") {
          if (s.attach !== "quote_pdf") return errors.push(`Step ${n}: only the quotation PDF can be attached.`);
          if (eventType !== QUOTE_ATTACH_EVENT) return errors.push(`Step ${n}: the quotation PDF can be attached only to the quotation event.`);
          if (recipient.kind !== "customer") return errors.push(`Step ${n}: the quotation PDF goes to the customer only.`);
          attach = { attach: "quote_pdf" };
        }
        return steps.push({ type: "email", to: recipient, subject, template, ...attach });
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
      // The English text of a staff step (optional; empty = none). Ignored for the customer and a typed number.
      let en: { templateEn?: string } = {};
      if (isStaffRecipient(kind) && s.templateEn !== undefined && s.templateEn !== null) {
        if (typeof s.templateEn !== "string") return errors.push(`Step ${n}: the English message must be text.`);
        const templateEn = s.templateEn.trim();
        if (templateEn.length > TEMPLATE_MAX_LENGTH) {
          return errors.push(`Step ${n}: the English message must be ${TEMPLATE_MAX_LENGTH} characters or fewer.`);
        }
        const unknownEn = unknownPlaceholders(event, templateEn);
        if (unknownEn.length) {
          return errors.push(`Step ${n}: unknown variable${unknownEn.length > 1 ? "s" : ""} in the English message ${unknownEn.map((k) => `{{${k}}}`).join(", ")}.`);
        }
        if (templateEn) en = { templateEn };
      }
      if (kind === "employee") {
        const employeeId = str(to.employeeId);
        if (!employeeId) return errors.push(`Step ${n}: choose an employee.`);
        return steps.push({ type: "whatsapp", to: { kind: "employee", employeeId }, template, ...en });
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
      steps.push({ type: "whatsapp", to: { kind: kind as Exclude<RecipientKind, "employee" | "phone"> }, template, ...en });
    });

    if (steps.length === rawSteps.length) {
      if (!steps.some(isMessageStep)) errors.push("Add at least one message step.");
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

/**
 * The fixed outside addresses a rule sends to (a typed e-mail or phone number), as "email:<addr>" / "phone:<digits>".
 * Adding one needs the administrator with a step-up (fix round 1): such a step can carry customer data outside.
 */
export function fixedTargetsOf(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.type === "email" && s.to.kind === "email") out.add(`email:${s.to.email}`);
    if (s.type === "whatsapp" && s.to.kind === "phone") out.add(`phone:${s.to.phone}`);
  }
  return [...out].sort();
}
/** The fixed targets in `next` that `prev` did not already have. */
export const newFixedTargets = (prev: Step[], next: Step[]) => {
  const had = new Set(fixedTargetsOf(prev));
  return fixedTargetsOf(next).filter((t) => !had.has(t));
};
