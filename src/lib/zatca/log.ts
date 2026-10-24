// ZATCA Phase 2 (A4) — the Fatoora log (ZatcaLog, append-only in the database): every request to ZATCA and its
// answer, and the owner's e-invoicing decisions. What is written is already redacted (./fatoora redact): no OTP,
// no token, no secret, no key, no CSR, no invoice body (the signed / cleared bytes live in ZatcaDocument).
import type { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/db";

type Db = Prisma.TransactionClient | typeof prisma;

export type LogInput = {
  egsId?: string | null; documentId?: string | null; action: string; environment: string; method: string; endpoint: string;
  httpStatus?: number | null; outcome: string; durationMs?: number | null; attempt?: number | null;
  request?: Record<string, unknown> | null; response?: Record<string, unknown> | null; actorId?: string | null;
};

const json = (v: Record<string, unknown> | null | undefined) => (v ? (v as Prisma.InputJsonValue) : undefined);

export async function writeLog(db: Db, l: LogInput): Promise<void> {
  try {
    await db.zatcaLog.create({
      data: {
        egsId: l.egsId ?? null, documentId: l.documentId ?? null, action: l.action, environment: l.environment, method: l.method,
        endpoint: l.endpoint.slice(0, 300), httpStatus: l.httpStatus ?? null, outcome: l.outcome.slice(0, 60), durationMs: l.durationMs ?? null,
        attempt: l.attempt ?? null, request: json(l.request), response: json(l.response), actorId: l.actorId ?? null,
      },
    });
  } catch (e) {
    // The log never decides the outcome; a failure to write it is reported, not thrown.
    console.error("[zatca] log not written:", (e as Error)?.message?.slice(0, 200));
  }
}
