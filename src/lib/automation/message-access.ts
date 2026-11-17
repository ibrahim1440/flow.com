// R1-e (owner decisions 0–6, 17 Nov 2026): WHO may read and WHO may process (review / resend / cancel / retry) a row of
// «سجل رسائل الأتمتة» — WhatsApp and e-mail alike — and «الأرشيف». One rule, enforced on the server, in SQL, by every
// endpoint that reads these rows: the list, its search and its counters, the CSV export (archive ?all=1), the customer
// page's «آخر رسالة», and every action on a single id.
//
// Every row belongs to ONE department, decided by what it is about (first match wins):
//   test        recipientKind 'test' (the connection check, a status-rule test)
//   activation  subjectType 'Employee' / dedupeKey 'activation:…' (account activation and password-reset links)
//   qoyod       attachmentKind 'qoyod_pdf' (a «فاتورة قيود» copy sent from the invoice page)
//   invoices    subjectType 'SalesInvoice' (an invoice status message)
//   collection  subjectType 'SalesCollection'
//   orders      subjectType 'Order' or 'Delivery'
//   operations  subjectType 'RoastingBatch' or 'ProductionOrder' (production, QC, packaging; the QC guest invitation)
//   sales       subjectType 'Quote', 'Opportunity' or 'Activity' (quotation, deal stage, task due)
//   finance     subjectType 'FinApprovalRequest'
//   unknown     anything else (no subject, a subject type not listed here)
//
// WHO opens the log at all is unchanged (log-scope.ts opensMessageLog: the automation module, a sales holder, a customer
// manager, the administrator) — the department rule only narrows what each of them reads; it never adds a reader.
// READ = the department's EXISTING read permission AND the linked record in the viewer's scope (the record's own rule):
//   test        automation › manage_messages
//   activation  nobody but the administrator (links are issued only by requireAdminAction "users.credentials")
//   qoyod       canViewInvoices (sales › invoices_view, accounting › ar, or accounting + invoices_issue) and the
//   invoices    invoice's customer in scopedCustomerIds (the invoice routes' inScope)
//   collection  the sales or commissions module, and collectionScope (all, or only what the viewer submitted)
//   orders      the orders module, and the order in the viewer's book (orderInScope / orderedByOrForWhere)
//   operations  the production, qc or packaging module (they work the whole queue)
//   sales       quotation: the sales or accounting module, and quotesSeeAll or the deal's owner (api/sales/quotes/[id]);
//               deal / task: the sales module, and seesAllSales or its owner
//   finance     the finance module, and the request raised by / assigned to the viewer, or decidable by them (their
//               finance › *_approve sub, unassigned, a branch in their scope — approvalQueue)
//   unknown     DENIED (default deny)
// PROCESS = READ AND automation › manage_messages AND the permission of the ACTION itself (owner, 17 Nov 06:10 — viewing
// an invoice never resends it). The existing permission each department's action already needs:
//   test        automation › manage_messages
//   activation  the administrator, review only (never resent)
//   qoyod /     canIssueInvoices: sales › invoices_issue, or the accounting module with accounting › invoices_issue —
//   invoices    the permission that issues and sends invoices today (invoices_view and accounting › ar do not send)
//   collection  commissions › collection_verify / collection_reject / collection_reverse or accounting › receipts_confirm
//               (any collection); sales › collection_submit (only a collection the viewer submitted)
//   orders      orders › manage_status or orders › edit
//   operations  edit access on the production, qc or packaging module
//   sales       quotation: sales › quote_write or accounting › quotes_issue; deal: sales › deal_stage_move; task: its owner,
//               or sales › lead_assign
//   finance     who may decide the request (its finance › *_approve sub, unassigned, a branch in scope) or is assigned it
//
// THE EXCEPTION («المالك أو مدير مخوّل صراحةً»): the administrator — `role === "admin"`, the same test as
// requireAdminAction (auth-server.ts) — reads and processes every row, unknown ones included. No new permission exists
// for this; nobody else is exempt. What a resend may do is a separate rule (message-review.ts): an activation row is
// never resent (409 — a new link is issued from user management), a Qoyod copy only while its PDF can be reproduced.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { canEdit, hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { canIssueInvoices, canViewInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds } from "@/lib/services/invoicing/http";
import { collectionScope, customersScopedToOwner, orderedByOrForWhere, seesAllSales } from "@/lib/services/sales/scope";
import { quotesSeeAll } from "@/lib/services/sales/quote-access";
import { resolveScope, type FinanceActor } from "@/lib/finance/server/context";
import { opensMessageLog } from "./log-scope";

