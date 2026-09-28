// Operational stock → inventory accounting (stage 4b).
//
// Each operational write that changes stock (purchase, roast, roast cancellation, blend, packing,
// dispatch, adjustment, opening quantity) calls recordStockEvent in the SAME transaction, with the
// quantities the operational system treats as authoritative:
//   PURCHASE          PurchaseRecord.quantity (kg) at costPerUnit          → RECEIPT
//   ROAST             RoastingBatch green kg in, roasted kg out           → PRODUCTION (ROASTING)
//   ROAST_CANCEL      the batch's kg; restock or not                       → ADJUSTMENT / ISSUE
//   BLEND             kg taken from each source batch, blend kg out        → PRODUCTION (BLENDING)
//   PACK              roasted grams drawn (packed + loss), materials drawn,
//                     whole units per standard lot, content-share of a unit
//                     for a partial package and its top-ups               → PRODUCTION (PACKING)
//   DISPATCH          whole SKU units shipped (consumeFinishedUnits)       → TRANSFER to "delivered, not invoiced"
//   ADJUST            signed kg / pieces from an operational count         → ADJUSTMENT
//   OPENING           quantity entered when the master record is created   → held: no cost, opening-balance decision
// A database trigger adds an UNINTEGRATED event for any InventoryMovement written by a
// transaction that recorded none, so an unknown stock writer is an exception, never a silent gap.
//
// The processor turns each event into ONE inventory document (sourceType OPS, sourceId = event
// id: a retry, a second worker or a crash never duplicates it). With the inventory.operations
// policy approved, a document within tolerance (items linked, cost known, loss within the
// approved band of the process) is approved under that policy and posted; anything else waits
// for an accountant (HELD, with the document prepared) or stops with its reason (BLOCKED). Posting
// failures (stock not yet there, period closed, decision D-1 open) retry with back-off (FAILED).
// Nothing here changes the operational record, and nobody re-enters operational quantities.
import { Prisma, type InvOpsStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDateOf, todayAccountingDate } from "./dates";
import { INV_SYSTEM, createInvDoc, submitInvDoc, onHand, type InvDocInput } from "./inventory-service";
import { deliveredLocation, systemDoc } from "./sales-costing";

type Tx = Prisma.TransactionClient;
type DV = string | number | Prisma.Decimal;
const LEASE_MS = 2 * 60_000;
export const OPS_KINDS = ["PURCHASE", "OPENING", "ROAST", "ROAST_CANCEL", "BLEND", "PACK", "DISPATCH", "ADJUST", "UNINTEGRATED"] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

export type StockEvent = { kind: Exclude<OpsKind, "UNINTEGRATED">; sourceId: string; seq?: number; occurredOn?: Date; payload: Record<string, unknown>; userId?: string | null };

/** Record an operational stock event inside the operational transaction that changed the stock. */
export async function recordStockEvent(tx: Tx, e: StockEvent) {
  return tx.invOpsEvent.create({ data: {
    kind: e.kind, sourceId: e.sourceId, seq: e.seq ?? 0, occurredOn: e.occurredOn ? accountingDateOf(e.occurredOn) : todayAccountingDate(),
    payload: e.payload as Prisma.InputJsonValue, userId: e.userId ?? null,
  } });
}

/** A reason the event cannot become a document by itself. */
class Stop extends Error { constructor(readonly status: "BLOCKED" | "HELD", message: string) { super(message); } }
const blocked = (m: string) => new Stop("BLOCKED", m);

type Built = { input: InvDocInput; auto: boolean; why?: string } | { skip: string };

