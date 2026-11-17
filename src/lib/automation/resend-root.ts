// R1-e (gate M1): the FIRST message of a resend chain. A resend is a new row pointing at the message it replaces
// (resendOfMessageId, UNIQUE); a resend of a resend points at the resend. The window of every link is measured from the
// root's first attempt, so following the chain back is what keeps «a review never restarts the window» true for chains.
import type { Prisma } from "@/generated/prisma/client";

export type MessageTable = "WhatsAppMessage" | "EmailMessage" | "MktMessage";
const TABLES: readonly MessageTable[] = ["WhatsAppMessage", "EmailMessage", "MktMessage"];
/** Far above any real chain (one resend per message, each after a review); a cycle is impossible (FK + not-self). */
const MAX_DEPTH = 50;

/** The root id of `id`'s resend chain (itself when it is not a resend); null when the row or a link is missing. */
export async function rootMessageId(db: Pick<Prisma.TransactionClient, "$queryRawUnsafe">, table: MessageTable, id: string): Promise<string | null> {
  if (!TABLES.includes(table)) throw new Error("unknown message table");
  const rows = await db.$queryRawUnsafe<{ id: string; parent: string | null }[]>(
    `WITH RECURSIVE c AS (
       SELECT id, "resendOfMessageId" AS parent, 0 AS depth FROM "${table}" WHERE id = $1
       UNION ALL
       SELECT p.id, p."resendOfMessageId", c.depth + 1 FROM "${table}" p JOIN c ON p.id = c.parent WHERE c.depth < ${MAX_DEPTH}
     ) SELECT id, parent FROM c ORDER BY depth DESC LIMIT 1`, id);
  const top = rows[0];
  return top && top.parent === null ? top.id : null;
}
