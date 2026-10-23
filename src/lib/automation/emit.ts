/**
 * Raising an automation event — the one call every hook point makes.
 *
 * ── Same transaction, never inline ──
 * Call this with the transaction client of the change it describes. The event row then exists
 * exactly when the change committed: a refused delivery rolls its event back with it, and a
 * committed one cannot lose its event to a crash between two writes. Nothing is sent here.
 * The dispatcher runs after the response has gone (Next's `after`), so the WhatsApp server
 * being slow, down or misconfigured can never fail or delay the operation that raised it.
 *
 * ── Free when unused ──
 * The insert is a round trip inside a transaction that is already paying ~170 ms per
 * statement to a remote database. So an event no active rule listens to is not written at
 * all. Which events are listened to is cached per server instance for CACHE_MS; a rule saved
 * on another instance takes at most that long to start hearing events here.
 *
 * This module must stay importable outside a request (finance services are tested under
 * plain Node): the dispatcher is loaded lazily, and `after` outside a request is swallowed —
 * the scheduled dispatch picks the event up instead.
 */
import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { eventTypesOfSources } from "./status-rules/sources";
import { NOTIFIED_AUTOMATION_EVENTS, notifyFromAutomationEvent } from "@/lib/notifications/from-automation";

type Tx = Prisma.TransactionClient;

export type AutomationEventInput = {
  eventType: string;
  subjectType: string;
  subjectId: string;
  /** Only the facts of the moment. Names and phones are read when the event is processed. */
  payload?: Prisma.InputJsonObject;
  actorId?: string | null;
};

const CACHE_MS = 30_000;
let cache: { at: number; types: Set<string> } | null = null;

async function listenedEventTypes(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.types;
  const rows = await prisma.automationRule.findMany({
    where: { isActive: true },
    select: { eventType: true },
    distinct: ["eventType"],
  });
  const types = new Set(rows.map((r) => r.eventType));
  // «إشعارات الحالات»: a switched-on status rule listens to its source's events. Read apart, so
  // a database without the status table yet (before 20261022100000) behaves exactly as before.
  const statusSources = await prisma.whatsAppStatusRule
    .findMany({ where: { enabled: true, active: true }, select: { source: true }, distinct: ["source"] })
    .catch(() => [] as { source: string }[]);
  for (const t of eventTypesOfSources(statusSources.map((r) => r.source))) types.add(t);
  cache = { at: Date.now(), types };
  return cache.types;
}

/**
 * Whether any active rule listens to this event. For a hook point that would have to read
 * something extra just to describe its event: ask first, and pay nothing when nobody listens.
 */
export async function automationListens(eventType: string): Promise<boolean> {
  // feat/notifications: an event the in-app notifications cover is always "heard" — the hook point
  // must describe it even when no WhatsApp rule listens.
  if (NOTIFIED_AUTOMATION_EVENTS.has(eventType)) return true;
  try {
    return (await listenedEventTypes()).has(eventType);
  } catch {
    return true;
  }
}

/** Called after a rule is saved, so this instance hears the change at once. */
export function invalidateAutomationCache(): void {
  cache = null;
}

export async function emitAutomationEvent(tx: Tx, input: AutomationEventInput): Promise<void> {
  // feat/notifications: the in-app notifications of this event, in the same transaction, whether or
  // not any automation rule listens (lib/notifications/from-automation.ts; no read for other events).
  await notifyFromAutomationEvent(tx, input);
  let listened: Set<string>;
  try {
    listened = await listenedEventTypes();
  } catch {
    // Not knowing is not a reason to fail the business operation, nor to drop the event.
    listened = new Set([input.eventType]);
  }
  if (!listened.has(input.eventType)) return;

  await tx.automationEvent.create({
    data: {
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: input.payload ?? {},
      actorId: input.actorId ?? null,
    },
  });
  requestAutomationDispatch();
}

/** Run the dispatcher once the current response has been sent. Outside a request, a no-op. */
export function requestAutomationDispatch(): void {
  try {
    after(async () => {
      const { runAutomationDispatch } = await import("./dispatcher");
      await runAutomationDispatch({ budgetMs: 8_000, maxSends: 5 });
    });
  } catch {
    // Outside a request scope (a script, a test). The scheduled dispatch will process it.
  }
}
