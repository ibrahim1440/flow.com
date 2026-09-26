# Sales collections — the manually finance-verified workflow

What this adds, what it refuses, how it is proven, and how to accept it in five minutes.

> **Read this first.** A collection here is a **salesperson's claim that money arrived**,
> which becomes a fact when somebody in Finance agrees. It is stamped
> `MANUAL_FINANCE_VERIFICATION`. There is no bank feed, no statement matching and no
> accounting integration in this ERP. "Verified" means a person verified it.

---

## 1. The cycle, as server-side behaviour

Lead → Pipeline → Quotation → Won → Collection → Commission. Every arrow below is a
transaction on the server. None of it depends on a particular button, a page staying open,
or a browser finishing anything.

| Step | Trigger | What the server does |
| --- | --- | --- |
| Lead qualifies | An activity is logged with one of five engagement outcomes | Converts the lead through the existing `convertLead`, creates exactly one Opportunity in the configured Qualification stage, links activity ↔ lead ↔ customer ↔ deal, writes the stage event, returns the deal |
| Deal reaches Quotation | A quotation is issued | Moves the deal forward to the configured Quotation stage. Never backwards, never on a closed deal |
| Deal is Won | The customer's acceptance is recorded | Marks the deal Won in the same transaction as the acceptance, records the accepted quote and the timestamp, preserves the stage it was won on |
| Money is claimed | A rep records a collection | Derives tax and net from the accepted quotation, stores it `PENDING_VERIFICATION`. **Creates no commission** |
| Money is agreed | Finance approves | Writes one `CollectionEvent` stamped `MANUAL_FINANCE_VERIFICATION` and accrues commission on the approved **net** |
| Money is returned | Finance reverses | Marks the event `REVERSED`, re-accrues, which posts a negative adjustment. The original is never deleted |

**Importing leads creates nothing.** No Customer, no Opportunity. A lead enters the pipeline
only by a real interaction.

### The five outcomes that qualify a lead

`INTERESTED`, `MEETING_SCHEDULED`, `VISIT_SCHEDULED`, `MEETING_COMPLETED`, `VISIT_COMPLETED`.

The other five — `NO_ANSWER`, `LEFT_MESSAGE`, `FOLLOW_UP_REQUIRED`, `NOT_INTERESTED`,
`NOTE_ONLY` — do not. `NOT_INTERESTED` marks a lead Unqualified **only when no Opportunity
exists**; losing a live deal stays an explicit act with a required reason.

Qualification is idempotent: a second qualifying interaction links to the deal that already
exists and changes no stage. A deal past Qualification is never dragged back.

### Stages are resolved by configured purpose

Not by name (translated and editable), not by code (this deployment's are `UAT_QUALIFY` and
`UAT_PROPOSAL`), not by position (inserting a column would silently redirect the automation).
Set them in **Sales settings → Pipeline stages → Automation**. At most one stage per purpose.

- **Qualification unset** → qualification refuses and names the screen. There is nowhere to
  put the deal, so guessing would be worse.
- **Quotation unset** → the quotation is still issued; only the card does not move, and the
  response says so. An unset option must not stop a roastery sending a customer a price.

---

## 2. What recording a collection refuses

Checked in the service, behind a `FOR UPDATE` lock on the deal — not in the browser:

- zero, negative, or more than two decimal places
- a currency the accepted quotation is not in (there is no exchange-rate policy, so it is
  refused rather than converted at an invented rate)
- more than **what is available to submit** — the unpaid balance less what is already awaiting verification (the two are not the same number; see below)
- a deal with no accepted quotation
- another salesperson's deal (404, which does not confirm the deal exists)
- a replay of the same `idempotencyKey` by the same submitter
- a receipt dated in the future
- approving, rejecting or reversing something already terminal

## Two balances, and why one number was not enough

A deal has **two** figures that both look like "what is left", and for most of this module's
life the screen showed only the second under a word that means the first:

| | Definition | Answers |
| --- | --- | --- |
| **المتبقي غير المسدد** — unpaid balance | accepted total − approved collections | what the customer still owes |
| **المتاح لتسجيل تحصيل إضافي** — available to submit | unpaid balance − pending collections | how much more may be claimed right now |

They differ by exactly the pending total, so they coincide only while nothing is awaiting
verification — which is never, on a screen whose purpose is reviewing pending items.

Worked from the hosted fixture: a 1,150.00 quotation with 345.00 approved and 230.00 pending
has an unpaid balance of **805.00** and capacity of **575.00**. Before the fix the deal panel
showed 575.00 labelled «المتبقي» / "Outstanding", and a reviewer deciding on a payment would
have read the debt as 575.00.

