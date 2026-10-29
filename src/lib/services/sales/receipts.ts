// «سند قبض» — the accountant's side of collections (BATCH22 WP-D; owner answer 2 and the owner's approval of 2026-10-29).
//
//   · Sales records a collection (commission) → the accountant REVIEWS and CONFIRMS it (accounting › receipts_confirm, or
//     the older commissions › collection_verify) → it is numbered «RCT-YYYY-NNNNNN» by the database and posted to the
//     deposit account the accountant chose; or the accountant RETURNS it for correction («إعادة للمندوب للتصحيح», a reasoned
//     rejection) and Sales «نسخ وتصحيح» it into a new pending collection (the returned one stays REJECTED — history kept).
//   · A receipt for an invoice with NO deal behind it (manual / recurring invoices): the accountant records it against an
//     issued invoice of a customer with no open deal; no commission; a SECOND person confirms it (four-eyes in the
//     database: SalesCollection_four_eyes_check) unless the SoD setting allows self-approval (SIMPLE MODE does) — then the
//     confirmation is flagged (sodBypass) and listed in «استثناءات فصل المهام».
// The amounts, the date, the method, the deal and the payer are never edited by the accountant: they are the commission
// basis and the rep's claim. Pure helpers are exported for the unit tests.
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "../commissions/engine";
import { PAYMENT_METHODS, customerOpenDeal, submitCollection, type PaymentMethodValue } from "./collections";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { defaultBranchForActor } from "@/lib/accounting/locations";

type Tx = Prisma.TransactionClient;
const bi = (code: string, status: number, ar: string, en: string) => ({ _appCode: status, code, message: ar, errorEn: en });

// ── who may do what (pure; the routes are the boundary, these are their rules and the screens' reasons) ─────────────

const holds = (p: Permissions, m: string, s: string) => hasModuleAccess(p, m) && hasSubPrivilege(p, m, s);

export type ReceiptAbilities = {
  /** Confirm a Sales collection («تأكيد السند»). */
  confirm: boolean;
  /** Return for correction / reject. */
  reject: boolean;
  /** Reverse a confirmed receipt (commissions › collection_reverse, or receipts_confirm for an accountant receipt) —
   *  the journal duty (journal_reverse) is checked by the route once accounting is active. */
  reverse: boolean;
  /** Record a receipt for an invoice with no deal (accounting › receipts_confirm or accounting › ar). */
  record: boolean;
  /** Edit the confirmation fields (deposit account, memo, allocation): the accounting key only. */
  editVoucher: boolean;
};

export function receiptAbilities(p: Permissions): ReceiptAbilities {
  const rc = holds(p, "accounting", "receipts_confirm");
  return {
    confirm: rc || holds(p, "commissions", "collection_verify"),
    reject: rc || holds(p, "commissions", "collection_reject"),
    reverse: rc || holds(p, "commissions", "collection_reverse"),
    record: rc || holds(p, "accounting", "ar"),
    editVoucher: rc,
  };
}

/** The permission key a decision exercises (for the central gate), by the row's source. null = refused. */
export function decisionKey(p: Permissions, action: "approve" | "reject" | "return" | "reverse", source: string): [module: string, sub: string] | null {
  const rc = holds(p, "accounting", "receipts_confirm");
  const accountant = source === "ACCOUNTANT";
  if (action === "approve") return rc ? ["accounting", "receipts_confirm"] : !accountant && holds(p, "commissions", "collection_verify") ? ["commissions", "collection_verify"] : null;
  if (action === "reject" || action === "return") return rc ? ["accounting", "receipts_confirm"] : !accountant && holds(p, "commissions", "collection_reject") ? ["commissions", "collection_reject"] : null;
  // Reverse: the commission correction stays commissions › collection_reverse for a Sales collection; an accountant
  // receipt has no commission, so the accounting key reverses it.
  if (accountant) return rc ? ["accounting", "receipts_confirm"] : null;
  return holds(p, "commissions", "collection_reverse") ? ["commissions", "collection_reverse"] : null;
}

/** Business days (Riyadh: Friday and Saturday off) between two instants — the queue's age. */
export function businessDaysBetween(from: Date, to: Date): number {
  const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const shift = (d: Date) => new Date(d.getTime() + 3 * 3600_000);
  let a = day(shift(from));
  const b = day(shift(to));
  let n = 0;
  while (a < b) {
    a = new Date(a.getTime() + 86_400_000);
    const w = a.getUTCDay();
    if (w !== 5 && w !== 6) n++;
  }
  return n;
}