const num = (v: unknown) => new Prisma.Decimal(String(v ?? 0));
const q4 = (v: DV) => new Prisma.Decimal(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const day = (d: Date) => d.toISOString().slice(0, 10);

async function opsLocation() {
  const loc = await prisma.invLocation.findFirst({ where: { isSalesDefault: true, isActive: true } });
  if (!loc) throw blocked("No stock location is marked as the sales default; operational stock is booked there. Set it in inventory setup.");
  return loc;
}
const itemBy = async (field: "greenBeanId" | "coffeeProductId" | "materialItemId" | "productSkuId", id: string | null | undefined, what: string) => {
  if (!id) throw blocked(`${what} is not recorded on the operational record.`);
  const it = await prisma.invItem.findUnique({ where: { [field]: id } as unknown as Prisma.InvItemWhereUniqueInput });
  if (!it) throw blocked(`${what} (${id}) is not linked to an inventory item; link it in inventory setup, then retry.`);
  if (!it.isActive) throw blocked(`Inventory item ${it.code} is inactive.`);
  return it;
};
async function batchProduct(batchId: string) {
  const b = await prisma.roastingBatch.findUnique({ where: { id: batchId }, select: { productId: true, batchNumber: true, orderItem: { select: { productId: true } } } });
  return { productId: b?.productId ?? b?.orderItem?.productId ?? null, batchNumber: b?.batchNumber ?? batchId };
}
async function lossBand(process: string) {
  const bands = await prisma.invLossBand.findMany({ where: { process, status: "APPROVED" } });
  return bands.length === 1 ? bands[0] : null;
}
/** Production loss check against the approved band: within → automatic, above → an accountant approves. */
async function productionTolerance(process: string, lines: { itemId: string; role: "INPUT" | "OUTPUT"; quantity: string }[]) {
  const items = new Map((await prisma.invItem.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } })).map((i) => [i.id, i]));
  const Y = new Set(["GREEN_COFFEE", "ROASTED_COFFEE", "MILK", "BAKERY_INGREDIENT", "FINISHED_GOOD"]);
  const y = (role: string) => lines.filter((l) => l.role === role && Y.has(items.get(l.itemId)!.kind)).reduce((s, l) => s.add(num(l.quantity).mul(dec(items.get(l.itemId)!.yieldPerUnit))), ZERO);
  const yin = y("INPUT"), yout = y("OUTPUT");
  const lossPct = yin.isZero() ? ZERO : yin.sub(yout).div(yin).mul(100);
  if (lossPct.lte(0)) return { lossBandId: null as string | null, auto: true };
  const band = await lossBand(process);
  if (!band) return { lossBandId: null, auto: false, why: `No single approved loss band for ${process}; the loss of ${lossPct.toFixed(2)}% needs an accountant (choose the band on the document).` };
  if (lossPct.gt(dec(band.maxLossPercent))) return { lossBandId: band.id, auto: false, why: `Loss ${lossPct.toFixed(2)}% is above the approved band ${band.code} (${dec(band.maxLossPercent).toFixed(2)}%): the abnormal loss needs an accountant's approval.` };
  return { lossBandId: band.id, auto: true };
}

