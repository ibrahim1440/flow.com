// Accounting policies and commission-plan accounting approval: prepare (draft) → approve by a
// second person → retire. The database guard enforces four-eyes and immutability.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { auditAccounting } from "./audit";
import { POLICIES } from "./catalog";
import { ledgerTx } from "./journal-service";

export async function listPolicies() {
  const rows = await prisma.accountingPolicy.findMany({ orderBy: [{ key: "asc" }, { version: "desc" }] });
  return POLICIES.map((p) => ({ ...p, versions: rows.filter((r) => r.key === p.key) }));
}

export async function draftPolicy(key: string, input: { statement?: string; parameters?: Prisma.InputJsonValue }, userId: string) {
  const def = POLICIES.find((p) => p.key === key);
  if (!def) throw new AccountingError("Unknown policy.", 400);
  const statement = (input.statement ?? def.defaultStatement).trim();
  if (statement.length < 20) throw new AccountingError("The policy statement is too short to approve.", 400);
  return ledgerTx(async (tx) => {
    const draft = await tx.accountingPolicy.findFirst({ where: { key, status: "DRAFT" } });
    if (draft) throw new AccountingError(`Version ${draft.version} of this policy is already a draft; approve or discard it first.`, 409);
    const last = await tx.accountingPolicy.findFirst({ where: { key }, orderBy: { version: "desc" } });
    const row = await tx.accountingPolicy.create({
      data: { key, version: (last?.version ?? 0) + 1, titleEn: def.en, titleAr: def.ar, statement, parameters: input.parameters, preparedBy: userId },
    });
    await auditAccounting(tx, { action: "policy.draft", entityType: "policy", entityId: row.id, userId, after: { key, version: row.version } });
    return row;
  });
}

export async function approvePolicy(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const p = await tx.accountingPolicy.findUnique({ where: { id } });
    if (!p) throw new AccountingError("Policy version not found.", 404);
    if (p.status !== "DRAFT") throw new AccountingError(`This version is ${p.status}.`, 409);
    if (p.preparedBy === userId) throw new AccountingError("You prepared this policy version; someone else must approve it.", 403);
    const now = new Date();
    const current = await tx.accountingPolicy.findFirst({ where: { key: p.key, status: "APPROVED" } });
    if (current) await tx.accountingPolicy.update({ where: { id: current.id }, data: { status: "RETIRED", retiredAt: now, retiredBy: userId } });
    const row = await tx.accountingPolicy.update({ where: { id }, data: { status: "APPROVED", approvedAt: now, approvedBy: userId } });
    await auditAccounting(tx, { action: "policy.approve", entityType: "policy", entityId: id, userId, refs: current ? { retired: current.id } : undefined });
    return row;
  });
}

export async function discardPolicyDraft(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const p = await tx.accountingPolicy.findUnique({ where: { id } });
    if (!p) throw new AccountingError("Policy version not found.", 404);
    if (p.status !== "DRAFT") throw new AccountingError("Only a draft can be discarded.", 409);
    await tx.accountingPolicy.delete({ where: { id } });
    await auditAccounting(tx, { action: "policy.discard", entityType: "policy", entityId: id, userId, before: { key: p.key, version: p.version } });
    return { discarded: true };
  });
}

export async function listCommissionPlanVersions() {
  return prisma.commissionPlanVersion.findMany({
    orderBy: [{ plan: { code: "asc" } }, { version: "desc" }],
    select: {
      id: true, version: true, baseRatePercent: true, effectiveFrom: true, effectiveTo: true, createdById: true,
      accountingApproval: true, accountingApprovedBy: true, accountingApprovedAt: true,
      plan: { select: { code: true, name: true, nameAr: true } }, _count: { select: { ledgerEntries: true } },
    },
  });
}

export async function approveCommissionPlanVersion(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const v = await tx.commissionPlanVersion.findUnique({ where: { id } });
    if (!v) throw new AccountingError("Plan version not found.", 404);
    if (v.accountingApproval === "APPROVED") throw new AccountingError("Already approved for accounting.", 409);
    if (v.createdById && v.createdById === userId) throw new AccountingError("You created this plan version; someone else must approve it for accounting.", 403);
    if (!v.createdById) throw new AccountingError("This plan version does not record its author, so four-eyes approval cannot be shown; create a new version.", 409);
    const row = await tx.commissionPlanVersion.update({ where: { id }, data: { accountingApproval: "APPROVED", accountingApprovedBy: userId, accountingApprovedAt: new Date() } });
    await auditAccounting(tx, { action: "commission_plan.accounting_approve", entityType: "commission_plan_version", entityId: id, userId });
    return row;
  });
}
