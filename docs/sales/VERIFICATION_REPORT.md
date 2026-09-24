# Verification Report — Sales CRM & Commissions

Branch `feature/sales-crm-commissions` · base `4640cbe`.

**Which commit each evidence set covers**, because they are not all the same one:

| Evidence | Commit |
|---|---|
| §1 operational regression, 2297 assertions | `d1a7b4b` |
| §2 sales suites, 439 assertions | `dc5c27c` — the commit that made every order-number writer share one locking scheme |
| §3 browser suite, 52 tests | `dc5c27c` |
| §8 role isolation, 36 assertions | re-run against the live `sales_preview` after every change below |
| §8 hosted smoke, 66 assertions | the deployment of `84fd9d6` |

`84fd9d6` adds `vercel.json` and changes no application code, so §2 and §3 cover the
deployed code exactly. §1 predates the order-numbering fix; what that fix touched is
re-covered by §2, which was run after it.

Reported in the six separate categories the brief asked for, because collapsing them into one
number is how a suite that proves little comes to look like a suite that proves a lot.

**A note on what these numbers are not.** An assertion count is a measure of how much was
checked, not of how much is covered. 500 assertions about one function and 500 spread across a
module are the same number and completely different facts. Nothing below is offered as proof
that the module is defect-free; it is a record of what was exercised, and §4–§6 are the parts
worth reading if you want to know what was not.

---

## 1. Existing regression — did this branch break anything already working?

The operational ERP's own 26-suite regression, run against this branch's build, on the
non-production regression database with migration 21 applied.

**Result: 2297 assertions, 0 failed — as a composite of one loaded run plus an
isolated re-verification of five suites the shared database starved. §1a has the whole story,**

What this does and does not establish:

- It **does** show that orders, production, packaging, QC, dispatch, blending, accounting and
  the reset paths still behave as their own suites assert, with the 19 new tables present and
  with `POST /api/orders` now delegating to the extracted `orders/create-order.ts`.
- It **does not** establish "zero regression". These suites cover what they cover. A behaviour
  none of them asserts could have changed and this run would be just as green.

The single most load-bearing suite for this change is `order-to-delivery`, because order
creation was refactored: the route no longer builds orders itself, it calls the shared service.
If that extraction were wrong, an order would come out with the wrong lines or the wrong
kilograms, and that suite drives a real order all the way to a delivery.

### 1a. Result

```
ERP_E2E_BASE_URL=http://127.0.0.1:3010 node withpkg-sales.mjs node scripts/e2e/regression/run-all.mjs
```

**First pass: 1797 assertions, 1 failed, and 5 suites the runner
refused to call trustworthy.** Reported as it happened rather than re-run until it looked
clean.

**The cause was mine, and it was not the change under test.** The preview database
`sales_crm_preview` and the regression database `neondb` sit on the SAME Neon compute
(`ep-wandering-leaf-aqjtuin5`, 0.25–2 CU, free tier). I ran the Playwright browser suite and
the sales suites against port 3020 while `run-all.mjs` was running against 3010 — both on
that one compute. The server log for the window shows exactly what that produces:

```
[API Error] Error: Connection terminated unexpectedly
⨯ Error: Connection terminated due to connection timeout
⨯ Error: timeout exceeded when trying to connect
```

Four suites died mid-run without printing a summary; `platform-hardening` failed one
assertion — *"and can read the module it has access to << status=500"* — and the very next
assertion, which reuses the same session, passed. That is a dropped connection, not a
session-handling defect.

**Every suspect was then re-run in isolation, with nothing else touching that compute:**

| Suite | In the loaded run | Alone |
|---|---|---|
| `blend-integrity` | 0 passed, 0 failed — exited 1; printed no "<n> passed, <m> failed" summary | **105 passed, 0 failed** |
| `po-lifecycle` | 0 passed, 0 failed — exited 1; printed no "<n> passed, <m> failed" summary | **132 passed, 0 failed** |
| `hardening` | 0 passed, 0 failed — exited 1; printed no "<n> passed, <m> failed" summary | **117 passed, 0 failed** |
| `platform-hardening` | 46 passed, 1 failed — exited 1 | **47 passed, 0 failed** |
| `h2a-hardening` | 0 passed, 0 failed — exited 1; printed no "<n> passed, <m> failed" summary | **145 passed, 0 failed** |

**546 assertions, 0 failed, no connection drops and no FATAL.**

Combined honest figure: **2297 assertions, 0 failed across all 26 suites** — taking each
suite's isolated result where the loaded run could not produce one. That is a composite, and
it is labelled as one. It is not a single clean end-to-end pass, and this document does not
claim one.

