// Confirmed & reviewed bank transaction → journal entry (STAGE_2_DESIGN.md §2, policy bank.posting).
// The cash side is the cash account's mapped GL account; the other side follows the Finance
// module's budget splits (which always add up to the full line). A split whose category maps to
// the payables control account posts only to the extent the line is matched to POSTED supplier
// bills — those matches name the supplier. Customer receipts/refunds post once assigned to a
// customer (CustomerReceipt): Cr AR_CONTROL for the allocated part, Cr CUSTOMER_ADVANCES + OUTPUT_VAT
// (per decision D-2) for the rest, all tagged with the customer.
import type { Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "../dates";
import { PostingBlocked } from "../errors";
import { dec, ZERO } from "../money";
import type { EngineLine } from "../posting";
import { journalOfEvent, mirrorOfJournal } from "./mirror";
import { advanceDecisionsPending } from "./receivables";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };

/** Settlements of POS/gateway sales: no POS sales records exist, so the daily summary is journalised by hand. */
export const WAITS_FOR_POS = new Set(["POS_SETTLEMENT", "GATEWAY_SETTLEMENT"]);
/** Money from or back to a customer: posts only once the line is assigned to a customer (stage 3). */
export const CUSTOMER_CLASSES = new Set(["CUSTOMER_RECEIPT", "CUSTOMER_REFUND"]);
/** Control kinds a bank split may never hit directly. */
const FORBIDDEN_CONTROLS = new Set(["RECEIVABLE", "CUSTOMER_ADVANCES", "COMMISSION_PAYABLE", "INVENTORY", "CASH"]);

export type SplitIn = { amount: Prisma.Decimal; accountId: string | null; accountCode?: string; controlKind?: string; categoryCode: string; costCenterId: string | null };
export type BillMatch = { amount: Prisma.Decimal; supplierId: string };

/** Pure composition of the journal lines, or the reason it cannot post. */
export function composeBankLines(input: { amount: Prisma.Decimal; cashAccountId: string; splits: SplitIn[]; billMatches: BillMatch[]; branchId?: string | null }):
  { lines: EngineLine[] } | { blocked: string } {
  const { amount } = input;
  if (amount.isZero()) return { blocked: "The bank line is zero." };
  const out = amount.isNegative();
  if (input.splits.length === 0) return { blocked: "The bank line has no budget split, so its counterpart account is unknown." };
  const splitSum = input.splits.reduce((s, x) => s.add(x.amount), ZERO);
  if (!splitSum.equals(amount)) return { blocked: `Budget splits (${splitSum.toFixed(2)}) do not add up to the line (${amount.toFixed(2)}).` };
  const unmapped = input.splits.filter((s) => !s.accountId).map((s) => s.categoryCode);
  if (unmapped.length) return { blocked: `Budget categories not mapped to a ledger account: ${[...new Set(unmapped)].join(", ")}.` };
  const forbidden = input.splits.filter((s) => s.controlKind && FORBIDDEN_CONTROLS.has(s.controlKind));
  if (forbidden.length) return { blocked: `Category ${forbidden[0].categoryCode} maps to control account ${forbidden[0].accountCode}, which a bank line cannot post to directly.` };

  const abs = amount.abs();
  const lines: EngineLine[] = [out
    ? { accountId: input.cashAccountId, credit: abs, description: "Bank", branchId: input.branchId }
    : { accountId: input.cashAccountId, debit: abs, description: "Bank", branchId: input.branchId }];

  const payable = input.splits.filter((s) => s.controlKind === "PAYABLE");
  const payableTotal = payable.reduce((s, x) => s.add(x.amount.abs()), ZERO);
  if (payableTotal.gt(0)) {
    if (!out) return { blocked: "Money received on the payables category (a supplier refund) is not supported yet." };
    const matched = input.billMatches.reduce((s, m) => s.add(m.amount), ZERO);
    if (matched.lt(payableTotal)) {
      return { blocked: `${payableTotal.sub(matched).toFixed(2)} SAR on the payables category is not matched to posted supplier bills.` };
    }
    if (matched.gt(payableTotal)) {
      return { blocked: `Matches to posted bills (${matched.toFixed(2)}) exceed the payables split (${payableTotal.toFixed(2)}).` };
    }
    // One AP debit per supplier, from the matches.
    const bySupplier = new Map<string, Prisma.Decimal>();
    for (const m of input.billMatches) bySupplier.set(m.supplierId, (bySupplier.get(m.supplierId) ?? ZERO).add(m.amount));
    const apAccount = payable[0].accountId!;
    for (const [supplierId, amt] of bySupplier) {
      lines.push({ accountId: apAccount, debit: amt, description: "Supplier payment", partyType: "SUPPLIER", partyId: supplierId, branchId: input.branchId });
    }
  }
  for (const s of input.splits.filter((x) => x.controlKind !== "PAYABLE")) {
    const a = s.amount.abs();
    lines.push(out
      ? { accountId: s.accountId!, debit: a, description: s.categoryCode, costCenterId: s.costCenterId, branchId: input.branchId }
      : { accountId: s.accountId!, credit: a, description: s.categoryCode, costCenterId: s.costCenterId, branchId: input.branchId });
  }
  return { lines };
}

