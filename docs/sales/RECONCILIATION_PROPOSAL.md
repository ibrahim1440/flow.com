# Historical reconciliation — a design proposal, not an implementation

**Status: proposed. Nothing here is built, and nothing should be built from it until it is
reviewed.** No mechanism described below exists in the codebase. The payout gate currently
has no exit: a period can become unresolved and there is no supported, non-destructive way
out of it. That is the gap this proposes to close, and the reason it exists at all.

It is a general design. It is **not** a proposal to reconcile any particular period, and
certainly not the preview test periods — those are test residue, and adopting or writing
off a test balance as a business liability would be a category error.

---

## 1. What problem it actually solves

A period is refused when its entitlement cannot be derived: a movement belongs to no
accrual, an accrual has no movement of its own, or a reversal has nothing applied against
it. The refusal is correct — the alternative is paying against a figure the ledger cannot
explain. But a correct refusal that can never be lifted is an outage, not a control.

The two ways out that must **not** be used:

- **Deleting the movements.** That is destroying financial history to make a check pass.
- **Inferring the links.** Amount and timestamp resemblance is not attribution. On the
  preview data five `+50.00` movements sit beside five `50.00` accruals, which looks
  decisive until you notice the four `−50.00` reversals: which reversal compensates which
  movement is genuinely ambiguous, and a wrong assignment changes which accrual nets to
  zero while leaving the period total identical. The entitlement model exists precisely to
  stop that guess being made silently.

What remains is a **documented human decision**, recorded as evidence, that the model
honours. That is what this describes.

---

## 2. Shape

An append-only record, one per employee-period, alongside the ledger rather than inside it.
Nothing it does rewrites a movement, an accrual or a payout.

| field | why it is required |
| --- | --- |
| `employeeId`, `periodStart` | the subject. One open record per pair — see §5. |
| `coveredMovementIds` | **explicit list**, not a filter, not a date range. A filter re-evaluates as history changes and would silently absorb movements nobody reviewed. |
| `acceptedEntitlement` | the entitlement the reviewer determined this period carries, signed. The figure the model uses in place of the covered movements. |
| `acceptedStatus` | `APPROVED` or `NOT_PAYABLE`. Accepting that a figure is *correct* is not the same as accepting it is *payable*, and conflating them would let a reconciliation authorise a payment by itself. |
| `evidence` | free text **and** at least one reference: a document id, a ticket, a signed statement, a bank record. Required, non-empty, and not satisfiable by arithmetic (§4). |
| `basis` | an enum naming *how* attribution was established — `SOURCE_SYSTEM_EXPORT`, `BANK_RECONCILIATION`, `SIGNED_MANAGEMENT_DECISION`, `WRITE_OFF`. It records what kind of claim is being made, so a later reader can weigh it. |
| `preparedById`, `preparedAt` | who determined it. |
| `approvedById`, `approvedAt` | who countersigned. Must differ from `preparedById` (§6). |
| `supersededById` | set when a later record replaces this one. Never deleted. |
| `invalidatedAt`, `invalidationReason` | set automatically when new history appears (§8). |

Only a record that is **approved, not superseded and not invalidated** counts.

---

## 3. How the entitlement model would read it

Today `fullyAttributed` requires every movement to carry its own link. It would instead
accept either:

- the movement is linked, **or**
- the movement is listed in an active reconciliation record for its employee-period.

