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
- more than the outstanding balance, **counting what is already awaiting verification**
- a deal with no accepted quotation
- another salesperson's deal (404, which does not confirm the deal exists)
- a replay of the same `idempotencyKey` by the same submitter
- a receipt dated in the future
- approving, rejecting or reversing something already terminal

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