export type Viewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };
export type MessageSource = "whatsapp" | "email" | "archive";
export type Department = "test" | "activation" | "qoyod" | "invoices" | "collection" | "orders" | "operations" | "sales" | "finance" | "unknown";
export const DEPARTMENTS: readonly Department[] = ["test", "activation", "qoyod", "invoices", "collection", "orders", "operations", "sales", "finance", "unknown"];

const BOOK_CAP = 20_000;
const FIN_SUBS = ["budget_approve", "transfer_approve", "spend_override_approve", "period_close"] as const;

export const isAdministrator = (v: Viewer) => v.role === "admin";
const mod = (v: Viewer, m: string) => hasModuleAccess(v.permissions as Permissions, m);
const sub = (v: Viewer, m: string, s: string) => hasSubPrivilege(v.permissions as Permissions, m, s);
export const managesMessages = (v: Viewer) => isAdministrator(v) || (mod(v, "automation") && sub(v, "automation", "manage_messages"));

/**
 * The viewer's reach, resolved once per request: for each department either null (no access), "all", or the
 * record ids / owner the department's own rule allows. Lists are capped like the log's book (BOOK_CAP).
 */
export type Reach = {
  /** Gate low (orchestrator): the departments whose record list hit BOOK_CAP — the viewer may see fewer rows than
   *  their scope allows; the log says so (never silently). */
  capped?: ("invoices" | "orders")[];
  admin: boolean;
  manage: boolean;
  me: string;
  test: boolean;
  invoices: null | "all" | string[]; // customer ids
  collection: null | "all" | "own";
  orders: null | "all" | string[]; // order ids
  operations: boolean;
  quotes: null | "all" | "own";
  deals: null | "all" | "own";
  finance: null | { subs: string[]; branches: "all" | string[] };
  /** The action permissions (PROCESS), on top of READ and manage_messages. */
  act: { invoices: boolean; collection: null | "all" | "own"; orders: boolean; operations: boolean; quotes: boolean; deals: boolean; tasks: "all" | "own" };
};

/** The record list of `dept` was cut at BOOK_CAP: recorded on the reach (shown on the log) and warned in the server log —
 *  counts only, no ids. */
function capped(r: Reach, dept: "invoices" | "orders", total: number | null) {
  (r.capped ??= []).push(dept);
  console.warn(`[message-access] ${dept}: the viewer's record list was cut at ${BOOK_CAP}${total ? ` of ${total}` : "+"} — some of their messages are not listed`);
}

