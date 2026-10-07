import "server-only";

/**
 * The dispatcher: turns pending events into messages, and sends the messages that are due.
 *
 * It runs in three places, all calling this one function:
 *   - after the response of any request that raised an event (emit.ts, Next's `after`),
 *   - on a schedule, through POST /api/automation/dispatch (a cron, with CRON_SECRET),
 *   - by hand, from the WhatsApp screen.
 * Any number of them may run at once. Every claim below is a row lock taken with SKIP LOCKED
 * and every write that could repeat is keyed by a unique column, so concurrent dispatchers
 * share the work instead of duplicating it.
 *
 * ── Sending is deliberately slow ──
 * The WhatsApp server speaks the WhatsApp Web protocol. A number that sends in bursts gets
 * banned, and that number cannot be recreated. So sends are sequential with a pause between
 * them, a single run sends a handful at most, and a message that misses its moment by more
 * than a day is expired rather than delivered late.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getConnectionState, sendText } from "@/lib/whatsapp/evolution";
import { getEvent, type Lang } from "./catalog";
import { firstFailingCondition } from "./conditions";
import { employeeRecipient, resolveEventContext, type EventContext, type Person, type StoredEvent } from "./context";
import { normalizePhoneForWhatsApp } from "./phone";
import { parseStoredConditions, parseStoredSteps, stepOffsetsMinutes, type Recipient } from "./rules";
import { effectiveMode, readSettings, SETTINGS_ID, type EffectiveMode } from "./settings";
import { renderTemplate } from "./template";

type Tx = Prisma.TransactionClient;

export const MAX_SEND_ATTEMPTS = 5;
/** Minutes to wait before attempt 2, 3, 4 and 5. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const PAUSE_BETWEEN_SENDS_MS = 1_500;
const EVENT_BATCH = 20;
const EVENT_MAX_ATTEMPTS = 5;
/** An event or a message older than this is no longer news. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** A send that has been "in flight" this long was interrupted. */
const STUCK_SEND_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const EVENT_RETENTION_DAYS = 90;

export type DispatchOptions = { budgetMs: number; maxSends: number };

export type DispatchReport = {
  tasksRaised: number;
  eventsProcessed: number;
  eventsFailed: number;
  messagesQueued: number;
  messagesSkipped: number;
  sent: number;
  sendFailures: number;
  /** Why nothing was sent this run, when that is the case. */
  sendingPaused: string | null;
};

export async function runAutomationDispatch(opts: DispatchOptions): Promise<DispatchReport> {
  const deadline = Date.now() + opts.budgetMs;
  const report: DispatchReport = {
    tasksRaised: 0,
    eventsProcessed: 0,
    eventsFailed: 0,
    messagesQueued: 0,
    messagesSkipped: 0,
    sent: 0,
    sendFailures: 0,
    sendingPaused: null,
  };
  try {
    await recoverInterruptedSends();
    await sweepDueTasks(report);
    await processPendingEvents(report, deadline);
    await sendDueMessages(report, deadline, opts.maxSends);
  } catch (err) {
    // A dispatcher failure must never surface in the request that scheduled it. Whatever was
    // not done stays pending for the next run.
    console.error("[automation] dispatch failed:", err instanceof Error ? err.message : err);
  }
  return report;
}

// ─── 1. Interrupted sends ──────────────────────────────────────────────────────

/**
 * A message left SENDING was in flight when its process died. It may or may not have reached
 * the phone, and sending it again could deliver it twice — so it is failed with that said,
 * and only a person decides whether to retry it.
 */
async function recoverInterruptedSends() {
  await prisma.whatsAppMessage.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(Date.now() - STUCK_SEND_MS) } },
    data: {
      status: "FAILED",
      lockedAt: null,
      statusNote: "Interrupted while sending: it may or may not have been delivered. Retry only if you are sure it was not.",
    },
  });
}

// ─── 2. Time-based events ──────────────────────────────────────────────────────

/**
 * Raise "sales.task_due" for open tasks whose due time has passed since the last sweep.
 *
 * At most one sweep a minute across every dispatcher: claiming the sweep is a conditional
 * update of `lastSweepAt`, and only the run whose update matched sweeps. The window starts
 * at the previous sweep, so a quiet night is caught up in the morning, but never reaches back
 * further than a day — switching a rule on must not wake every task overdue since spring.
 */
