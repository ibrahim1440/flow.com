-- PAYOUT GATE IMPACT AUDIT — read-only. SELECT only; no INSERT, UPDATE, DELETE or DDL.
--
-- What it answers
-- ───────────────
-- Commit 65815ee makes a payout refuse outright for an employee-period whose entitlement
-- cannot be derived. Two Preview periods are refused by it today. Preview residue does not
-- establish Production exposure, so this reports, per employee and Riyadh month:
--
--   movements             every ACCRUAL/REVERSAL in the period
--   unplaced_movements    those carrying no accrualId — nothing can say what they are worth
--   gap_positive          their positive half, at full magnitude
--   gap_negative          their negative half, as a positive magnitude
--   unallocated_reversal  negative movements with nothing applied against them
--   non_derived_accruals  accruals with no positive movement of their own to derive from
--   payouts / paid_total  what has already been paid out of the period
--   would_block           whether 65815ee refuses a payout here
--
-- gap_positive and gap_negative are reported SEPARATELY and never netted. An unattributed
-- +10.00 beside an unattributed -10.00 sums to zero while two movements stay unexplained,
-- which is precisely the reading that would under-report exposure.
--
-- `paid_total` matters most where `would_block` is true: money has already left against a
-- period the new rule says is not derivable, so those are the cases to look at first.
--
-- Riyadh months: periodStart holds the Riyadh month's first moment as a UTC instant in a
-- `timestamp without time zone` column, so a naive to_char reads one month early. The
-- + interval '3 hours' is what puts it back.
--
-- Safe to run anywhere the schema exists, including Production. It writes nothing.

WITH mv AS (
  SELECT
    l.id,
    l."employeeId",
    l."periodStart",
    l.type::text AS t,
    l.amount,
    l."accrualId",
    -- How much of this movement has been applied against earlier ones. Only meaningful
    -- for a negative movement; zero elsewhere.
    COALESCE((SELECT SUM(x.amount) FROM "CommissionLedgerCorrection" x WHERE x."entryId" = l.id), 0) AS allocated_out
  FROM "CommissionLedgerEntry" l
),
acc AS (
  SELECT
    a."employeeId",
    a."periodStart",
    -- An accrual with no positive movement of its own cannot have its current value
    -- derived; only a stored projection exists, and that is what the engine rewrites.
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM "CommissionLedgerEntry" m
         WHERE m."accrualId" = a.id AND m.type = 'ACCRUAL'
      )
    ) AS non_derived_accruals
  FROM "CommissionAccrual" a
  GROUP BY 1, 2
)
SELECT
  m."employeeId",
  to_char(m."periodStart" + interval '3 hours', 'YYYY-MM')                                       AS riyadh_month,
  count(*) FILTER (WHERE m.t IN ('ACCRUAL', 'REVERSAL'))                                          AS movements,
  count(*) FILTER (WHERE m.t IN ('ACCRUAL', 'REVERSAL') AND m."accrualId" IS NULL)                AS unplaced_movements,
  COALESCE(SUM(m.amount) FILTER (
    WHERE m.t IN ('ACCRUAL', 'REVERSAL') AND m."accrualId" IS NULL AND m.amount > 0), 0)::text    AS gap_positive,
  COALESCE(-SUM(m.amount) FILTER (
    WHERE m.t IN ('ACCRUAL', 'REVERSAL') AND m."accrualId" IS NULL AND m.amount < 0), 0)::text    AS gap_negative,
  COALESCE(SUM(GREATEST(0, -m.amount - m.allocated_out)) FILTER (WHERE m.t = 'REVERSAL'), 0)::text AS unallocated_reversal,
  COALESCE(MAX(a.non_derived_accruals), 0)                                                        AS non_derived_accruals,
  count(*) FILTER (WHERE m.t = 'PAYOUT')                                                          AS payouts,
  COALESCE(SUM(m.amount) FILTER (WHERE m.t = 'PAYOUT'), 0)::text                                  AS paid_total,
  (
    count(*) FILTER (WHERE m.t IN ('ACCRUAL', 'REVERSAL') AND m."accrualId" IS NULL) > 0
    OR COALESCE(SUM(GREATEST(0, -m.amount - m.allocated_out)) FILTER (WHERE m.t = 'REVERSAL'), 0) > 0
    OR COALESCE(MAX(a.non_derived_accruals), 0) > 0
  )                                                                                               AS would_block
FROM mv m
LEFT JOIN acc a
  ON a."employeeId" = m."employeeId" AND a."periodStart" = m."periodStart"
GROUP BY m."employeeId", m."periodStart"
ORDER BY would_block DESC, m."employeeId", m."periodStart";
