-- PRODUCTION READINESS AUDIT — read-only. SELECT only. No INSERT, UPDATE, DELETE or DDL.
--
-- For an authorised operator to run against the CONFIRMED Production datasource, in one
-- session, top to bottom. Every query is safe on any schema version: the later sections
-- check for the columns they need rather than assuming them, so nothing errors out
-- half-way and leaves the audit half-answered.
--
-- ── Confirming the datasource first ──
--
-- Steps 0a and 0b describe the connection, they do not prove it is Production. That proof
-- has to come from Production's own configuration and cannot come from inside the
-- database:
--
--   1. Read the HOST from the Vercel Production DATABASE_URL (type Secret; only someone
--      with that access can see it). The hostname alone is enough — the user, password
--      and database name are never needed by anyone else and should not be quoted.
--   2. Map that hostname to its Neon endpoint id, which gives the branch. In project
--      dark-lab-61530722 the two candidates are:
--         ep-jolly-feather-aqne6cp1  ->  branch "production"            (br-fragrant-poetry-aqd0ndyx)
--         ep-dawn-dust-aqn1u1uf      ->  branch "hiqbah-demo-training-20260529" (br-weathered-bread-aqais7hp)
--   3. Connect to THAT endpoint, run 0a, and check the reported host matches the one you
--      just mapped. Only then does the rest of this file describe Production.
--
-- Record the mapping in the release package. Without it every number below is unattributed.
--
-- Note on 0a: Neon routes through a proxy, so `inet_server_addr()` reports the proxy and
-- not the compute endpoint — on the preview database it returns 127.0.0.1/32. It is
-- therefore useless as identification, which is the point: the database cannot tell you
-- which deployment points at it. Only the configuration can. Use 0a to confirm the
-- database NAME and the role you connected as, and take the endpoint identity from the
-- connection you deliberately opened in step 3 above.

-- ═══ 0a. which server am I actually on ════════════════════════════════════════
SELECT
  current_database()                                   AS database,
  current_user                                         AS connected_as,
  inet_server_addr()::text                             AS server_addr,
  split_part(version(), ' on ', 1)                     AS postgres,
  pg_postmaster_start_time()                           AS server_started;

-- ═══ 0b. is this a populated system, or an empty branch ═══════════════════════
SELECT
  (SELECT count(*) FROM "Employee")               AS employees,
  (SELECT count(*) FROM "Employee" WHERE active)  AS active_employees,
  (SELECT count(*) FROM "CommissionLedgerEntry")  AS ledger_entries,
  (SELECT count(*) FROM "CommissionAccrual")      AS accruals,
  (SELECT max("createdAt") FROM "CommissionLedgerEntry") AS newest_movement;

-- ═══ 1. APPLIED MIGRATIONS — before anything assumes a column exists ══════════
-- The release adds two. Both must be ABSENT here before deploying; if either is present
-- the database is already ahead of what this audit assumes and the plan needs revisiting.
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
  FROM _prisma_migrations
 WHERE migration_name IN (
         '20260926190000_commission_movement_provenance',
         '20260927100000_protect_movement_provenance',
         '20260927140000_payout_idempotency',
         '20260927180000_payout_idempotency_global')
 ORDER BY finished_at NULLS LAST;

-- How far along the database is overall, and whether anything failed.
SELECT count(*) AS applied_total,
       count(*) FILTER (WHERE finished_at IS NULL)   AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
       max(migration_name)                            AS latest_by_name
  FROM _prisma_migrations;

-- ═══ 2. SCHEMA SHAPE — what actually exists on CommissionLedgerEntry ══════════
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'CommissionLedgerEntry'
   AND column_name IN ('idempotencyKey','accrualId','collectionEventId','planVersionId',
                       'qualifyingBase','sharePercent','effectiveRatePercent')
 ORDER BY column_name;

-- The indexes the release replaces. Expect NEITHER before deploying. Migration 1 creates
-- the composite one; migration 2 DROPS that composite index and creates the global one in
-- its place — they are not cumulative, and the composite does not survive the release.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'CommissionLedgerEntry'
   AND indexname IN ('CommissionLedgerEntry_employeeId_periodStart_idempotencyKey_key',
                     'CommissionLedgerEntry_idempotencyKey_key');

-- Does the correction table exist at all? Entitlement derivation needs it.
SELECT to_regclass('"CommissionLedgerCorrection"') AS correction_table;

-- ═══ 3. IDEMPOTENCY PRE-FLIGHT — only meaningful once the column exists ═══════
-- Guarded, so it returns a verdict rather than erroring on a schema without the column.
-- Migration 2 creates a UNIQUE index on idempotencyKey alone; it fails if any value is
-- duplicated. NULLs are distinct in Postgres, so keyless rows never conflict.
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'CommissionLedgerEntry' AND column_name = 'idempotencyKey')
    THEN 'NOT APPLICABLE — the column does not exist yet, so no value can be duplicated. '
         'Migration 1 adds it empty. Re-run this section between migration 1 and 2 if you '
         'apply them separately.'
  WHEN (SELECT count(*) FROM (
          SELECT "idempotencyKey" FROM "CommissionLedgerEntry"
           WHERE "idempotencyKey" IS NOT NULL
           GROUP BY 1 HAVING count(*) > 1) d) = 0
    THEN 'PASS — no duplicate keys. Migration 2 can create the unique index.'
  ELSE 'BLOCKED — duplicate idempotencyKey values exist. Migration 2 WILL FAIL. '
       'List them before proceeding.'
END AS idempotency_preflight;

