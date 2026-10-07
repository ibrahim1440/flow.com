# WhatsApp Automation

Rules that send WhatsApp messages when something happens in the ERP:

> **When** an event happens → **if** its conditions hold → **do** the steps, in order.

A step is a WhatsApp message to a recipient, rendered from a template, or a wait that delays every
later step. Most rules message staff — the order owner, the roaster, a sales rep, an approver.
Customers can be messaged too, and can opt out.

Outbound only. Nothing here reads incoming WhatsApp messages or turns them into ERP records.

---

## 1. Where things are

| Piece | Path |
|---|---|
| Event catalogue (events, variables, recipients) | `src/lib/automation/catalog.ts` |
| Rule shape and validator | `src/lib/automation/rules.ts` |
| Templates `{{variable}}` | `src/lib/automation/template.ts` |
| Conditions | `src/lib/automation/conditions.ts` |
| Phone normalisation (`05…` → `9665…`) | `src/lib/automation/phone.ts` |
| Raising an event (the outbox write) | `src/lib/automation/emit.ts` |
| Reading an event's variables and recipients | `src/lib/automation/context.ts` |
| Dispatcher (events → messages → WhatsApp) | `src/lib/automation/dispatcher.ts` |
| Sending mode | `src/lib/automation/settings.ts` |
| WhatsApp server client (Evolution API 2.x) | `src/lib/whatsapp/evolution.ts` |
| Screens | `src/app/dashboard/automation/**` |
| API | `src/app/api/automation/**` |
| Tables | `AutomationRule`, `AutomationEvent`, `AutomationRun`, `WhatsAppMessage`, `WhatsAppSendAttempt`, `AutomationSettings`, plus `Customer.whatsappOptOut` |
| Migration | `prisma/migrations/20261006120000_whatsapp_automation` (expand-only) |
| Unit tests | `tests/automation/*.test.ts` — `npm run test:automation:unit` |

---

## 2. Events

| Event | Raised in | Recipients it can resolve |
|---|---|---|
| `order.created` | `POST /api/orders`, `POST /api/sales/quotes/[id]/create-order` | customer, actor |
| `order.status_changed` | `orders/[id]/preparation-review`, `orders/[id]/approve`, `orders/[id]/status` | customer, order owner, actor |
| `delivery.recorded` | `POST /api/deliveries` (both the unit and the kg path) | customer, order owner, actor |
| `production.batch_roasted` | `POST /api/roasting-batches` | order owner, actor |
| `qc.batch_finalized` | `qc/[batchId]/finalize`, `qc-records/bulk-finalize` | order owner, actor |
| `packaging.completed` | `roasting-batches/[id]/pack` | order owner, actor |
| `production.order_created` | `order-items/[id]/production-requirement` | order owner, actor |
| `sales.quote_status_changed` | `sales/quotes/[id]/transition` | customer, deal owner, actor |
| `sales.task_due` | the dispatcher's sweep (an open activity whose `dueAt` passed) | task owner |
| `finance.approval_requested` | `createApproval` (finance) | approver(s), requester |
| `finance.approval_decided` | `decideApproval`, `cancelApproval` (finance) | requester, approver |

Every step can also send to **a specific employee** (their `Employee.phoneNumber`) or **a fixed number**.

"Approver" for a request with no named approver is every active employee who could decide it: holds
the request's finance sub-privilege, has the branch in scope, and is not the requester — the same
test `assertMayDecide` applies.

### Adding an event

1. Describe it in `catalog.ts` (key, labels, variables, recipients).
2. Call `emitAutomationEvent(tx, …)` in the **same transaction** as the change it describes.
3. Add a resolver in `context.ts`.

`tests/automation/catalog.test.ts` fails if a catalogued event has no resolver.

---

## 3. How a message is produced

```
business transaction ──► AutomationEvent (PENDING)          same transaction: exists iff the change committed
        │
        └─ after the response (Next `after`) ──► dispatcher
                 1. recover sends interrupted mid-flight
                 2. sweep: raise sales.task_due for tasks that fell due   (≤ once a minute)
                 3. each PENDING event, in its own short transaction, row-locked (SKIP LOCKED):
                      for each active rule on that event:
                        AutomationRun (rule × event, unique)  — matched or not, and why
                        render each message step → WhatsAppMessage rows (unique dedupeKey)
                 4. send due QUEUED messages, one at a time, 1.5 s apart, if WhatsApp is connected
```

- **Never inline.** The business route only inserts the event row. A slow, down or misconfigured
  WhatsApp server can never fail or delay an order, a delivery or a QC decision.
- **Free when unused.** An event no active rule listens to is not written at all. The listened set is
  cached per server instance for 30 s (cleared on rule save on that instance).
- **Exactly-once per rule and event.** `AutomationRun (ruleId, eventId)` and `WhatsAppMessage.dedupeKey`
  are unique; concurrent dispatchers share the work instead of repeating it.
