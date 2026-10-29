// Sales invoicing A2 — the AR sub-ledger: customer open items, applying receipts (approved SalesCollection rows)
// and credit-note credit to invoices, the statement of account, the aging, and the two hooks of the collection
// workflow (approved → RECEIVED with automatic application to the receipt's order; reversed → every posting of
// the receipt reversed and its applications reversed). Pure arithmetic in ./ar-math.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { riyadhDay, dayText } from "@/lib/accounting/dates";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { reverseEntry } from "@/lib/accounting/posting-engine";
import { agingOf, allocateFifo, applicationRefusal, daysOverdue, statementOf, openOf, unappliedOf, type CreditItem, type DebitItem, type StatementMove } from "./ar-math";
import { postApplication, postReceiptReceived, postedEntry, reverseReceiptEntries } from "./postings";
import { refuseInv, refuseWith } from "./refusals";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
const D = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const todayRiyadh = () => dayText(riyadhDay());

/** The customer of a receipt: its own customerId, else its deal's. */
async function receiptCustomer(db: Db, c: { customerId: string | null; opportunityId: string | null }): Promise<string | null> {
  if (c.customerId) return c.customerId;
  if (!c.opportunityId) return null;
  const o = await db.opportunity.findUnique({ where: { id: c.opportunityId }, select: { customerId: true } });
  return o?.customerId ?? null;
}

/** Every AR item of the given customers (null = all customers with any). */
export async function arItems(db: Db, customerIds: string[] | null) {
  const inCust = customerIds ? { customerId: { in: customerIds } } : {};
  const [docs, apps, receipts] = await Promise.all([
    db.salesInvoice.findMany({
      where: { status: "ISSUED", ...inCust },
      select: { id: true, kind: true, number: true, customerId: true, issueDate: true, dueDate: true, grandTotal: true, issuedAt: true, originalInvoiceId: true, family: true },
    }),
    db.arApplication.findMany({ where: { status: "APPLIED", ...inCust }, select: { id: true, invoiceId: true, collectionId: true, creditNoteId: true, amount: true, customerId: true, appliedDate: true, atReceipt: true, createdAt: true } }),
    db.salesCollection.findMany({
      where: { status: { in: ["APPROVED", "REVERSED"] }, ...(customerIds ? { OR: [{ customerId: { in: customerIds } }, { customerId: null, opportunity: { customerId: { in: customerIds } } }] } : {}) },
      select: { id: true, status: true, customerId: true, amountGross: true, collectedAt: true, decidedAt: true, reversedAt: true, referenceNumber: true, paymentMethod: true, opportunity: { select: { customerId: true, title: true } }, quote: { select: { quoteNumber: true } } },
    }),
  ]);
  const appliedTo = new Map<string, Decimal>(), appliedFrom = new Map<string, Decimal>();
  for (const a of apps) {
    appliedTo.set(a.invoiceId, (appliedTo.get(a.invoiceId) ?? ZERO).plus(D(a.amount)));
    const src = a.collectionId ?? a.creditNoteId!;
    appliedFrom.set(src, (appliedFrom.get(src) ?? ZERO).plus(D(a.amount)));
  }
  const byCustomer = new Map<string, { debits: DebitItem[]; credits: CreditItem[]; moves: StatementMove[] }>();
  const bucket = (id: string) => { let b = byCustomer.get(id); if (!b) { b = { debits: [], credits: [], moves: [] }; byCustomer.set(id, b); } return b; };
  for (const d of docs) {
    const b = bucket(d.customerId);
    const total = D(d.grandTotal);
    if (d.kind === "CREDIT_NOTE") {
      b.credits.push({ id: d.id, kind: "CREDIT_NOTE", ref: d.number!, date: day(d.issueDate), amount: total, applied: appliedFrom.get(d.id) ?? ZERO });
      b.moves.push({ date: day(d.issueDate), at: d.issuedAt!.toISOString(), kind: "CREDIT_NOTE", ref: d.number!, id: d.id, debit: ZERO, credit: total });
    } else {
      b.debits.push({ id: d.id, kind: d.kind as "INVOICE" | "DEBIT_NOTE", number: d.number!, issueDate: day(d.issueDate), dueDate: d.dueDate ? day(d.dueDate) : null, total, applied: appliedTo.get(d.id) ?? ZERO });
      b.moves.push({ date: day(d.issueDate), at: d.issuedAt!.toISOString(), kind: d.kind as "INVOICE" | "DEBIT_NOTE", ref: d.number!, id: d.id, debit: total, credit: ZERO });
    }
  }
  for (const r of receipts) {
    const cust = r.customerId ?? r.opportunity?.customerId ?? null;
    if (!cust) continue;
    const b = bucket(cust);
    const amount = D(r.amountGross);
    const ref = r.referenceNumber || r.quote?.quoteNumber || r.id.slice(-6);
    const at = day(r.collectedAt);
    b.moves.push({ date: at, at: (r.decidedAt ?? r.collectedAt).toISOString(), kind: "RECEIPT", ref, id: r.id, debit: ZERO, credit: amount, memo: r.paymentMethod });
    if (r.status === "REVERSED") {
      b.moves.push({ date: day(r.reversedAt ?? r.collectedAt), at: (r.reversedAt ?? r.collectedAt).toISOString(), kind: "RECEIPT_REVERSED", ref, id: r.id, debit: amount, credit: ZERO });
    } else {
      b.credits.push({ id: r.id, kind: "RECEIPT", ref, date: at, amount, applied: appliedFrom.get(r.id) ?? ZERO });
    }
  }
  return { byCustomer, applications: apps };
}

