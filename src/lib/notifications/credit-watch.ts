// «تجاوز حد الائتمان» / «متأخر في السداد» — notified ONCE PER CHANGE, never daily (feat/notifications).
//
// A customer's standing is derived, not stored (loadCreditFlags: the same statement and aging as the
// customer file), and «overdue» starts with the passing of time — there is no job. So the standing is
// compared with the last one notified (NotificationWatch «credit:<customerId>») whenever it is
// computed anyway or may have changed:
//   * after the response of an accepted quotation, an approved / reversed collection, a delivery;
//   * when the customer file or the customer list (credit badges) is read.
// A condition that APPEARS (OVER_LIMIT, OVERDUE) is notified to the finance approvers
// (commissions › collection_verify) and the holders of customers › sales_hold (scoped reps only for
// their own customers). A condition that clears updates the watch silently, so a later relapse is
// news again. The watch row is claimed with a conditional write: concurrent readers notify once.
// Never throws — a failed check is retried by the next read.
import { after } from "next/server";
import { loadCreditFlags } from "@/lib/services/customers/credit-db";
import { notify } from "./notify";

/** "OVER_LIMIT,OVERDUE" — the conditions in force, sorted. Pure. */
export function standingKey(f: { overLimit: boolean; overdueDays: number }): string {
  return [f.overLimit ? "OVER_LIMIT" : null, f.overdueDays > 0 ? "OVERDUE" : null].filter(Boolean).join(",");
}
/** The conditions present now and absent before. Pure. */
export function newConditions(before: string | null, now: string): string[] {
  const had = new Set((before ?? "").split(",").filter(Boolean));
  return now.split(",").filter((x) => x && !had.has(x));
}

export async function checkCreditStanding(customerIds: string[], now = new Date()): Promise<number> {
  const ids = [...new Set(customerIds.filter(Boolean))].slice(0, 200);
  if (ids.length === 0) return 0;
  let sent = 0;
  try {
    const { prisma } = await import("@/lib/db");
    const flags = await prisma.$transaction((tx) => loadCreditFlags(tx, ids, now));
    const watches = await prisma.notificationWatch.findMany({ where: { key: { in: ids.map((id) => `credit:${id}`) } } });
    const before = new Map(watches.map((w) => [w.key, w.state]));
    for (const [customerId, f] of flags) {
      const key = `credit:${customerId}`;
      const state = standingKey(f);
      const prev = before.has(key) ? before.get(key)! : null;
      if ((prev ?? "") === state) continue;
      // Claim the change: only the writer that moved the watch from `prev` notifies.
      let claimed = false;
      if (prev === null) {
        claimed = await prisma.notificationWatch.create({ data: { key, state } }).then(() => true, () => false);
      } else {
        claimed = (await prisma.notificationWatch.updateMany({ where: { key, state: prev }, data: { state } })).count === 1;
      }
      if (!claimed || newConditions(prev, state).length === 0) continue;
      const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true, nameAr: true, accountOwnerId: true } });
      if (!c) continue;
      const r = await notify(prisma, {
        event: "finance.credit_alert", dedupeKey: `${customerId}:${state}:${now.toISOString().slice(0, 10)}`,
        entity: { type: "Customer", id: customerId },
        facts: { customerName: c.nameAr || c.name, customerId, overLimit: f.overLimit ? "yes" : "no", overdueDays: f.overdueDays },
        scopeOwners: [c.accountOwnerId],
      });
      sent += r.inserted;
    }
  } catch (e) {
    console.error("[notifications] credit standing check failed:", (e as Error)?.name ?? "error");
  }
  return sent;
}

/** The same, after the current response (outside a request: at once, awaited by nobody). */
export function checkCreditStandingLater(customerIds: (string | null | undefined)[]): void {
  const ids = customerIds.filter((x): x is string => !!x);
  if (ids.length === 0) return;
  try {
    after(() => checkCreditStanding(ids).then(() => undefined));
  } catch {
    void checkCreditStanding(ids);
  }
}