async function build(ev: { id: string; kind: string; sourceId: string; occurredOn: Date; payload: Prisma.JsonValue }): Promise<Built> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const base = { docDate: day(ev.occurredOn), sourceType: "OPS", sourceId: ev.id };
  switch (ev.kind) {
    case "UNINTEGRATED":
      throw blocked("A stock movement was written by an operational path the integration does not know; review it and post a document, or dismiss it with the reason.");
    case "PURCHASE": {
      const loc = await opsLocation();
      const it = p.materialItemId ? await itemBy("materialItemId", String(p.materialItemId), "The purchased material") : await itemBy("greenBeanId", String(p.greenBeanId ?? ""), "The purchased green coffee");
      if (!p.supplierId) throw blocked("The purchase names no supplier.");
      return { input: { ...base, type: "RECEIPT", locationId: loc.id, supplierId: p.supplierId, description: `Purchase ${String(p.purchaseId ?? ev.sourceId)} · ${p.quantity} × ${p.costPerUnit}`,
        lines: [{ itemId: it.id, quantity: q4(num(p.quantity)).toFixed(4), unitCost: q4(num(p.costPerUnit)).toFixed(4) }] }, auto: true };
    }
    case "OPENING": {
      // An opening quantity carries no cost, and its counter-entry (opening balance, migration
      // suspense…) is an accounting decision, not an operational one: it waits, with the reason.
      const field = p.materialItemId ? "materialItemId" : "greenBeanId";
      const it = await itemBy(field, String(p.materialItemId ?? p.greenBeanId ?? ""), field === "greenBeanId" ? "The green coffee" : "The material");
      throw new Stop("HELD", `Opening quantity ${num(p.quantity).toFixed(4)} ${it.baseUnit} of ${it.code} was entered without a cost. Record it through the opening-balance procedure (a migration decision) and link that document here, or dismiss it with the reason.`);
    }
    case "ROAST": {
      const loc = await opsLocation();
      const green = await itemBy("greenBeanId", String(p.greenBeanId ?? ""), "The roast's green coffee");
      const productId = (p.productId as string | null) ?? (await batchProduct(ev.sourceId)).productId;
      const roasted = await itemBy("coffeeProductId", productId, "The roasted product");
      const lines = [{ role: "INPUT" as const, itemId: green.id, quantity: q4(num(p.greenKg)).toFixed(4) }, { role: "OUTPUT" as const, itemId: roasted.id, quantity: q4(num(p.roastedKg)).toFixed(4) }];
      const t = await productionTolerance("ROASTING", lines);
      return { input: { ...base, type: "PRODUCTION", process: "ROASTING", locationId: loc.id, lossBandId: t.lossBandId, description: `Roast ${p.batchNumber} · ${p.greenKg} kg → ${p.roastedKg} kg`, lines }, auto: t.auto, why: t.why };
    }
    case "ROAST_CANCEL": {
      const loc = await opsLocation();
      const roast = await prisma.invOpsEvent.findUnique({ where: { kind_sourceId_seq: { kind: "ROAST", sourceId: ev.sourceId, seq: 0 } } });
      const green = await itemBy("greenBeanId", String(p.greenBeanId ?? ""), "The roast's green coffee");
      if (roast && roast.status !== "POSTED" && roast.status !== "IGNORED") {
        if (roast.status === "PROCESSING") throw new AccountingError("The roast is being processed; the cancellation follows it.", 409);
        // The roast never reached the accounts: nothing to undo. Without restock the green was used up.
        await prisma.invOpsEvent.update({ where: { id: roast.id }, data: { status: "IGNORED", resolution: "The batch was cancelled before its roast reached the accounts.", resolvedBy: INV_SYSTEM, resolvedAt: new Date(), leaseUntil: null } });
        if (p.restock) return { skip: "The batch was cancelled with its green coffee restocked before the roast reached the accounts: no stock effect." };
        return { input: { ...base, type: "ISSUE", issueReason: "SPOILAGE", locationId: loc.id, description: `Cancelled roast ${p.batchNumber}: green coffee used, nothing kept`, lines: [{ itemId: green.id, quantity: q4(num(p.greenKg)).toFixed(4) }] }, auto: true };
      }
      const productId = (p.productId as string | null) ?? null;
      const roasted = await itemBy("coffeeProductId", productId, "The roasted product");
      if (!p.restock) return { input: { ...base, type: "ISSUE", issueReason: "SPOILAGE", locationId: loc.id, description: `Cancelled roast ${p.batchNumber}: roasted coffee discarded`, lines: [{ itemId: roasted.id, quantity: q4(num(p.roastedKg)).toFixed(4) }] }, auto: true };
      // Restocked: the roasted output leaves, the green comes back at the cost it left at.
      let unitCost: string | undefined;
      if (roast?.documentId) {
        const outs = await prisma.invMove.findMany({ where: { documentId: roast.documentId, itemId: green.id, kind: "OUT" } });
        const q = outs.reduce((s, m) => s.sub(dec(m.qty)), ZERO), v = outs.reduce((s, m) => s.sub(dec(m.value)), ZERO);
        if (q.gt(0)) unitCost = v.div(q).toDecimalPlaces(4).toFixed(4);
      }
      return { input: { ...base, type: "ADJUSTMENT", locationId: loc.id, reason: `Roast ${p.batchNumber} cancelled, green coffee restocked`, description: `Cancelled roast ${p.batchNumber}: restock`,
        lines: [{ itemId: roasted.id, role: "INPUT", quantity: q4(num(p.roastedKg)).toFixed(4) }, { itemId: green.id, role: "OUTPUT", quantity: q4(num(p.greenKg)).toFixed(4), unitCost }] }, auto: true };
    }
    case "BLEND": {
      const loc = await opsLocation();
      const sources = (p.sources as { batchId: string; kg: number }[]) ?? [];
      const byItem = new Map<string, Prisma.Decimal>();
      for (const s of sources) {
        const it = await itemBy("coffeeProductId", (await batchProduct(s.batchId)).productId, `The roasted product of source batch ${(await batchProduct(s.batchId)).batchNumber}`);
        byItem.set(it.id, (byItem.get(it.id) ?? ZERO).add(num(s.kg)));
      }
      const out = await itemBy("coffeeProductId", (p.productId as string | null) ?? (await batchProduct(ev.sourceId)).productId, "The blend product");
      const lines = [...[...byItem].map(([itemId, kg]) => ({ role: "INPUT" as const, itemId, quantity: q4(kg).toFixed(4) })), { role: "OUTPUT" as const, itemId: out.id, quantity: q4(num(p.totalKg)).toFixed(4) }];
      const t = await productionTolerance("BLENDING", lines);
      return { input: { ...base, type: "PRODUCTION", process: "BLENDING", locationId: loc.id, lossBandId: t.lossBandId, description: `Blend ${p.batchNumber} · ${sources.length} source batch(es) → ${p.totalKg} kg`, lines }, auto: t.auto, why: t.why };
    }
    case "PACK": {
      const loc = await opsLocation();
      const roasted = await itemBy("coffeeProductId", (p.productId as string | null) ?? (await batchProduct(String(p.batchId))).productId, "The packed roasted product");
      const lines: { role: "INPUT" | "OUTPUT"; itemId: string; quantity: string; lotId?: string }[] = [];
      const gramsIn = num(p.gramsConsumed);
      if (gramsIn.gt(0)) lines.push({ role: "INPUT", itemId: roasted.id, quantity: q4(gramsIn.div(1000)).toFixed(4) });
      for (const m of (p.materials as { materialItemId: string; quantity: number }[]) ?? []) {
        const it = await itemBy("materialItemId", m.materialItemId, "A packaging material");
        lines.push({ role: "INPUT", itemId: it.id, quantity: q4(num(m.quantity)).toFixed(4) });
      }
      // Units: a standard package is one unit; a partial package is its content's share of a unit,
      // and a top-up adds the difference (a package that reaches its weight becomes exactly one).
      const share = (g: DV, nominal: DV) => q4(num(g).div(num(nominal)));
      for (const l of (p.lots as { lotId: string; productSkuId: string; kind: string; units: number; actualGrams: number; nominalGrams: number; gramsAdded?: number; becomesStandard?: boolean }[]) ?? []) {
        const it = await itemBy("productSkuId", l.productSkuId, "The packed SKU");
        let units: Prisma.Decimal;
        if (l.kind === "STANDARD") units = num(l.units);
        else if (l.kind === "PARTIAL") units = share(l.actualGrams, l.nominalGrams);
        else units = (l.becomesStandard ? dec(1) : share(l.actualGrams, l.nominalGrams)).sub(share(num(l.actualGrams).sub(num(l.gramsAdded ?? 0)), l.nominalGrams));
        if (units.gt(0)) lines.push({ role: "OUTPUT", itemId: it.id, quantity: units.toFixed(4), lotId: l.lotId });
      }
      if (!lines.some((l) => l.role === "OUTPUT")) {
        // Only loss: the coffee drawn is written off.
        if (!lines.length) return { skip: "Nothing was drawn." };
        return { input: { ...base, type: "ISSUE", issueReason: "SPOILAGE", locationId: loc.id, description: `Packing loss on batch ${p.batchNumber}`, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) }, auto: true };
      }
      const t = await productionTolerance("PACKING", lines);
      return { input: { ...base, type: "PRODUCTION", process: "PACKING", locationId: loc.id, lossBandId: t.lossBandId, description: `Packing batch ${p.batchNumber} · ${gramsIn.toFixed(0)} g`, lines }, auto: t.auto, why: t.why };
    }
    case "DISPATCH": {
      if (p.mode === "KG") throw blocked("A kilogram lot (the old packing path, not integrated) was dispatched; its cost is not in the inventory accounts. Post the dispatch manually or dismiss it with the reason.");
      const loc = await opsLocation();
      const dlv = await deliveredLocation();
      const it = await itemBy("productSkuId", String(p.productSkuId ?? ""), "The dispatched SKU");
      return { input: { ...base, type: "TRANSFER", locationId: loc.id, toLocationId: dlv.id, description: `Dispatch ${ev.sourceId} · ${p.units} × ${it.code}`,
        lines: [{ itemId: it.id, quantity: q4(num(p.units)).toFixed(4), orderItemId: p.orderItemId, lotId: p.lotId }] }, auto: true };
    }
    case "ADJUST": {
      const loc = await opsLocation();
      const it = p.materialItemId ? await itemBy("materialItemId", String(p.materialItemId), "The adjusted material") : await itemBy("greenBeanId", String(p.greenBeanId ?? ""), "The adjusted green coffee");
      const delta = num(p.quantityChanged);
      if (delta.isZero()) return { skip: "No quantity change." };
      return { input: { ...base, type: "ADJUSTMENT", locationId: loc.id, reason: String(p.reason ?? "Operational stock adjustment"), description: `Operational adjustment · ${it.code} ${delta.gt(0) ? "+" : ""}${delta.toFixed(4)}`,
        lines: [{ itemId: it.id, role: delta.gt(0) ? "OUTPUT" : "INPUT", quantity: q4(delta.abs()).toFixed(4) }] }, auto: true };
    }
  }
  throw blocked(`Unknown operational event kind ${ev.kind}.`);
}

