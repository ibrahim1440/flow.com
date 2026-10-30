/**
 * «إشعارات الحالات» — the pure part: reconciling the stored catalogue with the statuses found
 * in the system, validating what the owner saves, and planning the messages for an event.
 *
 * No database, no Next: tests/automation/status-rules.test.ts runs every rule here under plain
 * Node. sync.ts and the dispatcher do the reads and writes around these functions.
 */
import type { Person } from "../context";
import type { EffectiveMode } from "../settings";
import { planDelivery } from "../send-mode";
import { renderTemplate, TEMPLATE_MAX_LENGTH, unknownPlaceholders, type RenderContext } from "../template";
import { getStatusSource, sourceEventDef, statusCanFire, statusEnglishDefault, type StatusRecipient } from "./sources";
import { pickStaffTemplate, resolveMessageLang, staffIdOf, type MsgLang } from "../employee-lang";

// ─── Reconcile ─────────────────────────────────────────────────────────────────

/** A status as the sync found it in its source right now. */
export type FoundStatus = {
  source: string;
  statusKey: string;
  labelAr: string;
  labelEn: string;
  position: number;
  /** False when it exists but is hidden in its source (a pipeline stage switched off). */
  visible: boolean;
};

/** A stored catalogue row, as far as the sync is concerned. */
export type StoredStatus = {
  id: string;
  source: string;
  statusKey: string;
  labelAr: string;
  labelEn: string;
  position: number;
  active: boolean;
};

export type SyncChange =
  | { kind: "renamed"; id: string; labelAr: string; labelEn: string; position: number }
  | { kind: "deactivated"; id: string }
  | { kind: "reactivated"; id: string; labelAr: string; labelEn: string; position: number };

export type SyncPlan = {
  create: (FoundStatus & { active: boolean })[];
  changes: SyncChange[];
  /** Ids of stored rows seen in this sync (their lastSeenAt moves to now). */
  seen: string[];
};

export const statusId = (source: string, statusKey: string) => `${source}\u0000${statusKey}`;

/**
 * What a sync must do to make the catalogue match the system. Idempotent: running it again on
 * its own result plans nothing but "seen".
 *
 *   found, not stored            → create (OFF; inactive if hidden in its source)
 *   stored, not found            → deactivated (kept, never deleted)
 *   stored, found hidden         → deactivated
 *   stored inactive, found shown → reactivated (its saved choice comes back with it)
 *   stored, label/order changed  → renamed (the key is the identity; labels follow the source)
 */
export function planSync(stored: StoredStatus[], found: FoundStatus[]): SyncPlan {
  const byId = new Map(stored.map((r) => [statusId(r.source, r.statusKey), r]));
  const foundIds = new Set<string>();
  const create: SyncPlan["create"] = [];
  const changes: SyncChange[] = [];
  const seen: string[] = [];

  for (const f of found) {
    const id = statusId(f.source, f.statusKey);
    if (foundIds.has(id)) continue;
    foundIds.add(id);
    const row = byId.get(id);
    if (!row) {
      create.push({ ...f, active: f.visible });
      continue;
    }
    seen.push(row.id);
    if (!f.visible) {
      if (row.active) changes.push({ kind: "deactivated", id: row.id });
      continue;
    }
    if (!row.active) {
      changes.push({ kind: "reactivated", id: row.id, labelAr: f.labelAr, labelEn: f.labelEn, position: f.position });
    } else if (row.labelAr !== f.labelAr || row.labelEn !== f.labelEn || row.position !== f.position) {
      changes.push({ kind: "renamed", id: row.id, labelAr: f.labelAr, labelEn: f.labelEn, position: f.position });
    }
  }
  for (const row of stored) {
    if (row.active && !foundIds.has(statusId(row.source, row.statusKey))) changes.push({ kind: "deactivated", id: row.id });
  }
  return { create, changes, seen };
}

export type SyncReport = {
  added: number;
  deactivated: number;
  reactivated: number;
  renamed: number;
  /** "source:key" of the statuses added — what the «جديدة» feedback names. */
  addedKeys: string[];
};

