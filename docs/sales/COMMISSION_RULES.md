# Commission Rules

> **These rules are PROVISIONAL.** The numbers below are the worked examples supplied with
> the task brief, used as test fixtures. They are **not** an approved company commission
> policy, and nothing here changes one. Where a policy decision was needed and none existed,
> the assumption is recorded as an assumption rather than presented as settled.

Engine: `src/lib/services/commissions/engine.ts` — pure arithmetic, no database, no HTTP.
Proof: `scripts/e2e/regression/commission-engine.mjs` — **48 assertions, 0 failed**.

---

## 1. The base

**Net qualified collection.** Commission is owed on money actually received, never on an
invoice raised or a deal marked Won.

```
qualifying base = amount collected − tax collected − non-qualifying portion
```

- **Tax is excluded.** VAT is collected on the state's behalf and is never earned.
- **Non-qualifying portion** is whatever the plan excludes — freight, excluded product
  lines. Supplied per collection event by the source.
- The base **floors at zero**. An over-subtracted collection earns nothing; it does not
  claw back from unrelated earnings.

Worked (from the brief): an invoice of net 10,000 + VAT 1,500. A collection of 5,750 carries
750 of tax with it, so the qualifying base is **5,000**.

---

## 2. Rates and tiers

**Base rate** is per plan version and therefore per employee, since each employee is assigned
a plan. 1% and 2% for two different people is the ordinary case, not a special one.

**Tiers are INCREMENTAL.** A tier's rate is **percentage points added** to the base rate, and
it applies **only to the slice of base inside that band** — never to the whole base.

- `fromAmount` is inclusive, `toAmount` is exclusive, `null` means "and above".
- Bands may not overlap, may not be empty, and nothing may sit above an open-ended band.
  Each is refused at validation rather than resolved by guessing.

Worked (from the brief): 1% on everything, plus 0.5 points on the slice between 100,000 and
120,000. At a cumulative base of 110,000:

```
110,000 × 1%              = 1,100.00
(110,000 − 100,000) × 0.5% =    50.00
                            ─────────
                              1,150.00      effective rate 1.045455%
```

The effective rate is **not** 1.5%. Conflating the two is the specific error this
representation prevents.

### RETROACTIVE tiers are refused

`RETROACTIVE` exists in the enum so the concept is nameable, and **validation rejects it**
with an explanation. A retroactive tier applies the reached rate to the entire base and pays
very differently on identical numbers. Shipping it half-working would produce wrong payslips
that only the earner would notice. Enabling it is a deliberate future change with its own
tests, not a configuration flag.

---

## 3. Accrual: cumulative target, then the difference

This is the core of the design and the reason partial payments behave.

For each (employee, period, plan version) the engine computes the **target cumulative
commission** from every qualifying collection to date, then writes only the **difference**
against what is already accrued.

Consequences, all asserted:

| Event | Behaviour |
|---|---|
| First 5,000 collected | target 50.00 → accrue **+50.00** |
| Remaining 5,000 collected | target 100.00 → accrue **+50.00**, not another 100.00 |
| Same collection event re-delivered | target unchanged → accrue **0.00** |
| 2,000 refunded after 10,000 collected | target 80.00 → **−20.00** adjustment |
| Payment arrives in three parts of 3,333.33 / 3,333.33 / 3,333.34 | increments total exactly **100.00** — halves neither vanish nor double |

A naive per-payment calculation gets the first row right and every other row wrong.

---

## 4. Split ownership

The **base** is split, not the finished commission. With tiers the two differ: splitting a
tiered result would hand each person a share of somebody else's tier progress.

Worked (from the brief): base 5,000 split 60/40, A on 1% and B on 2%:

```
A: 5,000 × 60% = 3,000 base × 1% =  30.00
B: 5,000 × 40% = 2,000 base × 2% =  40.00
```

Shares must be positive, distinct per employee, and total **exactly 100%**. A total of 90% is
refused, never normalised — rounding it would decide somebody's pay by accident.

**Reassigning a customer or deal does not move historical earnings.** A new split takes
effect from its own `effectiveFrom`; what was already earned stays earned.

---

## 5. Periods and timing

- Monthly, **Asia/Riyadh**. Riyadh is UTC+03:00 with no daylight saving, so a fixed offset is
  exact and a timezone library would add a dependency without adding accuracy.
- Stored as UTC instants, so servers in different regions agree which month a collection fell
  in. February 2026 begins at `2026-01-31T21:00:00Z`.
- A collection at `2026-01-31T22:00Z` is already February in Riyadh and accrues to February.
  One at `20:00Z` the same day is still January. Both directions are asserted.

**Plan version selection** is by the date the money arrived, not the date the deal closed or
the date the plan was edited. The latest version whose window contains that instant governs.

**Late collections after a period closes** — assumption, not policy: they accrue to the
period the money actually arrived in, and appear as a new accrual in the open period rather
than reopening a closed one. No approved policy exists; flagged for a decision.

---

## 6. Immutability and corrections

An accrual that is `APPROVED` or `PAID` is **never rewritten**. Editing a plan does not
restate it.

Corrections are new `CommissionLedgerEntry` rows of type `ADJUSTMENT` or `REVERSAL`, each
carrying the actor, a reason, and a reference to the entry it corrects. The ledger is
append-only, so what someone was told they earned remains readable after a correction.

`CommissionAccrual` is unique on `(collectionEventId, employeeId, planVersionId)`: the same
collection can never accrue twice for the same person under the same rules, whatever a
retrying source does.

---

## 7. Currency

**SAR only.** A collection or plan in any other currency is **refused with a clear error**,
not converted. There is no FX policy in this system to honour, and an invented rate in a pay
calculation is worse than a refusal.

---

## 8. What the money comes from — and why this is blocked

This system has **no invoice, payment, receipt or receivables model**. Verified against the
schema, not assumed. The general ledger exists but is an accounting-event sink, not a
receivables subledger.

Commission is therefore fed by an **adapter** with one implementation: a sandbox
`CollectionEvent` source, every row stamped `sourceSystem = "SANDBOX"`.

**The financial cycle is not integrated.** No accounting sync, no payment gateway, no payout
execution. `PREVIEW → ACCRUED → APPROVED → PAID` is modelled and auditable, but `PAID` records
that a payout was *recorded*, never that money moved. The commission screens state that the
collection source is a sandbox rather than implying a live figure.

Connecting a real collection source is a separate, explicitly-scoped piece of work.

---

## 9. Open decisions

None of these can be assumed safely; each needs a business answer.

1. **Late collection after period close** — current assumption in §5. Confirm or replace.
2. **Ownership fixing point** — when does attribution become final: at Won, at first invoice,
   or at collection? Currently the split in force at the collection date governs.
3. **Target bonuses** — `SalesTarget` carries a `bonusAmount`, held deliberately separate from
   commission. How a bonus is earned (all-or-nothing at 100%, pro-rata, stepped) is undefined
   and therefore not computed.
4. **Non-qualifying rules** — currently supplied per collection event by the source rather
   than derived from product categories. A category-based rule needs a policy first.
