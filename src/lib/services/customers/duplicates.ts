// Round 3 (gate M1): one duplicate check for every path that creates a customer or changes its «مسلّمات» — the rep's
// registration and the customers editors' create (POST /api/customers), the VAT / CR / unified-number edit (PUT
// /api/customers/[id]), and the accountant's create and edit (accounting-customers.ts). A match on the VAT number, the
// CR number, the unified number, or the exact normalised name (name or Arabic name) of ANY other customer — the
// unassigned pool and other reps' customers included (customers are never soft-deleted) — is refused. The caller words
// the refusal (DUPLICATE_CUSTOMER never names the customer or its owner to a rep).
import { prisma } from "@/lib/db";
import { findDuplicateCustomerIn, type Db, type DuplicateBy, type DuplicateProbe } from "./duplicates-core";

export type { DuplicateBy, DuplicateProbe };

/** The first other customer matching the probe, and on what — or null. `excludeId`: the customer being edited. */
export async function findDuplicateCustomer(probe: DuplicateProbe, opts: { excludeId?: string | null; db?: Db } = {}): Promise<{ id: string; name: string; by: DuplicateBy } | null> {
  return findDuplicateCustomerIn(opts.db ?? prisma, probe, { excludeId: opts.excludeId });
}