/** One customer's AR: open items, unapplied credits, aging, and the statement of account. */
export async function customerAr(db: Db, customerId: string, opts: { asOf?: string; from?: string | null; to?: string | null } = {}) {
  const asOf = opts.asOf ?? todayRiyadh();
  const { byCustomer, applications } = await arItems(db, [customerId]);
  const b = byCustomer.get(customerId) ?? { debits: [], credits: [], moves: [] };
  const aging = agingOf(b.debits, b.credits, asOf);
  const st = statementOf(b.moves, opts.from ?? null, opts.to ?? null);
  return {
    asOf,
    open: b.debits.filter((d) => openOf(d).greaterThan(0)).sort((x, y) => x.issueDate.localeCompare(y.issueDate)).map((d) => ({ ...d, open: openOf(d), daysOverdue: Math.max(daysOverdue(d, asOf), 0) })),
    settled: b.debits.filter((d) => openOf(d).lessThanOrEqualTo(0)).map((d) => d.id),
    credits: b.credits.filter((c) => unappliedOf(c).greaterThan(0)).map((c) => ({ ...c, unapplied: unappliedOf(c) })),
    aging, statement: st, applications,
  };
}

/** The aging of every customer with an AR item (or the given ones), and the totals. */
export async function agingReport(db: Db, customerIds: string[] | null, asOf: string = todayRiyadh()) {
  const { byCustomer } = await arItems(db, customerIds);
  const ids = [...byCustomer.keys()];
  const customers = ids.length ? await db.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, nameAr: true, creditLimit: true, paymentTermsDays: true, accountOwnerId: true } }) : [];
  const names = new Map(customers.map((c) => [c.id, c]));
  const rows = ids.map((id) => {
    const b = byCustomer.get(id)!;
    return { customerId: id, customer: names.get(id) ?? null, aging: agingOf(b.debits, b.credits, asOf) };
  }).filter((r) => !r.aging.totalOpen.isZero() || !r.aging.unappliedCredit.isZero())
    .sort((a, b) => b.aging.balance.comparedTo(a.aging.balance));
  const keys = ["current", "d1_30", "d31_60", "d61_90", "d90p", "totalOpen", "unappliedCredit", "balance", "overdue"] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s.plus(r.aging[k]), ZERO)])) as Record<(typeof keys)[number], Decimal>;
  return { asOf, rows, totals };
}

// ── applications ────────────────────────────────────────────────────────────────────────────────────

async function lockCollectionRow(tx: Tx, id: string) {
  const r = await tx.$queryRaw<{ id: string; status: string; customerId: string | null; opportunityId: string | null; amountGross: string; paymentMethod: string; collectedAt: Date; orderId: string | null; referenceNumber: string | null; branchId: string | null }[]>`
    SELECT "id", "status"::text AS status, "customerId", "opportunityId", "amountGross"::text, "paymentMethod"::text AS "paymentMethod", "collectedAt", "orderId", "referenceNumber", "branchId"
      FROM "SalesCollection" WHERE "id" = ${id} FOR UPDATE`;
  return r[0] ?? null;
}

export type ApplyInput = { invoiceId: string; amount: string; collectionId?: string | null; creditNoteId?: string | null };