-- ═══ 4. CLIENT COMPATIBILITY — who records payouts, and how ═══════════════════
-- After this release a payout without an idempotencyKey is refused with 400. Anything
-- other than the in-app dialog that writes payouts must be updated first.
SELECT
  count(*)                                                       AS payout_rows_total,
  count(*) FILTER (WHERE "idempotencyKey" IS NULL)               AS payouts_without_key,
  count(DISTINCT "actorId")                                      AS distinct_payout_actors,
  min("createdAt")                                               AS first_payout,
  max("createdAt")                                               AS last_payout
  FROM "CommissionLedgerEntry" WHERE type = 'PAYOUT';

-- Who has the privilege at all. A payout can only arrive from one of these identities.
SELECT id, name, active
  FROM "Employee"
 WHERE (permissions::jsonb -> 'commissions' -> 'sub' ->> 'record_payout') = 'true'
 ORDER BY active DESC, id;

-- ═══ 5. THE IMPACT ITSELF — every affected employee-period ════════════════════
-- All of them. `paid_total` orders the attention, it does not limit the set: a blocked
-- period with no payout is still a period nobody can pay until it is reconciled.
--
-- The two halves of each attribution gap are reported separately and never netted. An
-- unattributed +10.00 beside an unattributed -10.00 sums to zero while two movements stay
-- unexplained, and netting them is exactly the reading that under-reports exposure.
WITH mv AS (
  SELECT l.id, l."employeeId", l."periodStart", l.type::text AS t, l.amount, l."accrualId",
         COALESCE((SELECT SUM(x.amount) FROM "CommissionLedgerCorrection" x
                    WHERE x."entryId" = l.id), 0) AS allocated_out
    FROM "CommissionLedgerEntry" l
),
acc AS (
  SELECT a."employeeId", a."periodStart",
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM "CommissionLedgerEntry" m
            WHERE m."accrualId" = a.id AND m.type = 'ACCRUAL')) AS non_derived_accruals
    FROM "CommissionAccrual" a GROUP BY 1, 2
)
SELECT
  m."employeeId",
  to_char(m."periodStart" + interval '3 hours', 'YYYY-MM')                                        AS riyadh_month,
  count(*) FILTER (WHERE m.t IN ('ACCRUAL','REVERSAL'))                                           AS movements,
  count(*) FILTER (WHERE m.t IN ('ACCRUAL','REVERSAL') AND m."accrualId" IS NULL)                 AS unplaced_movements,
  COALESCE(SUM(m.amount) FILTER (
    WHERE m.t IN ('ACCRUAL','REVERSAL') AND m."accrualId" IS NULL AND m.amount > 0), 0)::text     AS gap_positive,
  COALESCE(-SUM(m.amount) FILTER (
    WHERE m.t IN ('ACCRUAL','REVERSAL') AND m."accrualId" IS NULL AND m.amount < 0), 0)::text     AS gap_negative,
  COALESCE(SUM(GREATEST(0, -m.amount - m.allocated_out)) FILTER (WHERE m.t = 'REVERSAL'), 0)::text AS unallocated_reversal,
  COALESCE(MAX(a.non_derived_accruals), 0)                                                        AS non_derived_accruals,
  count(*) FILTER (WHERE m.t = 'PAYOUT')                                                          AS payouts,
  COALESCE(SUM(m.amount) FILTER (WHERE m.t = 'PAYOUT'), 0)::text                                  AS paid_total,
  (count(*) FILTER (WHERE m.t IN ('ACCRUAL','REVERSAL') AND m."accrualId" IS NULL) > 0
   OR COALESCE(SUM(GREATEST(0, -m.amount - m.allocated_out)) FILTER (WHERE m.t='REVERSAL'), 0) > 0
   OR COALESCE(MAX(a.non_derived_accruals), 0) > 0)                                               AS would_block
FROM mv m
LEFT JOIN acc a ON a."employeeId" = m."employeeId" AND a."periodStart" = m."periodStart"
GROUP BY m."employeeId", m."periodStart"
ORDER BY would_block DESC, (SUM(m.amount) FILTER (WHERE m.t = 'PAYOUT')) DESC NULLS LAST,
         m."employeeId", m."periodStart";

-- ═══ 6. THE ONE-LINE VERDICT ══════════════════════════════════════════════════
WITH mv AS (
  SELECT l."employeeId", l."periodStart", l.type::text AS t, l.amount, l."accrualId",
         COALESCE((SELECT SUM(x.amount) FROM "CommissionLedgerCorrection" x
                    WHERE x."entryId" = l.id), 0) AS allocated_out
    FROM "CommissionLedgerEntry" l
),
acc AS (
  SELECT a."employeeId", a."periodStart",
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM "CommissionLedgerEntry" m
            WHERE m."accrualId" = a.id AND m.type = 'ACCRUAL')) AS nd
    FROM "CommissionAccrual" a GROUP BY 1, 2
),
per AS (
  SELECT m."employeeId", m."periodStart",
         (count(*) FILTER (WHERE m.t IN ('ACCRUAL','REVERSAL') AND m."accrualId" IS NULL) > 0
          OR COALESCE(SUM(GREATEST(0, -m.amount - m.allocated_out)) FILTER (WHERE m.t='REVERSAL'),0) > 0
          OR COALESCE(MAX(a.nd), 0) > 0) AS blocked,
         COALESCE(SUM(m.amount) FILTER (WHERE m.t = 'PAYOUT'), 0) AS paid
    FROM mv m LEFT JOIN acc a
      ON a."employeeId" = m."employeeId" AND a."periodStart" = m."periodStart"
   GROUP BY 1, 2
)
SELECT count(*)                                                    AS periods_total,
       count(*) FILTER (WHERE blocked)                             AS periods_blocked,
       count(*) FILTER (WHERE blocked AND paid <> 0)               AS blocked_with_payouts,
       COALESCE(SUM(paid) FILTER (WHERE blocked), 0)::text         AS paid_against_blocked
  FROM per;
