// Conversion cost: direct labour and production overhead absorbed into production (stage 4b).
//
// A cost pool belongs to a process (roasting, blending, packing, baking) and a kind (direct labour
// or production overhead). Its rate is the budgeted pool over normal capacity in the pool's basis
// (kg in, kg out, units out, batches, labour hours, machine hours), so a period of low output
// absorbs less and the unabsorbed cost stays in the period's expense (IAS 2 normal capacity). A
// pool is proposed by one person and approved by another, and never changes once approved.
// Absorption credits a contra account (labour / overhead absorbed) — the actual costs stay where
// they are booked (salaries, maintenance…), so nothing is counted twice: expense less absorbed is
// what the period bears, the absorbed part sits in inventory until sold.
// The rates used by tests and the local fixture are SYNTHETIC TEST ASSUMPTIONS (codes end "-SYN").
import { Prisma, type InvCostBasis, type InvCostPoolKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { m2 } from "./inventory-costing";

type Tx = Prisma.TransactionClient;
const KINDS = new Set<InvCostPoolKind>(["DIRECT_LABOUR", "PRODUCTION_OVERHEAD"]);
const BASES = new Set<InvCostBasis>(["PER_KG_INPUT", "PER_KG_OUTPUT", "PER_UNIT_OUTPUT", "PER_BATCH", "PER_LABOUR_HOUR", "PER_MACHINE_HOUR"]);
const PROCESSES = new Set(["ROASTING", "BLENDING", "PACKING", "BAKING", "OTHER"]);
export const ABSORBED_ROLE: Record<InvCostPoolKind, string> = { DIRECT_LABOUR: "LABOUR_ABSORBED", PRODUCTION_OVERHEAD: "OVERHEAD_ABSORBED" };

const num = (v: unknown, what: string, places: number) => {
  let d: Prisma.Decimal;
  try { d = new Prisma.Decimal(String(v ?? "").trim()); } catch { throw new AccountingError(`${what} is not a number.`, 400); }
  if (!d.isFinite() || d.decimalPlaces() > places) throw new AccountingError(`${what} has more than ${places} decimals.`, 400);
  return d;
};

export async function createCostPool(b: Record<string, unknown>, userId: string) {
  const code = typeof b.code === "string" ? b.code.trim().slice(0, 40) : "", name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
  if (!code || !name) throw new AccountingError("Code and name are required.", 400);
  if (!KINDS.has(b.kind as InvCostPoolKind)) throw new AccountingError("A pool is direct labour or production overhead.", 400);
  if (!PROCESSES.has(String(b.process))) throw new AccountingError("Choose the process (roasting, blending, packing, baking or other).", 400);
  if (!BASES.has(b.basis as InvCostBasis)) throw new AccountingError("Choose the allocation basis.", 400);
  const budgetAmount = num(b.budgetAmount, "Budgeted pool", 2), normalCapacity = num(b.normalCapacity, "Normal capacity", 4);
  if (budgetAmount.lt(0)) throw new AccountingError("The budgeted pool cannot be negative.", 400);
  if (normalCapacity.lte(0)) throw new AccountingError("Normal capacity must be positive.", 400);
  const acc = await prisma.account.findUnique({ where: { id: String(b.expenseAccountId ?? "") } });
  if (!acc || acc.type !== "EXPENSE" || !acc.allowPosting) throw new AccountingError("Choose the expense account where the pool's actual costs are booked.", 400);
  const rate = budgetAmount.div(normalCapacity).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  return ledgerTx(async (tx) => {
    const p = await tx.invCostPool.create({ data: { code, name, nameAr: typeof b.nameAr === "string" ? b.nameAr.trim().slice(0, 200) || null : null, kind: b.kind as InvCostPoolKind, process: String(b.process), basis: b.basis as InvCostBasis, budgetAmount, normalCapacity, rate, expenseAccountId: acc.id, createdBy: userId } });
    await auditAccounting(tx, { action: "inventory.cost_pool.create", entityType: "inv_cost_pool", entityId: p.id, userId, after: p });
    return p;
  });
}

export async function approveCostPool(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const cur = await tx.invCostPool.findUnique({ where: { id } });
    if (!cur) throw new AccountingError("Cost pool not found.", 404);
    if (cur.createdBy === userId) throw new AccountingError("A cost pool is approved by someone other than its author.", 403);
    if (cur.status !== "DRAFT") throw new AccountingError("Only a draft cost pool can be approved.", 409);
    const live = await tx.invCostPool.findFirst({ where: { kind: cur.kind, process: cur.process, status: "APPROVED" } });
    if (live) throw new AccountingError(`${live.code} is the approved ${cur.kind === "DIRECT_LABOUR" ? "labour" : "overhead"} pool of ${cur.process}; retire it first.`, 409);
    await tx.invCostPool.update({ where: { id }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    await auditAccounting(tx, { action: "inventory.cost_pool.approve", entityType: "inv_cost_pool", entityId: id, userId });
    return tx.invCostPool.findUniqueOrThrow({ where: { id } });
  });
}

export async function retireCostPool(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const r = await tx.invCostPool.updateMany({ where: { id, status: "APPROVED" }, data: { status: "RETIRED" } });
    if (r.count !== 1) throw new AccountingError("Only an approved cost pool can be retired.", 409);
    await auditAccounting(tx, { action: "inventory.cost_pool.retire", entityType: "inv_cost_pool", entityId: id, userId });
    return tx.invCostPool.findUniqueOrThrow({ where: { id } });
  });
}

