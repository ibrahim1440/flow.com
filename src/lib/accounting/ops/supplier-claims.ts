// «نقص من المورد» (feat/supplier-shortfall, 20261119090000_supplier_shortfall) — the supplier claims sub-ledger.
//
//   A CLAIM line of a posted one-step purchase invoice opens one SupplierClaim (ap.ts postInvoiceTx: Dr SUPPLIER_CLAIMS
//   the shortfall at the line's unit cost; its input VAT stays claimed on the invoice). It is settled, in parts or at
//   once, by:
//     a credit note  «إشعار دائن من المورد»   Dr AP (net + VAT) / Cr SUPPLIER_CLAIMS (net) / Cr VAT_INPUT (VAT) — the bill's
//                                            open amount falls by the gross (creditedTotal); a negative box-7 adjustment
//                                            in the VAT return of the note's quarter; its own SCN number series;
//     replacement goods «بضاعة بديلة»         received at the claim's unit cost (the shared receive service: stock, cost
//                                            move, Dr INVENTORY / Cr GRNI), then Dr GRNI / Cr SUPPLIER_CLAIMS — so
//                                            Dr INVENTORY / Cr SUPPLIER_CLAIMS, no VAT (the VAT was on the invoice);
//     an abandonment «تنازل»                  Dr PURCHASE_SHORTAGE / Cr SUPPLIER_CLAIMS (net); with the setting «عكس ضريبة
//                                            المدخلات» (default on) also Dr PURCHASE_SHORTAGE / Cr VAT_INPUT (VAT) and a
//                                            negative box-7 adjustment — «تحقق مع مستشارك الضريبي».
//   Gates (the routes): a credit note and its cancel — accounting › ap (verified individual + step-up); replacement —
//   inventory › receive; abandonment — inventory › adjust through stockChangeGate (step-up) and a reason.
//   Accounting not active: the claims, settlements and credit notes are still recorded (the sub-ledger), the entries
//   are skipped (the engine's NOT_ACTIVE / BEFORE_GO_LIVE) — the existing pattern.
//   Lock order: the invoice, then the claim (cancelInvoice takes them in the same order).
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { reverseEntry, postEntry, type PostingLineInput } from "../posting-engine";
import { Decimal, ZERO, toDecimal, MoneyError, roundMoney } from "../money";
import { dayText, parseBusinessDay, riyadhDay } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { lineVat, qty4 } from "./costing";
import { flushPostings, netLines, side } from "./cost-ledger";
import { opsRefuse } from "./refusals";
import { nextNumber } from "./ap";
import { logPurchaseActivity } from "./purchase-activity";
import { supplierShortfallFromRow } from "./supplier-shortfall";
import { receiveGreen, receiveMaterial, type ReceiptUser } from "@/lib/services/purchase-receipts";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const f2 = (d: Decimal | Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : new Decimal(d).toFixed(2));
/** A claim older than this many days is flagged «متأخرة» on the claims list (council: chase it or decide). */
export const CLAIM_STALE_DAYS = 60;

function money(v: unknown, what: string): Decimal {
  try {
    const d = toDecimal(typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? ""));
    if (!d.equals(d.toDecimalPlaces(2))) throw new MoneyError("2 decimals at most");
    return d;
  } catch { throw opsRefuse("CLAIM_AMOUNT", `${what}.`, `${what}.`); }
}
function dayOf(v: unknown, fallback: Date): Date {
  if (v === undefined || v === null || v === "") return fallback;
  try { return parseBusinessDay(String(v)); } catch { throw opsRefuse("OPS_BAD_INPUT", "The date is YYYY-MM-DD.", "التاريخ بصيغة YYYY-MM-DD."); }
}

/** What is still open on a claim (quantity, net, VAT). */
export function claimOpen(c: { qty: Prisma.Decimal | Decimal; net: Prisma.Decimal | Decimal; vat: Prisma.Decimal | Decimal; settledQty: Prisma.Decimal | Decimal; settledNet: Prisma.Decimal | Decimal; settledVat: Prisma.Decimal | Decimal }) {
  return { qty: new Decimal(c.qty).minus(c.settledQty), net: new Decimal(c.net).minus(c.settledNet), vat: new Decimal(c.vat).minus(c.settledVat) };
}

/** The settings in force (Settings › Inventory «نقص من المورد»). */
export async function shortfallSettings(db: Db) {
  return supplierShortfallFromRow(await db.systemConfig.findUnique({ where: { id: "singleton" }, select: { purchaseShortfallTolerancePercent: true, purchaseAbandonReverseVat: true } }));
}

