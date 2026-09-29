// Fixed-asset documents → journal entries (stage 5). Accounts come from the asset's class; the
// disposal gain or loss from the roles FA_DISPOSAL_GAIN / FA_DISPOSAL_LOSS.
//   fa.asset.capitalised   Dr cost / Cr counter, per source whose cost is not already on the cost
//                          account; opening depreciation with a counter: Dr counter / Cr accumulated
//   fa.asset.cancelled     the same, reversed
//   fa.depreciation.posted Dr depreciation expense / Cr accumulated depreciation, per class and branch
//   fa.depreciation.reversed  the same, reversed (dated the run's period end)
//   fa.disposal.posted     Dr accumulated · Dr proceeds account / Cr cost · Cr gain or Dr loss
//   fa.disposal.reversed   the same, reversed (dated the disposal date)
import type { Prisma } from "@/generated/prisma/client";
import { ZERO, dec } from "../money";
import type { EngineLine } from "../posting";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };
const flip = (ls: EngineLine[]): EngineLine[] => ls.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
const faNo = (n: number) => `FA-${String(n).padStart(4, "0")}`;

export async function translateFixedAssets(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  const p = ev.payload as { assetId?: string; runId?: string; disposalId?: string };
  const reversed = ev.eventType.endsWith(".cancelled") || ev.eventType.endsWith(".reversed");

  if (p.assetId) {
    const a = await tx.faAsset.findUnique({ where: { id: p.assetId }, include: { class: true, sources: true } });
    if (!a || !a.capitalisedAt) return { skip: "The asset is not capitalised." };
    const dims = { branchId: a.branchId, costCenterId: a.costCenterId };
    const label = `${reversed ? "Capitalisation cancelled" : "Capitalisation"} ${faNo(a.assetNo)} · ${a.name}`;
    const lines: EngineLine[] = [];
    for (const s of a.sources) {
      if (s.kind === "IN_LEDGER" || !s.counterAccountId || s.counterAccountId === a.class.costAccountId) continue;
      lines.push({ accountId: a.class.costAccountId, debit: dec(s.amount), description: label, ...dims });
      lines.push({ accountId: s.counterAccountId, credit: dec(s.amount), description: s.description ?? label, ...dims });
    }
    if (dec(a.openingAccumulated).gt(0) && a.openingAccumCounterAccountId) {
      lines.push({ accountId: a.openingAccumCounterAccountId, debit: dec(a.openingAccumulated), description: `${label} · opening depreciation`, ...dims });
      lines.push({ accountId: a.class.accumAccountId, credit: dec(a.openingAccumulated), description: `${label} · opening depreciation`, ...dims });
    }
    if (lines.length < 2) return { skip: "Nothing to post: the cost is already on the asset account." };
    return { entryDate: reversed ? dayOf(ev.occurredAt) : a.capitalisedAt, description: label, sourceModule: "fixed_assets", sourceDocumentId: a.id, lines: reversed ? flip(lines) : lines, alsoUnapproved: [] };
  }

  if (p.runId) {
    const r = await tx.faDepRun.findUnique({ where: { id: p.runId }, include: { lines: { include: { asset: { include: { class: true } } } } } });
    if (!r) return { skip: "The depreciation run no longer exists." };
    const groups = new Map<string, { exp: string; acc: string; branchId: string | null; costCenterId: string | null; v: Prisma.Decimal; code: string }>();
    for (const l of r.lines) {
      const c = l.asset.class;
      const k = [c.expenseAccountId, c.accumAccountId, l.asset.branchId ?? "", l.asset.costCenterId ?? ""].join("|");
      const g = groups.get(k) ?? { exp: c.expenseAccountId, acc: c.accumAccountId, branchId: l.asset.branchId, costCenterId: l.asset.costCenterId, v: ZERO, code: c.code };
      g.v = g.v.add(l.amount); groups.set(k, g);
    }
    const label = `${reversed ? "Depreciation reversed" : "Depreciation"} ${r.periodEnd.toISOString().slice(0, 7)} · run #${r.runNo}`;
    const lines: EngineLine[] = [];
    for (const g of groups.values()) {
      if (g.v.isZero()) continue;
      lines.push({ accountId: g.exp, debit: g.v, description: `${label} · ${g.code}`, branchId: g.branchId, costCenterId: g.costCenterId });
      lines.push({ accountId: g.acc, credit: g.v, description: `${label} · ${g.code}`, branchId: g.branchId, costCenterId: g.costCenterId });
    }
    if (lines.length < 2) return { skip: "Nothing to post (zero depreciation)." };
    return { entryDate: r.periodEnd, description: label, sourceModule: "fixed_assets", sourceDocumentId: r.id, lines: reversed ? flip(lines) : lines, alsoUnapproved: [] };
  }

  if (p.disposalId) {
    const d = await tx.faDisposal.findUnique({ where: { id: p.disposalId }, include: { asset: { include: { class: true } } } });
    if (!d || d.cost === null || d.accumulated === null || d.gainLoss === null) return { skip: "The disposal has not been approved." };
    const a = d.asset;
    const dims = { branchId: a.branchId, costCenterId: a.costCenterId };
    const label = `${reversed ? "Disposal reversed" : "Disposal"} ${faNo(a.assetNo)} · ${a.name} (${d.kind.toLowerCase()})`;
    const lines: EngineLine[] = [
      { accountId: a.class.accumAccountId, debit: dec(d.accumulated), description: label, ...dims },
      { accountId: a.class.costAccountId, credit: dec(d.cost), description: label, ...dims },
    ];
    if (dec(d.proceeds).gt(0)) lines.push({ accountId: d.proceedsAccountId!, debit: dec(d.proceeds), description: `${label} · proceeds`, ...dims });
    const gl = dec(d.gainLoss);
    if (gl.gt(0)) lines.push({ role: "FA_DISPOSAL_GAIN", credit: gl, description: `${label} · gain`, ...dims });
    if (gl.lt(0)) lines.push({ role: "FA_DISPOSAL_LOSS", debit: gl.abs(), description: `${label} · loss`, ...dims });
    return { entryDate: d.disposalDate, description: label, sourceModule: "fixed_assets", sourceDocumentId: d.id, lines: reversed ? flip(lines) : lines, alsoUnapproved: [] };
  }
  return { skip: "Unknown fixed-asset event." };
}

function dayOf(at: Date) {
  // occurredAt of a cancellation is the accounting day it was recorded (stored as UTC midnight).
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