This failure mode is documented and was known before this run: the endpoint drops connections
under load, each pass fails a *different* block of suites, and every suspect passes alone. The
avoidable part — overlapping two suite sets on one compute — was my own scheduling mistake and
is now recorded so the next person does not repeat it.

---

## 2. New feature tests — API and domain level

Five suites, run with `npm run regression:sales` against `sales_preview`.

| Suite | Assertions | What it proves | Needs |
|---|---|---|---|
| `commission-engine` | **48** | the arithmetic: base, tiers, splits, periods, rounding, refusals | nothing — pure |
| `quotes-domain` | **112** | quotation pricing, the lifecycle table, and the whole CSV layer | nothing — pure |
| `sales-commissions-db` | **23** | constraints exist, concurrency resolves, a rollback leaves nothing | PostgreSQL |
| `sales-security` | **34** | what is refused — every case passes only if the server said no | running app |
| `sales-workflow` | **222** | the ordinary path end to end, with rows checked after every step | running app |
| | **439** | **0 failed** | |

The two pure suites are the ones to trust most: every expected figure in them was worked out by
hand and written as a literal, so none of them can pass by the code agreeing with itself.

`sales-workflow` is the one that answers "can a user actually do this": lead → duplicate
handling → conversion → activities → sample → quotation → discount refusal → issue → revision →
acceptance → order → idempotent replay → won → collections → accrual → approval → refund →
adjustment → payout → target → report → CSV import → CSV export → stage configuration →
assignment lifecycle. After each step it reads the database rather than believing the response.
It also drives the four order-numbering races described in defect 8 of §7: two different
quotations converting at once, the same quotation converting twice at once, a quotation
conversion racing an ordinary `POST /api/orders`, and a conversion that is rolled back. Each
asserts the order count, the uniqueness of every number in the table, and that exactly one
quote-to-order relationship exists.

---

## 3. Browser workflows exercised

Chrome, real screens, real keypad sign-in. `npm run uat:sales`.

**52 tests, 0 failed** (`tests/e2e/sales-crm.spec.ts`), plus **15, 0 failed** in the existing
`permissions.spec.ts`, extended with the three CRM roles.

| Group | Workflows driven |
|---|---|
| Sign-in and session | a rep signs in and the session survives a reload; signing out refuses a protected page; a deactivated employee is unauthenticated on the very next request |
| Leads | create through the form; the same phone in another format is reported and the operator may still proceed; a rep cannot see or reach a colleague's lead; a manager can; conversion makes one customer and one deal however many times it is clicked |
| Deals | the board shows the deal in its stage column and opens it; the deal page opens; a stage move writes an event and survives a reload; a rep cannot close a deal at all; a manager marking one lost cannot until a reason is typed; the server refuses it too when the dialog is bypassed; reopening is a separate privilege and clears the stale loss reason |
| Quotations | build a quotation line by line and the server prices it; a rep is refused at the discount threshold; a manager issues it and the approval is recorded on the document; the issued quotation is read-only on screen and on the server; a revision supersedes and carries the lines; the revision is issued at a corrected price and accepted |
| Orders | the accepted quotation becomes exactly one order with kilograms derived by the order service; clicking again returns the first order; the order appears on the operational Orders screen; the deal can then be won |
| Commission | a rep cannot record a collection; a partial collection accrues once and a re-delivery changes nothing; the rep sees their own figure marked as sandbox and cannot open the team review; the second instalment adds the difference and the rows sum to the period; two people on different plans are paid differently for the same money; finance reviews and the ledger reconciles with the rows; finance cannot approve their own; approval makes the rows immutable; a refund after approval corrects the ledger and leaves the approved rows untouched |
| Arabic, mobile, keyboard | RTL renders with Arabic headings and no horizontal overflow at 390px; the follow-ups screen works at phone width; a form is completed with the keyboard alone, reached by label; Escape closes a dialog without saving; an invalid form cannot be submitted and the server agrees; the CSV importer previews before it writes |
| Targets and reports | a manager sets a target and the bar reflects real collections; a manager cannot set their own; the reports screen states the denominator of its conversion rate; a rep's reports are scoped to their own work; the report exports as a CSV carrying its own sandbox caveat |
| Document, settings, deletion | an issued quotation renders as a document from its frozen snapshot, and **renaming the SKU afterwards does not change it**; a draft says it has no document rather than showing an empty one; the settings screen adds, renames and reorders a stage without two stages ever sharing a position; a stage holding deals cannot be retired from the screen either; a lead with logged activities cannot be deleted and a converted one offers no control; a lead raised in error is deleted |