and the period's entitlement becomes `Σ derivable accruals + Σ acceptedEntitlement of
active records`, where a record's contribution counts toward `availableToPay` only if its
`acceptedStatus` is `APPROVED`.

`fullyAttributed` stays a **count**, never a sum: a period is resolved when every movement
is either linked or covered, not when the numbers happen to add up. The
`unattributedCount` / magnitude reporting stays exactly as it is, and a reconciled period
reports both what was derived and what was accepted, separately and permanently.

**Per-accrual attribution is not claimed.** A reconciliation resolves the period total,
which is what payability needs, and says so explicitly. It does not pretend to know which
accrual each covered movement belonged to, because it does not.

---

## 4. A zero closing balance is not evidence

The tempting shortcut: "the undecided movements net to exactly the outstanding shortfall,
so adopt them." On the preview data both blocked periods close at exactly 0.00 under
adoption, which feels like proof and is not.

Arithmetic consistency means the money adds up. It does not establish that the money was
**earned**, that it was earned by **this person**, or that it was earned in **this period**.
A period fabricated from the wrong movements closes at zero just as neatly as a correct
one — that is a property of the subtraction, not of the facts.

So the record requires an evidence reference that is not arithmetic, and the check that a
figure reconciles is treated as a **sanity test that can fail**, never as the reason to
accept. If the numbers do not reconcile, that is a reason to stop. If they do, it is not by
itself a reason to proceed.

---

## 5. Preventing overlapping coverage and double counting

Three constraints, all enforced by the database rather than by the writer:

1. **A movement may be covered once.** A join table `(reconciliationId, movementId)` with
   the movement unique across all *active* records. A second record naming the same
   movement is refused, not merged.
2. **One active record per employee-period.** A partial unique index on
   `(employeeId, periodStart) WHERE superseded_by IS NULL AND invalidated_at IS NULL`.
   Revising a decision means writing a new record that supersedes the old one, not editing
   it and not adding a second.
3. **A covered movement is excluded from derivation.** Its own links, if any later appear,
   do not add to the total on top of `acceptedEntitlement` — the record replaces the
   covered movements rather than sitting beside them. Without this, resolving a period and
   then repairing a link would count the same money twice.

---

## 6. Independent approval

`preparedById ≠ approvedById`, enforced in the same place the payout route already enforces
that nobody approves their own commission, and for the same reason. Additionally:

- neither may be the employee the record is about;
- approval is a separate action with its own privilege, not a field set at creation;
- an unapproved record has **no effect**: the period stays blocked until somebody
  countersigns. A prepared-but-unapproved record must not partially resolve anything.

---

## 7. Reversals that arrive afterwards

A reversal landing after reconciliation is ordinary new history and is handled as such: it
posts as a movement with provenance, it allocates against whatever it compensates, and it
changes the balance. Two rules keep it honest:

- **It may not allocate against a covered movement.** Those are closed by decision; a later
  allocation against them would reopen a figure a person signed. It allocates against
  derivable movements, and any remainder is reported as unallocated — which will itself
  make the period unresolved again, correctly.
- **It does not change `acceptedEntitlement`.** The accepted figure is what was decided at
  the time, on the evidence available then. A reversal reduces the period's balance through
  its own movement, leaving the record intact and the history readable as what happened.

If the reversal means the original decision was wrong, the answer is a new record that
supersedes it — with its own evidence and its own countersignature.

---

## 8. Invalidation when new history appears

A reconciliation is a statement about a known set of movements. New movements make it a
statement about something else, so:

- a new movement in a reconciled employee-period that is **not** covered and **not**
  derivable sets `invalidatedAt` on the active record and returns the period to unresolved;
- a new movement that **is** derivable does not invalidate: the record still describes
  exactly the movements it named, and the new one stands on its own provenance;
- invalidation is recorded, never silent, and the invalidated record stays readable —
  it is evidence of what was believed and when.

A **review date** is also worth carrying: a `WRITE_OFF` in particular is a decision that
ages, and a record that no one has looked at in a year should say so rather than quietly
continuing to authorise payments.

---

## 9. What this deliberately does not do

- It does not unblock anything by itself. It supplies evidence the gate can accept; the
  gate is unchanged.
- It does not make an unresolved shortfall into a debt. That remains a separate finding
  requiring complete history — see *A shortfall is not a debt* in `COLLECTIONS_WORKFLOW.md`.
- It does not delete, edit or re-link a single historical row.
- It does not apply to Production data, whose exposure is unmeasured. Whether any of this
  is needed at all depends on the read-only audit
  (`scripts/sales-preview/payout-gate-impact-audit.sql`) being run by an authorised
  operator against the confirmed Production datasource. **If Production has no affected
  periods, none of this is needed to activate payouts.**
