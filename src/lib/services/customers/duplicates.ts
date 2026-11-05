// Round 3 (gate M1): one duplicate check for every path that creates a customer or changes its «مسلّمات» — the rep's
// registration and the customers editors' create (POST /api/customers), the VAT / CR / unified-number edit (PUT
// /api/customers/[id]), and the accountant's create and edit (accounting-customers.ts). A match on the VAT number, the
// CR number, the unified number, or the exact normalised name (name or Arabic name) of ANY other customer — the
// unassigned pool and other reps' customers included (customers are never soft-deleted) — is refused. The caller words
// the refusal (DUPLICATE_CUSTOMER never names the customer or its owner to a rep).
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { normaliseCustomerName } from "./customer-identity";

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;
export type DuplicateBy = "vatNumber" | "commercialRegNo" | "unifiedNumber" | "name";
export type DuplicateProbe = { name?: string | null; nameAr?: string | null; vatNumber?: string | null; commercialRegNo?: string | null; unifiedNumber?: string | null };

/** The first other customer matching the probe, and on what — or null. `excludeId`: the customer being edited. */
export async function findDuplicateCustomer(probe: DuplicateProbe, opts: { excludeId?: string | null; db?: Db } = {}): Promise<{ id: string; name: string; by: DuplicateBy } | null> {
  const db = opts.db ?? prisma;
  const vat = probe.vatNumber || null, cr = probe.commercialRegNo || null, uni = probe.unifiedNumber || null;
  const names = [...new Set([normaliseCustomerName(probe.name), normaliseCustomerName(probe.nameAr)].filter((x): x is string => !!x))];
  if (!vat && !cr && !uni && names.length === 0) return null;
  const n1 = names[0] ?? null, n2 = names[1] ?? null;
  const exclude = opts.excludeId ?? "";
  // The SQL normalisation mirrors normaliseCustomerName (Arabic-Indic digits, tatweel, whitespace, case).
  const rows = await db.$queryRaw<{ id: string; name: string; by: DuplicateBy }[]>`
    WITH c AS (
      SELECT c."id", c."name", c."vatNumber", c."commercialRegNo", c."unifiedNumber",
             lower(btrim(regexp_replace(replace(translate(c."name", '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), 'ـ', ''), '[[:space:]]+', ' ', 'g'))) AS n,
             lower(btrim(regexp_replace(replace(translate(coalesce(c."nameAr", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), 'ـ', ''), '[[:space:]]+', ' ', 'g'))) AS nar
        FROM "Customer" c WHERE c."id" <> ${exclude}
    )
    SELECT c."id", c."name",
           CASE WHEN ${vat}::text IS NOT NULL AND c."vatNumber" = ${vat} THEN 'vatNumber'
                WHEN ${cr}::text IS NOT NULL AND c."commercialRegNo" = ${cr} THEN 'commercialRegNo'
                WHEN ${uni}::text IS NOT NULL AND c."unifiedNumber" = ${uni} THEN 'unifiedNumber'
                ELSE 'name' END AS by
      FROM c
     WHERE (${vat}::text IS NOT NULL AND c."vatNumber" = ${vat})
        OR (${cr}::text IS NOT NULL AND c."commercialRegNo" = ${cr})
        OR (${uni}::text IS NOT NULL AND c."unifiedNumber" = ${uni})
        OR (${n1}::text IS NOT NULL AND (c.n = ${n1} OR c.nar = ${n1}))
        OR (${n2}::text IS NOT NULL AND (c.n = ${n2} OR c.nar = ${n2}))
     LIMIT 1`;
  return rows[0] ?? null;
}