**Where the API is used instead of the UI, and why.** Two places, both marked in the file.
Sandbox collection events, because there is deliberately no screen for them — the collection
source is an adapter behind three server-side gates, and an operator-facing way to type in
payments would be building the very thing this module does not claim to have. And every
negative permission check, because a hidden button is a courtesy and the handler is the control.
Both call the endpoint **from inside the logged-in browser session**, with the real cookie.

**Nothing external is mocked, because nothing external exists**: no email, no SMS, no payment
provider, no queue. The only outbound integration in the codebase is an optional translation
API which this module does not touch.

---

## 4. Requirements not yet covered

The full matrix is `REQUIREMENTS_MATRIX.md`. What is NOT built, gathered here:

| Gap | Where it stands |
|---|---|
| **Figma design and prototype** | The only remaining requirement, and it is not code. See §5. |

The four gaps this section previously listed — a printable quotation document, a pipeline
settings screen, report export, and deleting a lead from the interface — are built and
covered by `ui 7.5` and `ui 8.1–8.6`.

Every implemented rule in the matrix now has an assertion of its own. The two that did not —
retiring a pipeline stage that still holds deals, and ending a commission assignment rather
than deleting it — are covered by `flow I2` and `flow I3`.

---

## 5. Tests and work blocked or skipped

| Item | Status | Precisely what is missing |
|---|---|---|
| **Hosted Preview deployment and smoke test** | **DONE** | §8. The sequencing deadlock was removed with `vercel.json`'s `git.deploymentEnabled` rather than by pushing and letting a build fail. |
| **Figma design and prototype** | **BLOCKED** | The MCP server is installed but unauthenticated; only `authenticate` and `complete_authentication` are exposed. OAuth consent is the account holder's to give and was not bypassed. Whether that server can write canvas content at all is **still untested** — the tools do not appear until authentication succeeds, so claiming it can would be a guess. `FIGMA_UX_HANDOFF.md` holds the handoff material. |
| **Database privilege isolation for the preview** | **DONE** | `DATABASE_ISOLATION.md`. Two SQL-created roles with no memberships, on a new database; 36 assertions, 0 failed. One residual is recorded rather than fixed: `PUBLIC` keeps `CONNECT` on `neondb`, because revoking it would change infrastructure shared with the operational regression, which was explicitly out of scope. The runtime role can therefore open a connection there and read nothing — proven with a synthetic probe table. |
| **Load, performance and soak testing** | **NOT ATTEMPTED** | No claim is made about behaviour under concurrent load beyond the specific races §2 asserts. |
| **Running two suite sets at once** | **AN EXECUTION CONSTRAINT, NOT A GAP** | `sales_preview` and the regression database `neondb` share one Neon compute. Suites must be run one set at a time; §1a is what happens otherwise. This applies to the hosted Preview too, which reaches the same compute from Vercel. |
| **Accessibility audit beyond what is tested** | **PARTIAL** | Labels, keyboard operation, focus states, `aria-*` on dialogs and progress bars are implemented and partly tested. No screen-reader pass and no contrast audit was run. |

Nothing was skipped because it was inconvenient, and no test was deleted, weakened or had an
expected value changed to accommodate behaviour.

---

## 6. Remaining implementation and integration gaps

**The financial cycle is not integrated, and this is the most important sentence in this
document.** This ERP has no invoice, payment or receivables model — verified against the
schema, not assumed. Commission is owed on money actually *collected*, so collection is an
**adapter**, and its only implementation is a sandbox: events entered deliberately through a
surface behind three server-side gates, every row stamped `sourceSystem = "SANDBOX"`, and every
screen that displays a figure derived from them says so.

**No commission figure in this module corresponds to money anyone has actually received.**

What a real integration would need to replace: one adapter, `POST`/`PATCH
/api/commissions/sandbox-collections`, writing `CollectionEvent` rows with a different
`sourceSystem`. Everything downstream — accrual, splits, tiers, periods, approval, ledger — is
already indifferent to where the event came from, which is why the adapter shape was chosen.

Other integration notes:

- **Quotation → order is real**, and goes through the same `orders/create-order.ts` that
  `POST /api/orders` uses. There is no second order writer.
- **Customers are the existing `Customer` model.** No parallel customer system was created.
- **Samples do not move stock**, deliberately. The roastery has one inventory path with its own
  guards; a second one is the defect the packaging rework was spent closing.
- **A payout is a record, not a transfer.**

---

## 7. Defects found and fixed during this work