/**
 * Council F1: a claim opened before go-live (its invoice's entry SKIPPED) is in the books only through the opening
 * (the valuation tool's «مطالبات الموردين المفتوحة» line). A settlement posted after go-live credits SUPPLIER_CLAIMS:
 * refused — the whole transaction rolls back — when that would leave the supplier's claims account below zero
 * (the opening not posted yet, or posted without the claims line).
 */
/** Refused up front: the claim's invoice has no entry (approved before go-live) and the opening is not posted yet. */
async function openingGuard(tx: Tx, c: { invoice: { journalEntryId?: string | null } }) {
  if (c.invoice.journalEntryId) return;
  const st = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true, openingEntryId: true } });
  if (st?.accountingActive && st.goLiveDate && st.goLiveDate <= riyadhDay() && !st.openingEntryId) throw opsRefuse("CLAIM_OPENING_PENDING");
}

async function claimsGlGuard(tx: Tx, supplierId: string) {
  const role = await tx.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "SUPPLIER_CLAIMS" } }, select: { accountId: true } });
  if (!role) return;
  const [b] = await tx.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${role.accountId} AND l."partyType" = 'SUPPLIER' AND l."partyId" = ${supplierId} AND e."status" IN ('POSTED', 'REVERSED')`;
  if (new Decimal(b?.v ?? 0).isNegative()) throw opsRefuse("CLAIM_OPENING_PENDING");
}

/** Lock the claim's invoice, then the claim; refused unless the claim is OPEN on a POSTED invoice. */
async function lockClaim(tx: Tx, claimId: string) {
  const head = await tx.supplierClaim.findUnique({ where: { id: claimId }, select: { invoiceId: true } });
  if (!head) throw opsRefuse("OPS_NOT_FOUND");
  await tx.$queryRaw`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${head.invoiceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "SupplierClaim" WHERE "id" = ${claimId} FOR UPDATE`;
  const c = await tx.supplierClaim.findUniqueOrThrow({ where: { id: claimId }, include: { invoice: { select: { id: true, number: true, supplierRef: true, status: true, invoiceDate: true, grossTotal: true, paidTotal: true, creditedTotal: true, journalEntryId: true } }, invoiceLine: { select: { lineNo: true, taxSnapshot: true } } } });
  if (c.status !== "OPEN" || c.invoice.status !== "POSTED") throw opsRefuse("CLAIM_STATE");
  await openingGuard(tx, c);
  return c;
}

/** Apply a settlement to the claim (its settled totals; SETTLED once the net is all settled). */
async function settle(tx: Tx, claimId: string, part: { qty: Decimal; net: Decimal; vat: Decimal }, all: boolean) {
  const c = await tx.supplierClaim.findUniqueOrThrow({ where: { id: claimId } });
  const settledQty = all ? new Decimal(c.qty) : Decimal.min(new Decimal(c.qty), new Decimal(c.settledQty).plus(part.qty));
  const settledNet = all ? new Decimal(c.net) : new Decimal(c.settledNet).plus(part.net);
  const settledVat = Decimal.min(new Decimal(c.vat), new Decimal(c.settledVat).plus(part.vat));
  await tx.supplierClaim.update({ where: { id: claimId }, data: { settledQty, settledNet, settledVat, status: settledNet.gte(c.net) ? "SETTLED" : "OPEN", updatedAt: new Date() } });
}

/** The share of what is open that `qty` of it carries (the whole rest when qty is all of it). */
function shareOf(open: { qty: Decimal; net: Decimal; vat: Decimal }, qty: Decimal) {
  if (qty.gte(open.qty)) return { qty: open.qty, net: open.net, vat: open.vat, all: true };
  const net = Decimal.min(open.net, roundMoney(open.net.times(qty).div(open.qty)));
  return { qty, net, vat: Decimal.min(open.vat, roundMoney(open.vat.times(qty).div(open.qty))), all: false };
}

// ─── Credit note ─────────────────────────────────────────────────────────────────────────────────

export type CreditNoteInput = { supplierRef: string; noteDate?: string | null; net?: string | number | null; vat?: string | number | null; notes?: string | null };

/**
 * «إشعار دائن من المورد» against an open claim: at most what is open (default: all of it). Its VAT is the claim's
 * remaining VAT when it takes the whole rest, else lineVat on its net (at most the remaining VAT); the VAT on the
 * supplier's document may be entered instead, within ±0.01 of that (council F6). The part of the gross above what the
 * invoice still owes (it was paid) is a supplier advance (Dr SUPPLIER_ADVANCES, council F4), applied later.
 */
export async function createCreditNote(claimId: string, input: CreditNoteInput, ctx: AuditContext) {
  const supplierRef = str(input?.supplierRef, 60);
  if (!supplierRef) throw opsRefuse("CREDIT_NOTE_REF_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const c = await lockClaim(tx, claimId);
    const open = claimOpen(c);
    const net = input?.net === undefined || input?.net === null || input?.net === "" ? open.net : money(input.net, "net");
    if (!net.gt(0) || net.gt(open.net)) throw opsRefuse("CLAIM_AMOUNT");
    const all = net.equals(open.net);
    const computed = all ? open.vat : Decimal.min(open.vat, lineVat(net, new Decimal(c.vatRate)));
    let vat = computed;
    if (input?.vat !== undefined && input?.vat !== null && input?.vat !== "") {
      const given = money(input.vat, "vat");
      if (given.isNegative() || given.gt(open.vat) || given.minus(computed).abs().gt("0.01")) throw opsRefuse("CREDIT_NOTE_VAT", `${computed.toFixed(2)}.`, `${computed.toFixed(2)}.`);
      vat = given;
    }
    const gross = net.plus(vat);
    const outstanding = Decimal.max(ZERO, new Decimal(c.invoice.grossTotal).minus(c.invoice.paidTotal).minus(c.invoice.creditedTotal));
    const advance = Decimal.max(ZERO, gross.minus(outstanding));
    const credited = gross.minus(advance);
    const today = riyadhDay();
    const noteDate = dayOf(input?.noteDate, today);
    if (noteDate > today || noteDate < c.invoice.invoiceDate) throw opsRefuse("OPS_BAD_INPUT", "The credit note's date is on or after the invoice's and not after today.", "تاريخ الإشعار لا يسبق تاريخ الفاتورة ولا يتجاوز اليوم.");
    const number = await nextNumber(tx, "SCN", noteDate);
    const note = await tx.supplierCreditNote.create({ data: { number, supplierId: c.supplierId, invoiceId: c.invoiceId, claimId, supplierRef, noteDate, net, vat, gross, advanceAmount: advance, notes: str(input?.notes, 500), createdBy: ctx.actorId }, select: { id: true } });
    const party = { type: "SUPPLIER" as const, id: c.supplierId };
    const r = await postEntry(tx, {
      source: { module: "purchasing", type: "SUPPLIER_CREDIT_NOTE", id: note.id, event: "POSTED" }, date: dayText(noteDate), whenPeriodNotOpen: "nextOpenPeriod",
      memo: `إشعار دائن من المورد ${number} · ${supplierRef} · فاتورة ${c.invoice.number}`, createdBy: ctx.actorId,
      lines: netLines([side("AP", credited, { party }), side("SUPPLIER_ADVANCES", advance, { party }), side("SUPPLIER_CLAIMS", net.negated(), { party }), side("VAT_INPUT", vat.negated(), { party })]),
    });
    if (r.status === "posted") await claimsGlGuard(tx, c.supplierId);
    const journalEntryId = r.status === "posted" ? r.entryId : null;
    if (journalEntryId) await tx.supplierCreditNote.update({ where: { id: note.id }, data: { journalEntryId } });
    await tx.supplierClaimSettlement.create({ data: { claimId, kind: "CREDIT_NOTE", qty: all ? open.qty : null, net, vat, reverseVat: vat.gt(0), creditNoteId: note.id, journalEntryId, createdBy: ctx.actorId } });
    await settle(tx, claimId, { qty: all ? open.qty : ZERO, net, vat }, all);
    if (credited.gt(0)) await tx.supplierInvoice.update({ where: { id: c.invoiceId }, data: { creditedTotal: { increment: credited } } });
    await logPurchaseActivity(tx, ctx, "PURCHASE_CREDIT_NOTE_POSTED", c.invoiceId, { claimId, creditNoteId: note.id, creditNoteNumber: number });
    return getCreditNote(note.id, tx);
  }, TX_OPTS);
}

/** Cancel a supplier credit note: its entry reversed, the claim and the invoice's open amount back as they were. */
export async function cancelCreditNote(id: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const head = await tx.supplierCreditNote.findUnique({ where: { id }, select: { invoiceId: true, claimId: true } });
    if (!head) throw opsRefuse("OPS_NOT_FOUND");
    await tx.$queryRaw`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${head.invoiceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SupplierClaim" WHERE "id" = ${head.claimId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SupplierCreditNote" WHERE "id" = ${id} FOR UPDATE`;
    const n = await tx.supplierCreditNote.findUniqueOrThrow({ where: { id }, include: { settlements: true, claim: true } });
    if (n.status !== "POSTED") throw opsRefuse("CREDIT_NOTE_STATE");
    if (n.claim.status === "VOID") throw opsRefuse("CLAIM_STATE");
    if (n.journalEntryId) await reverseEntry(tx, { entryId: n.journalEntryId, reason: r, actorId: ctx.actorId });
    const now = new Date();
    await tx.supplierCreditNote.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: ctx.actorId, cancelledAt: now, cancelReason: r, updatedAt: now } });
    for (const s of n.settlements.filter((x) => !x.voidedAt)) {
      await tx.supplierClaimSettlement.update({ where: { id: s.id }, data: { voidedAt: now, voidedBy: ctx.actorId, voidReason: r } });
      const c = n.claim;
      const settledNet = new Decimal(c.settledNet).minus(s.net);
      await tx.supplierClaim.update({ where: { id: c.id }, data: {
        settledNet, settledVat: Decimal.max(ZERO, new Decimal(c.settledVat).minus(s.vat)), settledQty: Decimal.max(ZERO, new Decimal(c.settledQty).minus(s.qty ?? 0)),
        status: "OPEN", updatedAt: now,
      } });
    }
    const credited = new Decimal(n.gross).minus(n.advanceAmount);
    if (credited.gt(0)) await tx.supplierInvoice.update({ where: { id: n.invoiceId }, data: { creditedTotal: { decrement: credited } } });
    await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_CREDIT_NOTE_CANCELLED", n.invoiceId, { claimId: n.claimId, creditNoteId: id, creditNoteNumber: n.number });
    return getCreditNote(id, tx);
  }, TX_OPTS);
}

export async function getCreditNote(id: string, db: Db = prisma) {
  const n = await db.supplierCreditNote.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true, supplierRef: true } } } });
  if (!n) throw opsRefuse("OPS_NOT_FOUND");
  return { ...n, noteDate: dayText(n.noteDate), net: f2(n.net), vat: f2(n.vat), gross: f2(n.gross) };
}

// ─── Replacement goods ───────────────────────────────────────────────────────────────────────────

/**
 * «استلام بضاعة بديلة»: the supplier sends the missing goods. Received through the shared receive service at the claim's
 * unit cost (lineKey `CLAIM:<id>`, so the receipt is never an open GRNI item nor matched to a bill), then
 * Dr GRNI / Cr SUPPLIER_CLAIMS for its value. At most the open quantity; no VAT.
 */
export async function replaceClaim(claimId: string, input: { quantity: string | number; receivedDate?: string | null; locationId?: string | null }, user: ReceiptUser, ctx: AuditContext) {
  const qn = typeof input?.quantity === "number" ? input.quantity : typeof input?.quantity === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(input.quantity.trim()) ? Number(input.quantity) : NaN;
  if (!Number.isFinite(qn) || qn <= 0) throw opsRefuse("CLAIM_AMOUNT");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const c = await lockClaim(tx, claimId);
    const open = claimOpen(c);
    const qty = qty4(qn);
    if (qty.gt(open.qty)) throw opsRefuse("CLAIM_AMOUNT");
    const part = shareOf(open, qty);
    if (!part.net.gt(0)) throw opsRefuse("CLAIM_AMOUNT");
    const today = riyadhDay();
    const day = dayOf(input?.receivedDate, today);
    if (day > today) throw opsRefuse("RECEIVED_DATE_INVALID");
    const lineKey = `CLAIM:${claimId}`;
    const notes = `بضاعة بديلة عن نقص فاتورة ${c.invoice.number} · ${c.invoice.supplierRef}`;
    const unit = Number(part.net.div(part.qty).toDecimalPlaces(6));
    const purchaseRecordId = c.stockKind === "GREEN_BEAN"
      ? (await receiveGreen(tx, user, { supplierId: c.supplierId, greenBeanId: c.stockItemId, quantity: Number(part.qty), costPerUnit: unit, purchaseDate: day, notes, value: part.net, lineKey, locationId: input?.locationId ?? null })).purchase.id
      : (await receiveMaterial(tx, user, { materialItemId: c.stockItemId, quantity: Number(part.qty), supplierId: c.supplierId, reference: c.invoice.supplierRef, notes, unitCost: unit, purchaseDate: day, value: part.net, lineKey, locationId: input?.locationId ?? null })).purchase!.id;
    // The receipt's own entry (Dr INVENTORY / Cr GRNI) first, then the claim's (Dr GRNI / Cr SUPPLIER_CLAIMS).
    await flushPostings(tx);
    const s = await tx.supplierClaimSettlement.create({ data: { claimId, kind: "REPLACEMENT", qty: part.qty, net: part.net, vat: ZERO, purchaseRecordId, createdBy: ctx.actorId }, select: { id: true } });
    const party = { type: "SUPPLIER" as const, id: c.supplierId };
    const r = await postEntry(tx, {
      source: { module: "purchasing", type: "SUPPLIER_CLAIM", id: s.id, event: "REPLACED" }, date: dayText(day), whenPeriodNotOpen: "nextOpenPeriod",
      memo: `بضاعة بديلة عن مطالبة · فاتورة ${c.invoice.number}`, createdBy: ctx.actorId,
      lines: netLines([side("GRNI", part.net, { party }), side("SUPPLIER_CLAIMS", part.net.negated(), { party })]),
    });
    if (r.status === "posted") { await tx.supplierClaimSettlement.update({ where: { id: s.id }, data: { journalEntryId: r.entryId } }); await claimsGlGuard(tx, c.supplierId); }
    await settle(tx, claimId, { qty: part.qty, net: part.net, vat: ZERO }, false);
    await logPurchaseActivity(tx, ctx, "PURCHASE_CLAIM_REPLACED", c.invoiceId, { claimId, purchaseRecordId, qty: part.qty.toFixed() });
    return { claim: await getClaim(claimId, tx), purchaseRecordId };
  }, { ...TX_OPTS, timeout: 60_000 });
}

// ─── Abandonment ─────────────────────────────────────────────────────────────────────────────────

/**
 * «التنازل عن المطالبة»: what is open becomes a purchase shortage loss. With the setting (default on) its input VAT is
 * reversed too (the goods never came, so the tax invoice's VAT on them is not kept) — «تحقق مع مستشارك الضريبي».
 */
export async function abandonClaim(claimId: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("SHORTFALL_REASON");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const c = await lockClaim(tx, claimId);
    const open = claimOpen(c);
    if (!open.net.gt(0)) throw opsRefuse("CLAIM_STATE");
    const reverseVat = (await shortfallSettings(tx)).abandonReverseVat && open.vat.gt(0);
    const vat = reverseVat ? open.vat : ZERO;
    const s = await tx.supplierClaimSettlement.create({ data: { claimId, kind: "ABANDON", qty: open.qty, net: open.net, vat, reverseVat, reason: r, createdBy: ctx.actorId }, select: { id: true } });
    const party = { type: "SUPPLIER" as const, id: c.supplierId };
    const lines: (PostingLineInput | null)[] = [side("PURCHASE_SHORTAGE", open.net.plus(vat), { party }), side("SUPPLIER_CLAIMS", open.net.negated(), { party }), side("VAT_INPUT", vat.negated(), { party })];
    const e = await postEntry(tx, {
      source: { module: "purchasing", type: "SUPPLIER_CLAIM", id: s.id, event: "ABANDONED" }, date: dayText(riyadhDay()), whenPeriodNotOpen: "nextOpenPeriod",
      memo: `تنازل عن مطالبة مورد · فاتورة ${c.invoice.number} · ${r}`.slice(0, 500), createdBy: ctx.actorId, lines: netLines(lines),
    });
    if (e.status === "posted") { await tx.supplierClaimSettlement.update({ where: { id: s.id }, data: { journalEntryId: e.entryId } }); await claimsGlGuard(tx, c.supplierId); }
    await settle(tx, claimId, { qty: open.qty, net: open.net, vat }, true);
    await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_CLAIM_ABANDONED", c.invoiceId, { claimId, reverseVat });
    return getClaim(claimId, tx);
  }, TX_OPTS);
}

// ─── Refund received ─────────────────────────────────────────────────────────────────────────────

/**
 * «استرداد نقدي من المورد» (council F4): cash or a bank transfer received against an open claim — at most what is open
 * (net + VAT). The VAT share returned with it is reversed (in proportion; all of it when the refund takes the whole rest):
 * Dr BANK / CASH / Cr SUPPLIER_CLAIMS (net share) / Cr VAT_INPUT (VAT share). The AP gate.
 */
export async function refundClaim(claimId: string, input: { amount: string | number; method: string; reference?: string | null; receivedDate?: string | null }, ctx: AuditContext) {
  const method = input?.method === "CASH" ? "CASH" : input?.method === "BANK_TRANSFER" ? "BANK_TRANSFER" : null;
  if (!method) throw opsRefuse("OPS_BAD_INPUT", "method is BANK_TRANSFER or CASH.", "طريقة الاسترداد: تحويل بنكي أو نقدًا.");
  const amount = money(input?.amount, "amount");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const c = await lockClaim(tx, claimId);
    const open = claimOpen(c);
    const openGross = open.net.plus(open.vat);
    if (!amount.gt(0) || amount.gt(openGross)) throw opsRefuse("CLAIM_AMOUNT");
    const all = amount.equals(openGross);
    const vat = all ? open.vat : Decimal.min(open.vat, roundMoney(amount.times(open.vat).div(openGross)));
    const net = amount.minus(vat);
    if (!net.gt(0)) throw opsRefuse("CLAIM_AMOUNT");
    const qty = all ? open.qty : open.qty.times(net).div(open.net).toDecimalPlaces(4);
    const today = riyadhDay();
    const day = dayOf(input?.receivedDate, today);
    if (day > today) throw opsRefuse("OPS_BAD_INPUT", "The date is not after today.", "التاريخ لا يتجاوز اليوم.");
    const s = await tx.supplierClaimSettlement.create({ data: { claimId, kind: "REFUND", qty: qty.gt(0) ? qty : null, net, vat, reverseVat: vat.gt(0), method, reference: str(input?.reference, 120), createdBy: ctx.actorId }, select: { id: true } });
    const party = { type: "SUPPLIER" as const, id: c.supplierId };
    const r = await postEntry(tx, {
      source: { module: "purchasing", type: "SUPPLIER_CLAIM", id: s.id, event: "REFUNDED" }, date: dayText(day), whenPeriodNotOpen: "nextOpenPeriod",
      memo: `استرداد من المورد عن مطالبة · فاتورة ${c.invoice.number}`, createdBy: ctx.actorId,
      lines: netLines([side(method === "CASH" ? "CASH" : "BANK", amount), side("SUPPLIER_CLAIMS", net.negated(), { party }), side("VAT_INPUT", vat.negated(), { party })]),
    });
    if (r.status === "posted") { await tx.supplierClaimSettlement.update({ where: { id: s.id }, data: { journalEntryId: r.entryId } }); await claimsGlGuard(tx, c.supplierId); }
    await settle(tx, claimId, { qty, net, vat }, all);
    await logPurchaseActivity(tx, ctx, "PURCHASE_CLAIM_REFUNDED", c.invoiceId, { claimId, method });
    return getClaim(claimId, tx);
  }, TX_OPTS);
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────────

const claimInclude = {
  supplier: { select: { id: true, name: true } },
  invoice: { select: { id: true, number: true, supplierRef: true, invoiceDate: true, status: true, grossTotal: true, paidTotal: true, creditedTotal: true } },
  invoiceLine: { select: { lineNo: true, description: true, quantity: true, billedQty: true } },
  settlements: { orderBy: { createdAt: "asc" as const }, include: { creditNote: { select: { id: true, number: true, supplierRef: true, noteDate: true, status: true, advanceAmount: true } } } },
} as const;
type ClaimRow = Prisma.SupplierClaimGetPayload<{ include: typeof claimInclude }>;

function claimView(c: ClaimRow, today: Date) {
  const open = claimOpen(c);
  const ageDays = Math.max(0, Math.floor((today.getTime() - riyadhDayOf(c.createdAt).getTime()) / 86_400_000));
  return {
    id: c.id, status: c.status, supplierId: c.supplierId, supplierName: c.supplier.name, stockKind: c.stockKind, stockItemId: c.stockItemId,
    invoice: { id: c.invoice.id, number: c.invoice.number, supplierRef: c.invoice.supplierRef, invoiceDate: dayText(c.invoice.invoiceDate), status: c.invoice.status, outstanding: Decimal.max(ZERO, new Decimal(c.invoice.grossTotal).minus(c.invoice.paidTotal).minus(c.invoice.creditedTotal)).toFixed(2) },
    line: { lineNo: c.invoiceLine.lineNo, description: c.invoiceLine.description, received: c.invoiceLine.quantity ? new Decimal(c.invoiceLine.quantity).toFixed() : null, billed: c.invoiceLine.billedQty ? new Decimal(c.invoiceLine.billedQty).toFixed() : null },
    qty: new Decimal(c.qty).toFixed(), unitCost: new Decimal(c.unitCost).toFixed(), net: f2(c.net), vatRate: new Decimal(c.vatRate).toFixed(), vat: f2(c.vat),
    settledQty: new Decimal(c.settledQty).toFixed(), settledNet: f2(c.settledNet), settledVat: f2(c.settledVat),
    openQty: open.qty.toFixed(), openNet: open.net.toFixed(2), openVat: open.vat.toFixed(2), openGross: open.net.plus(open.vat).toFixed(2),
    createdAt: c.createdAt.toISOString(), ageDays, stale: c.status === "OPEN" && ageDays > CLAIM_STALE_DAYS,
    settlements: c.settlements.map((s) => ({
      id: s.id, kind: s.kind, method: s.method, qty: s.qty ? new Decimal(s.qty).toFixed() : null, net: f2(s.net), vat: f2(s.vat), reverseVat: s.reverseVat, reason: s.reason, purchaseRecordId: s.purchaseRecordId, journalEntryId: s.journalEntryId,
      createdAt: s.createdAt.toISOString(), createdBy: s.createdBy, voidedAt: s.voidedAt?.toISOString() ?? null,
      creditNote: s.creditNote ? { ...s.creditNote, noteDate: dayText(s.creditNote.noteDate), advanceAmount: f2(s.creditNote.advanceAmount) } : null,
    })),
  };
}
const riyadhDayOf = (d: Date) => new Date(Date.UTC(new Date(d.getTime() + 3 * 3600_000).getUTCFullYear(), new Date(d.getTime() + 3 * 3600_000).getUTCMonth(), new Date(d.getTime() + 3 * 3600_000).getUTCDate()));

export async function getClaim(id: string, db: Db = prisma) {
  const c = await db.supplierClaim.findUnique({ where: { id }, include: claimInclude });
  if (!c) throw opsRefuse("OPS_NOT_FOUND");
  return claimView(c, riyadhDay());
}

/** The claims of an invoice (the invoice page's «مطالبات المورد» panel and timeline). */
export async function claimsOfInvoice(invoiceId: string, db: Db = prisma) {
  const rows = await db.supplierClaim.findMany({ where: { invoiceId }, include: claimInclude, orderBy: { createdAt: "asc" } });
  const today = riyadhDay();
  return rows.map((c) => claimView(c, today));
}

/**
 * The claims list («مطالبات الموردين»): open by default (status ALL for every one), per supplier, oldest first, with
 * the age and the > 60 days flag; and the open total per supplier.
 */
export async function listClaims(q: { supplierId?: string | null; status?: string | null }) {
  const status = q.status === "ALL" ? undefined : q.status === "SETTLED" || q.status === "VOID" ? q.status : "OPEN";
  const rows = await prisma.supplierClaim.findMany({ where: { ...(status ? { status } : {}), ...(q.supplierId ? { supplierId: q.supplierId } : {}) }, include: claimInclude, orderBy: { createdAt: "asc" }, take: 1000 });
  const today = riyadhDay();
  const out = rows.map((c) => claimView(c, today));
  const bySupplier = new Map<string, { supplierId: string; name: string; count: number; openGross: Decimal; stale: number; oldestDays: number }>();
  for (const c of out.filter((x) => x.status === "OPEN")) {
    const s = bySupplier.get(c.supplierId) ?? { supplierId: c.supplierId, name: c.supplierName, count: 0, openGross: ZERO, stale: 0, oldestDays: 0 };
    s.count++; s.openGross = s.openGross.plus(c.openGross); if (c.stale) s.stale++; s.oldestDays = Math.max(s.oldestDays, c.ageDays);
    bySupplier.set(c.supplierId, s);
  }
  return {
    rows: out, staleDays: CLAIM_STALE_DAYS,
    suppliers: [...bySupplier.values()].sort((a, b) => b.openGross.comparedTo(a.openGross)).map((s) => ({ ...s, openGross: s.openGross.toFixed(2) })),
    openGross: out.filter((x) => x.status === "OPEN").reduce((s, x) => s.plus(x.openGross), ZERO).toFixed(2),
  };
}

/**
 * Council F1 — what the books cannot hold yet, per supplier: claims whose invoice's entry was SKIPPED (approved before
 * go-live, or while accounting was off), at their net less the settlements that were not posted either. The opening
 * valuation tool puts it in the opening grid (Dr SUPPLIER_CLAIMS per supplier); once that opening is posted, the GL
 * carries every claim and each later settlement posts against it.
 */
export async function claimsNotInBooks(db: Db = prisma): Promise<Map<string, Decimal>> {
  const rows = await db.supplierClaim.findMany({ where: { status: { not: "VOID" }, invoice: { journalEntryId: null } }, select: { supplierId: true, net: true, settlements: { where: { voidedAt: null, journalEntryId: null }, select: { net: true } } } });
  const m = new Map<string, Decimal>();
  for (const c of rows) {
    const v = c.settlements.reduce((t, x) => t.minus(x.net), new Decimal(c.net));
    if (v.gt(0)) m.set(c.supplierId, (m.get(c.supplierId) ?? ZERO).plus(v));
  }
  return m;
}

/** The AP opening a supplier's pre-go-live invoices imply: gross − the payments and credit notes not posted either. */
export async function apNotInBooks(db: Db = prisma): Promise<Map<string, Decimal>> {
  const rows = await db.supplierInvoice.findMany({ where: { status: "POSTED", journalEntryId: null }, select: { supplierId: true, grossTotal: true,
    allocations: { where: { payment: { status: "POSTED", journalEntryId: null } }, select: { amount: true } },
    creditNotes: { where: { status: "POSTED", journalEntryId: null }, select: { gross: true, advanceAmount: true } } } });
  const m = new Map<string, Decimal>();
  for (const v of rows) {
    const open = new Decimal(v.grossTotal).minus(v.allocations.reduce((t, a) => t.plus(a.amount), ZERO)).minus(v.creditNotes.reduce((t, n) => t.plus(n.gross).minus(n.advanceAmount), ZERO));
    if (open.gt(0)) m.set(v.supplierId, (m.get(v.supplierId) ?? ZERO).plus(open));
  }
  return m;
}

/** Σ of the open claims (net + VAT) per supplier — the suppliers list and the AP aging. */
export async function openClaimsBySupplier(db: Db = prisma): Promise<Map<string, Decimal>> {
  const rows = await db.supplierClaim.findMany({ where: { status: "OPEN" }, select: { supplierId: true, net: true, vat: true, settledNet: true, settledVat: true } });
  const m = new Map<string, Decimal>();
  for (const c of rows) m.set(c.supplierId, (m.get(c.supplierId) ?? ZERO).plus(new Decimal(c.net).minus(c.settledNet)).plus(new Decimal(c.vat).minus(c.settledVat)));
  return m;
}

/**
 * «موثوقية المورد» per supplier over a period (posted one-step invoices dated in it): the fill rate (received ÷ billed,
 * by value at the lines' unit costs — kilograms and pieces do not add up), the shortage value (Σ shortfall), how much
 * of it was claimed and the share of the claims recovered (credit notes + replacement goods + refunds ÷ claims; an abandonment
 * is not a recovery).
 */
export async function supplierReliability(q: { from?: string | null; to?: string | null; supplierId?: string | null }) {
  const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? parseBusinessDay(q.to) : riyadhDay();
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? parseBusinessDay(q.from) : new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  const rows = await prisma.$queryRaw<{ supplierId: string; name: string; invoices: number; billed: Prisma.Decimal; shortage: Prisma.Decimal; lines: number; shortLines: number; claimed: Prisma.Decimal; recovered: Prisma.Decimal; abandoned: Prisma.Decimal; lost: Prisma.Decimal; absorbed: Prisma.Decimal }[]>`
    SELECT v."supplierId", s."name", count(DISTINCT v."id")::int AS invoices,
           coalesce(sum(l."net"), 0) AS billed, coalesce(sum(coalesce(l."shortfallNet", 0)), 0) AS shortage,
           count(l."id")::int AS lines, count(l."shortfallNet")::int AS "shortLines",
           coalesce(sum(CASE WHEN l."shortfallTreatment" = 'CLAIM' THEN l."shortfallNet" END), 0) AS claimed,
           coalesce(sum(CASE WHEN l."shortfallTreatment" = 'LOSS' THEN l."shortfallNet" END), 0) AS lost,
           coalesce(sum(CASE WHEN l."shortfallTreatment" = 'ABSORBED' THEN l."shortfallNet" END), 0) AS absorbed,
           coalesce(sum((SELECT coalesce(sum(t."net"), 0) FROM "SupplierClaim" c JOIN "SupplierClaimSettlement" t ON t."claimId" = c."id" WHERE c."invoiceLineId" = l."id" AND t."voidedAt" IS NULL AND t."kind" IN ('CREDIT_NOTE', 'REPLACEMENT', 'REFUND'))), 0) AS recovered,
           coalesce(sum((SELECT coalesce(sum(t."net"), 0) FROM "SupplierClaim" c JOIN "SupplierClaimSettlement" t ON t."claimId" = c."id" WHERE c."invoiceLineId" = l."id" AND t."voidedAt" IS NULL AND t."kind" = 'ABANDON')), 0) AS abandoned
      FROM "SupplierInvoice" v JOIN "Supplier" s ON s."id" = v."supplierId"
      JOIN "SupplierInvoiceLine" l ON l."invoiceId" = v."id" AND l."kind" = 'GRN'
     WHERE v."status" = 'POSTED' AND v."origin" = 'PURCHASES' AND v."invoiceDate" >= ${from} AND v."invoiceDate" <= ${to}
       AND (${q.supplierId ?? null}::text IS NULL OR v."supplierId" = ${q.supplierId ?? null})
     GROUP BY 1, 2 ORDER BY sum(coalesce(l."shortfallNet", 0)) DESC, s."name"`;
  const pct = (a: Decimal, b: Decimal) => (b.gt(0) ? a.div(b).times(100).toDecimalPlaces(1).toFixed(1) : null);
  return {
    from: dayText(from), to: dayText(to),
    rows: rows.map((r) => {
      const billed = new Decimal(r.billed), shortage = new Decimal(r.shortage), claimed = new Decimal(r.claimed), recovered = new Decimal(r.recovered);
      return {
        supplierId: r.supplierId, name: r.name, invoices: r.invoices, lines: r.lines, shortLines: r.shortLines,
        billed: billed.toFixed(2), received: billed.minus(shortage).toFixed(2), fillRate: pct(billed.minus(shortage), billed),
        shortage: shortage.toFixed(2), claimed: claimed.toFixed(2), lost: new Decimal(r.lost).toFixed(2), absorbed: new Decimal(r.absorbed).toFixed(2),
        recovered: recovered.toFixed(2), abandoned: new Decimal(r.abandoned).toFixed(2), recoveredPct: pct(recovered, claimed),
      };
    }),
  };
}