/** Apply part of an approved receipt (or of a credit note's credit) to an issued invoice / debit note. */
export async function applyToInvoice(input: ApplyInput, ctx: AuditContext) {
  if (!!input.collectionId === !!input.creditNoteId) throw refuseInv("BAD_INPUT", "Name a receipt or a credit note.", "حدد سند تحصيل أو إشعارًا دائنًا.");
  let amount: Decimal;
  try { amount = new Decimal(String(input.amount ?? "").trim()); } catch { throw refuseInv("BAD_INPUT", "amount.", "المبلغ غير صالح."); }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const today = todayRiyadh();
    let customerId: string | null, source: { amount: Decimal; applied: Decimal };
    let receipt: Awaited<ReturnType<typeof lockCollectionRow>> | null = null;
    if (input.collectionId) {
      receipt = await lockCollectionRow(tx, input.collectionId);
      if (!receipt) throw refuseInv("NOT_FOUND");
      if (receipt.status !== "APPROVED") throw refuseInv("COLLECTION_NOT_APPROVED");
      customerId = await receiptCustomer(tx, receipt);
      const used = await tx.arApplication.aggregate({ where: { collectionId: receipt.id, status: "APPLIED" }, _sum: { amount: true } });
      source = { amount: D(receipt.amountGross), applied: D(used._sum.amount) };
    } else {
      const cn = await tx.salesInvoice.findUnique({ where: { id: input.creditNoteId! }, select: { id: true, kind: true, status: true, customerId: true, grandTotal: true } });
      if (!cn || cn.kind !== "CREDIT_NOTE" || cn.status !== "ISSUED") throw refuseInv("NOT_FOUND");
      await tx.$queryRaw`SELECT "id" FROM "SalesInvoice" WHERE "id" = ${cn.id} FOR UPDATE`;
      customerId = cn.customerId;
      const used = await tx.arApplication.aggregate({ where: { creditNoteId: cn.id, status: "APPLIED" }, _sum: { amount: true } });
      source = { amount: D(cn.grandTotal), applied: D(used._sum.amount) };
    }
    const inv = await tx.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: { id: true, kind: true, status: true, customerId: true, grandTotal: true, number: true } });
    if (!inv || inv.status !== "ISSUED" || inv.kind === "CREDIT_NOTE") throw refuseInv("NOT_FOUND");
    if (!customerId || customerId !== inv.customerId) throw refuseInv("CUSTOMER_MISMATCH");
    await tx.$queryRaw`SELECT "id" FROM "SalesInvoice" WHERE "id" = ${inv.id} FOR UPDATE`;
    const owed = await tx.arApplication.aggregate({ where: { invoiceId: inv.id, status: "APPLIED" }, _sum: { amount: true } });
    const why = applicationRefusal(amount, source, { total: D(inv.grandTotal), applied: D(owed._sum.amount) });
    if (why) throw refuseWith("OVER_APPLIED", { reason: why }, `(${why.en})`);
    const app = await tx.arApplication.create({
      data: { customerId, invoiceId: inv.id, collectionId: input.collectionId ?? null, creditNoteId: input.creditNoteId ?? null, amount: amount.toFixed(2), appliedDate: new Date(`${today}T00:00:00Z`), createdById: ctx.actorId },
      select: { id: true },
    });
    let posting: string = "none";
    // A receipt application moves the customer's advance to AR — only when the receipt itself was posted (a receipt
    // from before the go-live date sits in the opening balances, not in CUSTOMER_ADVANCES). A credit-note credit is
    // AR against AR (same party): no entry.
    if (receipt && (await postedEntry(tx, "COLLECTION", receipt.id, "RECEIVED"))) {
      const r = await postApplication(tx, { applicationId: app.id, collectionId: receipt.id, customerId, amount, date: today, invoiceNumber: inv.number!, branchId: receipt.branchId }, ctx.actorId, "APPLIED");
      posting = r.status;
    }
    return { id: app.id, posting };
  }, TX_OPTS);
}

/** Undo an application (it becomes REVERSED); its posting is reversed / offset. */
export async function unapply(applicationId: string, reason: string, ctx: AuditContext) {
  const why = (reason ?? "").trim();
  if (why.length < 3) throw refuseInv("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: why });
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ArApplication" WHERE "id" = ${applicationId} FOR UPDATE`;
    if (!rows[0]) throw refuseInv("NOT_FOUND");
    const a = await tx.arApplication.findUniqueOrThrow({ where: { id: applicationId }, include: { invoice: { select: { number: true } }, collection: { select: { branchId: true } } } });
    if (a.status !== "APPLIED") throw refuseInv("ALREADY_REVERSED");
    await tx.arApplication.update({ where: { id: a.id }, data: { status: "REVERSED", reversedAt: new Date(), reversedById: ctx.actorId, reverseReason: why.slice(0, 500) } });
    if (a.collectionId) {
      if (a.atReceipt) {
        if (await postedEntry(tx, "COLLECTION", a.collectionId, "RECEIVED")) {
          await postApplication(tx, { applicationId: a.id, collectionId: a.collectionId, customerId: a.customerId, amount: D(a.amount), date: todayRiyadh(), invoiceNumber: a.invoice.number ?? "", branchId: a.collection?.branchId ?? null }, ctx.actorId, "UNAPPLIED");
        }
      } else {
        const e = await postedEntry(tx, "COLLECTION", a.collectionId, `APPLIED.${a.id}`);
        if (e && e.status === "POSTED") await reverseEntry(tx, { entryId: e.id, reason: `إلغاء تخصيص: ${why}`, actorId: ctx.actorId });
      }
    }
    return { id: a.id, status: "REVERSED" };
  }, TX_OPTS);
}