async function sweepDueTasks(report: DispatchReport) {
  const now = new Date();
  const threshold = new Date(now.getTime() - SWEEP_EVERY_MS);

  const settings = await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { lastSweepAt: true } });
  if (!settings) {
    await prisma.automationSettings.create({ data: { id: SETTINGS_ID, lastSweepAt: now } }).catch(() => undefined);
    return;
  }
  const claim = await prisma.automationSettings.updateMany({
    where: { id: SETTINGS_ID, OR: [{ lastSweepAt: null }, { lastSweepAt: { lt: threshold } }] },
    data: { lastSweepAt: now },
  });
  if (claim.count === 0) return;

  const listening = await prisma.automationRule.count({ where: { isActive: true, eventType: "sales.task_due" } });
  if (listening > 0) {
    const floor = new Date(now.getTime() - STALE_MS);
    const from = settings.lastSweepAt && settings.lastSweepAt > floor ? settings.lastSweepAt : new Date(now.getTime() - 15 * 60 * 1000);
    const due = await prisma.activity.findMany({
      where: { completedAt: null, dueAt: { gt: from, lte: now } },
      select: { id: true, dueAt: true, ownerId: true },
      take: 500,
    });
    if (due.length) {
      const created = await prisma.automationEvent.createMany({
        data: due.map((a) => ({
          eventType: "sales.task_due",
          subjectType: "Activity",
          subjectId: a.id,
          payload: {},
          actorId: null,
          occurredAt: a.dueAt!,
          dedupeKey: `sales.task_due:${a.id}:${a.dueAt!.toISOString()}`,
        })),
        skipDuplicates: true,
      });
      report.tasksRaised = created.count;
    }
  }

  // Housekeeping, at the same once-a-minute cadence. Messages keep their own copy of what
  // they need, so an old event can go without taking its history with it.
  await prisma.automationEvent.deleteMany({
    where: { status: { not: "PENDING" }, occurredAt: { lt: new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000) } },
  });
}

// ─── 3. Events → messages ──────────────────────────────────────────────────────

async function processPendingEvents(report: DispatchReport, deadline: number) {
  const settings = await readSettings();
  const mode = effectiveMode(settings);

  const candidates = await prisma.automationEvent.findMany({
    where: { status: "PENDING", occurredAt: { lte: new Date() } },
    orderBy: { occurredAt: "asc" },
    select: { id: true },
    take: EVENT_BATCH,
  });

  for (const { id } of candidates) {
    if (Date.now() > deadline) return;
    try {
      const done = await prisma.$transaction((tx) => processOneEvent(tx, id, mode, report));
      if (done) report.eventsProcessed++;
    } catch (err) {
      report.eventsFailed++;
      const message = err instanceof Error ? err.message.slice(0, 500) : "Processing failed.";
      const ev = await prisma.automationEvent.update({
        where: { id },
        data: { attempts: { increment: 1 }, lastError: message },
        select: { attempts: true },
      });
      if (ev.attempts >= EVENT_MAX_ATTEMPTS) {
        await prisma.automationEvent.update({ where: { id }, data: { status: "FAILED", processedAt: new Date() } });
      }
    }
  }
}