export async function translateBank(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  const { transactionId } = ev.payload as { transactionId: string };
  // Lock the line (and a transfer's other leg) so an edit and a posting cannot interleave: an edit
  // committed first is what posts; an edit after the journal is refused by the database guard.
  await tx.$queryRaw`SELECT 1 FROM "BankTransaction" WHERE "id" = ${transactionId} OR "transferPeerId" = ${transactionId} ORDER BY "id" FOR UPDATE`;
  const t = await tx.bankTransaction.findUnique({
    where: { id: transactionId },
    include: { cashAccount: true, splits: true, matches: { where: { active: true } } },
  });
  if (!t) return { skip: "The bank transaction no longer exists." };
  const label = `${t.cashAccount.code} · ${t.txnDate.toISOString().slice(0, 10)}${t.bankReference ? ` · ${t.bankReference}` : ""}${t.description ? ` · ${t.description}` : ""}`;

  if (ev.eventType === "bank.transaction.voided") {
    const original = await journalOfEvent(tx, `bank:${t.id}:confirmed`);
    if (!original) return { skip: "The line was voided before it posted; there is nothing to mirror." };
    return {
      entryDate: accountingDateOf(ev.occurredAt), description: `Void of bank line ${label}`,
      sourceModule: "bank", sourceDocumentId: t.id, lines: await mirrorOfJournal(tx, original, "Bank line voided"), alsoUnapproved: [],
    };
  }

  if (t.status === "VOID") return { skip: "The line was voided before it posted." };
  const settings = await tx.accountingSettings.findUnique({ where: { id: "singleton" } });
  if (!settings?.bankPostingFrom) throw new PostingBlocked("The bank posting start date is not set, so bank lines do not post yet.");
  if (t.txnDate < settings.bankPostingFrom) return { skip: `Dated before bank posting starts (${settings.bankPostingFrom.toISOString().slice(0, 10)}).` };
  if (WAITS_FOR_POS.has(t.classification)) throw new PostingBlocked("POS and gateway settlements do not post automatically: there are no POS sales records to match, so journalise the daily sales summary manually.");
  if (!t.cashAccount.glAccountId) throw new PostingBlocked(`Cash account ${t.cashAccount.code} is not mapped to a ledger account.`);

  if (CUSTOMER_CLASSES.has(t.classification)) {
    // Stage 3: receivables part to AR, the rest to customer advances (with VAT per D-2).
    const r = await tx.customerReceipt.findUnique({ where: { bankTransactionId: t.id }, include: { customer: true } });
    if (!r || r.voided) throw new PostingBlocked("Assign this line to a customer in Accounting → Receivables → Receipts.");
    if (!dec(r.amount).equals(dec(t.amount))) throw new PostingBlocked(`The customer assignment (${dec(r.amount).toFixed(2)}) no longer matches the line (${dec(t.amount).toFixed(2)}); assign it again.`);
    const party = { partyType: "CUSTOMER" as const, partyId: r.customerId };
    const who = `${r.customer.nameAr ?? r.customer.name}`;
    const signed = (role: string, v: Prisma.Decimal, description: string): EngineLine | null =>
      v.isZero() ? null : v.isPositive() ? { role, credit: v, description, ...party } : { role, debit: v.abs(), description, ...party };
    const amt = dec(t.amount);
    const lines: EngineLine[] = [amt.isPositive()
      ? { accountId: t.cashAccount.glAccountId, debit: amt, description: "Bank" }
      : { accountId: t.cashAccount.glAccountId, credit: amt.abs(), description: "Bank" }];
    const adv = dec(r.advanceAmount), advVat = dec(r.advanceVat);
    for (const l of [signed("AR_CONTROL", dec(r.arAmount), `Receipt ${r.receiptNo} · ${who}`), signed("CUSTOMER_ADVANCES", adv.sub(advVat), `Advance · ${who}`), signed("OUTPUT_VAT", advVat, `VAT on advance · ${who}`)]) if (l) lines.push(l);
    return { entryDate: accountingDateOf(t.txnDate), description: `Customer ${amt.isPositive() ? "receipt" : "refund"} ${label} · ${who}`, sourceModule: "bank", sourceDocumentId: t.id, lines,
      alsoUnapproved: adv.isZero() ? [] : await advanceDecisionsPending(tx) };
  }

  if (t.classification === "INTERNAL_TRANSFER") {
    if (!t.transferPeerId) throw new PostingBlocked("The transfer has no paired line.");
    if (dec(t.amount).isPositive()) return { skip: "Transfers post once, from the paying side." };
    const peer = await tx.bankTransaction.findUnique({ where: { id: t.transferPeerId }, include: { cashAccount: true } });
    if (!peer?.cashAccount.glAccountId) throw new PostingBlocked("The receiving cash account of the transfer is not mapped to a ledger account.");
    const abs = dec(t.amount).abs();
    return {
      entryDate: accountingDateOf(t.txnDate), description: `Transfer ${t.cashAccount.code} → ${peer.cashAccount.code}`,
      sourceModule: "bank", sourceDocumentId: t.id, alsoUnapproved: [],
      lines: [{ accountId: peer.cashAccount.glAccountId, debit: abs, description: "Transfer in" }, { accountId: t.cashAccount.glAccountId, credit: abs, description: "Transfer out" }],
    };
  }

  const cats = await tx.finCategory.findMany({ where: { id: { in: t.splits.map((s) => s.finCategoryId) } }, include: { glAccount: true } });
  const byId = new Map(cats.map((c) => [c.id, c]));
  const splits: SplitIn[] = t.splits.map((s) => {
    const c = byId.get(s.finCategoryId);
    return { amount: dec(s.amount), accountId: c?.glAccountId ?? null, accountCode: c?.glAccount?.code, controlKind: c?.glAccount?.controlKind, categoryCode: c?.code ?? s.finCategoryId, costCenterId: s.costCenterId };
  });
  // Matches to obligations that belong to POSTED supplier bills name the supplier.
  const obIds = t.matches.filter((m) => m.targetType === "OBLIGATION").map((m) => m.targetId);
  const bills = obIds.length ? await tx.supplierBill.findMany({ where: { obligationId: { in: obIds }, status: "POSTED" }, select: { obligationId: true, supplierId: true } }) : [];
  const billByOb = new Map(bills.map((b) => [b.obligationId!, b.supplierId]));
  const billMatches: BillMatch[] = t.matches.filter((m) => m.targetType === "OBLIGATION" && billByOb.has(m.targetId)).map((m) => ({ amount: dec(m.amount), supplierId: billByOb.get(m.targetId)! }));

  const r = composeBankLines({ amount: dec(t.amount), cashAccountId: t.cashAccount.glAccountId, splits, billMatches });
  if ("blocked" in r) throw new PostingBlocked(r.blocked);
  return { entryDate: accountingDateOf(t.txnDate), description: `Bank line ${label}`, sourceModule: "bank", sourceDocumentId: t.id, lines: r.lines, alsoUnapproved: [] };
}