export async function reachOf(v: Viewer): Promise<Reach> {
  const admin = isAdministrator(v);
  const p = v.permissions as Permissions;
  const act: Reach["act"] = {
    invoices: canIssueInvoices(p),
    collection: sub(v, "commissions", "collection_verify") || sub(v, "commissions", "collection_reject") || sub(v, "commissions", "collection_reverse") || sub(v, "accounting", "receipts_confirm")
      ? "all" : sub(v, "sales", "collection_submit") ? "own" : null,
    orders: sub(v, "orders", "manage_status") || sub(v, "orders", "edit"),
    operations: canEdit(p, "production") || canEdit(p, "qc") || canEdit(p, "packaging"),
    quotes: sub(v, "sales", "quote_write") || (mod(v, "accounting") && sub(v, "accounting", "quotes_issue")),
    deals: sub(v, "sales", "deal_stage_move"),
    tasks: sub(v, "sales", "lead_assign") ? "all" : "own",
  };
  const base: Reach = { admin, manage: managesMessages(v), me: v.id, test: false, invoices: null, collection: null, orders: null, operations: false, quotes: null, deals: null, finance: null, act };
  if (admin) return { ...base, test: true, invoices: "all", collection: "all", orders: "all", operations: true, quotes: "all", deals: "all", finance: { subs: [...FIN_SUBS], branches: "all" },
    act: { invoices: true, collection: "all", orders: true, operations: true, quotes: true, deals: true, tasks: "all" } };
  // The log's audience is unchanged (log-scope.ts): the department rule narrows what its readers see, never adds a reader.
  if (!opensMessageLog(v)) return { ...base, manage: false };
  base.test = base.manage;
  if (canViewInvoices(p)) {
    const ids = await scopedCustomerIds({ id: v.id, permissions: p });
    base.invoices = ids === null ? "all" : ids.slice(0, BOOK_CAP);
    if (ids !== null && ids.length > BOOK_CAP) capped(base, "invoices", ids.length);
  }
  if (mod(v, "sales") || mod(v, "commissions")) base.collection = collectionScope(p, v.id).all ? "all" : "own";
  if (mod(v, "orders")) {
    base.orders = customersScopedToOwner(v)
      ? (await prisma.order.findMany({ where: orderedByOrForWhere(v.id), select: { id: true }, take: BOOK_CAP + 1 })).map((o) => o.id)
      : "all";
    if (Array.isArray(base.orders) && base.orders.length > BOOK_CAP) { base.orders = base.orders.slice(0, BOOK_CAP); capped(base, "orders", null); }
  }
  base.operations = mod(v, "production") || mod(v, "qc") || mod(v, "packaging");
  if (mod(v, "sales") || mod(v, "accounting")) base.quotes = quotesSeeAll(p) ? "all" : "own";
  if (mod(v, "sales")) base.deals = seesAllSales(p) ? "all" : "own";
  if (mod(v, "finance")) {
    const scope = await resolveScope({ id: v.id, role: String(v.role ?? ""), permissions: p } as FinanceActor);
    base.finance = { subs: FIN_SUBS.filter((s) => sub(v, "finance", s)), branches: scope.all ? "all" : scope.branchKeys };
  }
  return base;
}

/** The department of a row, as SQL (one CASE, first match wins) — for counters and the tests. */
export function departmentSql(source: MessageSource, a = "m"): Prisma.Sql {
  const t = Prisma.raw(a);
  if (source === "archive") {
    return Prisma.sql`CASE
      WHEN ${t}."subjectType" = 'Employee' THEN 'activation'
      WHEN ${t}."subjectType" = 'SalesInvoice' AND ${t}."docKind" = 'qoyod_pdf' THEN 'qoyod'
      WHEN ${t}."subjectType" = 'SalesInvoice' THEN 'invoices'
      WHEN ${t}."subjectType" = 'SalesCollection' THEN 'collection'
      WHEN ${t}."subjectType" IN ('Order', 'Delivery') THEN 'orders'
      WHEN ${t}."subjectType" IN ('RoastingBatch', 'ProductionOrder') THEN 'operations'
      WHEN ${t}."subjectType" IN ('Quote', 'Opportunity', 'Activity') THEN 'sales'
      WHEN ${t}."subjectType" = 'FinApprovalRequest' THEN 'finance'
      ELSE 'unknown' END`;
  }
  return Prisma.sql`CASE
    WHEN ${t}."recipientKind" = 'test' THEN 'test'
    WHEN ${t}."subjectType" = 'Employee' OR ${t}."dedupeKey" LIKE 'activation:%' THEN 'activation'
    WHEN ${t}."attachmentKind" = 'qoyod_pdf' THEN 'qoyod'
    WHEN ${t}."subjectType" = 'SalesInvoice' THEN 'invoices'
    WHEN ${t}."subjectType" = 'SalesCollection' THEN 'collection'
    WHEN ${t}."subjectType" IN ('Order', 'Delivery') THEN 'orders'
    WHEN ${t}."subjectType" IN ('RoastingBatch', 'ProductionOrder') THEN 'operations'
    WHEN ${t}."subjectType" IN ('Quote', 'Opportunity', 'Activity') THEN 'sales'
    WHEN ${t}."subjectType" = 'FinApprovalRequest' THEN 'finance'
    ELSE 'unknown' END`;
}