/** Returns false when another dispatcher holds the event or already finished it. */
async function processOneEvent(tx: Tx, id: string, mode: EffectiveMode, report: DispatchReport): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "AutomationEvent" WHERE id = ${id} AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) return false;

  const ev = await tx.automationEvent.findUniqueOrThrow({ where: { id } });
  const event: StoredEvent = ev;
  const finish = (status: "PROCESSED" | "FAILED", lastError: string | null = null) =>
    tx.automationEvent.update({ where: { id }, data: { status, processedAt: new Date(), lastError } });

  if (Date.now() - ev.occurredAt.getTime() > STALE_MS) {
    await finish("FAILED", "Expired: not processed within 24 hours of happening.");
    return true;
  }

  const def = getEvent(ev.eventType);
  const rules = def
    ? await tx.automationRule.findMany({ where: { eventType: ev.eventType, isActive: true }, orderBy: { createdAt: "asc" } })
    : [];
  if (rules.length === 0) {
    await finish("PROCESSED");
    return true;
  }

  const contexts = new Map<Lang, EventContext | null>();
  const contextFor = async (lang: Lang) => {
    if (!contexts.has(lang)) contexts.set(lang, await resolveEventContext(tx, event, lang));
    return contexts.get(lang)!;
  };

  for (const rule of rules) {
    const lang: Lang = rule.locale === "en" ? "en" : "ar";
    const ctx = await contextFor(lang);
    if (!ctx) {
      await tx.automationRun.createMany({
        data: [{ ruleId: rule.id, eventId: id, matched: false, note: "The record behind this event no longer exists or no longer needs a message." }],
        skipDuplicates: true,
      });
      continue;
    }

    const failing = firstFailingCondition(parseStoredConditions(rule.conditions), ctx.vars);
    const run = await tx.automationRun.upsert({
      where: { ruleId_eventId: { ruleId: rule.id, eventId: id } },
      create: {
        ruleId: rule.id,
        eventId: id,
        matched: !failing,
        note: failing ? `Condition not met: ${failing.field} ${failing.op} ${failing.value ?? ""}`.trim() : null,
      },
      update: {},
    });
    if (failing) continue;

    const steps = parseStoredSteps(rule.steps);
    const offsets = stepOffsetsMinutes(steps);
    const rows: Prisma.WhatsAppMessageCreateManyInput[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type !== "whatsapp") continue;
      const scheduledAt = new Date(ev.occurredAt.getTime() + (offsets[i] ?? 0) * 60_000);
      const people = await recipientsOf(tx, step.to, ctx);
      const base = {
        ruleId: rule.id,
        ruleName: rule.name,
        eventId: id,
        eventType: ev.eventType,
        subjectType: ev.subjectType,
        subjectId: ev.subjectId,
        stepIndex: i,
        recipientKind: step.to.kind,
        scheduledAt,
      };
      const body = renderTemplate(def!, step.template, ctx.vars, lang);

      if (people.length === 0) {
        rows.push({ ...base, dedupeKey: `${run.id}:${i}:none`, body, status: "SKIPPED", statusNote: "No recipient for this event (for example, the order has no owner yet)." });
        continue;
      }
      const seenPhones = new Set<string>();
      for (const person of people) {
        const dedupeKey = `${run.id}:${i}:${person.key}`;
        const phone = normalizePhoneForWhatsApp(person.phone);
        const row = { ...base, dedupeKey, recipientName: person.name, body };
        if (!phone.ok) {
          rows.push({ ...row, phone: null, status: "SKIPPED", statusNote: phone.reason });
        } else if (seenPhones.has(phone.phone)) {
          continue;
        } else if (person.optOut) {
          seenPhones.add(phone.phone);
          rows.push({ ...row, phone: phone.phone, status: "SKIPPED", statusNote: "This customer asked not to receive WhatsApp messages." });
        } else if (mode.mode === "OFF") {
          seenPhones.add(phone.phone);
          rows.push({ ...row, phone: phone.phone, status: "SKIPPED", statusNote: mode.note });
        } else if (mode.mode === "TEST") {
          seenPhones.add(phone.phone);
          rows.push({ ...row, phone: mode.testPhone, intendedPhone: phone.phone, status: "QUEUED" });
        } else {
          seenPhones.add(phone.phone);
          rows.push({ ...row, phone: phone.phone, status: "QUEUED" });
        }
      }
    }

    if (rows.length) {
      await tx.whatsAppMessage.createMany({ data: rows, skipDuplicates: true });
      for (const r of rows) {
        if (r.status === "QUEUED") report.messagesQueued++;
        else report.messagesSkipped++;
      }
    }
  }

  await finish("PROCESSED");
  return true;
}

async function recipientsOf(tx: Tx, to: Recipient, ctx: EventContext): Promise<Person[]> {
  if (to.kind === "employee") return employeeRecipient(tx, to.employeeId);
  if (to.kind === "phone") return [{ key: `phone:${to.phone}`, name: to.name ?? "", phone: to.phone }];
  return ctx.people[to.kind] ?? [];
}

// ─── 4. Sending ────────────────────────────────────────────────────────────────

type Claimed = { id: string; phone: string | null; intendedPhone: string | null; body: string; attempts: number };

