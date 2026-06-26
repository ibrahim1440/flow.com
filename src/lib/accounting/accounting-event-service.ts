import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export type EmitAccountingEventInput = {
  eventType: string;
  sourceModule: string;
  sourceDocumentId: string;
  // The source's own event/version identifier. Combined with the fields below to form the
  // idempotency key, so a single source document can emit many distinct events safely.
  sourceEventId: string;
  occurredAt?: Date;
  payload: Prisma.InputJsonValue;
};

type Client = Prisma.TransactionClient | typeof prisma;

// Outbox-pattern primitive (spec R1): must be called inside the SAME transaction as the
// operational write it accounts for, by passing that transaction's client as `tx`.
// No operational module calls this yet in S0 — it exists for future modules to adopt.
export async function emitAccountingEvent(input: EmitAccountingEventInput, tx: Client = prisma) {
  const idempotencyKey = [input.sourceModule, input.sourceDocumentId, input.eventType, input.sourceEventId].join(":");
  return tx.accountingEvent.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      eventType: input.eventType,
      sourceModule: input.sourceModule,
      sourceDocumentId: input.sourceDocumentId,
      sourceEventId: input.sourceEventId,
      idempotencyKey,
      occurredAt: input.occurredAt ?? new Date(),
      payload: input.payload,
      status: "PENDING",
    },
  });
}