/** The queue colour: amber over 2 business days, red over 5 (design §WP-D). */
export const ageTone = (days: number): "ok" | "amber" | "red" => (days > 5 ? "red" : days > 2 ? "amber" : "ok");

/** The tax part of a receipt against an invoice, in the invoice's own proportion (net stays > 0). */
export function splitByInvoice(gross: Decimal, invoiceGross: Decimal, invoiceTax: Decimal): { tax: Decimal; net: Decimal } {
  let tax = invoiceGross.isZero() ? ZERO : roundMoney(gross.times(invoiceTax).dividedBy(invoiceGross));
  if (tax.lessThan(0)) tax = ZERO;
  if (tax.greaterThanOrEqualTo(gross)) tax = roundMoney(gross.minus("0.01"));
  return { tax, net: roundMoney(gross.minus(tax)) };
}

// ── the accountant's receipt for an invoice with no deal ──────────────────────────────────────────────────────────

export type AccountantReceiptInput = {
  invoiceId: string;
  amountGross: Decimal;
  collectedAt: Date;
  paymentMethod: PaymentMethodValue;
  referenceNumber: string | null;
  note: string | null;
  idempotencyKey: string;
  submittedById: string;
  replacesCollectionId?: string | null;
};

/**
 * Record a receipt the accountant took for an issued invoice whose customer has no open deal. PENDING until a second
 * person confirms it. Idempotent on (recorder, key). The invoice row is locked so two receipts cannot both read the
 * same open amount: what is pending against the invoice is reserved.
 */