**The arithmetic never changed.** `remainingGross` always carried
`total − approved − pending`, and the submission ceiling and its `FOR UPDATE` concurrency
check still read exactly that number. What changed is that the value now has an honest name
(`availableToSubmitGross`), the debt is computed and displayed beside it (`unpaidGross`), and
`remainingGross` remains as a deprecated alias so existing callers keep working.

**The salesperson never types the VAT.** They enter the gross received; the server splits it
using the document's own tax-to-gross ratio, and the settling payment takes whatever tax is
left so the document reconciles to the cent. Proportional, not rate-based, because a
quotation can carry lines at different rates and there is then no single "the VAT rate".

---

## 3. Evidence

PDF, JPEG or PNG, at most 5 MB, **identified by the file's own signature** — a PNG named
`.pdf` is stored as a PNG, and a file that is none of the three is refused whatever it claims.

Stored as bytes in `CollectionEvidence` with its checksum, size, proven MIME type, uploader
and collection. Not on the filesystem: the deployment's filesystem is ephemeral, so a receipt
written there is a receipt that disappears.

**There is no permanent public URL.** The only route that returns the bytes requires a
session, applies the same visibility rule as the collection list, and matches the evidence
against its collection in one query. The response is `attachment`, `nosniff`, sandboxed and
`no-store`.

---

## 4. Who may do what

Sub-privileges, not role names. Every one is enforced at the API, not by hiding a control.

| Ability | Privilege |
| --- | --- |
| Record a collection on an owned deal | `sales / collection_submit` |
| See the team's collections, not only my own | `sales / collection_view_team` |
| Verify (this is what creates commission) | `commissions / collection_verify` |
| Reject | `commissions / collection_reject` |
| Reverse an approved collection | `commissions / collection_reverse` |

### Finance holds no sales module

That is deliberate — Finance verifies collections, they do not read the pipeline. So the
verification queue and the evidence download accept **either** `sales` or `commissions`
(`requireAnyModule`), and what each caller sees is still decided by `collectionWhere`. Gating
them on `sales` alone had locked the queue and the receipts away from the only people who can
act on them.

### Finding the queue at all

Collections lives under Sales, so the nav item was gated on the sales module — which
Finance does not hold. The queue was therefore invisible to the only people who can act on
it, reachable by typing the URL and by nothing else. A nav item can now name a second way
in as an **ability**: Collections admits anyone holding `collection_verify`,
`collection_reject` or `collection_reverse`. An ability, deliberately, and not a role name.

### Why a decision is offered, or not

Per row, because the answer is per row: the same Finance user may decide one collection and
be refused the next because they recorded it. `collectionDecisionAbility` returns a verdict
for each of approve, reject and reverse, and the queue prints the reason where the button
would have been.

| Reason | Means |
| --- | --- |
| `OK` | the action is offered |
| `NO_PRIVILEGE` | no financial decision privilege — a sales manager, by default |
| `SELF_SUBMITTED` | you recorded this one; another member of Finance decides it |
| `NOT_PENDING` | already approved or rejected |
| `NOT_APPROVED` | only an approved collection can be reversed |

Self-approval is decided in two places on purpose. `approveCollection` refuses it as the
boundary; this exists so the screen can say *you recorded this one* rather than offering a
button that will 403.

### What opening a collection shows

Gross received, the derived VAT, the net basis commission is computed on, and — while it is
still pending — **what approving would be worth**. That last figure is projected by running
the real engine over the live period twice and taking the difference, so it stays correct
under tiering; a headline rate times the net would be wrong the moment a tier boundary fell
between the two. It is labelled an estimate and is in no total until the approval happens.

Evidence is listed with a download that goes to the one route returning the bytes.

### Why the action is offered, or not

One function — `collectionAction` — answers "may this person record a collection on this deal
right now, and if not why". Every surface renders its verdict rather than re-deriving the rule:

| Reason | What the screen says |
| --- | --- |
| `OK` | the primary «تسجيل تحصيل» button |
| `NO_PRIVILEGE` | names the permission and where it is granted |
| `NOT_YOUR_DEAL` | a collection is recorded by the deal's owner |
| `NO_ACCEPTED_DOCUMENT` | record the customer's acceptance first |
| `NOTHING_OUTSTANDING` | no banner — the figures already say fully collected |

**This is not the authorisation boundary.** `POST /api/sales/collections` re-checks ownership
and re-derives every amount behind a row lock, and refuses regardless of what a screen chose to
render. The verdict exists so the screen can state the true reason instead of hiding the
control, which is what it used to do.