- **Retries.** A transient failure (unreachable, timeout, 429, 5xx, rejected key) is retried after
  1, 5, 15 and 60 minutes; after 5 attempts the message is FAILED. A permanent failure (for example
  "this number is not on WhatsApp") fails at once. A rejected key or an unreachable server stops the
  batch, so the remaining messages keep their attempts.
- **Interrupted sends** (a message left `SENDING` for 5 minutes) become FAILED with a note that the
  message may or may not have arrived. Only a person retries those.
- **Late is worse than never.** An event older than 24 h is not processed, and a message not sent
  within 24 h of its time expires.
- **Names and phones are read when the event is processed**, not when it happens; the event row
  carries only the facts of its moment (from/to status, quantity delivered, QC outcome).
- **Retention.** Processed events older than 90 days are deleted; messages keep their own copy of
  what they need (rule name, event type, subject, rendered body).

---

## 4. Sending modes

Two keys must turn before a real recipient receives anything:

| Mode (WhatsApp screen) | Behaviour |
|---|---|
| **OFF** (default) | Rules run and the log shows what they would have sent, marked "not sent". |
| **TEST** | Every message goes to the single test number, whoever it was for. |
| **LIVE** | Messages go to the real recipients — only if the server also sets `WHATSAPP_LIVE_ENABLED=true`. Without it LIVE behaves as OFF. |

`WHATSAPP_LIVE_ENABLED` is what keeps a preview, a local copy or a restored backup — any database
holding real phone numbers — from messaging those people because a settings row said LIVE.

Customers with **"does not want WhatsApp messages"** (`Customer.whatsappOptOut`) are skipped in every mode.

---

## 5. The WhatsApp server

Evolution API 2.x, one instance. Configured by environment only:

```
WHATSAPP_API_URL=https://…
WHATSAPP_INSTANCE=…
WHATSAPP_API_KEY=…            # sent only as the `apikey` header, server-side
WHATSAPP_LIVE_ENABLED=true    # only where real recipients may be messaged
CRON_SECRET=…                 # optional: lets a scheduler call /api/automation/dispatch
```

The client (`src/lib/whatsapp/evolution.ts`, `server-only`) can do exactly five things: get a QR or a
pairing code, read the connection state, send a text, log the phone out, restart. **It has no call to
delete or create an instance, and must never get one**: deleting the instance cannot be undone and the
number cannot be recreated from here. The key never reaches the browser, a response, or a log line.

The webhook settings of the instance are not touched (no incoming messages are needed).

---

## 6. Scheduling

Events are processed right after the request that raised them. A scheduler is still needed for:
delayed steps (waits), retries, and tasks falling due while nobody is using the system.

`GET|POST /api/automation/dispatch` runs one pass. It accepts `Authorization: Bearer <CRON_SECRET>`
(what Vercel Cron sends) or a signed-in user with `automation.manage_messages` ("Process now" in the log).

`vercel.json` is deliberately **not** changed: on the Hobby plan Vercel refuses a cron that runs more
than once a day, and that would fail the deployment. Pick one per deployment:

- Vercel Pro: add `"crons": [{ "path": "/api/automation/dispatch", "schedule": "* * * * *" }]` and set `CRON_SECRET`.
- Any external scheduler calling the route every minute with the bearer header.
- Without either, everything still works on traffic; waits and retries just run late.

---

## 7. Permissions

New module `automation`:

| Key | Allows |
|---|---|
| (view) | See rules and the message log |
| `manage_rules` | Create, edit, switch on/off, delete rules |
| `manage_connection` | Link/unlink the phone, restart, set the sending mode, send a test |
| `manage_messages` | Retry or cancel a message; run the dispatcher by hand |

Only the default **admin** role gets it automatically. Existing employees — admins included — hold a
stored permission document without the new keys, so they must be granted it once in Employees.

Admins can now also set an employee's WhatsApp number in Employees (it was self-service only, in Profile).

---

## 8. Relationship to `docs/integration-readiness.md`

That document defers integrations until a Tenant model exists. This feature was requested by the owner
as a scoped exception, built to the document's own messaging rules:

| integration-readiness rule | Here |
|---|---|
| Outbound only | Yes. No incoming message is read. |
| Asynchronous, never blocks an ERP response | Outbox row in the business transaction; sending after the response. |
| Log send attempts | `WhatsAppMessage` (one per message) + `WhatsAppSendAttempt` (append-only, one per call). Delivery receipts would need the webhook and are not collected. |
| Credentials never in code, logs or responses | Environment only; never returned or logged. |
| Retry with backoff, dead-letter | 1/5/15/60 min, then FAILED; retried only by a person. |
| Tenant-owned, `tenantId` when the Tenant model exists | Every new table is tenant-owned; no `tenantId` yet, per `docs/saas-readiness.md`. |

When the generic `IntegrationJob` / `IntegrationLog` design is approved, `WhatsAppMessage` and
`WhatsAppSendAttempt` are its messaging specialisation and can be migrated into it.