Six of the eight were found by tests rather than by reading, which is the point of them. Each
was fixed at the root and each has a regression test.

1. **A manual adjustment was cancelled out by the next collection.** The accrual engine counted
   `ADJUSTMENT` ledger entries as part of its own baseline, so the next payment computed a
   target that already contained the adjustment and wrote a smaller delta to compensate. An
   agreed goodwill payment evaporated the moment the customer paid again; the only symptom was
   somebody being paid less than they were promised. Fixed: the engine's baseline is `ACCRUAL`
   and `REVERSAL` only — which is what `periodStatement` had always reported separately.
   *(flow E9)*
2. **Every accrual row carried the period's running total** instead of its own collection
   event's contribution. A month with 50 then 100 collected showed rows of 50 and 150, summing
   to 200 against a real 150; anyone adding up their own payslip got a different answer from the
   ledger. Fixed: accruals are marginal, and the review screen now reconciles the two and shows
   the difference. *(flow E5)*
3. **`postDelta` upserted over APPROVED accruals.** A refund after approval silently restated a
   figure somebody had already been told they had earned — the exact failure an append-only
   ledger exists to prevent. Fixed: an approved accrual is frozen and the correction lives
   entirely in the ledger. *(flow E8, ui 5.8)*
4. **The lead form's Source select announced itself as its own option list.** A `<select>`
   wrapped in a `<label>` takes its accessible name from the label's whole text content, options
   included, so a screen reader read it as "Source Walk-in Referral Phone Social…" — and it was
   indistinguishable from the Phone field. Fixed: explicit `aria-label` on every control.
   *(found by ui 2.1)*
5. **Money rendered without its decimals.** A Prisma Decimal serialises as the shortest string
   that represents it, so a quotation total displayed as "1552.5 SAR". Fixed with `formatMoney`,
   which pads and groups as string operations — `Number(x).toFixed(2)` would be shorter and
   would route the amount through binary floating point. *(ui 4.1)*
6. **The import preview miscounted the file**, reporting "2 of 2 rows would be imported" for a
   three-row file, because the denominator counted rows that parsed rather than rows the file
   held. *(quotes I1/I5, ui 6.6)*
7. **The order-number retry could not retry inside a transaction.** Found by reading rather
   than by a test, and it was mine. `createOrderWithNumber` derives the next number from the
   current maximum and retries on a duplicate key — which works for `POST /api/orders`, where
   each insert is its own implicit transaction. The quotation-to-order path calls it INSIDE a
   transaction, because the order and the link row that makes it idempotent must commit
   together, and PostgreSQL aborts the whole transaction on a duplicate key: every later
   statement then fails with "current transaction is aborted", so the retry had nothing left to
   retry with. Two quotations converting in the same instant would have produced a confusing
   failure rather than a second attempt. Fixed with a transaction-scoped advisory lock in the
   namespace convention this codebase already uses — 7761 for production orders by year, 7763
   for roasting batches by date, now 7764 for order numbers — with the lock order documented
   beside it. *(flow D4b: two conversions fired with `Promise.all`, asserting two distinct
   numbers and no duplicate anywhere in the table)*

8. **The advisory lock protected one writer and not the other.** Defect 7 put a
   transaction-scoped advisory lock in `createOrderWithNumber`, and the quotation path
   observed it — but `POST /api/orders` called the same function *outside* a transaction, so
   each statement was its own implicit transaction and `pg_advisory_xact_lock` released the
   moment it was taken. Two writers were nominally using the same lock while only one of them
   was actually holding it, which serialises nothing. **A lock protects concurrent writers only
   when every writer participates in a compatible scheme**, and the fix for defect 7 was
   therefore incomplete rather than wrong: it made the quotation path safe against itself and
   left it racing the ordinary order path. Fixed by wrapping `POST /api/orders` in
   `prisma.$transaction`, so both writers hold the lock for the same duration, and by
   documenting on `createOrderWithNumber` that every caller must run inside a transaction.
   *(flow D4b–D4e: two different quotations converting at once; the same quotation converting
   twice at once; a conversion racing `POST /api/orders`; and a rolled-back conversion, which
   asserts the idempotency key is released, that an accepted quotation still refuses to be
   revised, and that a fresh quotation on the same deal converts normally)*

