// Year-end close → CLOSING journal entry (stage 5). Built from the approved snapshot: each revenue
// and expense balance of the year (per account, branch and cost centre) is reversed and the net goes
// to the RETAINED_EARNINGS role. The reopening entry is the same, reversed, also CLOSING-typed so the
// income statement (which excludes closing entries) stays right.
import type { Prisma } from "@/generated/prisma/client";
import { ZERO, dec } from "../money";
import type { EngineLine } from "../posting";
import type { CloseLine } from "../year-end-service";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };

export async function translateYearEnd(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  const { closeId } = ev.payload as { closeId: string };
  const c = await tx.yearEndClose.findUnique({ where: { id: closeId } });
  if (!c || c.status === "DRAFT" || c.status === "CANCELLED") return { skip: "The close has not been approved." };
  const reopen = ev.eventType === "gl.year.reopened";
  const label = `${reopen ? "Year-end close reversed" : "Year-end close"} ${c.year}`;
  const lines: EngineLine[] = [];
  let total = ZERO;
  for (const l of c.snapshot as unknown as CloseLine[]) {
    const net = dec(l.net); // debit-positive balance of the year
    total = total.add(net);
    const closing = net.neg();
    const dims = { branchId: l.branchId, costCenterId: l.costCenterId };
    lines.push(closing.isPositive() ? { accountId: l.accountId, debit: closing, description: label, ...dims } : { accountId: l.accountId, credit: closing.abs(), description: label, ...dims });
  }
  if (!total.isZero()) lines.push(total.isPositive() ? { role: "RETAINED_EARNINGS", debit: total, description: `${label} · net loss` } : { role: "RETAINED_EARNINGS", credit: total.abs(), description: `${label} · net income` });
  const out = reopen ? lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) : lines;
  if (out.length < 2) return { skip: "Nothing to close." };
  return { entryDate: c.yearEnd, description: label, sourceModule: "closing", sourceDocumentId: c.id, lines: out, alsoUnapproved: [], entryType: "CLOSING" };
}