// ── the collection workflow's hooks (inside approveCollection / reverseCollection's transaction) ─────

/** How a confirmed receipt is applied (BATCH22 WP-D «سند قبض»):
 *  · omitted — the A2 rule: its order's open invoices, oldest due first; the rest stays the customer's credit;
 *  · "AUTO" — the confirmation default: its own invoice (an accountant receipt) and its order's open invoices first, then
 *    the customer's other open invoices, oldest due first; the rest stays the customer's credit;
 *  · a list — exactly these parts (each ≤ what the invoice still owes, together ≤ the receipt). */
export type ReceiptAllocation = "AUTO" | { invoiceId: string; amount: string }[];
export type ReceiptConfirmOptions = { depositAccountId?: string | null; allocation?: ReceiptAllocation; sodBypass?: boolean; receiptNumber?: string | null };

type OpenDoc = { id: string; kind: string; number: string | null; issueDate: Date | null; dueDate: Date | null; grandTotal: Prisma.Decimal; orderId?: string | null };

/** The customer's open invoices / debit notes (locked), as debit items, with what each still owes. */
export async function openDebits(tx: Db, customerId: string, where: Prisma.SalesInvoiceWhereInput = {}, lock = true): Promise<(DebitItem & { orderId: string | null })[]> {
  const invoices: OpenDoc[] = await tx.salesInvoice.findMany({ where: { customerId, status: "ISSUED", kind: { in: ["INVOICE", "DEBIT_NOTE"] }, ...where }, select: { id: true, kind: true, number: true, issueDate: true, dueDate: true, grandTotal: true, orderId: true } });
  if (!invoices.length) return [];
  if (lock) await tx.$queryRaw`SELECT "id" FROM "SalesInvoice" WHERE "id" = ANY(${invoices.map((i) => i.id)}) ORDER BY "id" FOR UPDATE`;
  const sums = await tx.arApplication.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: invoices.map((i) => i.id) }, status: "APPLIED" }, _sum: { amount: true } });
  return invoices.map((i) => ({ id: i.id, kind: i.kind as "INVOICE", number: i.number!, issueDate: day(i.issueDate), dueDate: i.dueDate ? day(i.dueDate) : null, total: D(i.grandTotal), applied: D(sums.find((s) => s.invoiceId === i.id)?._sum.amount), orderId: i.orderId ?? null }));
}

/** The default allocation of a receipt at confirmation (pure over the open items): its own invoice, its order's, then the oldest. */
export function proposeAllocation(amount: Decimal, debits: (DebitItem & { orderId: string | null })[], first: { invoiceId?: string | null; orderId?: string | null }): { id: string; amount: Decimal }[] {
  const own = debits.filter((d) => d.id === first.invoiceId);
  const ofOrder = debits.filter((d) => d.id !== first.invoiceId && !!first.orderId && d.orderId === first.orderId);
  const rest = debits.filter((d) => d.id !== first.invoiceId && !(first.orderId && d.orderId === first.orderId));
  const out: { id: string; amount: Decimal }[] = [];
  let left = amount;
  for (const group of [own, ofOrder, rest]) {
    if (left.lessThanOrEqualTo(0)) break;
    const r = allocateFifo(left, group);
    out.push(...r.parts);
    left = r.left;
  }
  return out;
}

/**
 * A receipt was approved: apply it (by default to the open invoices of its order, oldest due first; the rest stays the
 * customer's credit — or as the confirmation chose, ReceiptConfirmOptions), then post RECEIVED (Dr the deposit account,
 * or cash / bank / card clearing by method; Cr AR for the part applied, Cr customer advances for the rest). No customer
 * (a deal without one): nothing to do — the receipt is not an AR item.
 */