export function reportOf(plan: SyncPlan): SyncReport {
  const count = (k: SyncChange["kind"]) => plan.changes.filter((c) => c.kind === k).length;
  return {
    added: plan.create.length,
    deactivated: count("deactivated"),
    reactivated: count("reactivated"),
    renamed: count("renamed"),
    addedKeys: plan.create.map((c) => `${c.source}:${c.statusKey}`),
  };
}

/** «أُضيفت 2 حالات جديدة» — the button's feedback, in the frames' Arabic. */
export function syncMessage(r: SyncReport, lang: "ar" | "en"): string {
  const parts: string[] = [];
  if (lang === "en") {
    if (r.added) parts.push(`${r.added} new status${r.added === 1 ? "" : "es"} added`);
    if (r.reactivated) parts.push(`${r.reactivated} back in use`);
    if (r.deactivated) parts.push(`${r.deactivated} no longer in use`);
    if (r.renamed) parts.push(`${r.renamed} renamed`);
    return parts.length ? `${parts.join(" · ")}.` : "The list is up to date. No new statuses.";
  }
  const n = (k: number, one: string, two: string, few: string, many: string) =>
    k === 1 ? one : k === 2 ? two : k <= 10 ? `${k} ${few}` : `${k} ${many}`;
  if (r.added) parts.push(`أُضيفت ${n(r.added, "حالة جديدة واحدة", "حالتان جديدتان", "حالات جديدة", "حالة جديدة")}`);
  if (r.reactivated) parts.push(`عادت ${n(r.reactivated, "حالة واحدة", "حالتان", "حالات", "حالة")} للاستخدام`);
  if (r.deactivated) parts.push(`${n(r.deactivated, "حالة واحدة", "حالتان", "حالات", "حالة")} لم تعد مستخدمة`);
  if (r.renamed) parts.push(`تغيّر اسم ${n(r.renamed, "حالة واحدة", "حالتين", "حالات", "حالة")}`);
  return parts.length ? `${parts.join(" · ")}.` : "القائمة محدّثة. لا توجد حالات جديدة.";
}

// ─── Validation ────────────────────────────────────────────────────────────────

/** templateEn (owner language decision 3): the English text for employees who receive English; "" = none. */
export type StatusRuleInput = { enabled: boolean; recipients: StatusRecipient[]; template: string; templateEn?: string; renotify: boolean };

