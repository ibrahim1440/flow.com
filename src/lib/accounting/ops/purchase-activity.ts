// Unified inventory phase 2 — the purchase invoice's ACTIVITY LOG (owner: every action visible). Each action writes one
// row to the person audit the users area reads («سجل الصلاحيات / التدقيق», /dashboard/employees/audit — AuthAuditLog,
// append-only by convention, its words in src/lib/users/audit-format.ts) in the action's own transaction: who, when,
// which document, a before / after summary (lines, quantities, amounts) and, for a cancel or a reversal, the reason.
// The invoice's own page shows the same rows as «سجل النشاط» (GET /api/purchases/invoices/:id/activity).
import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal } from "../money";
import type { AuditContext } from "../audit";

type Tx = Prisma.TransactionClient;

export const PURCHASE_ACTIVITY = [
  "PURCHASE_INVOICE_SAVED", "PURCHASE_INVOICE_SUBMITTED", "PURCHASE_INVOICE_RECEIVED", "PURCHASE_INVOICE_EDITED_AFTER_RECEIPT",
  "PURCHASE_INVOICE_POSTED", "PURCHASE_INVOICE_RETURNED", "PURCHASE_INVOICE_CANCELLED", "PURCHASE_INVOICE_CANCELLED_POSTED",
  "PURCHASE_INVOICE_DELETED", "PURCHASE_RECEIPT_REVERSED", "PURCHASE_LOT_CREATED", "PURCHASE_LOT_RETIRED",
  "PURCHASE_ACTION_DENIED",
] as const;
export type PurchaseActivity = (typeof PURCHASE_ACTIVITY)[number];

export type InvoiceSummary = {
  number: string; status: string; supplierName: string; supplierRef: string; invoiceDate: string;
  netTotal: string; vatTotal: string; grossTotal: string;
  lines: { kind: string; description: string; quantity: string | null; net: string; vat: string; taxCode: string | null; target?: string | null }[];
};

/** The invoice as the log records it (lines, quantities, amounts). */
export async function invoiceSummary(tx: Tx, id: string): Promise<InvoiceSummary | null> {
  const v = await tx.supplierInvoice.findUnique({ where: { id }, include: { supplier: { select: { name: true } }, lines: { orderBy: { lineNo: "asc" }, include: { taxCategory: { select: { code: true } } } } } });
  if (!v) return null;
  const f = (d: unknown) => new Decimal(String(d ?? 0)).toFixed(2);
  return {
    number: v.number, status: v.status, supplierName: v.supplier.name, supplierRef: v.supplierRef, invoiceDate: v.invoiceDate.toISOString().slice(0, 10),
    netTotal: f(v.netTotal), vatTotal: f(v.vatTotal), grossTotal: f(v.grossTotal),
    lines: v.lines.map((l) => ({ kind: l.kind, description: l.description.slice(0, 120), quantity: l.quantity === null ? null : new Decimal(l.quantity).toFixed(), net: f(l.net), vat: f(l.vat), taxCode: l.taxCategory?.code ?? null, target: l.targetPurchaseRecordId ?? null })),
  };
}

/** The address hash AuthAuditLog keeps (never the address): the platform address rule of auditFromRequest. */
async function ipHashOf(ip: string | null | undefined): Promise<string> {
  const value = ip || "0.0.0.0";
  try {
    const { hashRateLimitKey } = await import("@/lib/rate-limit");
    return hashRateLimitKey(value);
  } catch {
    // No pepper in this process (a script or a test): a plain digest — still never the address itself.
    const pepper = process.env.RATE_LIMIT_SECRET ?? process.env.JWT_SECRET;
    return pepper ? createHmac("sha256", pepper).update(value).digest("hex") : createHash("sha256").update(value).digest("hex");
  }
}

/**
 * One activity row, in the caller's transaction. `extra` carries the before summary of an edit, the receipts a cancel
 * reversed, the lot created or retired; the after summary is read here.
 */
export async function logPurchaseActivity(tx: Tx, ctx: Pick<AuditContext, "actorId" | "ip" | "userAgent" | "reason">, action: PurchaseActivity, invoiceId: string, extra: Record<string, unknown> = {}) {
  const after = await invoiceSummary(tx, invoiceId);
  const metadata = {
    invoiceId, number: after?.number ?? extra.number ?? null, targetName: after?.number ?? extra.number ?? null,
    supplierName: after?.supplierName ?? null, after, reason: ctx.reason ?? null, ...extra,
  };
  await tx.authAuditLog.create({
    data: {
      userId: ctx.actorId.startsWith("migration:") ? null : ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB",
      ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null, metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
    },
  });
}

/** The refusals worth a row in the person audit when someone tries (the attempt itself is the event). */
const DENIED = new Set(["RECEIVED_CHANGE_REQUIRED", "SOD_OWN_INVOICE", "INVOICE_STALE", "RECEIVE_REQUIRED"]);

/**
 * Run a purchase action; when it is refused for one of the reasons above, record the attempt — who, which invoice, what
 * was tried, the refusal — in a SEPARATE short transaction (the action's own transaction rolled back), then re-throw.
 */
export async function withDeniedLog<T>(ctx: Pick<AuditContext, "actorId" | "ip" | "userAgent" | "reason">, attempted: string, invoiceId: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && DENIED.has(code)) {
      try {
        const inv = invoiceId ? await prisma.supplierInvoice.findUnique({ where: { id: invoiceId }, select: { number: true } }) : null;
        await prisma.$transaction(async (tx) => {
          await tx.authAuditLog.create({
            data: {
              userId: ctx.actorId.startsWith("migration:") ? null : ctx.actorId, action: "PURCHASE_ACTION_DENIED", result: "DENIED", reasonCode: code, sourceInterface: "WEB",
              ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
              metadata: { invoiceId, number: inv?.number ?? null, targetName: inv?.number ?? null, attempted, code, reason: ctx.reason ?? null },
            },
          });
        });
      } catch { /* the refusal still reaches the person even if its audit row cannot be written */ }
    }
    throw e;
  }
}
