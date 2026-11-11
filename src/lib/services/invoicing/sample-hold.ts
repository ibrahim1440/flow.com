import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { SAMPLE_CHANNEL } from "./pricing";

type Db = Prisma.TransactionClient | typeof prisma;

export type SampleInvoiceInfo = { dealId: string | null; dealTitle: string | null; awaitingApproval: boolean; cancelled: boolean };

/**
 * D22 (أبو فهد B1, wording): what the accountant needs to know about a sample's invoice (channel SAMPLE) — the deal it was
 * sent on, and whether a sample of its send still waits for the manager (the issue is held: «تنتظر موافقة المدير») or the
 * one it names was cancelled. The same facts the issue check (service.ts sampleRefProblems) and the database trigger use.
 */
export async function sampleInvoiceInfo(db: Db, docs: { id: string; channel: string | null; externalOrderRef: string | null }[]): Promise<Map<string, SampleInvoiceInfo>> {
  const out = new Map<string, SampleInvoiceInfo>();
  const mine = docs.filter((d) => d.channel === SAMPLE_CHANNEL);
  if (!mine.length) return out;
  const sends = await db.hrAuditLog.findMany({ where: { action: "SAMPLE_SEND_CREATED", entityId: { in: mine.map((d) => d.id) } }, select: { entityId: true, after: true } });
  const idsOf = (d: { id: string; externalOrderRef: string | null }) => {
    const a = sends.find((s) => s.entityId === d.id)?.after as { samples?: { id: string }[] } | undefined;
    return [...new Set([d.externalOrderRef, ...(a?.samples ?? []).map((x) => x.id)].filter((x): x is string => !!x))];
  };
  const rows = await db.sampleShipment.findMany({
    where: { id: { in: mine.flatMap(idsOf) } },
    select: { id: true, status: true, approvalRequired: true, approvedAt: true, opportunityId: true, opportunity: { select: { title: true } } },
  });
  for (const d of mine) {
    const own = rows.filter((r) => idsOf(d).includes(r.id));
    const named = own.find((r) => r.id === d.externalOrderRef) ?? own[0];
    out.set(d.id, {
      dealId: named?.opportunityId ?? null, dealTitle: named?.opportunity?.title ?? null,
      awaitingApproval: own.some((r) => r.status !== "CANCELLED" && r.approvalRequired && !r.approvedAt),
      cancelled: !own.find((r) => r.id === d.externalOrderRef) || own.find((r) => r.id === d.externalOrderRef)!.status === "CANCELLED",
    });
  }
  return out;
}