export type StatusRuleValidation =
  | { ok: true; value: StatusRuleInput }
  | { ok: false; status: number; error: string; errorEn: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * PUT body → what is stored. Partial: an absent field keeps `current`. Switching a status on
 * needs at least one recipient and a message; a status that is no longer in use, or that no
 * event can announce, cannot be switched on (its saved choices may still be edited).
 */
export function validateStatusRuleInput(
  rule: { source: string; statusKey: string; active: boolean },
  current: StatusRuleInput,
  body: unknown,
): StatusRuleValidation {
  const bad = (error: string, errorEn: string, status = 400): StatusRuleValidation => ({ ok: false, status, error, errorEn });
  if (!isObj(body)) return bad("طلب غير صالح.", "The body must be an object.");
  const source = getStatusSource(rule.source);
  if (!source) return bad("مصدر الحالة غير معروف.", "Unknown status source.", 409);

  let enabled = current.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("قيمة التفعيل غير صالحة.", "enabled must be true or false.");
    enabled = body.enabled;
  }

  let renotify = current.renotify;
  if (body.renotify !== undefined) {
    if (typeof body.renotify !== "boolean") return bad("قيمة إعادة الإرسال غير صالحة.", "renotify must be true or false.");
    renotify = body.renotify;
  }

  let recipients = current.recipients;
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients)) return bad("المستلمون يجب أن يكونوا قائمة.", "recipients must be a list.");
    const allowed = new Set<string>(source.recipients);
    const list = [...new Set(body.recipients.map((r) => (typeof r === "string" ? r : "")))];
    if (list.some((r) => !allowed.has(r))) return bad("مستلم غير متاح لهذه الحالة.", "A recipient is not available for this status.");
    recipients = list as StatusRecipient[];
  }

  let template = current.template;
  if (body.template !== undefined) {
    if (typeof body.template !== "string") return bad("نص الرسالة غير صالح.", "template must be text.");
    template = body.template.trim();
    if (template.length > TEMPLATE_MAX_LENGTH) {
      return bad(`الرسالة أطول من ${TEMPLATE_MAX_LENGTH} حرف.`, `The message must be ${TEMPLATE_MAX_LENGTH} characters or fewer.`);
    }
    const unknown = unknownPlaceholders(sourceEventDef(source), template);
    if (unknown.length) {
      const list = unknown.map((k) => `{{${k}}}`).join(", ");
      return bad(`متغير غير معروف لهذه الحالة: ${list}`, `Unknown variable for this status: ${list}`);
    }
  }

  let templateEn = current.templateEn ?? "";
  if (body.templateEn !== undefined) {
    if (body.templateEn !== null && typeof body.templateEn !== "string") return bad("النص الإنجليزي غير صالح.", "templateEn must be text.");
    templateEn = (body.templateEn ?? "").trim();
    if (templateEn.length > TEMPLATE_MAX_LENGTH) {
      return bad(`النص الإنجليزي أطول من ${TEMPLATE_MAX_LENGTH} حرف.`, `The English text must be ${TEMPLATE_MAX_LENGTH} characters or fewer.`);
    }
    const unknownEn = unknownPlaceholders(sourceEventDef(source), templateEn);
    if (unknownEn.length) {
      const list = unknownEn.map((k) => `{{${k}}}`).join(", ");
      return bad(`متغير غير معروف في النص الإنجليزي: ${list}`, `Unknown variable in the English text: ${list}`);
    }
  }

  if (enabled) {
    if (!rule.active) return bad("هذه الحالة لم تعد مستخدمة في النظام، فلا يمكن تفعيلها.", "This status is no longer in use, so it cannot be switched on.", 409);
    if (!statusCanFire(source, rule.statusKey)) {
      return bad("لا يوجد حدث في النظام يُعلن هذه الحالة، فلا يمكن الإرسال عندها.", "No event in the system announces this status, so nothing can be sent for it.", 409);
    }
    if (recipients.length === 0) return bad("اختر مستلمًا واحدًا على الأقل.", "Choose at least one recipient.");
    if (!template) return bad("اكتب نص الرسالة.", "Write the message.");
  }
  return { ok: true, value: { enabled, recipients, template, templateEn, renotify } };
}

export function parseRecipients(raw: unknown): StatusRecipient[] {
  return Array.isArray(raw) ? (raw.filter((r) => typeof r === "string") as StatusRecipient[]) : [];
}

// ─── Planning the messages ─────────────────────────────────────────────────────

export type PlannedMessage = {
  dedupeKey: string;
  recipientKind: string;
  recipientName: string | null;
  phone: string | null;
  intendedPhone?: string | null;
  body: string;
  status: "QUEUED" | "SKIPPED";
  statusNote: string | null;
};

/**
 * The idempotency key of one status notification. WhatsAppMessage.dedupeKey is unique and rows
 * are inserted with skipDuplicates, so a second insert with the same key is a no-op.
 *
 *   base     status:<source>:<status>:<subjectType>:<subjectId>:<person>
 *            — one message per record, status and person, EVER (the default). A replayed event,
 *            a second dispatcher, the record moved out of the status and back, or the same person
 *            reached as both "customer" and "owner": same key.
 *   :entry:<eventId>   when the rule re-notifies («إعادة الإرسال عند العودة لنفس الحالة»): one per
 *            ENTRY. A re-entry is a new automation event, so it is announced again; a retry or a
 *            second dispatcher of the same event still collides.
 *   :mode:OFF / :mode:TEST   when the message is not a real delivery. A row recorded while sending
 *            was OFF, or redirected to the test number, therefore never blocks the later LIVE
 *            message for the same record, status and person; LIVE rows carry no suffix.
 */
