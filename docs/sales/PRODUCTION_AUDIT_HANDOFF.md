# Production audit — operator handoff

**Read-only. Nothing in this document writes to Production.** No migration, no backup, no
freeze, no deployment. Those all wait on the release approval, which waits on this.

**File to run:** `scripts/sales-preview/production-readiness-audit.sql`
*(it lives under `sales-preview/` with the other operational SQL; it is not preview-specific
and is safe on any schema version — later sections check for the columns they need rather
than assuming them)*

---

## 1. Confirm the datasource first

The database cannot identify itself. Neon routes through a proxy, so `inet_server_addr()`
returns the proxy address — on the preview database it reports `127.0.0.1/32`. Nothing you
can SELECT proves you are on Production. The mapping has to come from Production's own
configuration:

1. **Read the HOST from the Vercel Production `DATABASE_URL`.** It is stored as type
   Secret, so only someone with that access can see it. **You need the hostname only** —
   `ep-<something>.c-8.us-east-1.aws.neon.tech`. The user, password and database name are
   not needed by anyone and should not be written down or pasted anywhere.
2. **Map the hostname to its Neon endpoint, which gives the branch.** In project
   `dark-lab-61530722` there are two plausible candidates and they must not be guessed
   between:

   | endpoint | branch | note |
   | --- | --- | --- |
   | `ep-jolly-feather-aqne6cp1` | `production` (`br-fragrant-poetry-aqd0ndyx`) | named "production"; compute idle since 17 Sep |
   | `ep-dawn-dust-aqn1u1uf` | `hiqbah-demo-training-20260529` (`br-weathered-bread-aqais7hp`) | compute active; parent of today's pre-release backup branch |

   The name of a branch is not evidence of what serves traffic. Only the host in the
   Production configuration is.
3. **Connect to that endpoint** and run section 0a. Check the reported `database` and
   `connected_as` match what you expect for Production, and that you opened the connection
   against the endpoint you just mapped.

Record the mapping. Without it, every number the audit returns is unattributed.

---

## 2. Run the file top to bottom, in one session

| section | what it answers |
| --- | --- |
| 0a / 0b | which database, which role, is it populated |
| 1 | are the four commission migrations applied |
| **1b** | **any unfinished or rolled-back migration, named** |
| 2 | do the columns and indexes exist yet |
| 3 | idempotency pre-flight, guarded — plus the duplicates themselves if any |
| 4 | who can record payouts, who has, anything with no valid actor |
| 5 | **every affected employee-period** |
| 6 | the one-line verdict |

Section 5b is for **after** deployment and needs the timestamp of this run pasted in. Note
that timestamp now.

**Do not repair anything.** If section 1b returns rows, report them. `prisma migrate
resolve` would overwrite the evidence, and an unfinished row may be harmless residue or a
partially-applied schema change — the two look identical from the database and only
whoever ran it can tell them apart.

---

## 3. What to send back

All of it is non-secret. No connection string, credential or personal data is involved.

1. **The datasource mapping** — hostname (or just the endpoint id), branch name, branch id.
2. **Section 0a and 0b** verbatim.
3. **Section 1 and 1b in full** — including any failure rows, with their `logs` head.
4. **Section 2** — which of the two indexes exist, if either.
5. **Section 3** — the verdict line, and the duplicate rows if it reports BLOCKED.
6. **Section 4 in full** — the privilege holders and their payout counts, and any payout
   with a missing or unknown actor.
7. **Section 5 in full** — *every* row, not only `would_block = true`, and not only the
   ones with payouts. A blocked period with no payout is still a period nobody can pay.
8. **Section 6** — the verdict line.
9. **The timestamp** you ran it at.

Employee ids and commission amounts appear in sections 4 and 5. They are internal
identifiers and figures, not credentials; send them by whatever channel you already use
for commission reporting.

---

## 4. What happens next

The release stays **NO-GO** until this comes back. On the results:

- **no `would_block` rows** → GO for activation. Nothing needs reconciling, so the absence
  of a reconciliation mechanism does not matter.
- **`would_block` rows exist** → GO for everything else; those periods stay blocked and are
  scoped separately, prioritising any with a non-zero `paid_total`.
- **section 1b or 3 returns anything** → stop and discuss before deploying. Neither is a
  reason to repair anything first.