One more is worth recording because it was in my own tooling rather than in the product. The
scratch file-editing helper used a STRING replacement, and dollar-ampersand, dollar-backtick,
dollar-apostrophe and dollar-digit are all special **in the replacement argument**. A template
literal ending in a dollar sign immediately before its closing backtick — which is exactly what
a regex like "…/deals/:id, anchored at the end" produces — becomes dollar-backtick, meaning
"insert everything before the match". It silently duplicated an entire 60 KB spec file twice
before it was traced. The helper now passes a replacer **function**, which is taken literally,
and every file changed on this branch was re-scanned for the same corruption: only that one
spec was affected, it was restored from git, and `tsc` is clean across the project.

Three of the test fixtures were also wrong and were corrected rather than accommodated: all
three sandbox payments shared one timestamp, which made it impossible to test that a split takes
effect *from* its own date; a BOM assertion read the decoded string, which is exactly where
`fetch` strips a BOM; and a URL poll was already satisfied on the page the click started from.

### 7a. Incident — a Protection Bypass secret was exposed twice

Recorded in full because an earlier revision of this section understated it. That revision said
the exposed secrets "granted access to nothing beyond the protected Preview URL". **That was
wrong**, and the error was a category one: it described where the secret was *used* as though
that were the limit of what it *authorised*.

#### What the credential actually authorised

A Vercel **Protection Bypass for Automation** secret bypasses deployment protection for **every
deployment in the project** until it is revoked — presented as a request header or as the
`_vercel_jwt` cookie derived from it. It is not scoped to a URL, a deployment, a branch, or an
environment.

For this project that means the secret would have admitted a holder to any protected deployment
of `flow`, including the deployment URLs of **production** builds. (Production's public custom
domain is not protected in the first place, so the secret added nothing there; the protected
`*.vercel.app` deployment URLs are the ones it would have opened.) It confers no ability to
deploy, to read environment variables, or to act on the Vercel account — it defeats the access
gate in front of already-built deployments, and nothing else.

#### Timeline, from the session's own timestamps (UTC)

| Time | Event |
|---|---|
| 12:36–12:39 | A probe call asked Vercel to **generate** a bypass secret. The API returns the value in the response body, and the response was printed. **Exposure 1: transcript.** |
| 12:39:08 | Probe secret **revoked**; replacement #1 created from a locally generated value, sent with `--silent`, never printed. |
| 12:52:37 | A `curl -D -` probe sent `x-vercel-set-bypass-cookie: true`. The `307` response carried `Set-Cookie: _vercel_jwt=…`, whose JWT payload contains the bypass secret in clear text. The header block was printed. **Exposure 2: transcript, and a redaction filter matching the literal string did not catch it because it is base64-encoded.** |
| 12:53:12 | Replacement #1 **revoked**; replacement #2 created silently. Never displayed. |
| 12:54:00 | A second create attempt returned **409 `automation bypass already exists`** — evidence that this project holds at most one automation-bypass entry at a time. |
| 15:01:06 | Replacement #2 **revoked** at the end of the smoke testing. |
| 15:01:18 | Revocation verified: the raw secret returns `302` again. |

So a *displayed* secret was live for roughly three minutes in total across two windows
(≈12:36–12:39 and ≈12:52:37–12:53:12). Replacement #2 was live for about two hours but was
never displayed anywhere.

#### Where it was exposed, and where it was used

| | |
|---|---|
| **Exposed in** | this session's transcript, at `~/.claude/projects/…/<session>.jsonl`, twice. Nowhere else — see the scan below. |
| **Used by me against** | the Preview deployment `dpl_HynUSRbdwvVVzBYC99yoQW4iM8TY` only, on its immutable URL and its branch alias. |
| **Used by anyone else** | **unknown.** See the access-history limits below. |

#### What access history exists, and what does not

| Source | Available? |
|---|---|
| Vercel team audit log | **No** — `/v1/teams/…/audit-logs` returns 404 on this plan. |
| Per-bypass-secret usage record | **Does not exist.** Vercel's runtime logs do not record whether a request was admitted by a protection bypass, by SSO, or by a public route, so no request can be attributed to the secret even where logs survive. |
| Deployment runtime logs | **Partially** — and not for the window that matters. The retained window at the time of investigation was **15:00:32 → 15:39:48 UTC**, about 39 minutes, capped at 100 rows. Both exposure windows (≈12:36–12:39 and ≈12:52–12:53) had already aged out. |

**Therefore: no evidence of unauthorised use exists, and no evidence of its absence exists
either.** Both claims are unsupported and neither is made here. What can be said is that the
exposure was to a local session transcript on the developer's own machine rather than to a
shared or public surface, and that the displayed secrets were revoked within about three
minutes of being displayed.