async function policyApprover(): Promise<string | null> {
  const p = await prisma.accountingPolicy.findFirst({ where: { key: "inventory.operations", status: "APPROVED" } });
  return p ? `system:policy:inventory.operations:v${p.version}` : null;
}

async function settle(id: string, status: InvOpsStatus, data: Partial<{ lastError: string | null; documentId: string | null; resolution: string | null; nextAttemptAt: Date }> = {}) {
  await prisma.invOpsEvent.update({ where: { id }, data: { status, leaseUntil: null, ...data } });
  return { id, status, reason: data.lastError ?? data.resolution ?? null, documentId: data.documentId ?? null };
}

/** Bring one event to its accounting state. Idempotent; a live lease is respected unless forced. */
export async function processOpsEvent(id: string, opts: { force?: boolean } = {}) {
  const now = new Date();
  const claim = await prisma.invOpsEvent.updateMany({
    where: { id, status: { in: opts.force ? ["PENDING", "FAILED", "HELD", "BLOCKED", "PROCESSING"] : ["PENDING", "FAILED", "HELD"] }, ...(opts.force ? {} : { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }) },
    data: { status: "PROCESSING", leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
  });
  const ev = await prisma.invOpsEvent.findUnique({ where: { id } });
  if (!ev) throw new AccountingError("Operational event not found.", 404);
  if (claim.count !== 1) return { id, status: ev.status, reason: ev.lastError, documentId: ev.documentId };
  try {
    // A document already prepared (held for an accountant) finishes when it posts.
    const existing = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "OPS", sourceId: ev.id } } });
    if (existing && existing.status !== "APPROVED") {
      if (existing.status === "POSTED") return settle(id, "POSTED", { documentId: existing.id, lastError: null });
      return settle(id, "HELD", { documentId: existing.id, lastError: ev.lastError ?? `Document ${existing.docNo} waits for an accountant.` });
    }
    const b = await build(ev);
    if ("skip" in b) return settle(id, "IGNORED", { resolution: b.skip, lastError: null });
    const approver = await policyApprover();
    if (approver && b.auto) {
      const doc = await systemDoc(b.input, approver);
      if (doc.status !== "POSTED") throw new AccountingError(`Document ${doc.docNo} did not post.`, 409);
      return settle(id, "POSTED", { documentId: doc.id, lastError: null });
    }
    // Prepared for an accountant: submitted for approval (a draft when it needs input first).
    let doc = existing;
    if (!doc) {
      try { doc = await createInvDoc(b.input, ev.userId ?? INV_SYSTEM); }
      catch (e) { doc = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "OPS", sourceId: ev.id } } }); if (!doc) throw e; }
      if (doc.status === "DRAFT") await submitInvDoc(doc.id, ev.userId ?? INV_SYSTEM).catch(() => undefined);
    }
    const why = !approver ? "The inventory.operations policy is not approved: an accountant approves each operational document." : b.why ?? "An accountant approves this document.";
    return settle(id, "HELD", { documentId: doc.id, lastError: why });
  } catch (e) {
    if (e instanceof Stop) return settle(id, e.status, { lastError: e.message });
    const msg = e instanceof Error ? e.message : String(e);
    // Back-off: 1, 2, 4 … minutes, capped at an hour.
    const wait = Math.min(60, 2 ** Math.min(ev.attempts, 6)) * 60_000;
    return settle(id, "FAILED", { lastError: msg.slice(0, 1000), nextAttemptAt: new Date(Date.now() + wait) });
  }
}

