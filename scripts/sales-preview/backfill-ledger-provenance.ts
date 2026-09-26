/**
 * Link historical commission movements to their accrual — but only where the link is
 * provable, and never by resemblance.
 *
 * New movements carry their own provenance from the moment they are written. Movements
 * that predate that do not, and most of them cannot be recovered: a period holding five
 * accruals and nine movements has no structural evidence of which belongs to which, and
 * matching on amount or timestamp would manufacture an audit trail rather than restore
 * one. So this fills in exactly one case —
 *
 *   an (employee, period) that holds EXACTLY ONE accrual row has exactly one candidate,
 *
 * — and reports everything else as ambiguous, permanently.
 *
 * Even then it copies only the three STABLE identities: the accrual, its collection event
 * and its plan version. It does NOT copy `qualifyingBase`, `sharePercent` or
 * `effectiveRatePercent`, because the accrual is a mutable projection and its present
 * values are not evidence of what the movement was computed on months ago. Those stay null
 * on historical rows, which is honest, where a plausible number would not be.
 *
 * Reversal targets are not backfilled at all: proving which movement a historical negative
 * compensates needs the event attribution that these rows lack.
 *
 *   PREVIEW_ENV=<app env file> npx tsx scripts/sales-preview/backfill-ledger-provenance.ts [--apply]
 */
import { Client } from "pg";
import { PreviewRefusal, loadPreviewEnv } from "./preview-guard";

type Row = {
  id: string;
  type: string;
  employeeId: string;
  period: string;
  amount: string;
  accrualId: string | null;
  candidates: number;
  accrual_id: string | null;
  event_id: string | null;
  plan_id: string | null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const { url } = loadPreviewEnv();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<Row>(`
      SELECT l.id, l.type::text, l."employeeId", l."periodStart"::text AS period,
             l.amount::text, l."accrualId",
             cand.n::int AS candidates,
             cand.accrual_id, cand.event_id, cand.plan_id
        FROM "CommissionLedgerEntry" l
        JOIN LATERAL (
          SELECT count(*) AS n,
                 min(a.id)                  AS accrual_id,
                 min(a."collectionEventId") AS event_id,
                 min(a."planVersionId")     AS plan_id
            FROM "CommissionAccrual" a
           WHERE a."employeeId" = l."employeeId"
             AND a."periodStart" = l."periodStart"
        ) cand ON TRUE
       WHERE l."accrualId" IS NULL
       ORDER BY l."employeeId", l."periodStart", l."createdAt"
    `);

    const provable: Row[] = [];
    const ambiguous: Row[] = [];
    const notEngine: Row[] = [];

    for (const r of rows) {
      if (r.type !== "ACCRUAL" && r.type !== "REVERSAL") notEngine.push(r);
      else if (r.candidates === 1 && r.accrual_id) provable.push(r);
      else ambiguous.push(r);
    }

    console.log(`\n  ${rows.length} movements carry no provenance.\n`);

    console.log(`  PROVABLE — one accrual in the (employee, period), so one candidate: ${provable.length}`);
    for (const r of provable) {
      console.log(`    ${r.employeeId.padEnd(18)} ${r.period.slice(0, 10)} ${r.type.padEnd(9)} ${r.amount.padStart(9)}  →  accrual ${r.accrual_id!.slice(0, 12)}`);
    }

    console.log(`\n  AMBIGUOUS — left null on purpose: ${ambiguous.length}`);
    const byKey = new Map<string, { n: number; cands: number }>();
    for (const r of ambiguous) {
      const k = `${r.employeeId} ${r.period.slice(0, 10)}`;
      const e = byKey.get(k) ?? { n: 0, cands: r.candidates };
      e.n++;
      byKey.set(k, e);
    }
    for (const [k, v] of byKey) {
      console.log(`    ${k}  ${v.n} movements against ${v.cands} accruals — no structural evidence of which is which`);
    }

    console.log(`\n  NOT ENGINE MOVEMENTS — an adjustment or a payout has no accrual behind it: ${notEngine.length}`);
    for (const r of notEngine) {
      console.log(`    ${r.employeeId.padEnd(18)} ${r.period.slice(0, 10)} ${r.type.padEnd(9)} ${r.amount.padStart(9)}`);
    }

    console.log("\n  Reversal targets: not backfilled for any historical row. Proving which");
    console.log("  movement a negative compensates needs the event attribution these rows lack.\n");

    if (!apply) {
      console.log("  Dry run. Re-run with --apply to write the provable links.\n");
      return;
    }

    let written = 0;
    for (const r of provable) {
      const res = await client.query(
        `UPDATE "CommissionLedgerEntry"
            SET "accrualId" = $2,
                "collectionEventId" = COALESCE("collectionEventId", $3),
                "planVersionId"     = COALESCE("planVersionId", $4)
          WHERE id = $1 AND "accrualId" IS NULL`,
        [r.id, r.accrual_id, r.event_id, r.plan_id],
      );
      written += res.rowCount ?? 0;
    }
    console.log(`  Wrote ${written} provable links. ${ambiguous.length} left null, permanently.\n`);
  } finally {
    await client.end();
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    if (e instanceof PreviewRefusal) {
      console.error(e.message);
      process.exit(3);
    }
    console.error(e);
    process.exit(1);
  });
}