One thing the surviving logs *did* show, and it is recorded because it is unattributed rather
than because it is suspicious: at **15:38:46–15:39:48 UTC — 37 minutes after the last
revocation** — a browser-shaped request sequence reached the deployment's functions on the
immutable URL (`GET /`, `GET /login`, `GET /api/settings/logo`, then three
`POST /api/auth/login` each answered **401**). Because it postdates revocation and the cookie
path was already dead, it cannot have been admitted by the bypass; the only remaining admission
path is Vercel SSO, which requires project membership. The log rows carry no IP, user-agent or
identity, so it cannot be attributed further. The pattern — reaching the sign-in screen and
then failing authentication three times — is what a reviewer following the handoff would
produce if they had not been told the fixture PINs, which they had not been.

#### Revocation and verification

| Check | Result |
|---|---|
| Probe secret (exposure 1) | revoked 12:39:08 |
| Replacement #1 (exposure 2) | revoked 12:53:12 |
| Replacement #2 (never exposed) | revoked 15:01:06 |
| Entries remaining | **zero.** The 409 above establishes that the project holds at most one automation-bypass entry, and the last operation on it was a successful revoke. The REST API exposes no `GET` for this resource (404), so the dashboard — Project → Settings → Deployment Protection → Protection Bypass for Automation — is the authoritative visual confirmation. |
| Raw secret replayed | `302` to Vercel SSO, i.e. refused |
| **Issued cookie replayed** | the one `_vercel_jwt` recoverable from the transcript was replayed against **both** the branch alias and the immutable URL: **`302` to SSO on both** — refused. Its audience claim was the immutable deployment host. |
| Control | an unauthenticated request to the same URL also returns `302`, so "refused" above is not simply an open URL |
| `ssoProtection` | unchanged, `all_except_custom_domains` |

Replaying the cookie matters separately from replaying the secret: the cookie is a signed JWT
the edge validates, and a JWT can outlive the credential that minted it. Revoking the secret is
not by itself proof that the cookie path was invalidated.

#### Scan for retained copies

Needles recovered from the transcript and from the live environment files, then searched for
everywhere else. Reported by digest; no value was printed.

| Location | Result |
|---|---|
| Every commit this branch adds | **clean** — none of the nine credential values appears in any commit |
| Added lines, generic credential sweep | 17 `postgres://` strings, **all** with the literal placeholder password `p` in `scripts/sales-preview/guard-proof.sh`; no token, key or JWT pattern |
| Repository working tree | **clean** |
| Scratch directory | the two live env files only, which are their own source |
| `.env.sales-preview` | held the **superseded `neondb_owner` password** from the previous preview setup and was no longer needed — **deleted** |
| Session transcript | both exposed secrets and the cookie remain in it. Not sanitised: it is Claude Code's own append-only session store and editing it risks corrupting session state. All three values are revoked, so the retained copies are inert. Flagged for the account holder to delete the file if they prefer. |
| Env file permissions | `mode: 0o600` **does not restrict a file on Windows** — Node only toggles the read-only attribute, and Git Bash's `ls -l` reports an emulated `0644` that means nothing. Both files now carry a real ACL: inheritance removed, granted to the single user account. The README no longer claims 0600 on Windows. |

#### Making it safe by construction

Rules, not reminders, in `scripts/sales-preview/smoke-hosted.mjs` and its README:

- `x-vercel-set-bypass-cookie` is gone. The plain `x-vercel-protection-bypass` header alone
  returns `200`, so the cookie round-trip bought nothing and cost an exposure.
- No response header block is ever printed around a bypass-protected request.
- Auth endpoints are reported by **status code only** — never a response body, never the cookie
  jar.
- Every logged detail passes through a **pattern-based** redactor: the bypass value, anything
  JWT-shaped, any `_vercel_jwt`/`auth-token`/`session` cookie, and any
  `"secret"`/`"token"`/`"password"`/`"pin"` JSON field. Pattern-based because the second
  exposure proved a literal-string filter is defeated by base64.
- The secret is generated locally and the API call that registers it uses `--silent`, so the
  value never appears in a response that might be printed.

---

## 8. The deployed Preview, and what was proven on it

### 8a. Getting there without "push and see what breaks"

The previous revision recorded a deadlock: Vercel refuses a branch-scoped Preview variable for
a branch that is not on the remote, and pushing the branch is what triggers the first
deployment — which would then build with whatever broader Preview variables happened to
resolve. Letting that first build fail was rejected as a strategy; a build that fails is still
a build that ran, with whatever environment it inherited.

It was removed with `vercel.json`:

```json
{ "git": { "deploymentEnabled": { "feature/sales-crm-commissions": false } } }
```