/** Work through waiting events, oldest first (a roast before its packing). */
export async function processPendingOpsEvents(limit = 100) {
  const now = new Date();
  const due = await prisma.invOpsEvent.findMany({
    where: { OR: [{ status: "PENDING" }, { status: "FAILED", nextAttemptAt: { lte: now } }, { status: "HELD", documentId: { not: null } }, { status: "PROCESSING", leaseUntil: { lt: now } }] },
    orderBy: [{ createdAt: "asc" }, { seq: "asc" }], take: limit, select: { id: true, status: true },
  });
  const results = [];
  for (const e of due) {
    if (e.status === "PROCESSING") await prisma.invOpsEvent.updateMany({ where: { id: e.id, status: "PROCESSING", leaseUntil: { lt: now } }, data: { status: "FAILED", lastError: "The previous attempt stopped before finishing (lease expired); retried." } });
    results.push(await processOpsEvent(e.id));
  }
  return results;
}

export async function retryOpsEvent(id: string, userId: string) {
  const ev = await prisma.invOpsEvent.findUnique({ where: { id } });
  if (!ev) throw new AccountingError("Operational event not found.", 404);
  if (!["FAILED", "BLOCKED", "HELD", "PENDING"].includes(ev.status)) throw new AccountingError(`A ${ev.status.toLowerCase()} event cannot be retried.`, 409);
  if (ev.kind === "UNINTEGRATED") throw new AccountingError("An unintegrated movement is resolved by linking the document you posted for it, or dismissed with a reason.", 409);
  await ledgerTx(async (tx) => {
    await tx.invOpsEvent.update({ where: { id }, data: { status: "PENDING", nextAttemptAt: new Date(), leaseUntil: null } });
    await auditAccounting(tx, { action: "inventory.ops_event.retry", entityType: "inv_ops_event", entityId: id, userId });
  });
  return processOpsEvent(id);
}

