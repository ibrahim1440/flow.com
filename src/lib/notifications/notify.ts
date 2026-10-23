// Writing notifications (feat/notifications).
//
// `notify(db, …)` resolves the recipients of one catalogue event and inserts one row each. Call it
// with the TRANSACTION CLIENT of the change it describes: the rows then exist exactly when the
// change committed (a refused change leaves no notification behind). It costs two statements — the
// recipients read and one INSERT … ON CONFLICT DO NOTHING (the unique (recipient, dedupeKey) is the
// idempotency: the same event replayed, retried or raised twice never adds a second row).
//
// E-mail is never sent here: a row whose e-mail is due is written PENDING and the delivery runs after
// the response (Next's `after`; lib/notifications/deliver.ts), so a slow or failing mail provider can
// never delay or fail the business change. With no provider configured the row says NOT_CONFIGURED.
//
// Importable outside a request (scripts, tests): `after` outside a request is swallowed, and the
// next delivery run (any request that polls the bell, or the automation dispatch) sends what waits.
import { after } from "next/server";
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { emailConfigured } from "@/lib/notify/email";
import { eventDef, type Facts } from "./catalog";
import { loadCandidates, selectRecipients, type People } from "./recipients";

type Db = PrismaClient | PrismaNS.TransactionClient;

export type NotifyInput = {
  event: string;
  /** The event instance (an id, plus whatever makes a repeat a NEW event — a status, a revision). */
  dedupeKey: string;
  actorId?: string | null;
  facts?: Facts;
  people?: People;
  /** For `scope: "customer"` events: the customer's account owner and / or the deal owner. */
  scopeOwners?: (string | null | undefined)[];
  entity?: { type: string; id: string } | null;
};

function emailChannelOn(): boolean {
  return emailConfigured();
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Insert the notification rows of one event: the recipients chosen, and how many rows were new. */
export async function notify(db: Db, input: NotifyInput): Promise<{ recipients: string[]; inserted: number; dedupeKey: string }> {
  const def = eventDef(input.event);
  if (!def) throw new Error(`notify: unknown event ${input.event}`);
  const people = input.people ?? {};
  const candidates = await loadCandidates(db, def, people);
  const recipients = selectRecipients(def, { actorId: input.actorId, people, scopeOwners: input.scopeOwners }, candidates);
  const dedupeKey = clip(`${def.key}:${input.dedupeKey}`, 300);
  if (recipients.length === 0) return { recipients, inserted: 0, dedupeKey };
  const r = def.render(input.facts ?? {});
  const email = emailChannelOn() ? "PENDING" : "NOT_CONFIGURED";
  const res = await db.notification.createMany({
    data: recipients.map((recipientId) => ({
      recipientId, kind: def.key, category: def.category, severity: r.severity ?? def.severity,
      titleAr: clip(r.titleAr || def.label.ar, 300), titleEn: clip(r.titleEn || def.label.en, 300),
      bodyAr: clip(r.bodyAr, 2000), bodyEn: clip(r.bodyEn, 2000),
      link: r.link && r.link.startsWith("/dashboard") ? clip(r.link, 500) : null,
      entityType: input.entity?.type ?? null, entityId: input.entity?.id ?? null,
      actorId: input.actorId ?? null, dedupeKey, emailState: email,
    })),
    skipDuplicates: true,
  });
  if (res.count > 0 && email === "PENDING") requestNotificationDelivery();
  return { recipients, inserted: res.count, dedupeKey };
}

/** Run the e-mail delivery once the current response has been sent. Outside a request, a no-op. */
export function requestNotificationDelivery(): void {
  try {
    after(async () => {
      const { deliverPendingEmails } = await import("./deliver");
      await deliverPendingEmails({ limit: 50 });
    });
  } catch {
    // Outside a request scope: the next run picks the rows up.
  }
}