Vercel reads this from the commit being pushed, so the safeguard is in place *in the same push
that creates the branch*. Scope, stated precisely: the map keys are exact branch names and any
branch not named keeps the default of `true`, so this disables automatic deployment for this
one branch and for nothing else. Production and every other branch are unaffected. The file
was created rather than edited — the project had none — so no unrelated setting was
overwritten. `.github/workflows` was checked for push-triggered jobs; there are none that
deploy.

The sequence actually performed, in order:

1. Commit `vercel.json` with `deploymentEnabled: false`, push the branch.
2. Confirm the remote branch exists and **the deployment list is unchanged** — no build, no
   database operation.
3. Create the five branch-scoped Preview variables (§9).
4. Apply migrations under the migration identity, against the confirmed isolated target.
5. Flip the flag to `true`, push, and let the git-triggered deployment run.

Two pieces of evidence that the safeguard worked rather than merely appearing to: a deployment
attempted from the CLI while the flag was `false` is recorded by Vercel in state **`BLOCKED`**,
and no deployment exists for this branch between the first and second pushes.

### 8b. That the deployed application resolved the right environment

The build command is `tsx scripts/validate-env.ts && prisma generate && next build`. The
validator runs first, refuses without `DATABASE_URL` and `PIN_LOOKUP_SECRET`, and opens no
connection — so a `READY` deployment already establishes that the branch-scoped variables
resolved. Two stronger facts come from the smoke test itself:

- **Signing in with a seeded PIN succeeds.** `Employee.pinLookup` stores a selector *keyed*
  by `PIN_LOOKUP_SECRET`, so a different secret selects no row and a different database holds
  no such employee. One request proves both variables at once, and it cannot pass by accident.
- **A sandbox collection is accepted.** That route refuses unless
  `SALES_SANDBOX_COLLECTIONS` is exactly `"true"` *and* `DATABASE_URL` names none of the three
  protected production endpoints — checked in the deployed runtime, before it writes anything.

There is no branch-agnostic Preview `DATABASE_URL` on this project at all, so the only one
that can resolve for this branch is the branch-scoped one. There *is* a branch-agnostic
Preview `DIRECT_URL`; `DATABASE_ISOLATION.md` §2 explains why the branch-scoped `DIRECT_URL`
is set to the **runtime** role rather than left unset, and why no deployment runs a migration.

### 8c. Hosted smoke test — 66 assertions, 0 failed

**Exactly what was tested.** The branch alias moves to whatever this branch last deployed, so
it is the wrong thing to cite as evidence. The immutable identity is:

| | |
|---|---|
| Deployment ID | `dpl_HynUSRbdwvVVzBYC99yoQW4iM8TY` |
| Immutable URL | `https://flow-jjaqyku15-ibrahimmutambak-4927s-projects.vercel.app` |
| Branch alias (moves) | `https://flow-com-git-feature-sale-adea3e-ibrahimmutambak-4927s-projects.vercel.app` |
| Commit | `84fd9d60bbfcc446e3153721c45b673db1ecef36` |
| State / created | READY · 2026-09-24T12:35:48Z |

Run twice, once per URL, 66 assertions and 0 failures each time, from two different commission
baselines. **If a later commit redeploys this branch, this evidence does not carry forward to
it** — the alias will point somewhere else, and the new deployment needs its own run.

`scripts/sales-preview/smoke-hosted.mjs`, run over HTTPS. No local server, no direct database
connection: every assertion is what the deployed application answered.

| Group | What was driven on the hosted deployment |
|---|---|
| Protection | without the bypass header the URL is intercepted by Vercel SSO; with it the application answers |
| Sign-in | a rep signs in with a PIN; the session identifies them; a wrong PIN is refused and issues no session |
| Leads | a lead is created and is owned by the caller rather than by the `ownerId` the request body tried to set; the same number in another format is reported as a duplicate and names the existing lead; the lead is found again by a later search |
| Conversion | the lead converts to a deal; a second conversion replays instead of converting again; the deal record loads with its customer, its stages, and a `can` map that offers the rep quoting but not closing |
| Permissions | a rep cannot close a deal, cannot record a collection, and cannot open the team commission review |
| Quotation | the server prices the quotation at 1265.00 and ignores the 1.00 total the client sent; a 25% discount saves but the rep cannot issue it; the manager issues and accepts it |
| Order | the accepted quotation becomes one order; pressing again returns the same order number and says it replayed; the order appears on the operational orders list |
| Won / Lost | the deal is won once a quotation is accepted; it cannot be flipped to lost without reopening; reopening is allowed for someone who may; lost without a reason is refused and lost with one succeeds |
| Commission | a collection accrues 50.00 on a 5,000 net base; the same reference again changes nothing; the rep sees their own figure marked sandbox; finance cannot approve their own and can approve the rep's; an adjustment needs a reason, is reported separately from accrued, and survives a fresh request; a refund returns the ledger to its baseline while leaving the approved accrual row standing, and the screen reports the resulting difference rather than hiding it |
| Persistence | after signing out and back in, the deal still reads LOST with the reason that was given |