**A privilege added in code does not reach an existing employee.** `Employee.permissions` is a
stored snapshot; a role provisioned before the key existed simply lacks it, and the feature
then looks missing rather than withheld. Refresh the Preview roles with
`scripts/sales-preview/reviewer-permissions.ts`, which updates permissions only —
`reviewer-accounts.ts` rotates PINs and would sign out whoever is mid-review.

**Separation of duties: whoever recorded a collection cannot decide it** — not approve, not
reject — even holding every privilege. There is no emergency exception in this release, and
none was invented. An exception nobody documented is how a rule stops being a rule.

---

## 5. Commission

Only an **APPROVED** collection creates commission, and the basis is the approved **net**,
excluding VAT. Pending and rejected are worth exactly zero.

The worked example, proven end to end against PostgreSQL:

```
gross 5,750.00   tax 750.00   net 5,000.00   rate 1%
  recorded  → commission 0.00        (pending is worth nothing)
  approved  → commission 50.00
```

- **Partial**: collecting 2,300.00 of that deal earns 1% of its 2,000.00 net — 20.00, not 50.00.
  The remaining 3,450.00 then adds **30.00**, the difference, not another 50.00.
- **Replay**: approving again adds 0.00 and reports itself as a replay.
- **Reversal**: posts a negative adjustment linked to the original, which is not deleted.
- **Pending estimate** may be shown to the rep. It is never added to payable, approved or
  outstanding totals.

Nothing about the existing engine changed: plan versions, share-before-rate, incremental
tiers, Riyadh periods and the append-only ledger all still apply. An approved collection is
simply a second source of `CollectionEvent`, beside the sandbox one.

---

## 6. The `-200.00` reconciliation warning — resolved, and what it was

The commission review screen reported **`off by -200.00`** against the preview data and told
the reviewer not to approve.

**Nothing was wrong with the money.** For `UAT Sales Rep`: 250.00 accrued across five
entries, 200.00 given back across four reversals, 50.00 owed, 80.00 already paid, 0.00
outstanding. Verified directly against the ledger.

**The control was comparing two different quantities.** An accrual row tracks its
collection's current contribution while still unapproved — reversing decrements it to zero
and the rows keep matching. Once approved or paid the row is **frozen**, because restating a
figure somebody has been told they earned is exactly what the append-only ledger exists to
prevent; a later reversal leaves the row alone and posts a compensating entry instead. So on
any period where an approved accrual had since been reversed, the raw row total and the
ledger were guaranteed to disagree.

A control that goes red whenever a refund has happened is one reviewers learn to click past.

**The fix** subtracts exactly those rows, identified structurally (approved or paid, against
an event now `REVERSED`), and shows the reversal total as its own figure on the row. Nothing
was hidden, no history deleted, no balance rewritten — the four reversals are real, they stay
in the ledger, and the screen now names them. A genuine mismatch still fires; the harness
fixture carries one on purpose.

---

## 7. Arabic interface, Latin digits

`0–9` everywhere, while the interface stays Arabic and right-to-left: amounts, percentages,
counts, dates (`25/09/2026`), times, phone numbers, document numbers (`Q-202609-0008`),
commission arithmetic, print. Formatters are centralised in
`src/app/dashboard/sales/_components/ui.tsx`; mixed-direction values are wrapped in `<bdi>`.

**No stored value or calculation changed.** This is presentation only.

`tests/harness/digits.spec.ts` renders every Sales and Commissions screen at 1440, 1024 and
390 and scans the **rendered DOM** for `٠١٢٣٤٥٦٧٨٩` and `۰۱۲۳۴۵۶۷۸۹` — a grep over source
would miss the ones a formatter produces, which is where this actually goes wrong. Two
negative-control tests plant a violation to prove the scanner can see one.

**The one exclusion**: customer-entered free text. A company name, a note, a rejection reason
is somebody's own writing, and rewriting their numerals would change what they said. It is
excluded *by value*, not by selector — `CUSTOMER_TEXT` in `tests/harness/routes.mjs` lists the
strings, and they are subtracted from a node before it is scanned. So a café called
«كافيه ٢١» passes while a formatter rendering «٥ عروض» into the same cell still fails.

---

## 8. Five-minute acceptance — دليل القبول في خمس دقائق

> بالعربية، وبالترتيب. كل خطوة تنتهي بشيء يمكن رؤيته على الشاشة.

**قبل البدء** — سجّل الدخول بحساب مندوب، ثم بحساب مالية. الحسابان مختلفان عمداً: من يسجّل
التحصيل لا يعتمده.

