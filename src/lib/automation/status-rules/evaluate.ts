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
import { adminRecipients, type EventContext, type Person, type StoredEvent } from "../context";
import type { EffectiveMode } from "../settings";
import { parseRecipients, planStatusMessages } from "./rules";
import { statusesOfEvent, type StatusRecipient } from "./sources";

type Tx = Prisma.TransactionClient;

export type StatusEvalReport = { queued: number; skipped: number };

export async function processStatusRules(
  tx: Tx,
  ev: StoredEvent,
  mode: EffectiveMode,
  contextFor: () => Promise<EventContext | null>,
): Promise<StatusEvalReport> {
  const out: StatusEvalReport = { queued: 0, skipped: 0 };
  const hits = statusesOfEvent(ev.eventType, ev.payload);
  if (hits.length === 0) return out;

  const rules = await tx.whatsAppStatusRule.findMany({
    where: { enabled: true, active: true, OR: hits.map((h) => ({ source: h.source, statusKey: h.statusKey })) },
    orderBy: [{ source: "asc" }, { position: "asc" }],
  });
  if (rules.length === 0) return out;

  const ctx = await contextFor();
  if (!ctx) return out;

  let admins: Person[] | null = null;
  for (const rule of rules) {
    const recipients = parseRecipients(rule.recipients);
    const people: Partial<Record<StatusRecipient, Person[]>> = { ...ctx.people };
    if (recipients.includes("admins")) people.admins = admins ??= await adminRecipients(tx);

    const planned = planStatusMessages({
      rule: { source: rule.source, statusKey: rule.statusKey, labelAr: rule.labelAr, recipients, template: rule.template, renotify: rule.renotify },
      subject: { type: ev.subjectType, id: ev.subjectId },
      eventId: ev.id,
      vars: ctx.vars,
      people,
      mode,
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