/** Dismiss an event that needs no stock effect (e.g. a test entry), with the reason. Not for posted ones. */
export async function ignoreOpsEvent(id: string, userId: string, reason: string) {
  if (!reason || reason.trim().length < 10) throw new AccountingError("Dismissing an operational event needs a reason (at least 10 characters).", 400);
  return ledgerTx(async (tx) => {
    const ev = await tx.invOpsEvent.findUnique({ where: { id } });
    if (!ev) throw new AccountingError("Operational event not found.", 404);
    if (!["FAILED", "BLOCKED", "HELD", "PENDING"].includes(ev.status)) throw new AccountingError(`A ${ev.status.toLowerCase()} event cannot be dismissed.`, 409);
    if (ev.documentId) {
      const d = await tx.invDocument.findUnique({ where: { id: ev.documentId } });
      if (d?.status === "POSTED") throw new AccountingError("Its document has posted; the event is complete.", 409);
      if (d && d.status !== "DRAFT") throw new AccountingError(`Reject or delete document ${d.docNo} first.`, 409);
    }
    await tx.invOpsEvent.update({ where: { id }, data: { status: "IGNORED", resolvedBy: userId, resolvedAt: new Date(), resolution: reason.trim().slice(0, 500), leaseUntil: null } });
    await auditAccounting(tx, { action: "inventory.ops_event.ignore", entityType: "inv_ops_event", entityId: id, userId, reason: reason.trim() });
    return tx.invOpsEvent.findUniqueOrThrow({ where: { id } });
  });
}