export async function onCollectionApproved(tx: Tx, collectionId: string, actorId: string, opts: ReceiptConfirmOptions = {}) {
  const c = await tx.salesCollection.findUnique({ where: { id: collectionId }, select: { id: true, customerId: true, opportunityId: true, orderId: true, invoiceId: true, amountGross: true, paymentMethod: true, collectedAt: true, referenceNumber: true, receiptNumber: true, receiptMemo: true, depositAccountId: true, sodBypass: true, status: true, branchId: true } });
  if (!c || c.status !== "APPROVED") return null;
  const customerId = await receiptCustomer(tx, c);
  if (!customerId) return null;
  const amount = D(c.amountGross);
  let parts: { id: string; amount: Decimal }[] = [];
  if (opts.allocation === undefined) {
    if (c.orderId) parts = allocateFifo(amount, await openDebits(tx, customerId, { orderId: c.orderId })).parts;
  } else if (opts.allocation === "AUTO") {
    parts = proposeAllocation(amount, await openDebits(tx, customerId), { invoiceId: c.invoiceId, orderId: c.orderId });
  } else {
    const want = opts.allocation.map((a) => {
      let v: Decimal;
      try { v = new Decimal(String(a?.amount ?? "").trim()); } catch { throw refuseInv("BAD_INPUT", "allocation amount.", "مبلغ التخصيص غير صالح."); }
      return { id: String(a?.invoiceId ?? ""), amount: v };
    }).filter((a) => !a.amount.isZero());
    if (new Set(want.map((w) => w.id)).size !== want.length) throw refuseInv("BAD_INPUT", "An invoice is named twice in the allocation.", "فاتورة مكررة في التخصيص.");
    const debits = await openDebits(tx, customerId, { id: { in: want.map((w) => w.id) } });
    let total = ZERO;
    for (const w of want) {
      const d = debits.find((x) => x.id === w.id);
      if (!d) throw refuseInv("CUSTOMER_MISMATCH");
      const why = applicationRefusal(w.amount, { amount, applied: total }, d);
      if (why) throw refuseWith("OVER_APPLIED", { reason: why }, `(${why.en})`);
      total = total.plus(w.amount);
    }
    parts = want;
  }
  let applied = ZERO;
  const today = new Date(`${todayRiyadh()}T00:00:00Z`);
  for (const p of parts) {
    await tx.arApplication.create({ data: { customerId, invoiceId: p.id, collectionId: c.id, amount: p.amount.toFixed(2), appliedDate: today, atReceipt: true, createdById: actorId } });
    applied = applied.plus(p.amount);
  }
  const ref = c.receiptNumber ?? c.referenceNumber ?? c.id.slice(-8);
  const posting = await postReceiptReceived(tx, { collectionId: c.id, amount, appliedAtReceipt: applied, method: c.paymentMethod, depositAccountId: c.depositAccountId, customerId, date: dayText(riyadhDay(c.collectedAt)), ref, memo: c.receiptMemo, sodBypass: c.sodBypass, branchId: c.branchId }, actorId);
  return { applied: applied.toFixed(2), posting: posting.status, parts: parts.map((p) => ({ invoiceId: p.id, amount: p.amount.toFixed(2) })) };
}

/** A receipt was reversed: its applications are reversed and every posting of it is reversed. */
export async function onCollectionReversed(tx: Tx, collectionId: string, reason: string, actorId: string) {
  const now = new Date();
  await tx.arApplication.updateMany({ where: { collectionId, status: "APPLIED" }, data: { status: "REVERSED", reversedAt: now, reversedById: actorId, reverseReason: `تحصيل معكوس: ${reason}`.slice(0, 500) } });
  return reverseReceiptEntries(tx, collectionId, `عكس التحصيل: ${reason}`, actorId);
}

// ── credit warnings (feat/credit-hold), when accounting is active ───────────────────────────────────

/** The outstanding balance and overdue items of each customer from the invoice open items. */
export async function invoiceCreditFigures(db: Db, customerIds: string[], now: Date) {
  const asOf = dayText(riyadhDay(now));
  const { byCustomer } = await arItems(db, customerIds);
  const out = new Map<string, { outstanding: Decimal; open: { unpaid: Decimal; daysOverdue: number }[] }>();
  for (const id of customerIds) {
    const b = byCustomer.get(id) ?? { debits: [], credits: [], moves: [] };
    const a = agingOf(b.debits, b.credits, asOf);
    out.set(id, {
      outstanding: Decimal.max(a.balance, ZERO),
      open: b.debits.filter((d) => openOf(d).greaterThan(0)).map((d) => ({ unpaid: openOf(d), daysOverdue: Math.max(daysOverdue(d, asOf), 0) })),
    });
  }
  return out;
}

export { TX_OPTS };
