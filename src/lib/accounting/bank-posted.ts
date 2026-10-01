// Whether bank lines have posted to the ledger (same rule as the database guard
// acc_bank_txn_posted: the journal of the line's confirmed event, or of its transfer peer's,
// exists). Used by Finance to refuse changes with a clear message before the guard would.
import type { Prisma } from "@/generated/prisma/client";

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

export const POSTED_BANK_LINE_MESSAGE =
  "This bank line has posted to the ledger, so its amount, date, account, classification, splits and matches can no longer be changed here. Request a correction in Accounting → Bank.";

export async function postedBankLines(db: Db, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of new Set(ids)) {
    const r = await db.$queryRaw<{ p: boolean }[]>`SELECT acc_bank_txn_posted(${id}) AS p`;
    if (r[0]?.p) out.add(id);
  }
  return out;
}