| # | الخطوة | ما يجب أن تراه |
| --- | --- | --- |
| ١ | **مندوب** · افتح «العملاء المحتملون»، اختر عميلاً، وسجّل نشاطاً بنتيجة «مهتم» | تظهر الصفقة فوراً في «مسار الصفقات» في عمود التأهيل، ويظهر زر «فتح الصفقة» |
| ٢ | سجّل نشاطاً آخر بنتيجة «اجتماع مُجدول» على نفس العميل | **لا تُنشأ صفقة ثانية.** يُربط النشاط بالصفقة نفسها ولا تتغيّر المرحلة |
| ٣ | أصدر عرض سعر على الصفقة | تنتقل البطاقة إلى عمود «عرض السعر» بنفسها |
| ٤ | سجّل قبول العميل للعرض | تصبح الصفقة «رابحة» دون الضغط على أي زر آخر |
| ٥ | في الصفقة، افتح لوحة «التحصيل» وسجّل تحصيلاً بالمبلغ الكامل، وأرفق ملف PDF | الضريبة والصافي **يحسبهما النظام** ويظهران للقراءة فقط. الحالة «بانتظار التحقق» |
| ٦ | افتح «عمولاتي» | العمولة **صفر**. التقدير معروض ومكتوب بجانبه أنه لا يدخل في أي مجموع |
| ٧ | حاول اعتماد التحصيل بحسابك أنت | **يُرفض.** من سجّل التحصيل لا يعتمده |
| ٨ | **مالية** · افتح «التحصيلات»، واعتمد التحصيل | تتغيّر الحالة إلى «معتمَد»، وتظهر العمولة باسم المندوب |
| ٩ | ارجع إلى «عمولاتي» بحساب المندوب | العمولة الآن ١٪ من **الصافي** — من ٥,٧٥٠٫٠٠ ر.س بضريبة ٧٥٠٫٠٠ تكون ٥٠٫٠٠ ر.س |
| ١٠ | **مالية** · اعكس التحصيل واكتب سبباً | القيد الأصلي **يبقى كما هو** بمن اعتمده ووقته، وتُكتب فوقه تسوية سالبة مرتبطة به |
| ١١ | تحقّق من الأرقام في كل شاشة | كل الأرقام بالصيغة اللاتينية ٠–٩ → `0–9`، والواجهة عربية من اليمين إلى اليسار |

**ما لا يجب قبوله**: أي شاشة تصف هذا بأنه تسوية بنكية أو تكامل محاسبي. الاعتماد هنا **تحقّق
بشري يدوي** من موظف مالية، لا أكثر.

---

## 9. How it is proven

| Suite | What it proves | Assertions |
| --- | --- | --- |
| `commission-engine` | The arithmetic, offline | 48 |
| `quotes-domain` | Quotation pricing and lifecycle, offline | 113 |
| `quote-discount-authz` | The discount gate cannot be forged, source-level | 17 |
| `follow-up-workflow` | Two-write scheduling, offline | 46 |
| `sales-rtl-audit` | RTL and responsive statics | 7 |
| `sales-lifecycle-collections` | Qualification rules, tax allocation, commission deltas, offline | 45 |
| `sales-commissions-db` | Constraints, concurrency, rollback — real PostgreSQL | 23 |
| `sales-security` | What the API refuses — real HTTP | 34 |
| **`sales-collections`** | **Constraints, races, separation of duties, the money — PostgreSQL and real parallel HTTP** | **114** |
| `sales-workflow` | The ordinary path end to end — real HTTP | 222 |
| | **Total** | **669** |

Plus `harness:ui` (130) and `digits.spec.ts` (51) against the real components at three widths.

**`sales-collections` drives genuinely parallel requests** — two `fetch` calls in one
`Promise.all`, on separate sessions, contending for the same row lock. A suite that calls the
service twice in sequence cannot exhibit a deadlock or a lost update at all; this one found a
real deadlock (see below).

### What these are not

- Offline suites use a stand-in transaction. They prove decisions, not persistence.
- `harness:ui` and `digits.spec.ts` mount real components against fixture `fetch`. They are
  rendering evidence. **They are not persistence or authorisation evidence.**
- A local run is a local run. It is not evidence about any deployment.

### Two defects these found

1. **A deadlock on concurrent qualification.** Inserting an `Activity` that carries a
   `leadId` takes `FOR KEY SHARE` on the Lead; `convertLead` then wants `FOR UPDATE`. Within
   one transaction that is a harmless upgrade; between two it is a cycle, and PostgreSQL
   breaks it by killing one — which the salesperson sees as a 500 on a call they logged
   correctly. Fixed by taking the exclusive lock before the insert.
2. **The reconciliation control**, section 6.