export async function recordAccountantReceipt(tx: Tx, input: AccountantReceiptInput) {
  const existing = await tx.salesCollection.findUnique({ where: { submittedById_idempotencyKey: { submittedById: input.submittedById, idempotencyKey: input.idempotencyKey } }, select: { id: true } });
  if (existing) return { collectionId: existing.id, replayed: true };
  if (input.amountGross.lessThanOrEqualTo(0)) throw bi("AMOUNT", 400, "المبلغ يجب أن يكون موجبًا.", "The amount must be positive.");
  if (!(PAYMENT_METHODS as string[]).includes(input.paymentMethod)) throw bi("BAD_INPUT", 400, "طريقة الدفع غير معروفة.", "Unknown payment method.");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SalesInvoice" WHERE "id" = ${input.invoiceId} FOR UPDATE`;
  const inv = rows.length ? await tx.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: { id: true, kind: true, status: true, customerId: true, orderId: true, grandTotal: true, taxTotal: true, currency: true, number: true, branchId: true } }) : null;
  if (!inv || inv.status !== "ISSUED" || inv.kind === "CREDIT_NOTE") throw bi("INVOICE_NOT_OPEN", 404, "الفاتورة غير موجودة أو غير مُصدرة.", "The invoice does not exist or is not issued.");
  // The customer row is locked too: a deal opened for the customer meanwhile is seen (and re-checked at confirmation).
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${inv.customerId} FOR UPDATE`;
  const open = await customerOpenDeal(tx, inv.customerId);
  if (open) throw bi("CUSTOMER_HAS_OPEN_DEAL", 409, `للعميل صفقة مفتوحة («${open.title}»)؛ يُسجّل التحصيل من المبيعات على الصفقة.`, `The customer has an open deal ("${open.title}"); Sales records the collection on the deal.`);
  const applied = await tx.arApplication.aggregate({ where: { invoiceId: inv.id, status: "APPLIED" }, _sum: { amount: true } });
  const pending = await tx.salesCollection.aggregate({ where: { invoiceId: inv.id, status: "PENDING_VERIFICATION" }, _sum: { amountGross: true } });
  const total = new Decimal(inv.grandTotal.toString());
  const room = roundMoney(total.minus(new Decimal((applied._sum.amount ?? 0).toString())).minus(new Decimal((pending._sum.amountGross ?? 0).toString())));
  if (input.amountGross.greaterThan(room)) {
    throw bi("OVER_INVOICE", 409, `المتبقي على الفاتورة بعد السندات المعلّقة ${room.toFixed(2)} فقط.`, `Only ${room.toFixed(2)} is left on the invoice after the pending receipts.`);
  }
  const { tax, net } = splitByInvoice(input.amountGross, total, new Decimal(inv.taxTotal.toString()));
  const created = await tx.salesCollection.create({
    data: {
      source: "ACCOUNTANT", opportunityId: null, quoteId: null, orderId: inv.orderId, customerId: inv.customerId, invoiceId: inv.id,
      idempotencyKey: input.idempotencyKey, referenceNumber: input.referenceNumber?.trim() || null,
      amountGross: input.amountGross.toFixed(2), amountTax: tax.toFixed(2), amountNet: net.toFixed(2), currency: inv.currency ?? "SAR",
      paymentMethod: input.paymentMethod, collectedAt: input.collectedAt, note: input.note?.trim() || null,
      submittedById: input.submittedById, replacesCollectionId: input.replacesCollectionId ?? null,
      // «الموقع» (WP-B): the receipt of one invoice takes that invoice's location, else the recorder's default.
      branchId: inv.branchId ?? (await defaultBranchForActor(tx, input.submittedById)),
    },
    select: { id: true },
  });
  await emitAutomationEvent(tx, { eventType: "sales.collection_status_changed", subjectType: "SalesCollection", subjectId: created.id, payload: { from: null, to: "PENDING_VERIFICATION" }, actorId: input.submittedById });
  return { collectionId: created.id, replayed: false };
}

// ── «نسخ وتصحيح» ─────────────────────────────────────────────────────────────────────────────────────────────────

export type CorrectionEdits = { amountGross?: Decimal; collectedAt?: Date; paymentMethod?: PaymentMethodValue; referenceNumber?: string | null; note?: string | null };

/**
 * Copy a collection the accountant returned for correction into a new PENDING one, prefilled from it (the edits
 * applied), naming it (replacesCollectionId, unique — once per returned row) and with its evidence copied. The returned
 * collection stays REJECTED. Only its recorder may correct it (the rep who owns the claim).
 */
export async function copyAndCorrect(tx: Tx, input: { collectionId: string; actorId: string; idempotencyKey: string; edits: CorrectionEdits }) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SalesCollection" WHERE "id" = ${input.collectionId} FOR UPDATE`;
  const old = rows.length ? await tx.salesCollection.findUnique({ where: { id: input.collectionId }, include: { correctedBy: { select: { id: true } }, evidence: true } }) : null;
  if (!old) throw bi("NOT_FOUND", 404, "السند غير موجود.", "Collection not found.");
  if (old.submittedById !== input.actorId) throw bi("NOT_YOURS", 403, "يصحّح السند من سجّله فقط.", "Only the person who recorded a collection corrects it.");
  if (old.status !== "REJECTED" || old.decisionReasonCode !== "RETURN_FOR_CORRECTION") throw bi("NOT_RETURNED", 409, "لم يُعَد هذا السند للتصحيح.", "This collection was not returned for correction.");
  if (old.correctedBy) return { collectionId: old.correctedBy.id, replayed: true };
  const e = input.edits;
  const base = {
    amountGross: e.amountGross ?? new Decimal(old.amountGross.toString()),
    collectedAt: e.collectedAt ?? old.collectedAt,
    paymentMethod: (e.paymentMethod ?? old.paymentMethod) as PaymentMethodValue,
    referenceNumber: e.referenceNumber !== undefined ? e.referenceNumber : old.referenceNumber,
    note: e.note !== undefined ? e.note : old.note,
    idempotencyKey: input.idempotencyKey, submittedById: input.actorId, replacesCollectionId: old.id,
  };
  const r = old.source === "ACCOUNTANT"
    ? await recordAccountantReceipt(tx, { ...base, invoiceId: old.invoiceId! })
    : await submitCollection(tx, { ...base, opportunityId: old.opportunityId!, currency: old.currency });
  if (!r.replayed && old.evidence.length) {
    await tx.collectionEvidence.createMany({
      data: old.evidence.map((v) => ({ collectionId: r.collectionId, filename: v.filename, mimeType: v.mimeType, byteSize: v.byteSize, checksum: v.checksum, content: v.content, uploadedById: input.actorId })),
    });
  }
  return { collectionId: r.collectionId, replayed: r.replayed };
}

/** The accounts a receipt may be deposited to, and the default of each method (its role account, when mapped). */
export async function depositAccounts(tx: Pick<Tx, "account" | "accountRole">) {
  const accounts = await tx.account.findMany({
    where: { isActive: true, allowPosting: true, children: { none: {} }, OR: [{ controlType: { in: ["CASH", "BANK"] } }, { controlType: "CLEARING", roles: { some: { role: "CARD_CLEARING" } } }] },
    orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, controlType: true },
  });
  const roles = await tx.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["CASH", "BANK", "CARD_CLEARING"] } }, select: { role: true, accountId: true } });
  const by = new Map(roles.map((r) => [r.role, r.accountId]));
  const byMethod: Record<string, string | null> = {};
  for (const m of PAYMENT_METHODS) byMethod[m] = by.get(m === "CASH" ? "CASH" : m === "POS_CARD" ? "CARD_CLEARING" : "BANK") ?? null;
  return { accounts, byMethod };
}
