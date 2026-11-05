// The customer duplicate check itself (see duplicates.ts) with the database handle passed in — no Prisma client import, so
// a module that can reach a client bundle (services/sales/leads.ts, through qualification.ts) may call it inside its own
// transaction without dragging the database driver into the browser build.
import type { Prisma } from "@/generated/prisma/client";
import { normaliseCustomerName } from "./customer-identity";

export type Db = Pick<Prisma.TransactionClient, "$queryRaw">;
export type DuplicateBy = "vatNumber" | "commercialRegNo" | "unifiedNumber" | "name";
export type DuplicateProbe = { name?: string | null; nameAr?: string | null; vatNumber?: string | null; commercialRegNo?: string | null; unifiedNumber?: string | null };

/** The first other customer matching the probe, and on what — or null. `excludeId`: the customer being edited. */
export async function findDuplicateCustomerIn(db: Db, probe: DuplicateProbe, opts: { excludeId?: string | null } = {}): Promise<{ id: string; name: string; by: DuplicateBy } | null> {
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
                WHEN ${cr}::text IS NOT NULL AND (c."commercialRegNo" = ${cr} OR c."unifiedNumber" = ${cr}) THEN 'commercialRegNo'
                WHEN ${uni}::text IS NOT NULL AND (c."unifiedNumber" = ${uni} OR c."commercialRegNo" = ${uni}) THEN 'unifiedNumber'
                ELSE 'name' END AS by
      FROM c
     WHERE (${vat}::text IS NOT NULL AND c."vatNumber" = ${vat})
        -- One «السجل التجاري / الرقم الموحد» field (5 Nov 2026): a number is compared against BOTH columns, so a CR
        -- kept in the unified slot (or the reverse) still collides.
        OR (${cr}::text IS NOT NULL AND (c."commercialRegNo" = ${cr} OR c."unifiedNumber" = ${cr}))
        OR (${uni}::text IS NOT NULL AND (c."unifiedNumber" = ${uni} OR c."commercialRegNo" = ${uni}))
        OR (${n1}::text IS NOT NULL AND (c.n = ${n1} OR c.nar = ${n1}))
        OR (${n2}::text IS NOT NULL AND (c.n = ${n2} OR c.nar = ${n2}))
     LIMIT 1`;
  return rows[0] ?? null;
}