---

## 10. Data model

Additive only. No existing table was renamed or destructively altered, and no parallel
customer, employee, quotation, order or commission system was created — the workflow reuses
`convertLead`, `OpportunityStageEvent`, `Quote`, `CollectionEvent`, `CommissionAccrual` and
`CommissionLedgerEntry` as they are.

Two migrations, both applied to `sales_preview` only:

- `20260925130833_add_sales_collections` — `SalesCollection`, `CollectionEvidence`, three
  enums, and six hand-written CHECK constraints
- `20260925131140_add_pipeline_stage_purpose` — `PipelineStage.purpose`, unique

The constraints are not decoration; each is tested by attempting the write:

| Constraint | Refuses |
| --- | --- |
| `SalesCollection_amounts_positive` | zero or negative money |
| `SalesCollection_net_reconciles` | net that is not gross − tax |
| `SalesCollection_rejection_has_reason` | a rejection with no reason |
| `SalesCollection_reversal_has_reason` | a reversal with no reason |
| `SalesCollection_event_matches_status` | an approved row with no commission event, or a pending row that already has one |
| `CollectionEvidence_size_sane` | evidence above 5 MB |
| `@@unique([submittedById, idempotencyKey])` | one submitter reusing a key |
| `collectionEventId @unique` | two collections sharing one commission event |

`prisma migrate deploy` is **not** part of `npm run build`; the build is
`validate-env && prisma generate && next build`.

---

## 11. Provenance: what each record is for

The two halves of the commission model answer different questions, and conflating them is
what made a reversal hard to audit.

| | Contract | Mutable? |
| --- | --- | --- |
| `CommissionAccrual` | What one collection event **currently** contributes to a period | **Yes, while `ACCRUED`.** Frozen the moment it is `APPROVED` or `PAID` |
| `CommissionLedgerEntry` | A **movement** — money recognised or given back at a point in time | **No.** Append-only |

The accrual is deliberately a projection. `postDelta` replaces its base, split and effective
rate and increments its amount, so reversing a collection walks its row back towards zero
and the rows of a period keep summing to the period's total. That is why reconciliation
compares the ledger against the accrual rows *less the frozen-and-since-reversed ones*: an
approved row keeps the figure it was approved at while the ledger moves on.

The gap this closes: **the immutable half recorded no provenance.** A ledger row held an
amount, an employee and a period. The accrual it came from could legitimately be recomputed
afterwards, so once that happened nothing anywhere recorded what a movement had been awarded
on — and a negative row could be tied to the positive it compensated only by comparing
amounts and clocks.

### What a movement now carries

Written once, at the moment of the movement, and never updated:

| Field | What it fixes |
| --- | --- |
| `collectionEventId` | Which receipt the money came from |
| `accrualId` | Which accrual row it belongs to |
| `planVersionId` | Which plan governed it — a later plan revision cannot restate it |
| `qualifyingBase` | The share of that event's net the movement was computed on |
| `sharePercent` | The split in force at the time |
| `effectiveRatePercent` | The period's effective rate, which is why a tiered month's marginal amount is not base × headline rate |

### What a reversal compensates

`CommissionLedgerCorrection` joins a negative movement to the earlier movements it pays
back, **with the amount applied to each**. A join table rather than one nullable column
because the relationship is genuinely many-to-many in amount: reversing one collection in a
tiered month lowers the whole period's effective rate, so a single negative delta pays back
part of its own event's movement *and* part of movements belonging to other events.

Allocation happens at write time, in a defined order: **the reversed event's own earlier
movements first**, because that is where the money demonstrably came from, then the rest of
the period oldest-first, because the append-only log is the only defensible order in which
to unwind a tier change. Each target takes what it has left, so a partial reversal stops
part-way through one target and a split or tier change reaches across several.

Nothing consults an amount or a timestamp to *decide* correspondence — the event id does
that. Whatever cannot be allocated is reported as `unallocatedReversal` on the review
screen rather than hidden.

### Historical rows

`scripts/sales-preview/backfill-ledger-provenance.ts` links only what is provable: an
(employee, period) holding exactly one accrual has exactly one candidate. On the preview
database that was **1 movement of 24**; 18 are permanently ambiguous (two periods holding
9 movements against 2 and 5 accruals) and 5 are adjustments and payouts with no engine
accrual behind them. Reversal targets are not backfilled at all.

Even for the provable one it copies only the three **stable** identities — accrual,
collection event, plan version. It does not copy the base, split or rate, because the
accrual is a projection and its present values are not evidence of what a movement was
computed on months ago. Those stay null, which is honest where a plausible number would not
be.