/** Resolve an event by the posted document an accountant made for it (e.g. an unintegrated movement). */
export async function linkOpsEvent(id: string, documentId: string, userId: string, reason: string) {
  if (!reason || reason.trim().length < 10) throw new AccountingError("Linking a document needs a reason (at least 10 characters).", 400);
  return ledgerTx(async (tx) => {
    const ev = await tx.invOpsEvent.findUnique({ where: { id } });
    if (!ev) throw new AccountingError("Operational event not found.", 404);
    if (!["FAILED", "BLOCKED", "HELD"].includes(ev.status)) throw new AccountingError(`A ${ev.status.toLowerCase()} event cannot be linked.`, 409);
    const d = await tx.invDocument.findUnique({ where: { id: documentId } });
    if (!d || d.status !== "POSTED") throw new AccountingError("Choose a posted inventory document.", 400);
    const taken = await tx.invOpsEvent.findFirst({ where: { documentId, NOT: { id } } });
    if (taken || (d.sourceType === "OPS" && d.sourceId !== id)) throw new AccountingError(`Document ${d.docNo} already accounts for another operational event.`, 409);
    await tx.invOpsEvent.update({ where: { id }, data: { status: "POSTED", documentId, resolvedBy: userId, resolvedAt: new Date(), resolution: reason.trim().slice(0, 500), leaseUntil: null, lastError: null } });
    await auditAccounting(tx, { action: "inventory.ops_event.link", entityType: "inv_ops_event", entityId: id, userId, after: { documentId }, reason: reason.trim() });
    return tx.invOpsEvent.findUniqueOrThrow({ where: { id } });
  });
}

