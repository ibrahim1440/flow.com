/**
 * The status-rule evaluator: for one automation event being processed, the switched-on status
 * rules it matches and the WhatsApp messages they produce. Called by the dispatcher inside the
 * event's own transaction, next to the automation rules — same outbox, same queue, same sender,
 * same sending mode, same log (WhatsAppMessage / WhatsAppSendAttempt).
 *
 * Exactly once per record, status and person — or per entry when the rule re-notifies — and per
 * real delivery: WhatsAppMessage.dedupeKey (statusDedupeKey) is unique and the rows are inserted
 * with skipDuplicates.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { Lang } from "../catalog";
import { adminRecipients, employeeMessageLangs, type EventContext, type Person, type StoredEvent } from "../context";
import { resolveMessageLang, staffIdOf, type MsgLang } from "../employee-lang";
import type { EffectiveMode } from "../settings";
import { canEmailSource, parseRecipients, planStatusEmails, planStatusMessages } from "./rules";
import type { EffectiveEmailMode } from "../email-mode";
import { statusesOfEvent, type StatusRecipient } from "./sources";

type Tx = Prisma.TransactionClient;

export type StatusEvalReport = { queued: number; skipped: number; emailsQueued?: number; emailsSkipped?: number };

/** Batch 25: the e-mail half of a status notification (the customer only), planned in the same transaction. */
export type EmailPlanning = {
  mode: EffectiveEmailMode;
  /** The suppressed addresses among those given (pre-loaded: the planner is pure). */
  suppression: (emails: (string | null | undefined)[]) => Promise<(email: string) => boolean>;
  /** Runs the e-mail part in a savepoint: an e-mail error never loses this event's WhatsApp rows. */
  savepoint: (fn: () => Promise<void>) => Promise<void>;
};

export async function processStatusRules(
  tx: Tx,
  ev: StoredEvent,
  mode: EffectiveMode,
  contextFor: (lang?: Lang) => Promise<EventContext | null>,
  /** Owner language decision 3: the automation default for employees who have not chosen (null = Arabic). */
  employeeDefault: MsgLang | null = null,
  email: EmailPlanning | null = null,
): Promise<StatusEvalReport> {
  const out: StatusEvalReport = { queued: 0, skipped: 0, emailsQueued: 0, emailsSkipped: 0 };
  const hits = statusesOfEvent(ev.eventType, ev.payload);
  if (hits.length === 0) return out;

  const rules = await tx.whatsAppStatusRule.findMany({
    where: { active: true, AND: [{ OR: [{ enabled: true }, { emailEnabled: true }] }, { OR: hits.map((h) => ({ source: h.source, statusKey: h.statusKey })) }] },
    orderBy: [{ source: "asc" }, { position: "asc" }],
  });
  if (rules.length === 0) return out;

  const ctx = await contextFor();
  if (!ctx) return out;

  let admins: Person[] | null = null;
  for (const rule of rules) {
    // «إيميل» (batch 25): the customer of the record, on its own key namespace ("email:…"), never blocked by WhatsApp.
    if (email && rule.emailEnabled && canEmailSource(rule.source)) await email.savepoint(async () => {
      const customers = ctx.people.customer ?? [];
      const suppressed = await email.suppression(customers.map((c) => c.email));
      const planned = planStatusEmails({
        rule: { source: rule.source, statusKey: rule.statusKey, labelAr: rule.labelAr, template: rule.template, emailSubject: rule.emailSubject, renotify: rule.renotify },
        subject: { type: ev.subjectType, id: ev.subjectId }, eventId: ev.id, vars: ctx.vars, customers, mode: email.mode, suppressed,
      });
      if (planned.length) {
        const created = await tx.emailMessage.createMany({
          data: planned.map((m) => ({ ...m, ruleId: null, ruleName: `إشعار الحالة: ${rule.labelAr}`, eventId: ev.id, eventType: ev.eventType, subjectType: ev.subjectType, subjectId: ev.subjectId, scheduledAt: ev.occurredAt })),
          skipDuplicates: true,
        });
        const q = planned.filter((m) => m.status === "QUEUED").length;
        out.emailsQueued! += Math.min(q, created.count);
        out.emailsSkipped! += Math.max(0, created.count - q);
      }
    });
    if (!rule.enabled) continue;
    const recipients = parseRecipients(rule.recipients);
    const people: Partial<Record<StatusRecipient, Person[]>> = { ...ctx.people };
    if (recipients.includes("admins")) people.admins = admins ??= await adminRecipients(tx);
    // The employees among the recipients, and whether any of them receives English: only then is the
    // event's English context resolved.
    const staff = recipients.flatMap((k) => people[k] ?? []).filter((p) => staffIdOf(p.key));
    const staffLangs = await employeeMessageLangs(tx, staff);
    const wantsEn = staff.some((p) => resolveMessageLang(staffLangs.get(staffIdOf(p.key)!), employeeDefault) === "en");
    const ctxEn = wantsEn ? await contextFor("en") : null;

    const planned = planStatusMessages({
      rule: { source: rule.source, statusKey: rule.statusKey, labelAr: rule.labelAr, labelEn: rule.labelEn, recipients, template: rule.template, templateEn: rule.templateEn, renotify: rule.renotify },
      subject: { type: ev.subjectType, id: ev.subjectId },
      eventId: ev.id,
      vars: ctx.vars,
      people,
      mode,
      varsEn: ctxEn?.vars ?? null,
      staffLangs,
      employeeDefault,
    });
    if (planned.length === 0) continue;
    const created = await tx.whatsAppMessage.createMany({
      data: planned.map((m) => ({
        ...m,
        ruleId: null,
        ruleName: `إشعار الحالة: ${rule.labelAr}`,
        eventId: ev.id,
        eventType: ev.eventType,
        subjectType: ev.subjectType,
        subjectId: ev.subjectId,
        scheduledAt: ev.occurredAt,
      })),
      skipDuplicates: true,
    });
    // createMany reports inserted rows only; a replay inserts none.
    const queued = planned.filter((m) => m.status === "QUEUED").length;
    out.queued += Math.min(queued, created.count);
    out.skipped += Math.max(0, created.count - queued);
  }
  return out;
}
