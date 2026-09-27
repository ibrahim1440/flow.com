// The posting gate. An automatic posting that depends on a policy needs that policy's
// APPROVED version (and whatever else the translator says must be approved, e.g. the
// commission plan version). Without it the event is BLOCKED — except in an isolated test
// database, where it may post labelled provisional so the whole flow can be exercised.
// Two independent conditions make a database "isolated test": the operator sets
// ACCOUNTING_PROVISIONAL_POSTING=isolated-test, and the database itself carries the
// disposable marker. A database trigger re-checks the marker on every provisional entry.
import type { Prisma } from "@/generated/prisma/client";
import { PostingBlocked } from "./errors";

type Tx = Prisma.TransactionClient;

export async function isDisposableDatabase(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT acc_is_disposable_db() AS ok`;
  return r[0]?.ok === true;
}

export async function provisionalPostingAllowed(tx: Tx): Promise<boolean> {
  if (process.env.ACCOUNTING_PROVISIONAL_POSTING !== "isolated-test") return false;
  return isDisposableDatabase(tx);
}

export type PostingMode = { provisional: boolean; policyKey: string; policyVersion: number | null; reasons: string[] };

export async function resolvePostingMode(tx: Tx, policyKey: string, alsoUnapproved: string[] = []): Promise<PostingMode> {
  const policy = await tx.accountingPolicy.findFirst({ where: { key: policyKey, status: "APPROVED" } });
  const reasons = [...(policy ? [] : [`policy "${policyKey}" has no approved version`]), ...alsoUnapproved];
  if (reasons.length === 0) return { provisional: false, policyKey, policyVersion: policy!.version, reasons };
  if (await provisionalPostingAllowed(tx)) {
    return { provisional: true, policyKey, policyVersion: policy?.version ?? null, reasons };
  }
  throw new PostingBlocked(`Waiting for approval: ${reasons.join("; ")}.`, { reasons });
}