export async function listOpsEvents(q: { status?: string | null; kind?: string | null; sourceId?: string | null; limit?: number } = {}) {
  const statuses = q.status ? q.status.split(",") as InvOpsStatus[] : undefined;
  const rows = await prisma.invOpsEvent.findMany({ where: { ...(statuses ? { status: { in: statuses } } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.sourceId ? { sourceId: q.sourceId } : {}) },
    orderBy: [{ createdAt: "desc" }], take: Math.min(q.limit ?? 200, 500) });
  const docs = new Map((await prisma.invDocument.findMany({ where: { id: { in: rows.map((r) => r.documentId).filter(Boolean) as string[] } }, select: { id: true, docNo: true, status: true, type: true, docDate: true, originalDate: true } })).map((d) => [d.id, d]));
  const counts = await prisma.invOpsEvent.groupBy({ by: ["status"], _count: { _all: true } });
  return { rows: rows.map((r) => ({ ...r, txid: r.txid?.toString() ?? null, document: r.documentId ? docs.get(r.documentId) ?? null : null })), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

/**
 * The accounting state of operational records (for the operational screens), keyed by record id:
 * a batch's roast, cancellation and blend events, and its packing events (keyed by the batch).
 */
export async function opsStatusFor(sourceIds: string[]) {
  if (!sourceIds.length) return {};
  const rows = await prisma.$queryRaw<{ key: string; kind: string; status: string; lastError: string | null; resolution: string | null }[]>`
    SELECT CASE WHEN "kind" = 'PACK' THEN "payload"->>'batchId' ELSE "sourceId" END AS key, "kind", "status"::text AS status, "lastError", "resolution"
      FROM "InvOpsEvent"
     WHERE "sourceId" = ANY(${sourceIds}) OR ("kind" = 'PACK' AND "payload"->>'batchId' = ANY(${sourceIds}))
     ORDER BY "createdAt"`;
  const out: Record<string, { kind: string; status: string; reason: string | null }[]> = {};
  for (const r of rows) (out[r.key] ??= []).push({ kind: r.kind, status: r.status, reason: r.lastError ?? r.resolution });
  return out;
}

/**
 * Operational quantity against the accounts, per linked item (not a second entry: it detects
 * exceptions). The difference is explained by events not yet posted; what is left is unexplained.
 */
export async function opsReconciliation() {
  const loc = await prisma.invLocation.findFirst({ where: { isSalesDefault: true } });
  const items = await prisma.invItem.findMany({ where: { OR: [{ greenBeanId: { not: null } }, { materialItemId: { not: null } }, { coffeeProductId: { not: null } }, { productSkuId: { not: null } }] } });
  const open = await prisma.invOpsEvent.findMany({ where: { status: { notIn: ["POSTED", "IGNORED"] } } });
  const rows = [];
  for (const it of items) {
    let ops: Prisma.Decimal;
    if (it.greenBeanId) ops = dec((await prisma.greenBean.findUnique({ where: { id: it.greenBeanId }, select: { quantityKg: true } }))?.quantityKg ?? 0);
    else if (it.materialItemId) ops = dec((await prisma.materialItem.findUnique({ where: { id: it.materialItemId }, select: { quantityOnHand: true } }))?.quantityOnHand ?? 0);
    else if (it.coffeeProductId) {
      const bs = await prisma.roastingBatch.findMany({ where: { OR: [{ productId: it.coffeeProductId }, { productId: null, orderItem: { productId: it.coffeeProductId } }] }, select: { roastedAvailableKg: true } });
      ops = bs.reduce((s, b) => s.add(dec(b.roastedAvailableKg ?? 0)), ZERO);
    } else {
      const lots = await prisma.finishedGoodsLot.findMany({ where: { productSkuId: it.productSkuId!, isUnitTracked: true }, select: { unitsAvailable: true, unitsReserved: true, status: true, actualContentGrams: true, nominalContentGrams: true } });
      ops = lots.reduce((s, l) => s.add(l.status === "PARTIAL" && l.nominalContentGrams ? q4(dec(l.actualContentGrams ?? 0).div(dec(l.nominalContentGrams))) : dec(l.unitsAvailable ?? 0).add(dec(l.unitsReserved ?? 0))), ZERO);
    }
    const acc = loc ? (await onHand(prisma, it.id, loc.id)).qty : ZERO;
    const waiting = open.filter((e) => JSON.stringify(e.payload).includes(it.greenBeanId ?? it.materialItemId ?? it.coffeeProductId ?? it.productSkuId ?? "\u0000")).length;
    const diff = q4(ops.sub(acc));
    rows.push({ itemId: it.id, code: it.code, name: it.nameAr ?? it.name, ops: q4(ops).toFixed(4), accounts: q4(acc).toFixed(4), difference: diff.toFixed(4), openEvents: waiting,
      state: diff.abs().lt("0.001") ? "MATCHED" : waiting > 0 ? "EXPLAINED_BY_OPEN_EVENTS" : "EXCEPTION" });
  }
  return { location: loc ? { id: loc.id, code: loc.code } : null, rows, exceptions: rows.filter((r) => r.state === "EXCEPTION").length, openEvents: open.length };
}

/**
 * Called by an operational route after its transaction commits: bring the events it recorded to
 * their accounting state now. Never fails the operational request — whatever does not post stays
 * in the exception queue with its reason.
 */
export async function integrateNow(ids: (string | null | undefined)[]) {
  for (const id of ids) {
    if (!id) continue;
    try { await processOpsEvent(id); }
    catch (e) { console.error("[ops-integration]", id, e instanceof Error ? e.message : e); }
  }
}