**Commission figures are asserted as deltas against a baseline read at the start of the run.**
The database legitimately carries rows from the browser suite, including a period that is
already unreconciled because an accrual was approved and then refunded — which is correct
behaviour, not a defect. An absolute assertion would have failed for the wrong reason. Two
assertions in the first run did exactly that and were corrected: they were mistakes in the
test, and the application's answers were right both times.

Re-run it after any redeployment; it takes about a minute and needs the fixtures the browser
suite seeds.

---

## 9. Environments changed

The previous revision of this document said "Environments changed: none." **That was true when
it was written and is not true now.** What follows separates what was actually changed from
what was not touched, because a single "no production impact" line is not a substitute for
either list.

### 9a. Non-production changes made

**Database** — Neon project `hiqbah`, branch `erp-regression-r1`, endpoint
`ep-wandering-leaf-aqjtuin5`:

| Change | Detail |
|---|---|
| New database | `sales_preview`, created empty, owned by `neondb_owner` |
| New role | `sales_preview_app` — restricted runtime identity, created in SQL, no memberships |
| New role | `sales_preview_migrator` — migration identity, created in SQL, no memberships |
| Grants | `CONNECT` on `sales_preview` to both; `CREATE` on that database and `USAGE, CREATE` on its schema to the migrator; `USAGE` and table-level `SELECT, INSERT, UPDATE, DELETE` to the app; default privileges so future migrations stay readable |
| Revocations | `ALL ON DATABASE sales_preview FROM PUBLIC`; `CREATE ON SCHEMA public FROM PUBLIC` — both scoped to the **new** database only |
| Migrations | all 21 applied to `sales_preview` under the migration identity |
| Fixtures | synthetic only — 9 `UAT_`-prefixed employees, 7 tagged customers, 4 orders, 5 `SANDBOX` collection events |
| Probe | `public."__isolation_probe"` created and dropped in `neondb`, one invented row, to prove a refusal rather than an empty result |

**Deployment** — Vercel project `flow`:

| Change | Scope |
|---|---|
| `vercel.json` committed | `git.deploymentEnabled` for `feature/sales-crm-commissions` only |
| Five Preview variables created | `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `PIN_LOOKUP_SECRET`, `SALES_SANDBOX_COLLECTIONS` — **all branch-scoped to `feature/sales-crm-commissions`** |
| Protection Bypass for Automation | created for the smoke test, exposed twice, and **revoked** — including the cookie path, verified by replay. It is a **project-wide** credential, not a URL-scoped one. Full record in §7a. |
| Deployments | preview deployments of this branch |

**Secrets** — `JWT_SECRET` and `PIN_LOOKUP_SECRET` for this branch were generated fresh and
are not reused from anywhere. They are not the same relationship to the data, and were not
treated as if they were: `JWT_SECRET` only signs sessions, so changing it logs people out;
`PIN_LOOKUP_SECRET` is baked into every stored `Employee.pinLookup` and `Employee.pin`, so
changing it makes seeded employees unable to sign in until the fixtures are regenerated —
which is why the fixtures were regenerated against the new value rather than carried over.

**Repository** — a feature branch pushed to the remote. No merge to `main`.

### 9b. Production, and what was not touched

**Untouched.** No production database connection was opened, no production migration was run,
no production deployment was made, nothing was merged to `main`, no resource was deleted, no
paid upgrade was bought, and no security setting was weakened or bypassed. The project's
`ssoProtection` is exactly as it was found.

Specifically not changed, each of which was explicitly out of scope:

- `neondb_owner` — not altered, not rotated.
- Existing role memberships on the regression branch — not modified.
- `PUBLIC` privileges on `neondb` or any other pre-existing database — not revoked. This is
  why the residual in `DATABASE_ISOLATION.md` §6c exists rather than being fixed.
- The older `sales_crm_preview` database — left in place, not deleted.
- Production-scoped and branch-agnostic Vercel variables — read for scope, never written.
- Neon branches — none created, none deleted.

The latest production deployment remains `4640cbe`, dated 2026-09-19, which predates this
work.
