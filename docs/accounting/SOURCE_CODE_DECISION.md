# Source-code decision — independent implementation

Decision: the accounting module is implemented independently in BeanFlow's own stack. Third-party
accounting projects are used as **functional references only**. Evidence (licences, SHAs, manifests)
is in [SOURCES_AND_LICENSES.md](SOURCES_AND_LICENSES.md). Not legal advice.

## 1. Why the licence alone does not decide it

GPL, AGPL and LGPL all **permit** reuse, including commercial use. What they add are obligations
that depend on how the product is delivered:

| Licence | Candidate | Obligation trigger | What BeanFlow would owe |
|---|---|---|---|
| AGPLv3 | Bigcapital | Users interacting with a *modified* version over a network (§13) | Offer the complete Corresponding Source of the combined program to every user of the hosted ERP, under AGPLv3 |
| GPLv3 | ERPNext (accounts, stock, manufacturing, assets) | Conveying copies (distribution), not network use | Nothing while BeanFlow is only hosted by its owner; the whole combined work under GPLv3 as soon as any build is handed to a customer, franchisee, integrator or on-premise site |
| LGPLv3 | Odoo Community (`account`, `l10n_sa`, `l10n_sa_edi`) | Conveying; modified LGPL parts stay LGPL | Source of the LGPL parts (and modifications) on distribution; the rest may stay proprietary if the LGPL parts remain replaceable |
| MIT / ISC | Frappe framework; ZATCA candidates (`zatca-sdk`, `@jaicome/zatca-*`) | none beyond notice | Keep copyright and licence notices |

A port or translation (Python → TypeScript) is still a derivative work, so rewriting in another
language does not remove any of these obligations.

## 2. Compatibility with the product model

BeanFlow is a proprietary, closed-source, commercially hosted ERP. Today it is SaaS-only. That makes:

- **AGPL reuse incompatible with the product model.** It is legally allowed, but it requires
  publishing the ERP's source to its users. That is a business decision the owner has not made, and
  this work should not force it.
- **GPL reuse compatible only while BeanFlow is never distributed.** It would turn every future
  on-premise, offline, white-label or source-escrow request into a relicensing problem. The
  restriction would be invisible in the code and easy to breach by accident.
- **LGPL reuse workable for small, isolated, replaceable parts.** The only realistic example is
  ZATCA-specific artefacts such as Odoo's pre-hash XSL. Even there the official ZATCA specifications
  and the MIT-licensed SDK candidates cover the same ground without the obligation.

## 3. Architectural cost of reuse

Every candidate is inseparable from its framework:

| Candidate | Coupling | Reuse would mean |
|---|---|---|
| Bigcapital | NestJS + Knex/Objection on **MySQL**, database-per-tenant | Rewriting persistence and tenancy. Estimated 14–20 person-weeks for ledger + AR + AP + inventory, about the cost of an independent build |
| ERPNext | Frappe DocTypes (JSON metadata + Python controllers + `frappe.db`) | A translation, not a reuse. Estimated 18–27 person-weeks, and the result is GPL-derived |
| Odoo | Odoo ORM (`account.move`), QWeb, Python | Same as ERPNext. The full accounting reports and `l10n_sa_reports` are Enterprise-only (proprietary, not available) |

## 4. Alternatives considered

| # | Alternative | Result |
|---|---|---|
| A | Port code from ERPNext / Odoo / Bigcapital | Rejected: licence obligations (§1–2) plus framework coupling (§3), for no cost saving |
| B | Run ERPNext, Odoo Community or Bigcapital **unmodified as a separate service** ("sidecar") and integrate by API. Arm's-length communication generally does not make a combined work, so this is the licence-cleanest reuse | Rejected on requirements. The brief requires **one ledger, one PostgreSQL database, shared users, permissions and masters** inside the app shell. A sidecar means a second database (MySQL for Bigcapital), duplicate customers, suppliers, items and users, a sync layer that can drift, two permission systems, and a second hosting and upgrade burden. Bank-to-ledger without duplication and database-enforced posting controls would sit across a network boundary |
| C | Buy or connect an external accounting SaaS (for example Qoyod, which BeanFlow already exports to) | Kept as the **current operating fallback**: the existing Qoyod export remains until cutover. Not the target, because it does not meet the "native module, one ledger" requirement |
| D | Independent implementation from requirements, accounting standards and public regulatory specifications, using the references for behaviour only | **Chosen** |
| E | Adopt permissive (MIT) components where they are genuinely separable | Planned for ZATCA XML/signing/QR in the localisation stage, subject to its own evaluation (maintenance, test vectors, CSID flows). Recorded in the register |

## 5. Rules for using the references

- Reading public code and documentation to understand *behaviour* is allowed. Examples: how ERPNext
  reposts backdated stock valuation, how Odoo models reconciliation, and how Bigcapital locks
  transactions.
- No code, schema, migration, template or test text is copied. Behaviour is re-derived and written
  up in our own requirement, test and design documents (`ARCHITECTURE.md` ADRs,
  `EVENT_JOURNAL_MAP.md`).
- Any future permissive component is added to `SOURCES_AND_LICENSES.md` with its SHA, its licence
  text location and the notice it requires, before installation.

## 6. The cost of this choice, and how it is controlled

Independent implementation means BeanFlow carries the full correctness burden that mature projects
have already paid down. The controls:

1. **Invariants live in the database, not only in code.** Balanced entries (deferred check), immutable
   posted lines, open-period posting, four-eyes approval, exactly one journal per source event,
   policy gates. A bug in a service cannot post an unbalanced or unapproved entry.
2. **Tests at four levels:**
   - pure unit tests
   - database integration tests against real PostgreSQL, including attempts to bypass the triggers
     directly by SQL
   - HTTP authorisation tests
   - browser and visual tests against the Figma frames

   Each later stage adds the same four levels (see `TEST_RESULTS.md`).
3. **Reference behaviour as a test oracle.** Worked examples from public accounting documentation
   (moving average after a backdated receipt, landed-cost reallocation, partial reversal) are turned
   into fixed test cases with hand-computed expected values.
4. **Reconciliation reports as runtime checks.** Examples: the trial balance nets to zero; the
   commission subledger ties to the control account; later, AR/AP/inventory subledgers tie to their
   control accounts, and bank ties to the ledger. They are run in UAT and after cutover.
5. **Staged delivery** with a requirements matrix (`REQUIREMENTS_MATRIX.md`), so no area is called done
   without evidence.