async function sendDueMessages(report: DispatchReport, deadline: number, maxSends: number) {
  const settings = await readSettings();
  const mode = effectiveMode(settings);
  const now = new Date();

  // Late is worse than never for "your order is ready": expire instead of delivering tomorrow.
  await prisma.whatsAppMessage.updateMany({
    where: { status: "QUEUED", scheduledAt: { lt: new Date(now.getTime() - STALE_MS) } },
    data: { status: "FAILED", statusNote: "Expired: not sent within 24 hours of its time." },
  });

  if (mode.mode === "OFF") {
    report.sendingPaused = mode.note;
    return;
  }
  const due = await prisma.whatsAppMessage.count({
    where: { status: "QUEUED", scheduledAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
  });
  if (due === 0) return;

  const state = await getConnectionState();
  if (!state.ok || state.state !== "open") {
    report.sendingPaused = state.ok ? `WhatsApp is not connected (state: ${state.state}).` : state.error;
    return;
  }

  const claimed = await prisma.$queryRaw<Claimed[]>`
    UPDATE "WhatsAppMessage" SET status = 'SENDING', "lockedAt" = now(), "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "WhatsAppMessage"
      WHERE status = 'QUEUED' AND "scheduledAt" <= now() AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "scheduledAt" ASC
      LIMIT ${maxSends}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, phone, "intendedPhone", body, attempts`;

  for (let i = 0; i < claimed.length; i++) {
    const msg = claimed[i];
    if (Date.now() > deadline - 2 * PAUSE_BETWEEN_SENDS_MS) {
      await releaseUnsent(claimed.slice(i));
      return;
    }
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SENDS_MS));

    // TEST mode means nothing reaches a real recipient — including messages queued while
    // the mode was LIVE.
    let phone = msg.phone;
    let intendedPhone = msg.intendedPhone;
    if (mode.mode === "TEST" && !intendedPhone) {
      intendedPhone = phone;
      phone = mode.testPhone;
    }
    if (!phone) {
      await prisma.whatsAppMessage.update({ where: { id: msg.id }, data: { status: "FAILED", lockedAt: null, statusNote: "No phone number." } });
      continue;
    }

    const attemptNo = msg.attempts + 1;
    const started = Date.now();
    const result = await sendText(phone, msg.body);
    const durationMs = Date.now() - started;

    await prisma.whatsAppSendAttempt.create({
      data: {
        messageId: msg.id,
        attemptNo,
        ok: result.ok,
        httpStatus: result.ok ? 200 : result.status,
        error: result.ok ? null : result.error,
        durationMs,
      },
    });

    if (result.ok) {
      report.sent++;
      await prisma.whatsAppMessage.update({
        where: { id: msg.id },
        data: { status: "SENT", phone, intendedPhone, attempts: attemptNo, sentAt: new Date(), lockedAt: null, nextAttemptAt: null, providerMessageId: result.messageId, statusNote: null },
      });
      continue;
    }

    report.sendFailures++;
    const exhausted = attemptNo >= MAX_SEND_ATTEMPTS;
    const final = !result.transient || exhausted;
    await prisma.whatsAppMessage.update({
      where: { id: msg.id },
      data: final
        ? { status: "FAILED", phone, intendedPhone, attempts: attemptNo, lockedAt: null, nextAttemptAt: null, statusNote: exhausted && result.transient ? `Gave up after ${attemptNo} attempts: ${result.error}` : result.error }
        : { status: "QUEUED", phone, intendedPhone, attempts: attemptNo, lockedAt: null, nextAttemptAt: new Date(Date.now() + BACKOFF_MINUTES[attemptNo - 1] * 60_000), statusNote: result.error },
    });

    // A rejected key or an unreachable server fails every message the same way. Stop and
    // keep the rest for later rather than burning their attempts.
    if (result.status === null || result.status === 401 || result.status === 403) {
      report.sendingPaused = result.error;
      await releaseUnsent(claimed.slice(i + 1));
      return;
    }
  }
}

async function releaseUnsent(rows: Claimed[]) {
  if (rows.length === 0) return;
  await prisma.whatsAppMessage.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: "SENDING" },
    data: { status: "QUEUED", lockedAt: null },
  });
}
