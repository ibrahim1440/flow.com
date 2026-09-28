// Posted inventory document → journal entry, built only from the document's sealed cost moves
// (so the ledger always equals the cost subledger). Inventory accounts by item kind (KIND_ROLE);
// the counterpart by document type:
//   RECEIPT          Dr inventory            / Cr GRNI
//   SUPPLIER_RETURN  Dr GRNI                 / Cr inventory
//   ISSUE            Dr waste / cost of sales by reason / Cr inventory
//   TRANSFER         no ledger effect when both locations use the same account (they do: accounts are by item kind)
//   PRODUCTION       Dr outputs · Dr ABNORMAL_LOSS (loss beyond the band) / Cr inputs
//   SALE_ISSUE       Dr COGS                 / Cr finished goods
//   CUSTOMER_RETURN  Dr finished goods       / Cr COGS
//   COUNT            Dr/Cr inventory         / Cr/Dr INVENTORY_VARIANCE
//   LANDED_COST      Dr inventory (on hand) · Dr COGS (already used) / Cr GRNI
//   BILL_MATCH       the bill's price difference against GRNI: capitalised as landed cost, or all to INVENTORY_VARIANCE
import type { Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "../dates";
import { ZERO, dec } from "../money";
import type { EngineLine } from "../posting";
import { KIND_ROLE, ISSUE_ROLE } from "../inventory-rules";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };

const COUNTER: Record<string, string> = { RECEIPT: "GRNI", SUPPLIER_RETURN: "GRNI", SALE_ISSUE: "COGS", CUSTOMER_RETURN: "COGS", SALE_REVERSAL: "COGS", SUPPLIER_CREDIT: "GRNI", COUNT: "INVENTORY_VARIANCE", PRODUCTION: "ABNORMAL_LOSS", LANDED_COST: "GRNI", BILL_MATCH: "GRNI" };
const TYPE_LABEL: Record<string, string> = {
  RECEIPT: "Goods receipt", SUPPLIER_RETURN: "Return to supplier", ISSUE: "Stock issue", TRANSFER: "Transfer", PRODUCTION: "Production",
  SALE_ISSUE: "Cost of sales", CUSTOMER_RETURN: "Customer return", SALE_REVERSAL: "Invoice reversed: cost back to delivered, not invoiced", SUPPLIER_CREDIT: "Supplier credit", COUNT: "Stock count", LANDED_COST: "Landed cost", BILL_MATCH: "Supplier price difference",
};

export async function translateInventory(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  const { documentId } = ev.payload as { documentId: string };
  const d = await tx.invDocument.findUnique({ where: { id: documentId }, include: { moves: { include: { item: true } } } });
  if (!d || d.status !== "POSTED") return { skip: "The inventory document is not posted." };
  if (!d.movesSealed) return { skip: "The document's cost moves are incomplete." };
  const label = `${TYPE_LABEL[d.type]} #${d.docNo}${d.description ? ` · ${d.description}` : ""}`;

  const byRole = new Map<string, Prisma.Decimal>();
  const add = (role: string, v: Prisma.Decimal) => byRole.set(role, (byRole.get(role) ?? ZERO).add(v));
  // EXPENSED (a traced share of a cost change, to where the goods went) and ABSORBED (conversion
  // cost credited to its absorbed account) carry their posting role; older EXPENSED moves without
  // one keep their stage 4 meaning (cost of sales, or variance for an expensed price difference).
  const locs = new Map((await tx.invLocation.findMany({ where: { accountRole: { not: null } } })).map((l) => [l.id, l.accountRole!]));
  let expensed = ZERO;
  for (const m of d.moves) {
    if (m.kind === "EXPENSED" || m.kind === "ABSORBED") {
      if (m.role) add(m.role, dec(m.value)); else expensed = expensed.add(dec(m.value));
      continue;
    }
    add(locs.get(m.locationId) ?? KIND_ROLE[m.item.kind], dec(m.value));
  }
  const lines: EngineLine[] = [];
  const push = (role: string, v: Prisma.Decimal, description: string) => {
    if (v.isZero()) return;
    lines.push(v.isPositive() ? { role, debit: v, description } : { role, credit: v.abs(), description });
  };
  for (const [role, v] of byRole) push(role, v, label);
  if (!expensed.isZero()) {
    const role = d.type === "BILL_MATCH" && d.priceDifference === "EXPENSE" ? "INVENTORY_VARIANCE" : "COGS";
    push(role, expensed, d.type === "BILL_MATCH" && d.priceDifference === "EXPENSE" ? "Price difference expensed" : "Part for stock already used");
  }
  const net = [...byRole.values()].reduce((s, v) => s.add(v), ZERO).add(expensed);
  const counter = d.type === "ISSUE" ? ISSUE_ROLE[d.issueReason!] : d.type === "TRANSFER" ? null : COUNTER[d.type];
  if (!net.isZero()) {
    if (!counter) return { skip: "The document does not balance across inventory accounts; not posted." };
    push(counter, net.neg(), d.type === "PRODUCTION" ? "Loss beyond the approved band" : label);
  }
  if (lines.length < 2) return { skip: d.type === "TRANSFER" ? "A transfer between locations has no ledger effect (same accounts)." : "Nothing to post (zero value)." };
  return {
    entryDate: accountingDateOf(d.docDate), description: label, sourceModule: "inventory", sourceDocumentId: d.id, lines,
    alsoUnapproved: d.provisional ? ["decision D-1 (costing method, loss band or price-difference treatment) was not settled when the document posted"] : [],
  };
}
