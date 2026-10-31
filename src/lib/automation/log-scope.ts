// Who may read «سجل الرسائل» and «الأرشيف», and which rows (fix round 2, council b25 seat 5 N5): the manager who switches a
// customer's e-mails back on must be able to see whether the next e-mail reached them, and a rep the messages about their
// own customers. Read-only for everyone but the automation module (retry / cancel / dispatch stay manage_messages).
import { prisma } from "@/lib/db";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { customersScopedToOwner, orderedByOrForWhere, seesAllSales } from "@/lib/services/sales/scope";
import { quotesSeeAll } from "@/lib/services/sales/quote-access";
import { Prisma } from "@/generated/prisma/client";
import { isCustomerManager } from "@/lib/services/customers/email-consent";

type Viewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };

/**
 * all       — the automation module (and the administrator): every row, both channels, staff messages included.
 * customers — a manager (customers at edit and not limited to a book, or a sales manager): every message TO A CUSTOMER.
 * book      — any other sales holder: the messages to customers, each scoped BY WHAT IT IS ABOUT, with the record's own rule
 *             (fix round 3, gate D3): a quotation's message only when the viewer may open that quotation (their deal —
 *             api/sales/quotes/[id]: quotesSeeAll or opportunity.ownerId); an order's only for the orders they may open
 *             (orderedByOrForWhere); anything else only for the customers they are the account owner of (not the
 *             unassigned pool, not "holds a deal"). A sales holder with an operations duty (not limited to a book for
 *             customers and orders) keeps orders and customers unrestricted, but quotations stay their own.
 *             A list that is null is unrestricted.
 */
export type LogScope =
  | { kind: "all" }
  | { kind: "customers" }
  | { kind: "book"; customerIds: string[] | null; orderIds: string[] | null; quoteIds: string[] | null };

const BOOK_CAP = 20_000;

export function logScopeKind(user: Viewer): LogScope["kind"] | null {
  const p = user.permissions as Permissions;
  if (hasModuleAccess(p, "automation")) return "all";
  if (isCustomerManager(user) || (hasModuleAccess(p, "sales") && seesAllSales(p))) return "customers";
  if (hasModuleAccess(p, "sales")) return "book";
  return null;
}

export async function logScopeFor(user: Viewer): Promise<LogScope | null> {
  const kind = logScopeKind(user);
  if (kind !== "book") return kind ? { kind } : null;
  const p = user.permissions as Permissions;
  const scoped = customersScopedToOwner(user);
  const [customers, orders, quotes] = await Promise.all([
    scoped ? prisma.customer.findMany({ where: { accountOwnerId: user.id }, select: { id: true }, take: BOOK_CAP }) : null,
    scoped ? prisma.order.findMany({ where: orderedByOrForWhere(user.id), select: { id: true }, take: BOOK_CAP }) : null,
    quotesSeeAll(p) ? null : prisma.quote.findMany({ where: { opportunity: { ownerId: user.id } }, select: { id: true }, take: BOOK_CAP }),
  ]);
  return { kind: "book", customerIds: customers?.map((c) => c.id) ?? null, orderIds: orders?.map((o) => o.id) ?? null, quoteIds: quotes?.map((q) => q.id) ?? null };
}

type BookScope = Extract<LogScope, { kind: "book" }>;
const inList = (ids: string[] | null) => (ids ? { in: ids } : undefined);
const OTHER_SUBJECT = { OR: [{ subjectType: null }, { subjectType: { notIn: ["Quote", "Order"] } }] };

/** The one subject-aware rule, as a Prisma filter for the e-mail log (it carries customerId). */
export function bookEmailWhere(s: BookScope): Prisma.EmailMessageWhereInput {
  return {
    recipientKind: "customer",
    OR: [
      { subjectType: "Quote", ...(s.quoteIds ? { subjectId: inList(s.quoteIds) } : {}) },
      { subjectType: "Order", ...(s.orderIds ? { subjectId: inList(s.orderIds) } : {}) },
      { AND: [OTHER_SUBJECT, s.customerIds ? { customerId: inList(s.customerIds) } : {}] },
    ],
  };
}

/** The same for WhatsApp (no customerId column: another subject is shown only when customers are unrestricted). */
export function bookWhatsAppWhere(s: BookScope): Prisma.WhatsAppMessageWhereInput {
  return {
    recipientKind: "customer",
    OR: [
      { subjectType: "Quote", ...(s.quoteIds ? { subjectId: inList(s.quoteIds) } : {}) },
      { subjectType: "Order", ...(s.orderIds ? { subjectId: inList(s.orderIds) } : {}) },
      ...(s.customerIds ? [] : [OTHER_SUBJECT]),
    ],
  };
}

/** The same for the archive (no recipientKind: a customer's message is one with a customer). */
export function bookArchiveWhere(s: BookScope): Prisma.MessageArchiveWhereInput {
  return {
    customerId: { not: null },
    OR: [
      { subjectType: "Quote", ...(s.quoteIds ? { subjectId: inList(s.quoteIds) } : {}) },
      { subjectType: "Order", ...(s.orderIds ? { subjectId: inList(s.orderIds) } : {}) },
      { AND: [OTHER_SUBJECT, s.customerIds ? { customerId: inList(s.customerIds) } : {}] },
    ],
  };
}

/** Raw-SQL twins of the above for the paged UNION of the two logs (messages route). */
export function bookSql(s: BookScope, table: "email" | "whatsapp"): Prisma.Sql {
  const q = s.quoteIds ? Prisma.sql`AND "subjectId" = ANY(${s.quoteIds})` : Prisma.empty;
  const o = s.orderIds ? Prisma.sql`AND "subjectId" = ANY(${s.orderIds})` : Prisma.empty;
  const other = table === "email"
    ? Prisma.sql`OR (coalesce("subjectType", '') NOT IN ('Quote', 'Order') ${s.customerIds ? Prisma.sql`AND "customerId" = ANY(${s.customerIds})` : Prisma.empty})`
    : s.customerIds ? Prisma.empty : Prisma.sql`OR coalesce("subjectType", '') NOT IN ('Quote', 'Order')`;
  return Prisma.sql`AND "recipientKind" = 'customer' AND (("subjectType" = 'Quote' ${q}) OR ("subjectType" = 'Order' ${o}) ${other})`;
}
