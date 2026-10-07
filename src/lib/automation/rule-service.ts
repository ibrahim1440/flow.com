/**
 * Saving automation rules, and acting on individual messages.
 *
 * Services throw `{ _appCode, message }` to refuse, like the rest of the codebase; routes map
 * that with handleDomainError.
 */
import type { Prisma } from "@/generated/prisma/client";
import { invalidateAutomationCache } from "./emit";
import type { RuleInput } from "./rules";

type Tx = Prisma.TransactionClient;

/** A step naming an employee must name one who exists and is active. */
async function assertRecipientsExist(tx: Tx, input: RuleInput) {
  const ids = [
    ...new Set(input.steps.flatMap((s) => (s.type === "whatsapp" && s.to.kind === "employee" ? [s.to.employeeId] : []))),
  ];
  if (ids.length === 0) return;
  const found = await tx.employee.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
  if (found.length !== ids.length) {
    throw { _appCode: 400, message: "A step names an employee who does not exist or is inactive." };
  }
}

const data = (input: RuleInput) => ({
  name: input.name,
  description: input.description,
  eventType: input.eventType,
  isActive: input.isActive,
  locale: input.locale,
  conditions: input.conditions as unknown as Prisma.InputJsonValue,
  steps: input.steps as unknown as Prisma.InputJsonValue,
});

export async function createRule(tx: Tx, actorId: string, input: RuleInput) {
  await assertRecipientsExist(tx, input);
  const rule = await tx.automationRule.create({ data: { ...data(input), createdById: actorId, updatedById: actorId } });
  invalidateAutomationCache();
  return rule;
}

export async function updateRule(tx: Tx, actorId: string, id: string, input: RuleInput) {
  const existing = await tx.automationRule.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw { _appCode: 404, message: "Rule not found." };
  await assertRecipientsExist(tx, input);
  const rule = await tx.automationRule.update({ where: { id }, data: { ...data(input), updatedById: actorId } });
  invalidateAutomationCache();
  return rule;
}

export async function setRuleActive(tx: Tx, actorId: string, id: string, isActive: boolean) {
  const updated = await tx.automationRule.updateMany({ where: { id }, data: { isActive, updatedById: actorId } });
  if (updated.count === 0) throw { _appCode: 404, message: "Rule not found." };
  invalidateAutomationCache();
}

/**
 * Deleting a rule removes the rule and its run records. The messages it produced stay in the
 * log — they carry the rule's name — because what was sent to a customer is history.
 * Messages still waiting to be sent are cancelled rather than left to go out under a rule
 * that no longer exists.
 */
export async function deleteRule(tx: Tx, id: string) {
  const existing = await tx.automationRule.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw { _appCode: 404, message: "Rule not found." };
  await tx.whatsAppMessage.updateMany({
    where: { ruleId: id, status: "QUEUED" },
    data: { status: "CANCELLED", statusNote: "The rule was deleted before this message was sent." },
  });
  await tx.automationRule.delete({ where: { id } });
  invalidateAutomationCache();
}

/**
 * Retry: a FAILED message goes back to the queue with a fresh attempt budget. Only FAILED —
 * a SENT message is never re-sent from here, and a SKIPPED one was skipped for a reason that
 * a retry would not change (no number, opted out, sending off).
 * Cancel: a QUEUED message is withdrawn before it is sent.
 */
export async function actOnMessage(tx: Tx, id: string, action: "retry" | "cancel", actorName: string) {
  const msg = await tx.whatsAppMessage.findUnique({ where: { id }, select: { status: true, phone: true } });
  if (!msg) throw { _appCode: 404, message: "Message not found." };
  if (action === "retry") {
    if (msg.status !== "FAILED") throw { _appCode: 409, message: "Only a failed message can be retried." };
    if (!msg.phone) throw { _appCode: 409, message: "This message has no phone number to send to." };
    const r = await tx.whatsAppMessage.updateMany({
      where: { id, status: "FAILED" },
      data: { status: "QUEUED", attempts: 0, nextAttemptAt: null, lockedAt: null, scheduledAt: new Date(), statusNote: `Retried by ${actorName}.` },
    });
    if (r.count === 0) throw { _appCode: 409, message: "The message changed. Reload and try again." };
    return;
  }
  if (msg.status !== "QUEUED") throw { _appCode: 409, message: "Only a message waiting to be sent can be cancelled." };
  const r = await tx.whatsAppMessage.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "CANCELLED", statusNote: `Cancelled by ${actorName}.` },
  });
  if (r.count === 0) throw { _appCode: 409, message: "The message is already being sent." };
}