export async function listCostPools() {
  const pools = await prisma.invCostPool.findMany({ orderBy: [{ status: "asc" }, { process: "asc" }, { kind: "asc" }] });
  const accs = new Map((await prisma.account.findMany({ where: { id: { in: pools.map((p) => p.expenseAccountId) } }, select: { id: true, code: true, nameAr: true, nameEn: true } })).map((a) => [a.id, a]));
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: pools.flatMap((p) => [p.createdBy, p.approvedBy]).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return pools.map((p) => ({ ...p, budgetAmount: p.budgetAmount.toFixed(2), normalCapacity: p.normalCapacity.toFixed(4), rate: p.rate.toFixed(4), expenseAccount: accs.get(p.expenseAccountId) ?? null,
    createdByName: people.get(p.createdBy) ?? p.createdBy, approvedByName: p.approvedBy ? people.get(p.approvedBy) ?? p.approvedBy : null }));
}

/**
 * Conversion cost a production absorbs: every approved pool of its process, rate × driver.
 * A pool whose driver the document does not give (hours) stops the posting with the reason.
 */
export async function absorptionFor(tx: Tx, doc: { process: string | null; labourHours: Prisma.Decimal | null; machineHours: Prisma.Decimal | null }, drivers: { yieldIn: Prisma.Decimal; yieldOut: Prisma.Decimal; unitsOut: Prisma.Decimal }) {
  if (!doc.process) return [];
  const pools = await tx.invCostPool.findMany({ where: { process: doc.process, status: "APPROVED" }, orderBy: { kind: "asc" } });
  return pools.map((p) => {
    let driver: Prisma.Decimal;
    switch (p.basis) {
      case "PER_KG_INPUT": driver = drivers.yieldIn; break;
      case "PER_KG_OUTPUT": driver = drivers.yieldOut; break;
      case "PER_UNIT_OUTPUT": driver = drivers.unitsOut; break;
      case "PER_BATCH": driver = new Prisma.Decimal(1); break;
      case "PER_LABOUR_HOUR":
        if (doc.labourHours === null) throw new AccountingError(`Enter the labour hours: cost pool ${p.code} is absorbed per labour hour.`, 400);
        driver = dec(doc.labourHours); break;
      case "PER_MACHINE_HOUR":
        if (doc.machineHours === null) throw new AccountingError(`Enter the machine hours: cost pool ${p.code} is absorbed per machine hour.`, 400);
        driver = dec(doc.machineHours); break;
    }
    return { pool: p, driver, amount: m2(dec(p.rate).mul(driver)) };
  }).filter((a) => !a.amount.isZero());
}

/** Per pool and period: absorbed (from posted productions) against actual cost booked, under/over. */
export async function absorptionReport(from: Date, to: Date) {
  const pools = await prisma.invCostPool.findMany({ where: { status: { in: ["APPROVED", "RETIRED"] } }, orderBy: [{ process: "asc" }, { kind: "asc" }] });
  const moves = await prisma.invMove.groupBy({ by: ["poolId"], where: { kind: "ABSORBED", date: { gte: from, lte: to }, poolId: { in: pools.map((p) => p.id) } }, _sum: { value: true } });
  const absorbed = new Map(moves.map((m) => [m.poolId!, dec(m._sum.value).neg()]));
  const out = [];
  for (const p of pools) {
    const g = await prisma.journalEntryLine.aggregate({ where: { accountId: p.expenseAccountId, journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { gte: from, lte: to } } }, _sum: { debit: true, credit: true } });
    const actual = dec(g._sum.debit).sub(dec(g._sum.credit));
    const abs = absorbed.get(p.id) ?? ZERO;
    const acc = await prisma.account.findUnique({ where: { id: p.expenseAccountId }, select: { code: true, nameAr: true, nameEn: true } });
    out.push({ id: p.id, code: p.code, name: p.nameAr ?? p.name, kind: p.kind, process: p.process, basis: p.basis, rate: p.rate.toFixed(4), status: p.status,
      expenseAccount: acc, actual: actual.toFixed(2), absorbed: abs.toFixed(2), unabsorbed: actual.sub(abs).toFixed(2),
      // More absorbed than spent: inventory could carry more than cost (IAS 2) — the accountant decides the adjustment.
      overAbsorbed: abs.gt(actual) });
  }
  return { from, to, pools: out };
}