export function statusDedupeKey(e: {
  source: string;
  statusKey: string;
  subjectType: string;
  subjectId: string;
  personKey: string;
  mode?: "OFF" | "TEST" | "LIVE";
  entryEventId?: string | null;
}): string {
  let key = `status:${e.source}:${e.statusKey}:${e.subjectType}:${e.subjectId}:${e.personKey}`;
  if (e.entryEventId) key += `:entry:${e.entryEventId}`;
  if (e.mode && e.mode !== "LIVE") key += `:mode:${e.mode}`;
  return key;
}

/**
 * The rows one enabled rule produces for one event. Same sending rules as the automation rules
 * (dispatcher.ts, through planDelivery): an opted-out customer is SKIPPED, OFF records what it would
 * have sent, TEST sends to the test number only (even when the recipient's own number is missing or
 * unusable), LIVE skips a missing or unusable number with the reason.
 */
export function planStatusMessages(input: {
  rule: { source: string; statusKey: string; labelAr: string; labelEn?: string; recipients: StatusRecipient[]; template: string; templateEn?: string | null; renotify?: boolean };
  subject: { type: string; id: string };
  /** The automation event being processed (the entry); used in the key when the rule re-notifies. */
  eventId?: string;
  vars: RenderContext;
  people: Partial<Record<StatusRecipient, Person[]>>;
  mode: EffectiveMode;
  /**
   * Owner language decision 3. The English variables of the event (null: not resolved — every
   * employee then gets the Arabic), each employee's own choice by employee id, and the default.
   */
  varsEn?: RenderContext | null;
  staffLangs?: Map<string, MsgLang | null>;
  employeeDefault?: MsgLang | null;
}): PlannedMessage[] {
  const source = getStatusSource(input.rule.source);
  if (!source) return [];
  const def = sourceEventDef(source);
  const body = renderTemplate(def, input.rule.template, { ...input.vars, "status.name": input.rule.labelAr }, "ar");
  // The text an employee gets: English when they receive English and there is an English text
  // (stored, or the built-in English of the untouched built-in Arabic). Customers always get `body`.
  const englishDefault = statusEnglishDefault(source, input.rule.statusKey, input.rule.template);
  let bodyEn: string | null | undefined;
  const bodyFor = (person: Person): string => {
    const staffId = staffIdOf(person.key);
    if (!staffId || !input.varsEn) return body;
    const pick = pickStaffTemplate(
      { template: input.rule.template, templateEn: input.rule.templateEn, englishDefault, fallbackLang: "ar" },
      resolveMessageLang(input.staffLangs?.get(staffId), input.employeeDefault),
    );
    if (pick.lang !== "en") return body;
    bodyEn ??= renderTemplate(def, pick.template, { ...input.varsEn, "status.name": input.rule.labelEn || input.rule.labelAr }, "en");
    return bodyEn;
  };
  const rows: PlannedMessage[] = [];
  const seenPeople = new Set<string>();
  const seenPhones = new Set<string>();
  const key = (personKey: string) =>
    statusDedupeKey({
      source: input.rule.source,
      statusKey: input.rule.statusKey,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      personKey,
      mode: input.mode.mode,
      entryEventId: input.rule.renotify ? input.eventId ?? null : null,
    });

  for (const kind of input.rule.recipients) {
    const people = input.people[kind] ?? [];
    if (people.length === 0) {
      rows.push({ dedupeKey: key(`none:${kind}`), recipientKind: kind, recipientName: null, phone: null, body, status: "SKIPPED", statusNote: "No recipient for this event (for example, the order has no owner yet)." });
      continue;
    }
    for (const person of people) {
      if (seenPeople.has(person.key)) continue;
      seenPeople.add(person.key);
      const base = { dedupeKey: key(person.key), recipientKind: kind, recipientName: person.name, body: bodyFor(person) };
      // planDelivery (send-mode.ts), shared with the automation rules: in TEST mode the test number
      // is the only destination, whatever the recipient's own number is — missing or unusable included.
      const d = planDelivery(person, input.mode);
      if (d.ownPhone) {
        if (seenPhones.has(d.ownPhone)) continue;
        seenPhones.add(d.ownPhone);
      }
      rows.push({ ...base, phone: d.phone, intendedPhone: d.intendedPhone, status: d.status, statusNote: d.statusNote });
    }
  }
  return rows;
}