const ids = (list: string[]) => (list.length ? Prisma.sql`ANY(${list}::text[])` : Prisma.sql`ANY(ARRAY[]::text[])`);

/**
 * May the viewer READ the row aliased `a`? A boolean SQL expression built from the reach — the WHERE of every read.
 * Default deny: a department not granted below contributes FALSE, and an unknown row is the administrator's only.
 */
export function readableSql(r: Reach, source: MessageSource, a = "m"): Prisma.Sql {
  if (r.admin) return Prisma.sql`TRUE`;
  const t = Prisma.raw(a);
  const dept = departmentSql(source, a);
  const parts: Prisma.Sql[] = [];
  if (r.test && source !== "archive") parts.push(Prisma.sql`(${dept}) = 'test'`);
  // activation: the administrator only (above) — no part for anybody else.
  if (r.invoices) {
    const rec = r.invoices === "all" ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (SELECT 1 FROM "SalesInvoice" i WHERE i.id = ${t}."subjectId" AND i."customerId" = ${ids(r.invoices)})`;
    parts.push(Prisma.sql`((${dept}) IN ('qoyod', 'invoices') AND ${rec})`);
  }
  if (r.collection) {
    const rec = r.collection === "all" ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (SELECT 1 FROM "SalesCollection" c WHERE c.id = ${t}."subjectId" AND c."submittedById" = ${r.me})`;
    parts.push(Prisma.sql`((${dept}) = 'collection' AND ${rec})`);
  }
  if (r.orders) {
    const rec = r.orders === "all" ? Prisma.sql`TRUE`
      : Prisma.sql`(
          (${t}."subjectType" = 'Order' AND ${t}."subjectId" = ${ids(r.orders)})
          OR (${t}."subjectType" = 'Delivery' AND EXISTS (SELECT 1 FROM "Delivery" d JOIN "OrderItem" oi ON oi.id = d."orderItemId" WHERE d.id = ${t}."subjectId" AND oi."orderId" = ${ids(r.orders)})))`;
    parts.push(Prisma.sql`((${dept}) = 'orders' AND ${rec})`);
  }
  if (r.operations) parts.push(Prisma.sql`(${dept}) = 'operations'`);
  if (r.quotes) {
    const rec = r.quotes === "all" ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (SELECT 1 FROM "Quote" q JOIN "Opportunity" o ON o.id = q."opportunityId" WHERE q.id = ${t}."subjectId" AND o."ownerId" = ${r.me})`;
    parts.push(Prisma.sql`(${t}."subjectType" = 'Quote' AND (${dept}) = 'sales' AND ${rec})`);
  }
  if (r.deals) {
    const own = r.deals === "all";
    parts.push(Prisma.sql`(${t}."subjectType" = 'Opportunity' AND (${dept}) = 'sales' AND ${own ? Prisma.sql`TRUE` : Prisma.sql`EXISTS (SELECT 1 FROM "Opportunity" o WHERE o.id = ${t}."subjectId" AND o."ownerId" = ${r.me})`})`);
    parts.push(Prisma.sql`(${t}."subjectType" = 'Activity' AND (${dept}) = 'sales' AND ${own ? Prisma.sql`TRUE` : Prisma.sql`EXISTS (SELECT 1 FROM "Activity" x WHERE x.id = ${t}."subjectId" AND x."ownerId" = ${r.me})`})`);
  }
  if (r.finance) {
    const branch = r.finance.branches === "all" ? Prisma.sql`TRUE` : Prisma.sql`f."branchKey" = ${ids(r.finance.branches)}`;
    const decide = r.finance.subs.length ? Prisma.sql`(f."assignedToId" IS NULL AND f."requiredSub" = ${ids(r.finance.subs)} AND ${branch})` : Prisma.sql`FALSE`;
    parts.push(Prisma.sql`((${dept}) = 'finance' AND EXISTS (SELECT 1 FROM "FinApprovalRequest" f WHERE f.id = ${t}."subjectId" AND (f."requestedBy" = ${r.me} OR f."assignedToId" = ${r.me} OR ${decide})))`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, " OR ")})` : Prisma.sql`FALSE`;
}

/** The action permission of the row's department (see the table above) — no read rule in it; processableSql adds that. */
function actionSql(r: Reach, source: Exclude<MessageSource, "archive">, a: string): Prisma.Sql {
  if (r.admin) return Prisma.sql`TRUE`;
  const t = Prisma.raw(a);
  const dept = departmentSql(source, a);
  const parts: Prisma.Sql[] = [Prisma.sql`(${dept}) = 'test'`]; // manage_messages is checked by the caller
  if (r.act.invoices) parts.push(Prisma.sql`(${dept}) IN ('qoyod', 'invoices')`);
  if (r.act.collection === "all") parts.push(Prisma.sql`(${dept}) = 'collection'`);
  if (r.act.collection === "own") parts.push(Prisma.sql`((${dept}) = 'collection' AND EXISTS (SELECT 1 FROM "SalesCollection" c WHERE c.id = ${t}."subjectId" AND c."submittedById" = ${r.me}))`);
  if (r.act.orders) parts.push(Prisma.sql`(${dept}) = 'orders'`);
  if (r.act.operations) parts.push(Prisma.sql`(${dept}) = 'operations'`);
  if (r.act.quotes) parts.push(Prisma.sql`${t}."subjectType" = 'Quote'`);
  if (r.act.deals) parts.push(Prisma.sql`${t}."subjectType" = 'Opportunity'`);
  parts.push(r.act.tasks === "all" ? Prisma.sql`${t}."subjectType" = 'Activity'`
    : Prisma.sql`(${t}."subjectType" = 'Activity' AND EXISTS (SELECT 1 FROM "Activity" x WHERE x.id = ${t}."subjectId" AND x."ownerId" = ${r.me}))`);
  if (r.finance) {
    const branch = r.finance.branches === "all" ? Prisma.sql`TRUE` : Prisma.sql`f."branchKey" = ${ids(r.finance.branches)}`;
    const decide = r.finance.subs.length ? Prisma.sql`(f."assignedToId" IS NULL AND f."requiredSub" = ${ids(r.finance.subs)} AND ${branch})` : Prisma.sql`FALSE`;
    parts.push(Prisma.sql`((${dept}) = 'finance' AND EXISTS (SELECT 1 FROM "FinApprovalRequest" f WHERE f.id = ${t}."subjectId" AND (f."assignedToId" = ${r.me} OR ${decide})))`);
  }
  return Prisma.sql`(${Prisma.join(parts, " OR ")})`;
}

/** May the viewer PROCESS the row? READ AND manage_messages AND the department's action permission. */
export function processableSql(r: Reach, source: Exclude<MessageSource, "archive">, a = "m"): Prisma.Sql {
  return r.manage ? Prisma.sql`(${readableSql(r, source, a)} AND ${actionSql(r, source, a)})` : Prisma.sql`FALSE`;
}

const TABLE = { whatsapp: Prisma.raw(`"WhatsAppMessage"`), email: Prisma.raw(`"EmailMessage"`) } as const;

/**
 * The single-id gate for an action: 404 when the viewer may not read the row (or it does not exist — the same answer,
 * so an id never confirms that another department's message exists), 403 when they may read it but not process it.
 */
export async function gateMessage(v: Viewer, channel: "whatsapp" | "email", id: string, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<{ ok: true; department: Department } | { ok: false; status: 403 | 404 }> {
  const r = await reachOf(v);
  const rows = await db.$queryRaw<{ dept: Department; can: boolean }[]>`
    SELECT ${departmentSql(channel)} AS dept, ${processableSql(r, channel)} AS can
    FROM ${TABLE[channel]} m WHERE m.id = ${id} AND ${readableSql(r, channel)}`;
  if (!rows.length) return { ok: false, status: 404 };
  if (!rows[0].can) return { ok: false, status: 403 };
  return { ok: true, department: rows[0].dept };
}
